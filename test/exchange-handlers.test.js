const assert = require('assert');
const test = require('node:test');
const Database = require('better-sqlite3');
const QueryHandler = require('../src/query-handler');
const handlers = require('../src/handlers');
const rules = require('../src/exchange/rules');

const COINS = 10;
const COAL = 155;
const IRON = 151;
const LOBSTER = 373;

// a data server against an in-memory database built from the real
// create-tables.sql, a fake socket and a controllable clock
function makeExchange() {
    const queryHandler = new QueryHandler(new Database(':memory:'));
    queryHandler.sync();

    const clock = { now: 1700000000000 };
    queryHandler.exchange.now = () => clock.now;

    const sent = [];
    const client = {
        server: { queryHandler },
        socket: { sendMessage: (message) => sent.push(message) }
    };

    let token = 0;
    let op = 0;

    async function call(handler, body = {}) {
        token += 1;
        await handlers[handler].call(client, { handler, token, ...body });
        const message = sent.pop();
        assert.strictEqual(message.token, token, `${handler} replies token`);
        delete message.token;
        return message;
    }

    function opId() {
        op += 1;
        return `op-${op}`;
    }

    function getPlayer(username) {
        return queryHandler.getPlayer(username);
    }

    // a save object as Player.save() sends it
    function saveOf(username, change) {
        const player = getPlayer(username);
        delete player.username;
        delete player.loginDate;
        delete player.loginIP;

        if (change) {
            change(player);
        }

        return player;
    }

    function addPlayer(username, inventory = []) {
        queryHandler.insertPlayer({ username, password: 'x', ip: '1.1.1.1' });
        const save = saveOf(username, (player) => {
            player.inventory = inventory;
        });
        queryHandler.updatePlayer(JSON.parse(JSON.stringify(save)));
        return save.id;
    }

    function count(username, itemId) {
        const player = getPlayer(username);
        return player.inventory
            .concat(player.bank)
            .filter((item) => item.id === itemId)
            .reduce((sum, item) => sum + item.amount, 0);
    }

    // the save after the game server took `amount` of `itemId` out
    function withRemoved(username, itemId, amount) {
        return saveOf(username, (player) => {
            const entry = player.inventory.find((item) => item.id === itemId);
            assert.ok(entry && entry.amount >= amount, 'test holds the escrow');
            entry.amount -= amount;
            player.inventory = player.inventory.filter((item) => item.amount);
        });
    }

    function withAdded(username, items) {
        return saveOf(username, (player) => {
            for (const { itemId, amount } of items) {
                const entry = player.inventory.find(
                    (item) => item.id === itemId
                );

                if (entry) {
                    entry.amount += amount;
                } else {
                    player.inventory.push({ id: itemId, amount });
                }
            }
        });
    }

    // place an offer the way the game server does: take the escrow out of
    // the save, send it, keep it on success
    async function place(username, side, itemId, qty, price, extra = {}) {
        const playerId = getPlayer(username).id;
        const save =
            side === 'buy'
                ? withRemoved(username, COINS, qty * price)
                : withRemoved(username, itemId, qty);

        return call('exchangePlace', {
            opId: extra.opId || opId(),
            save,
            offer: {
                playerId,
                username,
                side,
                itemId,
                qty,
                price,
                basePrice: extra.basePrice || 100,
                stackable: !!extra.stackable
            }
        });
    }

    function db() {
        return queryHandler.database;
    }

    return {
        addPlayer,
        call,
        clock,
        count,
        db,
        getPlayer,
        opId,
        place,
        queryHandler,
        saveOf,
        withAdded,
        withRemoved
    };
}

function boxOf(reply) {
    const box = {};

    for (const { itemId, amount } of reply.collect) {
        box[itemId] = amount;
    }

    return box;
}

test('playerUpdate still saves through the shared helper', async () => {
    const ex = makeExchange();
    ex.addPlayer('alice', [{ id: COINS, amount: 5 }]);

    const save = ex.saveOf('alice', (player) => {
        player.inventory = [{ id: COINS, amount: 99 }];
        player.soundOn = false;
        player.x = 200;
    });

    const reply = await ex.call('playerUpdate', save);
    assert.deepStrictEqual(reply, { success: true });

    const player = ex.getPlayer('alice');
    assert.deepStrictEqual(player.inventory, [{ id: COINS, amount: 99 }]);
    assert.strictEqual(player.soundOn, 0);
    assert.strictEqual(player.x, 200);
});

