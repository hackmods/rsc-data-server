const assert = require('assert');
const test = require('node:test');
const { matchOffer } = require('../src/exchange/match');
const rules = require('../src/exchange/rules');

let nextId = 1;

function resting(side, playerId, price, qty, created, filled = 0) {
    return { id: nextId++, playerId, side, price, qty, filled, created };
}

test('incoming buy takes the cheapest sell first, then the oldest', () => {
    const a = resting('sell', 1, 100, 1, 10);
    const b = resting('sell', 2, 95, 1, 30);
    const c = resting('sell', 3, 95, 1, 20);
    const tooDear = resting('sell', 4, 101, 5, 1);

    const { fills, remaining } = matchOffer([a, b, c, tooDear], {
        playerId: 9,
        side: 'buy',
        price: 100,
        qty: 5
    });

    assert.deepStrictEqual(
        fills.map((fill) => fill.restingId),
        [c.id, b.id, a.id]
    );
    assert.deepStrictEqual(
        fills.map((fill) => fill.price),
        [95, 95, 100]
    );
    assert.strictEqual(remaining, 2);
});

test('incoming sell takes the highest bid first, then the oldest', () => {
    const low = resting('buy', 1, 90, 5, 1);
    const highOld = resting('buy', 2, 120, 2, 5);
    const highNew = resting('buy', 3, 120, 2, 6);
    const under = resting('buy', 4, 79, 50, 0);

    const { fills, remaining } = matchOffer([low, highNew, under, highOld], {
        playerId: 9,
        side: 'sell',
        price: 80,
        qty: 6
    });

    assert.deepStrictEqual(fills, [
        { restingId: highOld.id, qty: 2, price: 120 },
        { restingId: highNew.id, qty: 2, price: 120 },
        { restingId: low.id, qty: 2, price: 90 }
    ]);
    assert.strictEqual(remaining, 0);
});

test('partial fills across resting offers use their remainders', () => {
    const a = resting('sell', 1, 100, 10, 1, 7); // 3 left
    const b = resting('sell', 2, 101, 10, 2);

    const { fills, remaining } = matchOffer([a, b], {
        playerId: 9,
        side: 'buy',
        price: 105,
        qty: 8
    });

    assert.deepStrictEqual(fills, [
        { restingId: a.id, qty: 3, price: 100 },
        { restingId: b.id, qty: 5, price: 101 }
    ]);
    assert.strictEqual(remaining, 0);
});

test("the placer's own resting offers are never matched", () => {
    const own = resting('sell', 9, 50, 10, 1);
    const other = resting('sell', 2, 60, 10, 2);

    const { fills, remaining } = matchOffer([own, other], {
        playerId: 9,
        side: 'buy',
        price: 100,
        qty: 15
    });

    assert.deepStrictEqual(fills, [
        { restingId: other.id, qty: 10, price: 60 }
    ]);
    assert.strictEqual(remaining, 5);
});

test('same-side offers and non-crossing prices are ignored', () => {
    const bid = resting('buy', 2, 200, 10, 1);
    const ask = resting('sell', 3, 150, 10, 1);

    assert.deepStrictEqual(
        matchOffer([bid, ask], {
            playerId: 9,
            side: 'buy',
            price: 149,
            qty: 1
        }),
        { fills: [], remaining: 1 }
    );
});

test('tax is 2% of the fill rounded down, fills under 50 gp each exempt', () => {
    assert.strictEqual(rules.fillTax(15, 100), 30);
    assert.strictEqual(rules.fillTax(1, 50), 1);
    assert.strictEqual(rules.fillTax(1, 99), 1);
    assert.strictEqual(rules.fillTax(3, 75), 4); // 4.5
    assert.strictEqual(rules.fillTax(1000, 49), 0);
    assert.strictEqual(rules.fillTax(1, 1), 0);
});

test('guide: volume-weighted median, fallbacks to last fills and base price', () => {
    const fills = [
        { qty: 1, price: 10 },
        { qty: 1, price: 20 },
        { qty: 10, price: 30 }
    ];

    assert.strictEqual(rules.weightedMedian(fills), 30);
    assert.strictEqual(
        rules.weightedMedian([
            { qty: 5, price: 10 },
            { qty: 5, price: 20 }
        ]),
        10
    );
    assert.strictEqual(rules.weightedMedian([]), null);

    // 3+ recent fills: recent only
    assert.strictEqual(rules.fillGuide(fills, [{ qty: 99, price: 1 }]), 30);
    // fewer than 3 recent: the last 20 of any age
    assert.strictEqual(
        rules.fillGuide([{ qty: 1, price: 500 }], [{ qty: 9, price: 7 }]),
        7
    );
    assert.strictEqual(rules.fillGuide([], []), null);
    assert.strictEqual(rules.bandGuide([], [], 40), 40);
    assert.strictEqual(rules.bandGuide([], [], 0), 1);
    assert.strictEqual(rules.bandGuide([], [], undefined), 1);
});

test('price band is [5%, 1000%] of the guide', () => {
    assert.ok(rules.inBand(5, 100));
    assert.ok(!rules.inBand(4, 100));
    assert.ok(rules.inBand(1000, 100));
    assert.ok(!rules.inBand(1001, 100));
    assert.ok(rules.inBand(1, 1));
    assert.ok(rules.inBand(10, 1));
    assert.ok(!rules.inBand(11, 1));
});

test('buy limits and their 4 h window', () => {
    assert.strictEqual(rules.buyLimit(false), 1000);
    assert.strictEqual(rules.buyLimit(true), 25000);
    assert.strictEqual(rules.buyLimit(true, 50), 50);

    const now = 10 * rules.HOUR_MS;
    assert.deepStrictEqual(rules.limitWindow(undefined, now), {
        windowStart: now,
        bought: 0
    });
    assert.deepStrictEqual(
        rules.limitWindow({ windowStart: now - 1000, bought: 7 }, now),
        { windowStart: now - 1000, bought: 7 }
    );
    assert.deepStrictEqual(
        rules.limitWindow(
            { windowStart: now - rules.LIMIT_WINDOW_MS, bought: 7 },
            now
        ),
        { windowStart: now, bought: 0 }
    );
});

test('free slot is the lowest one no open offer holds', () => {
    assert.strictEqual(rules.freeSlot([]), 0);
    assert.strictEqual(rules.freeSlot([0, 1, 3]), 2);
    assert.strictEqual(rules.freeSlot([0, 1, 2, 3, 4, 5, 6, 7]), -1);
});
