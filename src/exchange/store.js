// Grand Exchange persistence: the order book, collection box, buy limits,
// idempotent writes and the economy ledger. Statements are prepared in
// QueryHandler.init() (EXCHANGE_STATEMENTS below); every write runs in one
// database transaction and is stored in exchange_ops by its opId.
//
// The contract is docs/GRAND_EXCHANGE.md in hackmods/Autonomous-RSC.

const log = require('bole')('exchange');
const rules = require('./rules');
const { matchOffer } = require('./match');
const { normalizeUsername } = require('../username');
const { savePlayer } = require('../player-save');

const { COINS_ID } = rules;

const EXCHANGE_STATEMENTS = {
    exGetOp: 'SELECT `result` FROM `exchange_ops` WHERE `op_id` = ?',
    exInsertOp:
        'INSERT INTO `exchange_ops` (`op_id`, `player_id`, `kind`, ' +
        '`result`, `at`) VALUES (?, ?, ?, ?, ?)',
    exGetPlayerById: 'SELECT `id`, `username` FROM `players` WHERE `id` = ?',
    exGetPlayerByName:
        'SELECT `id`, `username` FROM `players` WHERE `username` = ?',
    exOpenOffersByPlayer:
        "SELECT * FROM `exchange_offers` WHERE `player_id` = ? AND " +
        "`state` = 'open' ORDER BY `slot`",
    exOpenOfferBySlot:
        "SELECT * FROM `exchange_offers` WHERE `player_id` = ? AND " +
        "`slot` = ? AND `state` = 'open'",
    exGetOffer: 'SELECT * FROM `exchange_offers` WHERE `id` = ?',
    exInsertOffer:
        'INSERT INTO `exchange_offers` (`player_id`, `username`, `slot`, ' +
        '`side`, `item_id`, `qty`, `filled`, `price`, `coins_moved`, ' +
        "`state`, `created`, `updated`) VALUES (:player_id, :username, " +
        ":slot, :side, :item_id, :qty, 0, :price, 0, 'open', :now, :now)",
    exUpdateOffer:
        'UPDATE `exchange_offers` SET `filled` = :filled, `coins_moved` = ' +
        ':coins_moved, `state` = :state, `updated` = :updated WHERE ' +
        '`id` = :id',
    exRestingBook:
        "SELECT * FROM `exchange_offers` WHERE `item_id` = ? AND " +
        "`side` = ? AND `state` = 'open' AND `player_id` != ?",
    exInsertFill:
        'INSERT INTO `exchange_fills` (`buy_id`, `sell_id`, `item_id`, ' +
        '`qty`, `price`, `tax`, `at`) VALUES (?, ?, ?, ?, ?, ?, ?)',
    exRecentFills:
        'SELECT `qty`, `price`, `at` FROM `exchange_fills` WHERE ' +
        '`item_id` = ? AND `at` >= ? ORDER BY `at`, `id`',
    exLastFills:
        'SELECT `qty`, `price`, `at` FROM `exchange_fills` WHERE ' +
        '`item_id` = ? ORDER BY `at` DESC, `id` DESC LIMIT ?',
    exInsertCollect:
        'INSERT INTO `exchange_collect` (`player_id`, `item_id`, `amount`, ' +
        '`reason`, `offer_id`, `created`, `claimed_at`) VALUES ' +
        '(?, ?, ?, ?, ?, ?, ?)',
    exUnclaimedRows:
        'SELECT * FROM `exchange_collect` WHERE `player_id` = ? AND ' +
        '`claimed_at` IS NULL ORDER BY `created`, `id`',
    exUnclaimedSummed:
        'SELECT `item_id`, SUM(`amount`) AS `amount` FROM ' +
        '`exchange_collect` WHERE `player_id` = ? AND `claimed_at` IS NULL ' +
        'GROUP BY `item_id` ORDER BY MIN(`id`)',
    exClaimRow:
        'UPDATE `exchange_collect` SET `claimed_at` = ? WHERE `id` = ?',
    exSetCollectAmount:
        'UPDATE `exchange_collect` SET `amount` = ? WHERE `id` = ?',
    exGetLimit:
        'SELECT `window_start`, `bought` FROM `exchange_limits` WHERE ' +
        '`player_id` = ? AND `item_id` = ?',
    exSetLimit:
        'INSERT OR REPLACE INTO `exchange_limits` (`player_id`, `item_id`, ' +
        '`window_start`, `bought`) VALUES (?, ?, ?, ?)',
    exGetLimitOverride:
        'SELECT `buy_limit` FROM `exchange_limit_overrides` WHERE ' +
        '`item_id` = ?',
    exInsertLedger:
        'INSERT INTO `economy_ledger` (`at`, `kind`, `player_id`, ' +
        '`item_id`, `amount`, `note`) VALUES (?, ?, ?, ?, ?, ?)',
    exLedgerByKind:
        'SELECT `kind`, SUM(`amount`) AS `amount` FROM `economy_ledger` ' +
        'WHERE `at` >= ? AND (`item_id` = ' +
        COINS_ID +
        ' OR `item_id` IS NULL) GROUP BY `kind`',
    exBids:
        'SELECT `price`, SUM(`qty` - `filled`) AS `qty` FROM ' +
        "`exchange_offers` WHERE `item_id` = ? AND `side` = 'buy' AND " +
        "`state` = 'open' GROUP BY `price` ORDER BY `price` DESC LIMIT ?",
    exAsks:
        'SELECT `price`, SUM(`qty` - `filled`) AS `qty` FROM ' +
        "`exchange_offers` WHERE `item_id` = ? AND `side` = 'sell' AND " +
        "`state` = 'open' GROUP BY `price` ORDER BY `price` ASC LIMIT ?",
    exPricedItems:
        "SELECT `item_id` FROM `exchange_offers` WHERE `state` = 'open' " +
        'UNION SELECT `item_id` FROM `exchange_fills` ORDER BY `item_id`'
};