test('price-time priority: cheapest sell first, then oldest', async () => {
    const ex = makeExchange();
    ex.addPlayer('a', [{ id: COAL, amount: 10 }]);
    ex.addPlayer('b', [{ id: COAL, amount: 10 }]);
    ex.addPlayer('c', [{ id: COAL, amount: 10 }]);
    ex.addPlayer('d', [{ id: COINS, amount: 10000 }]);

    const a = await ex.place('a', 'sell', COAL, 1, 100);
    ex.clock.now += 1;
    const b = await ex.place('b', 'sell', COAL, 1, 95);
    ex.clock.now += 1;
    const c = await ex.place('c', 'sell', COAL, 1, 95);

    const order = [];

    for (let i = 0; i < 3; i += 1) {
        ex.clock.now += 1;
        const reply = await ex.place('d', 'buy', COAL, 1, 100);
        assert.strictEqual(reply.success, true);
        assert.strictEqual(reply.fills.length, 1);
        order.push(reply.fills[0].sellId);
    }

    assert.deepStrictEqual(order, [b.offer.id, c.offer.id, a.offer.id]);
});

test('partial fills across several resting offers, buyer refund, notify', async () => {
    const ex = makeExchange();
    const aId = ex.addPlayer('a', [{ id: COAL, amount: 10 }]);
    const bId = ex.addPlayer('b', [{ id: COAL, amount: 10 }]);
    const dId = ex.addPlayer('d', [{ id: COINS, amount: 5000 }]);

    const a = await ex.place('a', 'sell', COAL, 10, 100);
    const b = await ex.place('b', 'sell', COAL, 10, 101);
    assert.strictEqual(a.offer.slot, 0);
    assert.deepStrictEqual(a.fills, []);

    const d = await ex.place('d', 'buy', COAL, 15, 105);
    assert.strictEqual(d.success, true);
    assert.strictEqual(ex.count('d', COINS), 5000 - 15 * 105);

    assert.deepStrictEqual(
        d.fills.map(({ sellId, qty, price, tax }) => ({ sellId, qty, price, tax })),
        [
            { sellId: a.offer.id, qty: 10, price: 100, tax: 20 },
            { sellId: b.offer.id, qty: 5, price: 101, tax: 10 }
        ]
    );

    assert.strictEqual(d.offer.state, 'done');
    assert.strictEqual(d.offer.filled, 15);
    assert.strictEqual(d.offer.coinsMoved, 10 * 100 + 5 * 101);

    assert.deepStrictEqual(d.notify, [
        {
            playerId: aId,
            offerId: a.offer.id,
            slot: 0,
            side: 'sell',
            itemId: COAL,
            qty: 10,
            filled: 10,
            price: 100,
            state: 'done'
        },
        {
            playerId: bId,
            offerId: b.offer.id,
            slot: 0,
            side: 'sell',
            itemId: COAL,
            qty: 10,
            filled: 5,
            price: 101,
            state: 'open'
        }
    ]);

    // buyer: 15 coal plus the refund 10 * 5 + 5 * 4
    const dState = await ex.call('exchangeState', { playerId: dId });
    assert.deepStrictEqual(boxOf(dState), { [COAL]: 15, [COINS]: 70 });
    assert.deepStrictEqual(dState.offers, []);

    // sellers: proceeds less tax
    const aState = await ex.call('exchangeState', { username: 'A' });
    assert.strictEqual(aState.playerId, aId);
    assert.deepStrictEqual(boxOf(aState), { [COINS]: 1000 - 20 });

    const bState = await ex.call('exchangeState', { playerId: bId });
    assert.deepStrictEqual(boxOf(bState), { [COINS]: 505 - 10 });
    assert.strictEqual(bState.offers.length, 1);
    assert.strictEqual(bState.offers[0].filled, 5);
    assert.strictEqual(bState.offers[0].coinsMoved, 505);
});

test('a resting buy fills an incoming sell at the bid, with no refund', async () => {
    const ex = makeExchange();
    const buyerId = ex.addPlayer('buyer', [{ id: COINS, amount: 2000 }]);
    const sellerId = ex.addPlayer('seller', [{ id: COAL, amount: 5 }]);

    await ex.place('buyer', 'buy', COAL, 5, 120);
    const sell = await ex.place('seller', 'sell', COAL, 5, 90);

    assert.strictEqual(sell.fills.length, 1);
    assert.strictEqual(sell.fills[0].price, 120);
    assert.strictEqual(sell.offer.coinsMoved, 600);

    const buyerBox = boxOf(await ex.call('exchangeState', { playerId: buyerId }));
    assert.deepStrictEqual(buyerBox, { [COAL]: 5 });

    const sellerBox = boxOf(await ex.call('exchangeState', { playerId: sellerId }));
    assert.deepStrictEqual(sellerBox, { [COINS]: 600 - 12 });
});

