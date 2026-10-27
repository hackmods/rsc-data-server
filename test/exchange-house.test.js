// The house account (store.house): standing sell offers topped up to a
// quantity, seeded and ledgered, outside the 8 player slots and the band.

const assert = require('assert');
const test = require('node:test');
const Database = require('better-sqlite3');
const QueryHandler = require('../src/query-handler');
const handlers = require('../src/handlers');
const rules = require('../src/exchange/rules');

const COINS = 10;
const FIRE = 31;
const ARROWS = 11;

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

    return { addPlayer, call, clock, queryHandler };
}

const listings = [
    { itemId: FIRE, qty: 1000, price: 6 },
    { itemId: ARROWS, qty: 1000, price: 2 }
];

test('house: creates the account, lists past 8 slots, seeds and ledgers', async () => {
    const ex = makeExchange();

    const many = [];

    for (let id = 100; id < 120; id += 1) {
        many.push({ itemId: id, qty: 5, price: 50 });
    }

    const reply = await ex.call('exchangeHouse', {
        opId: 'house-1',
        username: 'Zezima',
        listings: [...listings, ...many],
        note: 'hourly'
    });

    assert.strictEqual(reply.success, true);
    assert.strictEqual(reply.listed, 22);
    assert.strictEqual(reply.seeded, 2100);

    const state = await ex.call('exchangeState', { username: 'Zezima' });
    assert.strictEqual(state.offers.length, 22);
    assert.ok(state.offers.every((o) => o.slot >= rules.HOUSE_SLOT_BASE));

    const seeds = ex.queryHandler.database
        .prepare("SELECT SUM(amount) AS n FROM economy_ledger WHERE kind = 'seed'")
        .get();
    assert.strictEqual(seeds.n, 2100);

    // the account exists but nobody knows its password
    const row = ex.queryHandler.database
        .prepare("SELECT password FROM players WHERE username = 'zezima'")
        .get();
    assert.ok(/^\$2[aby]\$/.test(row.password), 'a real bcrypt hash');
});

test('house: a rerun tops up to the target and reprices, never doubles', async () => {
    const ex = makeExchange();
    const buyer = ex.addPlayer('buyer', [{ id: COINS, amount: 100000 }]);

    await ex.call('exchangeHouse', { opId: 'h1', username: 'Zezima', listings });

    const buy = await ex.call('exchangePlace', {
        opId: 'b1',
        save: { ...buyer, inventory: [{ id: COINS, amount: 100000 - 300 * 6 }] },
        offer: {
            playerId: buyer.id,
            username: 'buyer',
            side: 'buy',
            itemId: FIRE,
            qty: 300,
            price: 6,
            basePrice: 4,
            stackable: true
        }
    });
    assert.strictEqual(buy.fills.length, 1);
    assert.strictEqual(buy.fills[0].qty, 300);

    ex.clock.now += rules.HOUR_MS;

    const again = await ex.call('exchangeHouse', {
        opId: 'h2',
        username: 'Zezima',
        listings: [
            { itemId: FIRE, qty: 1000, price: 7 },
            { itemId: ARROWS, qty: 1000, price: 2 }
        ]
    });

    assert.strictEqual(again.seeded, 300, 'only what sold is restocked');

    const state = await ex.call('exchangeState', { username: 'Zezima' });
    const fire = state.offers.find((o) => o.itemId === FIRE);
    assert.strictEqual(fire.qty - fire.filled, 1000);
    assert.strictEqual(fire.price, 7);
    assert.strictEqual(state.offers.length, 2);

    // the same opId runs once
    const replay = await ex.call('exchangeHouse', { opId: 'h2', username: 'Zezima', listings });
    assert.strictEqual(replay.seeded, 300);
    const seeds = ex.queryHandler.database
        .prepare("SELECT SUM(amount) AS n FROM economy_ledger WHERE kind = 'seed'")
        .get();
    assert.strictEqual(seeds.n, 2300);
});

test('house: a listing under a resting bid fills it at the bid', async () => {
    const ex = makeExchange();
    const buyer = ex.addPlayer('buyer', [{ id: COINS, amount: 1000 }]);

    await ex.call('exchangePlace', {
        opId: 'b1',
        save: { ...buyer, inventory: [{ id: COINS, amount: 1000 - 10 * 8 }] },
        offer: {
            playerId: buyer.id,
            username: 'buyer',
            side: 'buy',
            itemId: FIRE,
            qty: 10,
            price: 8,
            basePrice: 4,
            stackable: true
        }
    });

    const reply = await ex.call('exchangeHouse', { opId: 'h1', username: 'Zezima', listings });
    assert.strictEqual(reply.fills.length, 1);
    assert.strictEqual(reply.fills[0].price, 8);
    assert.strictEqual(reply.notify[0].playerId, buyer.id);
});

test('house: bad listings are refused and change nothing', async () => {
    const ex = makeExchange();

    for (const bad of [
        [{ itemId: COINS, qty: 1, price: 1 }],
        [{ itemId: FIRE, qty: 0, price: 1 }],
        [{ itemId: FIRE, qty: 1, price: -1 }]
    ]) {
        const reply = await ex.call('exchangeHouse', {
            opId: `bad-${JSON.stringify(bad)}`,
            username: 'Zezima',
            listings: [...listings, ...bad]
        });
        assert.strictEqual(reply.success, false);
    }

    const state = await ex.call('exchangeState', { username: 'Zezima' });
    assert.strictEqual(state.success, false, 'not even the account was made');
});