class Refusal extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function refuse(code) {
    throw new Refusal(code);
}

function toOffer(row) {
    return {
        id: row.id,
        playerId: row.player_id,
        username: row.username,
        slot: row.slot,
        side: row.side,
        itemId: row.item_id,
        qty: row.qty,
        filled: row.filled,
        price: row.price,
        coinsMoved: row.coins_moved,
        state: row.state,
        created: row.created,
        updated: row.updated
    };
}

function toCollect(rows) {
    return rows.map((row) => ({ itemId: row.item_id, amount: row.amount }));
}

// sum a [{itemId, amount}] list per item, keeping first-seen order
function sumPerItem(entries) {
    const totals = new Map();

    for (const { itemId, amount } of entries) {
        totals.set(itemId, (totals.get(itemId) || 0) + amount);
    }

    return [...totals].map(([itemId, amount]) => ({ itemId, amount }));
}

class ExchangeStore {
    constructor(queryHandler) {
        this.queryHandler = queryHandler;
        this.database = queryHandler.database;
        this.statements = queryHandler.statements;
        this.now = () => Date.now();

        // runs fn inside one transaction; a throw rolls everything back
        this.transaction = this.database.transaction((fn) => fn());
    }

    // --- helpers ---------------------------------------------------------

    storeOp(opId, playerId, kind, reply, now) {
        this.statements.exInsertOp.run(
            opId,
            playerId === undefined ? null : playerId,
            kind,
            JSON.stringify(reply),
            now
        );
    }

    storedOp(opId) {
        const row = this.statements.exGetOp.get(opId);
        return row ? JSON.parse(row.result) : undefined;
    }

    // one idempotent write: a stored opId returns its stored reply; a refusal
    // rolls back every write of fn and is stored on its own, so an
    // exchangeOp lookup after a timeout always gets an answer
    write(kind, opId, playerId, fn) {
        if (typeof opId !== 'string' || !opId.length) {
            return { success: false, code: 'DOWN' };
        }

        const stored = this.storedOp(opId);

        if (stored) {
            return stored;
        }

        const now = this.now();

        try {
            return this.transaction(() => {
                const reply = fn(now);
                this.storeOp(opId, playerId, kind, reply, now);
                return reply;
            });
        } catch (e) {
            let reply;

            if (e instanceof Refusal) {
                reply = { success: false, code: e.code };
            } else {
                log.error(e);
                reply = { success: false, code: 'DOWN' };
            }

            try {
                this.storeOp(opId, playerId, kind, reply, now);
            } catch (storeError) {
                log.error(storeError);
            }

            return reply;
        }
    }