test('tax: 2% rounded down, fills under 50 gp each exempt, ledgered', async () => {
    const ex = makeExchange();
    ex.addPlayer('s', [
        { id: COAL, amount: 100 },
        { id: IRON, amount: 100 }
    ]);
    ex.addPlayer('b', [{ id: COINS, amount: 100000 }]);

    await ex.place('s', 'sell', COAL, 3, 75, { basePrice: 75 });
    const taxed = await ex.place('b', 'buy', COAL, 3, 75, { basePrice: 75 });
    assert.strictEqual(taxed.fills[0].tax, 4);

    await ex.place('s', 'sell', IRON, 100, 49, { basePrice: 49 });
    const exempt = await ex.place('b', 'buy', IRON, 100, 49, { basePrice: 49 });
    assert.strictEqual(exempt.fills[0].tax, 0);

    const ledger = await ex.call('exchangeLedger', {});
    assert.deepStrictEqual(ledger, { success: true, byKind: { tax: 4 } });

    const later = await ex.call('exchangeLedger', { since: ex.clock.now + 1 });
    assert.deepStrictEqual(later.byKind, {});
});

test('cancel: the unfilled remainder goes to the collection box', async () => {
    const ex = makeExchange();
    const buyerId = ex.addPlayer('buyer', [{ id: COINS, amount: 2000 }]);
    const sellerId = ex.addPlayer('seller', [{ id: COAL, amount: 20 }]);

    const buy = await ex.place('buyer', 'buy', COAL, 10, 100);
    await ex.place('seller', 'sell', COAL, 3, 100);

    const cancelBuy = await ex.call('exchangeCancel', {
        opId: ex.opId(),
        playerId: buyerId,
        slot: buy.offer.slot
    });

    assert.strictEqual(cancelBuy.success, true);
    assert.strictEqual(cancelBuy.offer.state, 'cancelled');
    assert.strictEqual(cancelBuy.offer.filled, 3);

    const buyerBox = boxOf(await ex.call('exchangeState', { playerId: buyerId }));
    assert.deepStrictEqual(buyerBox, { [COAL]: 3, [COINS]: 700 });

    const sell = await ex.place('seller', 'sell', COAL, 17, 100);
    assert.strictEqual(sell.offer.slot, 0);

    const cancelSell = await ex.call('exchangeCancel', {
        opId: ex.opId(),
        playerId: sellerId,
        slot: 0
    });
    assert.strictEqual(cancelSell.offer.state, 'cancelled');

    const sellerState = await ex.call('exchangeState', { playerId: sellerId });
    assert.deepStrictEqual(sellerState.offers, []);
    assert.strictEqual(boxOf(sellerState)[COAL], 17);

    const again = await ex.call('exchangeCancel', {
        opId: ex.opId(),
        playerId: sellerId,
        slot: 0
    });
    assert.deepStrictEqual(again, { success: false, code: 'NOT_FOUND' });
});

test('buy limit: per item per 4 h window, cancel gives the unfilled part back', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('b', [{ id: COINS, amount: 10000000 }]);

    const first = await ex.place('b', 'buy', COAL, 600, 100);
    assert.strictEqual(first.success, true);

    const over = await ex.place('b', 'buy', COAL, 500, 100);
    assert.deepStrictEqual(over, { success: false, code: 'LIMIT' });
    assert.strictEqual(ex.count('b', COINS), 10000000 - 600 * 100);

    const prices = await ex.call('exchangePrices', {
        itemIds: [COAL],
        playerId: id
    });
    assert.strictEqual(prices.items[COAL].limitLeft, 400);

    await ex.call('exchangeCancel', { opId: ex.opId(), playerId: id, slot: 0 });

    const fits = await ex.place('b', 'buy', COAL, 1000, 100);
    assert.strictEqual(fits.success, true);

    const full = await ex.place('b', 'buy', COAL, 1, 100);
    assert.strictEqual(full.code, 'LIMIT');

    // other items have their own limit; stackable items 25000
    const lobsters = await ex.place('b', 'buy', LOBSTER, 1000, 100);
    assert.strictEqual(lobsters.success, true);
    const runes = await ex.place('b', 'buy', 33, 25000, 10, {
        basePrice: 10,
        stackable: true
    });
    assert.strictEqual(runes.success, true);

    // a new window once 4 h are over
    ex.clock.now += rules.LIMIT_WINDOW_MS;
    const nextWindow = await ex.place('b', 'buy', COAL, 1000, 100);
    assert.strictEqual(nextWindow.success, true);

    // overrides
    ex.db()
        .prepare(
            'INSERT INTO exchange_limit_overrides (item_id, buy_limit) VALUES (?, ?)'
        )
        .run(IRON, 5);
    assert.strictEqual(
        (await ex.place('b', 'buy', IRON, 6, 100)).code,
        'LIMIT'
    );
});

