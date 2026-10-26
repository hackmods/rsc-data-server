// Grand Exchange rules as pure functions (no database). The contract is
// docs/GRAND_EXCHANGE.md in hackmods/Autonomous-RSC.

const COINS_ID = 10;
const SLOTS = 8;
const MAX_INT = 2147483647;

const HOUR_MS = 1000 * 60 * 60;
const GUIDE_WINDOW_MS = 24 * HOUR_MS;
const GUIDE_MIN_RECENT = 3;
const GUIDE_FALLBACK_FILLS = 20;

const LIMIT_WINDOW_MS = 4 * HOUR_MS;
const DEFAULT_BUY_LIMIT = 1000;
const STACKABLE_BUY_LIMIT = 25000;

// price band, percent of the guide
const BAND_MIN_PERCENT = 5;
const BAND_MAX_PERCENT = 1000;

const TAX_MIN_PRICE = 50;
const TAX_PERCENT = 2;

// refusal codes shared with the game server and the bots
const CODES = [
    'FAR',
    'BARRED',
    'SLOTS',
    'NO_ITEM',
    'NO_COINS',
    'UNTRADEABLE',
    'PRICE_BAND',
    'LIMIT',
    'BUSY',
    'INV_FULL',
    'NOT_FOUND',
    'DOWN',
    'SHUTDOWN',
    'VOID'
];

function isPositiveInt(n) {
    return Number.isInteger(n) && n > 0 && n <= MAX_INT;
}

// 2% of the fill's gross, rounded down; fills priced under 50 gp each are
// exempt
function fillTax(qty, price) {
    if (price < TAX_MIN_PRICE) {
        return 0;
    }

    return Math.floor((qty * price * TAX_PERCENT) / 100);
}

// the price at which half the traded quantity is reached, cheapest first
function weightedMedian(fills) {
    const sorted = fills
        .filter((fill) => fill.qty > 0)
        .sort((a, b) => a.price - b.price);

    const total = sorted.reduce((sum, fill) => sum + fill.qty, 0);

    if (!total) {
        return null;
    }

    let seen = 0;

    for (const fill of sorted) {
        seen += fill.qty;

        if (seen * 2 >= total) {
            return fill.price;
        }
    }

    return sorted[sorted.length - 1].price;
}

// guide price from fills only: recentFills are the last 24 h, lastFills the
// last 20 of any age. null when the item never traded
function fillGuide(recentFills, lastFills) {
    if (recentFills.length >= GUIDE_MIN_RECENT) {
        return weightedMedian(recentFills);
    }

    return weightedMedian(lastFills);
}

// the guide the price band uses: fills, else the item's base price (min 1)
function bandGuide(recentFills, lastFills, basePrice) {
    const guide = fillGuide(recentFills, lastFills);

    if (guide !== null) {
        return guide;
    }

    return Math.max(1, Math.floor(Number(basePrice) || 0));
}

function inBand(price, guide) {
    return (
        price * 100 >= guide * BAND_MIN_PERCENT &&
        price * 100 <= guide * BAND_MAX_PERCENT
    );
}

function buyLimit(stackable, override) {
    if (Number.isInteger(override) && override > 0) {
        return override;
    }

    return stackable ? STACKABLE_BUY_LIMIT : DEFAULT_BUY_LIMIT;
}

// the 4 h window a buy placed at `now` counts in: the stored one while it
// lasts, else a new one starting now
function limitWindow(row, now) {
    if (!row || now - row.windowStart >= LIMIT_WINDOW_MS) {
        return { windowStart: now, bought: 0 };
    }

    return { windowStart: row.windowStart, bought: row.bought };
}

// the lowest slot that no open offer holds, or -1
function freeSlot(openSlots) {
    const taken = new Set(openSlots);

    for (let slot = 0; slot < SLOTS; slot += 1) {
        if (!taken.has(slot)) {
            return slot;
        }
    }

    return -1;
}

module.exports = {
    BAND_MAX_PERCENT,
    BAND_MIN_PERCENT,
    CODES,
    COINS_ID,
    DEFAULT_BUY_LIMIT,
    GUIDE_FALLBACK_FILLS,
    GUIDE_WINDOW_MS,
    HOUR_MS,
    LIMIT_WINDOW_MS,
    MAX_INT,
    SLOTS,
    STACKABLE_BUY_LIMIT,
    bandGuide,
    buyLimit,
    fillGuide,
    fillTax,
    freeSlot,
    inBand,
    isPositiveInt,
    limitWindow,
    weightedMedian
};