    getPlayerRow(playerId) {
        if (!Number.isInteger(playerId)) {
            return;
        }

        return this.statements.exGetPlayerById.get(playerId);
    }

    applySave(save, playerId) {
        if (!save) {
            return;
        }

        if (save.id !== playerId) {
            refuse('NOT_FOUND');
        }

        savePlayer(this.queryHandler, save);
    }

    collect(playerId, itemId, amount, reason, offerId, now) {
        if (amount <= 0) {
            return;
        }

        this.statements.exInsertCollect.run(
            playerId,
            itemId,
            amount,
            reason,
            offerId === undefined ? null : offerId,
            now,
            null
        );
    }

    ledger(kind, playerId, itemId, amount, note, now) {
        this.statements.exInsertLedger.run(
            now,
            kind,
            playerId === undefined ? null : playerId,
            itemId === undefined ? null : itemId,
            amount === undefined ? null : amount,
            note === undefined ? null : String(note)
        );
    }

    fillsFor(itemId, now) {
        const recent = this.statements.exRecentFills.all(
            itemId,
            now - rules.GUIDE_WINDOW_MS
        );

        const last = this.statements.exLastFills.all(
            itemId,
            rules.GUIDE_FALLBACK_FILLS
        );

        return { recent, last };
    }

    unclaimed(playerId) {
        return toCollect(this.statements.exUnclaimedSummed.all(playerId));
    }

    // --- writes ----------------------------------------------------------