test('collect: claims oldest first, splits rows, double claim refused', async () => {
    const ex = makeExchange();
    const buyerId = ex.addPlayer('buyer', [{ id: COINS, amount: 10000 }]);
    ex.addPlayer('s1', [{ id: COAL, amount: 10 }]);
    ex.addPlayer('s2', [{ id: COAL, amount: 10 }]);

    await ex.place('s1', 'sell', COAL, 4, 100);
    await ex.place('s2', 'sell', COAL, 6, 100);
    await ex.place('buyer', 'buy', COAL, 10, 100);

    const claimFive = [{ itemId: COAL, amount: 5 }];
    const reply = await ex.call('exchangeCollect', {
        opId: ex.opId(),
        save: ex.withAdded('buyer', claimFive),
        playerId: buyerId,
        claim: claimFive
    });

    assert.deepStrictEqual(reply, {
        success: true,
        collect: [{ itemId: COAL, amount: 5 }]
    });
    assert.strictEqual(ex.count('buyer', COAL), 5);

    const rows = ex
        .db()
        .prepare(
            'SELECT amount, claimed_at FROM exchange_collect WHERE player_id = ? ORDER BY id'
        )
        .all(buyerId);
    assert.deepStrictEqual(
        rows.map((row) => [row.amount, row.claimed_at !== null]),
        [
            [4, true],
            [5, false],
            [1, true]
        ]
    );

    const claimRest = [{ itemId: COAL, amount: 5 }];
    const rest = await ex.call('exchangeCollect', {
        opId: ex.opId(),
        save: ex.withAdded('buyer', claimRest),
        playerId: buyerId,
        claim: claimRest
    });
    assert.deepStrictEqual(rest.collect, []);
    assert.strictEqual(ex.count('buyer', COAL), 10);

    // the same claim again with a new opId: refused, the player row untouched
    const before = ex.getPlayer('buyer');
    const double = await ex.call('exchangeCollect', {
        opId: ex.opId(),
        save: ex.withAdded('buyer', claimRest),
        playerId: buyerId,
        claim: claimRest
    });
    assert.deepStrictEqual(double, { success: false, code: 'NO_ITEM' });
    assert.deepStrictEqual(ex.getPlayer('buyer'), before);
});

test('opId replay returns the stored reply and does nothing else', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('s', [{ id: COAL, amount: 10 }]);

    const save = ex.withRemoved('s', COAL, 5);
    const request = {
        opId: 'uuid-1',
        save,
        offer: {
            playerId: id,
            username: 's',
            side: 'sell',
            itemId: COAL,
            qty: 5,
            price: 100,
            basePrice: 100
        }
    };

    const first = await ex.call('exchangePlace', JSON.parse(JSON.stringify(request)));
    ex.clock.now += 5000;
    const second = await ex.call('exchangePlace', JSON.parse(JSON.stringify(request)));
    assert.deepStrictEqual(second, first);

    const offers = ex.db().prepare('SELECT * FROM exchange_offers').all();
    assert.strictEqual(offers.length, 1);

    assert.deepStrictEqual(await ex.call('exchangeOp', { opId: 'uuid-1' }), first);
    assert.deepStrictEqual(await ex.call('exchangeOp', { opId: 'nope' }), {
        unknown: true
    });

    // a refusal is stored too, so the lookup after a timeout answers
    const refused = await ex.call('exchangeCancel', {
        opId: 'uuid-2',
        playerId: id,
        slot: 5
    });
    assert.deepStrictEqual(refused, { success: false, code: 'NOT_FOUND' });
    assert.deepStrictEqual(await ex.call('exchangeOp', { opId: 'uuid-2' }), refused);

    // a stake replay pays once
    const stake = { opId: 'uuid-3', username: 's', coins: 5000, note: 'merchant' };
    await ex.call('exchangeStake', stake);
    await ex.call('exchangeStake', stake);
    const state = await ex.call('exchangeState', { playerId: id });
    assert.deepStrictEqual(boxOf(state), { [COINS]: 5000 });
    assert.deepStrictEqual((await ex.call('exchangeLedger', {})).byKind, {
        stake: 5000
    });
});

