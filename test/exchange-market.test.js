// Read-only market data: tape, candles, movers, index rows.

const assert = require('assert');
const test = require('node:test');
const Database = require('better-sqlite3');
const QueryHandler = require('../src/query-handler');
const handlers = require('../src/handlers');
const rules = require('../src/exchange/rules');

const COINS = 10;
const FIRE = 31;
const ARROWS = 11;
const T0 = 1700000000000 - (1700000000000 % rules.HOUR_MS);

function makeExchange() {
    const queryHandler = new QueryHandler(new Database(':memory:'));
    queryHandler.sync();

    const clock = { now: T0 };
    queryHandler.exchange.now = () => clock.now;

    const sent = [];
    const client = {
        server: { queryHandler },
        socket: { sendMessage: (message) => sent.push(message) }
    };

    let token = 0;

    async function call(handler, body = {}) {
        token += 1;
        await handlers[handler].call(client, { handler, token, ...body });
        const message = sent.pop();
        delete message.token;
        return message;
    }

    function addPlayer(username, inventory) {
        queryHandler.insertPlayer({ username, password: 'x', ip: '1.1.1.1' });
        const save = queryHandler.getPlayer(username);
        delete save.username;
        delete save.loginDate;
        delete save.loginIP;
        save.inventory = inventory;
        queryHandler.updatePlayer(JSON.parse(JSON.stringify(save)));
        return save;
    }

    let op = 0;

    async function place(player, side, itemId, qty, price) {
        op += 1;
        return call('exchangePlace', {
            opId: `${side}-${op}`,
            save: {
                ...player,
                inventory: [{ id: COINS, amount: side === 'buy' ? 1000000 : 1 }]
            },
            offer: {
                playerId: player.id,
                username: player.username,
                side,
                itemId,
                qty,
                price,
                basePrice: 4,
                stackable: true
            }
        });
    }

    return { addPlayer, call, clock, place, queryHandler };
}

// Fills (time, item, qty, price, seller):
//   T0+10m FIRE 20 @6 house   T0+20m FIRE 10 @8 house (repriced listing)
//   T0+70m FIRE 5 @5 player   T0+80m ARROWS 30 @2 house
async function scenario() {
    const ex = makeExchange();
    const buyer = ex.addPlayer('buyer', [{ id: COINS, amount: 1000000 }]);
    const seller = ex.addPlayer('seller', [{ id: FIRE, amount: 100 }]);

    await ex.call('exchangeHouse', {
        opId: 'h1',
        username: 'Zezima',
        listings: [
            { itemId: FIRE, qty: 100, price: 6 },
            { itemId: ARROWS, qty: 100, price: 2 }
        ]
    });

    ex.clock.now = T0 + 10 * 60000;
    await ex.place(buyer, 'buy', FIRE, 20, 6);

    ex.clock.now = T0 + 20 * 60000;
    await ex.call('exchangeHouse', {
        opId: 'h2',
        username: 'Zezima',
        listings: [
            { itemId: FIRE, qty: 100, price: 8 },
            { itemId: ARROWS, qty: 100, price: 2 }
        ]
    });
    await ex.place(buyer, 'buy', FIRE, 10, 8);

    ex.clock.now = T0 + 70 * 60000;
    await ex.place(seller, 'sell', FIRE, 5, 5);
    await ex.place(buyer, 'buy', FIRE, 5, 5);

    ex.clock.now = T0 + 80 * 60000;
    await ex.place(buyer, 'buy', ARROWS, 30, 2);

    ex.clock.now = T0 + 90 * 60000;
    return ex;
}

test('tape: newest first, house flag from the seller slot, limit and since', async () => {
    const ex = await scenario();
    const tape = await ex.call('exchangeTape', {});

    assert.strictEqual(tape.success, true);
    assert.deepStrictEqual(
        tape.fills.map((f) => [f.itemId, f.qty, f.price, f.house]),
        [
            [ARROWS, 30, 2, true],
            [FIRE, 5, 5, false],
            [FIRE, 10, 8, true],
            [FIRE, 20, 6, true]
        ]
    );
    assert.ok(tape.fills[0].at > tape.fills[1].at);
    assert.ok(tape.fills.every((f) => f.id > 0 && !('username' in f)));

    const two = await ex.call('exchangeTape', { limit: 2 });
    assert.strictEqual(two.fills.length, 2);

    const recent = await ex.call('exchangeTape', { since: T0 + 60 * 60000 });
    assert.strictEqual(recent.fills.length, 2);

    const huge = await ex.call('exchangeTape', { limit: 99999 });
    assert.strictEqual(huge.fills.length, 4);
});