    place({ opId, save, offer = {} }) {
        const playerId = offer.playerId;

        return this.write('place', opId, playerId, (now) => {
            const side = offer.side;
            const itemId = Number(offer.itemId);
            const qty = Number(offer.qty);
            const price = Number(offer.price);

            if (side !== 'buy' && side !== 'sell') {
                refuse('NOT_FOUND');
            }

            if (!Number.isInteger(itemId) || itemId < 0) {
                refuse('NOT_FOUND');
            }

            if (itemId === COINS_ID) {
                refuse('UNTRADEABLE');
            }

            if (!rules.isPositiveInt(qty)) {
                refuse('NO_ITEM');
            }

            if (!rules.isPositiveInt(price)) {
                refuse('PRICE_BAND');
            }

            if (side === 'buy' && qty * price > rules.MAX_INT) {
                refuse('NO_COINS');
            }

            const player = this.getPlayerRow(playerId);

            if (!player) {
                refuse('NOT_FOUND');
            }

            const open = this.statements.exOpenOffersByPlayer.all(playerId);
            const slot = rules.freeSlot(open.map((row) => row.slot));

            if (slot < 0) {
                refuse('SLOTS');
            }

            const { recent, last } = this.fillsFor(itemId, now);
            const guide = rules.bandGuide(recent, last, offer.basePrice);

            if (!rules.inBand(price, guide)) {
                refuse('PRICE_BAND');
            }

            if (side === 'buy') {
                const row = this.statements.exGetLimit.get(playerId, itemId);

                const window = rules.limitWindow(
                    row && { windowStart: row.window_start, bought: row.bought },
                    now
                );

                if (qty > this.limitLeft(playerId, itemId, offer.stackable, now)) {
                    refuse('LIMIT');
                }

                this.statements.exSetLimit.run(
                    playerId,
                    itemId,
                    window.windowStart,
                    window.bought + qty
                );
            }

            this.applySave(save, playerId);

            const { lastInsertRowid } = this.statements.exInsertOffer.run({
                player_id: playerId,
                username: offer.username || player.username,
                slot,
                side,
                item_id: itemId,
                qty,
                price,
                now
            });

            const incoming = toOffer(
                this.statements.exGetOffer.get(lastInsertRowid)
            );

            const book = this.statements.exRestingBook
                .all(itemId, side === 'buy' ? 'sell' : 'buy', playerId)
                .map(toOffer);

            const restingById = new Map(book.map((row) => [row.id, row]));
            const matched = matchOffer(book, incoming);

            const fills = [];
            const notify = [];

            for (const { restingId, qty: fillQty, price: fillPrice } of
                matched.fills) {
                const resting = restingById.get(restingId);
                const buy = side === 'buy' ? incoming : resting;
                const sell = side === 'buy' ? resting : incoming;

                const gross = fillQty * fillPrice;
                const tax = rules.fillTax(fillQty, fillPrice);
                const refund = fillQty * (buy.price - fillPrice);

                const fill = this.statements.exInsertFill.run(
                    buy.id,
                    sell.id,
                    itemId,
                    fillQty,
                    fillPrice,
                    tax,
                    now
                );

                fills.push({
                    id: Number(fill.lastInsertRowid),
                    buyId: buy.id,
                    sellId: sell.id,
                    itemId,
                    qty: fillQty,
                    price: fillPrice,
                    tax,
                    at: now
                });

                this.collect(buy.playerId, itemId, fillQty, 'bought', buy.id, now);
                this.collect(buy.playerId, COINS_ID, refund, 'refund', buy.id, now);

                this.collect(
                    sell.playerId,
                    COINS_ID,
                    gross - tax,
                    'sold',
                    sell.id,
                    now
                );

                if (refund > 0) {
                    this.ledger(
                        'refund',
                        buy.playerId,
                        COINS_ID,
                        refund,
                        `offer ${buy.id}`,
                        now
                    );
                }

                if (tax > 0) {
                    this.ledger(
                        'tax',
                        sell.playerId,
                        COINS_ID,
                        tax,
                        `fill ${fill.lastInsertRowid}`,
                        now
                    );
                }

                for (const touched of [resting, incoming]) {
                    touched.filled += fillQty;
                    touched.coinsMoved += gross;
                    touched.state =
                        touched.filled >= touched.qty ? 'done' : 'open';
                    touched.updated = now;
                }

                this.statements.exUpdateOffer.run({
                    id: resting.id,
                    filled: resting.filled,
                    coins_moved: resting.coinsMoved,
                    state: resting.state,
                    updated: now
                });

                notify.push({
                    playerId: resting.playerId,
                    offerId: resting.id,
                    slot: resting.slot,
                    side: resting.side,
                    itemId,
                    qty: resting.qty,
                    filled: resting.filled,
                    price: fillPrice,
                    state: resting.state
                });
            }

            if (fills.length) {
                this.statements.exUpdateOffer.run({
                    id: incoming.id,
                    filled: incoming.filled,
                    coins_moved: incoming.coinsMoved,
                    state: incoming.state,
                    updated: now
                });
            }

            return { success: true, offer: incoming, fills, notify };
        });
    }

    cancel({ opId, playerId, slot }) {
        return this.write('cancel', opId, playerId, (now) => {
            const row = Number.isInteger(slot)
                ? this.statements.exOpenOfferBySlot.get(playerId, slot)
                : undefined;

            if (!row) {
                refuse('NOT_FOUND');
            }

            const offer = toOffer(row);
            const remaining = offer.qty - offer.filled;

            if (offer.side === 'buy') {
                this.collect(
                    playerId,
                    COINS_ID,
                    remaining * offer.price,
                    'cancel',
                    offer.id,
                    now
                );

                // a cancel inside the window the offer counted in gives the
                // unfilled part of the buy limit back
                const limit = this.statements.exGetLimit.get(
                    playerId,
                    offer.itemId
                );

                if (
                    limit &&
                    offer.created >= limit.window_start &&
                    now - limit.window_start < rules.LIMIT_WINDOW_MS
                ) {
                    this.statements.exSetLimit.run(
                        playerId,
                        offer.itemId,
                        limit.window_start,
                        Math.max(0, limit.bought - remaining)
                    );
                }
            } else {
                this.collect(
                    playerId,
                    offer.itemId,
                    remaining,
                    'cancel',
                    offer.id,
                    now
                );
            }

            offer.state = 'cancelled';
            offer.updated = now;

            this.statements.exUpdateOffer.run({
                id: offer.id,
                filled: offer.filled,
                coins_moved: offer.coinsMoved,
                state: offer.state,
                updated: now
            });

            return { success: true, offer };
        });
    }