test('refused writes change nothing, not even the player row', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('p', [
        { id: COAL, amount: 100 },
        { id: COINS, amount: 100000 }
    ]);
    ex.addPlayer('q', [{ id: COAL, amount: 100 }]);

    async function refusedWith(code, side, itemId, qty, price, extra) {
        const before = ex.getPlayer('p');
        const counts = ex
            .db()
            .prepare(
                'SELECT (SELECT COUNT(1) FROM exchange_offers) o, ' +
                    '(SELECT COUNT(1) FROM exchange_limits) l, ' +
                    '(SELECT COUNT(1) FROM exchange_collect) c'
            )
            .get();

        const reply = await ex.place('p', side, itemId, qty, price, extra);
        assert.deepStrictEqual(reply, { success: false, code });
        assert.deepStrictEqual(ex.getPlayer('p'), before);
        assert.deepStrictEqual(
            ex
                .db()
                .prepare(
                    'SELECT (SELECT COUNT(1) FROM exchange_offers) o, ' +
                        '(SELECT COUNT(1) FROM exchange_limits) l, ' +
                        '(SELECT COUNT(1) FROM exchange_collect) c'
                )
                .get(),
            counts
        );
    }

    // band: base 100 means 5..1000
    await refusedWith('PRICE_BAND', 'sell', COAL, 1, 4);
    await refusedWith('PRICE_BAND', 'buy', COAL, 1, 1001);
    assert.strictEqual((await ex.place('p', 'sell', COAL, 1, 5)).success, true);

    // coins are not listable
    const coins = await ex.call('exchangePlace', {
        opId: ex.opId(),
        save: ex.saveOf('p'),
        offer: { playerId: id, side: 'sell', itemId: COINS, qty: 1, price: 1 }
    });
    assert.deepStrictEqual(coins, { success: false, code: 'UNTRADEABLE' });

    // a save for another player is refused
    const wrong = await ex.call('exchangePlace', {
        opId: ex.opId(),
        save: ex.saveOf('q'),
        offer: { playerId: id, side: 'sell', itemId: COAL, qty: 1, price: 100, basePrice: 100 }
    });
    assert.deepStrictEqual(wrong, { success: false, code: 'NOT_FOUND' });

    // a buy limit refusal leaves the limit row as it was
    await ex.place('p', 'buy', IRON, 1000, 10, { basePrice: 10 });
    await refusedWith('LIMIT', 'buy', IRON, 1, 10, { basePrice: 10 });

    // slots: 8 open offers, then SLOTS (2 are open already)
    for (let i = 0; i < 6; i += 1) {
        const reply = await ex.place('p', 'sell', COAL, 1, 900);
        assert.strictEqual(reply.offer.slot, i + 2);
    }

    await refusedWith('SLOTS', 'sell', COAL, 1, 900);

    // a cancelled slot is the lowest free one again
    await ex.call('exchangeCancel', { opId: ex.opId(), playerId: id, slot: 3 });
    assert.strictEqual((await ex.place('p', 'sell', COAL, 1, 900)).offer.slot, 3);
});

test("a player's own resting offers are never matched", async () => {
    const ex = makeExchange();
    ex.addPlayer('p', [
        { id: COAL, amount: 10 },
        { id: COINS, amount: 10000 }
    ]);

    await ex.place('p', 'sell', COAL, 10, 100);
    const buy = await ex.place('p', 'buy', COAL, 10, 200);
    assert.deepStrictEqual(buy.fills, []);
    assert.strictEqual(buy.offer.state, 'open');

    const book = await ex.call('exchangeBook', { itemId: COAL });
    assert.deepStrictEqual(book, {
        success: true,
        bids: [{ price: 200, qty: 10 }],
        asks: [{ price: 100, qty: 10 }]
    });
});