test('candles: OHLC and volume per bucket, empty buckets left out', async () => {
    const ex = await scenario();
    const reply = await ex.call('exchangeCandles', {
        itemId: FIRE,
        bucketMs: rules.HOUR_MS,
        hours: 24
    });

    assert.strictEqual(reply.bucketMs, rules.HOUR_MS);
    assert.deepStrictEqual(reply.candles, [
        { t: T0, open: 6, high: 8, low: 6, close: 8, volume: 30, trades: 2 },
        {
            t: T0 + rules.HOUR_MS,
            open: 5,
            high: 5,
            low: 5,
            close: 5,
            volume: 5,
            trades: 1
        }
    ]);

    const half = await ex.call('exchangeCandles', {
        itemId: FIRE,
        bucketMs: 30 * 60000
    });
    assert.deepStrictEqual(
        half.candles.map((c) => c.t),
        [T0, T0 + 60 * 60000]
    );

    const none = await ex.call('exchangeCandles', { itemId: 999 });
    assert.deepStrictEqual(none.candles, []);

    // a bucket under a minute is raised to a minute
    const tiny = await ex.call('exchangeCandles', { itemId: FIRE, bucketMs: 5 });
    assert.strictEqual(tiny.bucketMs, 60000);
});

test('movers: change, volume and house share per traded item', async () => {
    const ex = await scenario();
    const reply = await ex.call('exchangeMovers', { hours: 24 });
    const byId = Object.fromEntries(reply.items.map((i) => [i.itemId, i]));

    assert.strictEqual(reply.items.length, 2);
    assert.deepStrictEqual(byId[FIRE], {
        itemId: FIRE,
        open: 6,
        last: 5,
        change: (5 - 6) / 6,
        volume: 35,
        trades: 3,
        houseShare: 30 / 35
    });
    assert.strictEqual(byId[ARROWS].change, 0);
    assert.strictEqual(byId[ARROWS].houseShare, 1);

    // only the last 30 minutes: the ARROWS trade at T0+80m
    ex.clock.now = T0 + 105 * 60000;
    const narrow = await ex.call('exchangeMovers', { hours: 0.5 });
    assert.deepStrictEqual(
        narrow.items.map((i) => i.itemId),
        [ARROWS]
    );
});

test('index rows: quantity and coins per bucket and item', async () => {
    const ex = await scenario();
    const reply = await ex.call('exchangeIndexRows', {
        hours: 24,
        bucketMs: rules.HOUR_MS
    });

    assert.strictEqual(reply.bucketMs, rules.HOUR_MS);
    assert.deepStrictEqual(reply.rows, [
        { t: T0, itemId: FIRE, qty: 30, notional: 20 * 6 + 10 * 8 },
        { t: T0 + rules.HOUR_MS, itemId: ARROWS, qty: 30, notional: 60 },
        { t: T0 + rules.HOUR_MS, itemId: FIRE, qty: 5, notional: 25 }
    ]);
});

test('market reads write nothing', async () => {
    const ex = await scenario();
    const count = () =>
        ex.queryHandler.database
            .prepare('SELECT COUNT(*) AS n FROM exchange_ops')
            .get().n;
    const before = count();

    await ex.call('exchangeTape', {});
    await ex.call('exchangeCandles', { itemId: FIRE });
    await ex.call('exchangeMovers', {});
    await ex.call('exchangeIndexRows', {});

    assert.strictEqual(count(), before);
});

test('tape: account names only when asked (the fleet market watch; never on the public route)', async () => {
    const ex = await scenario();
    const plain = await ex.call('exchangeTape', {});
    assert.ok(plain.fills.every((f) => !('buyer' in f) && !('seller' in f)));
    const named = await ex.call('exchangeTape', { accounts: true });
    const own = named.fills.find((f) => !f.house);
    assert.deepStrictEqual([own.buyer, own.seller], ['buyer', 'seller']);
    assert.strictEqual(named.fills.find((f) => f.house).seller, 'zezima');
});