    claim({ opId, save, playerId, claim = [] }) {
        return this.write('collect', opId, playerId, (now) => {
            if (!this.getPlayerRow(playerId)) {
                refuse('NOT_FOUND');
            }

            if (!Array.isArray(claim)) {
                refuse('NO_ITEM');
            }

            const wanted = sumPerItem(
                claim.map((entry) => {
                    const itemId = Number(entry && entry.itemId);
                    const amount = Number(entry && entry.amount);

                    if (
                        !Number.isInteger(itemId) ||
                        !rules.isPositiveInt(amount)
                    ) {
                        refuse('NO_ITEM');
                    }

                    return { itemId, amount };
                })
            );

            const rows = this.statements.exUnclaimedRows.all(playerId);
            const have = new Map();

            for (const row of rows) {
                have.set(row.item_id, (have.get(row.item_id) || 0) + row.amount);
            }

            for (const { itemId, amount } of wanted) {
                if ((have.get(itemId) || 0) < amount) {
                    refuse('NO_ITEM');
                }
            }

            for (const { itemId, amount } of wanted) {
                let left = amount;

                for (const row of rows) {
                    if (left <= 0) {
                        break;
                    }

                    if (row.item_id !== itemId) {
                        continue;
                    }

                    if (row.amount <= left) {
                        this.statements.exClaimRow.run(now, row.id);
                        left -= row.amount;
                    } else {
                        // split: the claimed part becomes its own row
                        this.statements.exSetCollectAmount.run(
                            row.amount - left,
                            row.id
                        );

                        this.statements.exInsertCollect.run(
                            playerId,
                            itemId,
                            left,
                            row.reason,
                            row.offer_id,
                            row.created,
                            now
                        );

                        left = 0;
                    }
                }
            }

            this.applySave(save, playerId);

            return { success: true, collect: this.unclaimed(playerId) };
        });
    }

    stake({ opId, username, coins, note }) {
        return this.write('stake', opId, null, (now) => {
            const player =
                typeof username === 'string'
                    ? this.statements.exGetPlayerByName.get(
                          normalizeUsername(username)
                      )
                    : undefined;

            if (!player) {
                refuse('NOT_FOUND');
            }

            if (!rules.isPositiveInt(coins)) {
                refuse('NO_COINS');
            }

            this.collect(player.id, COINS_ID, coins, 'stake', null, now);
            this.ledger('stake', player.id, COINS_ID, coins, note, now);

            return { success: true };
        });
    }

    // the game server gave up waiting for the reply to opId. If the write
    // happened, return its stored reply; otherwise store a VOID refusal for
    // opId (so the original request is a no-op if it arrives later) and put
    // any escrow the logged-out player lost into their collection box
    voidOp({ opId, playerId, refund = [] }) {
        if (typeof opId !== 'string' || !opId.length) {
            return { success: false, code: 'DOWN' };
        }

        try {
            return this.transaction(() => {
                const stored = this.storedOp(opId);

                if (stored) {
                    return { success: true, voided: false, result: stored };
                }

                const now = this.now();

                const entries = (Array.isArray(refund) ? refund : []).map(
                    (entry) => ({
                        itemId: Number(entry && entry.itemId),
                        amount: Number(entry && entry.amount)
                    })
                );

                for (const { itemId, amount } of entries) {
                    if (
                        !Number.isInteger(itemId) ||
                        !Number.isInteger(amount) ||
                        amount > rules.MAX_INT
                    ) {
                        refuse('NO_ITEM');
                    }
                }

                const owed = entries.filter((entry) => entry.amount > 0);

                if (owed.length && !this.getPlayerRow(playerId)) {
                    refuse('NOT_FOUND');
                }

                this.storeOp(
                    opId,
                    playerId,
                    'void',
                    { success: false, code: 'VOID' },
                    now
                );

                for (const { itemId, amount } of owed) {
                    this.collect(playerId, itemId, amount, 'void', null, now);
                }

                return { success: true, voided: true };
            });
        } catch (e) {
            if (e instanceof Refusal) {
                return { success: false, code: e.code };
            }

            log.error(e);
            return { success: false, code: 'DOWN' };
        }
    }