test('guide price moves the band once the item trades', async () => {
    const ex = makeExchange();
    ex.addPlayer('s', [{ id: COAL, amount: 100 }]);
    ex.addPlayer('b', [{ id: COINS, amount: 1000000 }]);

    for (let i = 0; i < 3; i += 1) {
        await ex.place('s', 'sell', COAL, 1, 1000);
        await ex.place('b', 'buy', COAL, 1, 1000);
    }

    // base 100 would refuse 5000, the guide (1000) allows it
    const high = await ex.place('s', 'sell', COAL, 1, 5000, { basePrice: 100 });
    assert.strictEqual(high.success, true);
    const low = await ex.place('s', 'sell', COAL, 1, 49, { basePrice: 100 });
    assert.strictEqual(low.code, 'PRICE_BAND');
});

test('book, prices, history and ledger reads', async () => {
    const ex = makeExchange();
    const sId = ex.addPlayer('s', [{ id: COAL, amount: 100 }]);
    ex.addPlayer('b', [{ id: COINS, amount: 100000 }]);

    await ex.place('s', 'sell', COAL, 10, 120);
    await ex.place('s', 'sell', COAL, 5, 120);
    await ex.place('s', 'sell', COAL, 5, 130);
    await ex.place('b', 'buy', COAL, 4, 110);
    await ex.place('b', 'buy', COAL, 3, 100);

    const book = await ex.call('exchangeBook', { itemId: COAL, depth: 1 });
    assert.deepStrictEqual(book, {
        success: true,
        bids: [{ price: 110, qty: 4 }],
        asks: [{ price: 120, qty: 15 }]
    });

    let prices = await ex.call('exchangePrices', {});
    assert.strictEqual(prices.at, ex.clock.now);
    assert.deepStrictEqual(prices.items, {
        [COAL]: { guide: null, bid: 110, ask: 120, vol24: 0, last: null }
    });

    await ex.place('b', 'buy', COAL, 12, 125);
    ex.clock.now += 2 * rules.HOUR_MS;

    prices = await ex.call('exchangePrices', {});
    assert.deepStrictEqual(prices.items[COAL], {
        guide: 120,
        bid: 110,
        ask: 120,
        vol24: 12,
        last: 120
    });

    // filtered: unknown items too, and limitLeft for a player
    const filtered = await ex.call('exchangePrices', {
        itemIds: [COAL, LOBSTER, 33],
        playerId: sId,
        stackable: { 33: true }
    });
    assert.deepStrictEqual(Object.keys(filtered.items).map(Number).sort((a, b) => a - b), [
        33,
        COAL,
        LOBSTER
    ]);
    assert.deepStrictEqual(filtered.items[LOBSTER], {
        guide: null,
        bid: 0,
        ask: 0,
        vol24: 0,
        last: null,
        limitLeft: 1000
    });
    assert.strictEqual(filtered.items[33].limitLeft, 25000);
    assert.strictEqual(filtered.items[COAL].guide, 120);

    const history = await ex.call('exchangeHistory', { itemId: COAL });
    assert.deepStrictEqual(
        history.fills.map(({ qty, price }) => [qty, price]),
        [
            [10, 120],
            [2, 120]
        ]
    );
    const recent = await ex.call('exchangeHistory', { itemId: COAL, hours: 1 });
    assert.deepStrictEqual(recent.fills, []);

    const logged = await ex.call('exchangeLog', {
        kind: 'taint_trade',
        playerId: sId,
        itemId: COINS,
        amount: 500,
        note: 'to b'
    });
    assert.deepStrictEqual(logged, { success: true });

    const ledger = await ex.call('exchangeLedger', {});
    assert.deepStrictEqual(ledger.byKind, {
        refund: 12 * 5,
        tax: 24 + 4,
        taint_trade: 500
    });

    const missing = await ex.call('exchangeStake', {
        opId: ex.opId(),
        username: 'nobody',
        coins: 5000
    });
    assert.deepStrictEqual(missing, { success: false, code: 'NOT_FOUND' });

    const unknownState = await ex.call('exchangeState', { username: 'nobody' });
    assert.deepStrictEqual(unknownState, { success: false, code: 'NOT_FOUND' });
});