    log({ kind, playerId, itemId, amount, note }) {
        if (typeof kind !== 'string' || !kind.length) {
            return { success: false, code: 'NOT_FOUND' };
        }

        this.ledger(kind, playerId, itemId, amount, note, this.now());

        return { success: true };
    }

    // --- reads -----------------------------------------------------------

    op({ opId }) {
        const stored = typeof opId === 'string' ? this.storedOp(opId) : null;
        return stored || { unknown: true };
    }

    state({ playerId, username }) {
        const player =
            typeof username === 'string'
                ? this.statements.exGetPlayerByName.get(
                      normalizeUsername(username)
                  )
                : this.getPlayerRow(playerId);

        if (!player) {
            return { success: false, code: 'NOT_FOUND' };
        }

        return {
            success: true,
            playerId: player.id,
            offers: this.statements.exOpenOffersByPlayer
                .all(player.id)
                .map(toOffer),
            collect: this.unclaimed(player.id)
        };
    }

    book({ itemId, depth = 10 }) {
        itemId = Number(itemId);
        depth = Math.max(1, Math.min(100, Number(depth) || 10));

        return {
            success: true,
            bids: this.statements.exBids.all(itemId, depth),
            asks: this.statements.exAsks.all(itemId, depth)
        };
    }

    // the 4 h buy limit a player has left on an item at `now`
    limitLeft(playerId, itemId, stackable, now) {
        const row = this.statements.exGetLimit.get(playerId, itemId);
        const override = this.statements.exGetLimitOverride
            .pluck()
            .get(itemId);

        const limit = rules.buyLimit(!!stackable, override);

        const window = rules.limitWindow(
            row && { windowStart: row.window_start, bought: row.bought },
            now
        );

        return Math.max(0, limit - window.bought);
    }

    // itemIds: only those items (unknown ones too, empty); playerId: each item
    // also gets limitLeft, using stackable {id: bool} (default false)
    prices({ itemIds, playerId, stackable = {} } = {}) {
        const now = this.now();
        const items = {};

        const ids = Array.isArray(itemIds)
            ? [...new Set(itemIds.map(Number))].filter(Number.isInteger)
            : this.statements.exPricedItems.pluck().all();

        for (const itemId of ids) {
            const { recent, last } = this.fillsFor(itemId, now);
            const bid = this.statements.exBids.all(itemId, 1)[0];
            const ask = this.statements.exAsks.all(itemId, 1)[0];

            items[itemId] = {
                guide: rules.fillGuide(recent, last),
                bid: bid ? bid.price : 0,
                ask: ask ? ask.price : 0,
                vol24: recent.reduce((sum, fill) => sum + fill.qty, 0),
                last: last.length ? last[0].price : null
            };

            if (Number.isInteger(playerId)) {
                items[itemId].limitLeft = this.limitLeft(
                    playerId,
                    itemId,
                    stackable && stackable[itemId],
                    now
                );
            }
        }

        return { success: true, at: now, items };
    }

    history({ itemId, hours = 24 }) {
        hours = Number(hours);

        if (!(hours > 0)) {
            hours = 24;
        }

        const since = this.now() - hours * rules.HOUR_MS;

        return {
            success: true,
            fills: this.statements.exRecentFills.all(Number(itemId), since)
        };
    }

    ledgerTotals({ since = 0 }) {
        const byKind = {};

        for (const row of this.statements.exLedgerByKind.all(
            Number(since) || 0
        )) {
            byKind[row.kind] = row.amount;
        }

        return { success: true, byKind };
    }
}

module.exports = { EXCHANGE_STATEMENTS, ExchangeStore, Refusal };