test('exchangeVoid before the original: the original becomes a VOID no-op', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('s', [{ id: COAL, amount: 10 }]);

    const voided = await ex.call('exchangeVoid', {
        opId: 'late-1',
        playerId: id,
        refund: []
    });
    assert.deepStrictEqual(voided, { success: true, voided: true });

    const before = ex.getPlayer('s');
    const late = await ex.call('exchangePlace', {
        opId: 'late-1',
        save: ex.withRemoved('s', COAL, 5),
        offer: { playerId: id, side: 'sell', itemId: COAL, qty: 5, price: 100, basePrice: 100 }
    });
    assert.deepStrictEqual(late, { success: false, code: 'VOID' });
    assert.deepStrictEqual(ex.getPlayer('s'), before);
    assert.strictEqual(
        ex.db().prepare('SELECT COUNT(1) FROM exchange_offers').pluck().get(),
        0
    );
    assert.deepStrictEqual(await ex.call('exchangeOp', { opId: 'late-1' }), {
        success: false,
        code: 'VOID'
    });

    // voiding again changes nothing and reports the stored VOID
    const again = await ex.call('exchangeVoid', {
        opId: 'late-1',
        playerId: id,
        refund: [{ itemId: COAL, amount: 5 }]
    });
    assert.deepStrictEqual(again, {
        success: true,
        voided: false,
        result: { success: false, code: 'VOID' }
    });
    assert.deepStrictEqual((await ex.call('exchangeState', { playerId: id })).collect, []);
});

test('exchangeVoid after the original returns the stored result', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('s', [{ id: COAL, amount: 10 }]);

    const placed = await ex.place('s', 'sell', COAL, 5, 100, { opId: 'done-1' });
    assert.strictEqual(placed.success, true);

    const voided = await ex.call('exchangeVoid', {
        opId: 'done-1',
        playerId: id,
        refund: [{ itemId: COAL, amount: 5 }]
    });
    assert.deepStrictEqual(voided, { success: true, voided: false, result: placed });

    const state = await ex.call('exchangeState', { playerId: id });
    assert.strictEqual(state.offers.length, 1);
    assert.deepStrictEqual(state.collect, []);
});

test('exchangeVoid with a refund puts the escrow in the collection box', async () => {
    const ex = makeExchange();
    const id = ex.addPlayer('s', [{ id: COAL, amount: 10 }]);

    const voided = await ex.call('exchangeVoid', {
        opId: 'gone-1',
        playerId: id,
        refund: [
            { itemId: COAL, amount: 5 },
            { itemId: COINS, amount: 0 },
            { itemId: COINS, amount: 300 }
        ]
    });
    assert.deepStrictEqual(voided, { success: true, voided: true });

    const rows = ex
        .db()
        .prepare('SELECT item_id, amount, reason FROM exchange_collect ORDER BY id')
        .all();
    assert.deepStrictEqual(rows, [
        { item_id: COAL, amount: 5, reason: 'void' },
        { item_id: COINS, amount: 300, reason: 'void' }
    ]);

    const state = await ex.call('exchangeState', { playerId: id });
    assert.deepStrictEqual(boxOf(state), { [COAL]: 5, [COINS]: 300 });
});

// a small seeded PRNG so a failure reproduces
function prng(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('conservation: random place/cancel/collect streams keep every item total', async () => {
    const ex = makeExchange();
    const random = prng(20261025);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const between = (min, max) => min + Math.floor(random() * (max - min + 1));

    const items = { [COAL]: 100, [IRON]: 60, [LOBSTER]: 150 };
    const itemIds = Object.keys(items).map(Number);
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const ids = {};

    for (const name of names) {
        ids[name] = ex.addPlayer(name, [
            { id: COINS, amount: 200000 },
            { id: COAL, amount: 300 },
            { id: IRON, amount: 300 },
            { id: LOBSTER, amount: 300 }
        ]);
    }

    function totals() {
        const sum = {};
        const add = (itemId, amount) => {
            sum[itemId] = (sum[itemId] || 0) + amount;
        };

        for (const name of names) {
            const player = ex.getPlayer(name);

            for (const item of player.inventory.concat(player.bank)) {
                add(item.id, item.amount);
            }
        }

        const open = ex
            .db()
            .prepare("SELECT * FROM exchange_offers WHERE state = 'open'")
            .all();

        for (const offer of open) {
            const remaining = offer.qty - offer.filled;

            if (offer.side === 'buy') {
                add(COINS, remaining * offer.price);
            } else {
                add(offer.item_id, remaining);
            }
        }

        const unclaimed = ex
            .db()
            .prepare(
                'SELECT item_id, amount FROM exchange_collect WHERE claimed_at IS NULL'
            )
            .all();

        for (const row of unclaimed) {
            add(row.item_id, row.amount);
        }

        return sum;
    }

    const ledgered = async () => {
        const { byKind } = await ex.call('exchangeLedger', {});
        return { tax: byKind.tax || 0, stake: byKind.stake || 0 };
    };

    const start = totals();
    const history = [];
    const counts = { place: 0, filled: 0, cancel: 0, collect: 0, refused: 0, replay: 0 };

    for (let step = 0; step < 400; step += 1) {
        ex.clock.now += between(1, 120000);
        const name = pick(names);
        const player = ex.getPlayer(name);
        const roll = random();
        let request;
        let handler;

        if (roll < 0.55) {
            const itemId = pick(itemIds);
            const side = random() < 0.5 ? 'buy' : 'sell';
            const price = Math.max(1, Math.round(items[itemId] * (0.8 + random() * 0.4)));
            const held = player.inventory
                .filter((item) => item.id === (side === 'buy' ? COINS : itemId))
                .reduce((sum, item) => sum + item.amount, 0);
            const qty = side === 'buy'
                ? Math.min(between(1, 60), Math.floor(held / price))
                : Math.min(between(1, 60), held);

            if (qty < 1) {
                continue;
            }

            handler = 'exchangePlace';
            request = {
                opId: ex.opId(),
                save:
                    side === 'buy'
                        ? ex.withRemoved(name, COINS, qty * price)
                        : ex.withRemoved(name, itemId, qty),
                offer: {
                    playerId: ids[name],
                    username: name,
                    side,
                    itemId,
                    qty,
                    price,
                    basePrice: items[itemId],
                    stackable: false
                }
            };
        } else if (roll < 0.7) {
            handler = 'exchangeCancel';
            request = { opId: ex.opId(), playerId: ids[name], slot: between(0, 7) };
        } else if (roll < 0.9) {
            const state = await ex.call('exchangeState', { playerId: ids[name] });
            const claim = state.collect
                .filter(() => random() < 0.7)
                .map(({ itemId, amount }) => ({
                    itemId,
                    // sometimes too much: must be refused
                    amount: random() < 0.1 ? amount + 1 : between(1, amount)
                }));

            if (!claim.length) {
                continue;
            }

            handler = 'exchangeCollect';
            request = {
                opId: ex.opId(),
                save: ex.withAdded(name, claim),
                playerId: ids[name],
                claim
            };
        } else if (roll < 0.95 && history.length) {
            // replay an earlier write: same reply, nothing changes
            const before = totals();
            const old = pick(history);
            const reply = await ex.call(old.handler, JSON.parse(JSON.stringify(old.request)));
            assert.deepStrictEqual(reply, old.reply);
            assert.deepStrictEqual(totals(), before);
            counts.replay += 1;
            continue;
        } else {
            handler = 'exchangeStake';
            request = { opId: ex.opId(), username: name, coins: between(1, 500), note: 'test' };
        }

        const beforeRow = ex.getPlayer(name);
        const reply = await ex.call(handler, JSON.parse(JSON.stringify(request)));
        history.push({ handler, request, reply });

        if (!reply.success) {
            counts.refused += 1;
            assert.deepStrictEqual(ex.getPlayer(name), beforeRow, `${handler} refused changed the row`);
        } else if (handler === 'exchangePlace') {
            counts.place += 1;
            counts.filled += reply.fills.length;
        } else if (handler === 'exchangeCancel') {
            counts.cancel += 1;
        } else if (handler === 'exchangeCollect') {
            counts.collect += 1;
        }

        const { tax, stake } = await ledgered();
        const now = totals();

        for (const itemId of itemIds) {
            assert.strictEqual(now[itemId], start[itemId], `item ${itemId} at step ${step}`);
        }

        assert.strictEqual(now[COINS], start[COINS] - tax + stake, `coins at step ${step}`);
    }

    // the stream really exercised the book
    assert.ok(counts.place > 100, JSON.stringify(counts));
    assert.ok(counts.filled > 30, JSON.stringify(counts));
    assert.ok(counts.cancel > 5, JSON.stringify(counts));
    assert.ok(counts.collect > 20, JSON.stringify(counts));
    assert.ok(counts.refused > 5, JSON.stringify(counts));
    assert.ok(counts.replay > 5, JSON.stringify(counts));
    assert.ok((await ledgered()).tax > 0);
});
