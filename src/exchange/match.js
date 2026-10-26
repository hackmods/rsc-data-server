// Grand Exchange matching: a pure function, no database.
//
// book: the open offers on the other side for the offer's item, each
//   { id, playerId, side, price, qty, filled, created }
// offer: the incoming offer { playerId, side, price, qty, filled = 0 }
//
// An incoming buy at P takes resting sells priced <= P, cheapest first, then
// oldest; an incoming sell at P takes resting buys priced >= P, highest first,
// then oldest. Every fill is at the resting offer's price. The placer's own
// resting offers are never matched.
//
// returns { fills: [{ restingId, qty, price }], remaining }

function remainderOf(offer) {
    return offer.qty - (offer.filled || 0);
}

function compareResting(side) {
    return (a, b) => {
        if (a.price !== b.price) {
            // buyer takes the cheapest sell; seller takes the highest bid
            return side === 'buy' ? a.price - b.price : b.price - a.price;
        }

        if (a.created !== b.created) {
            return a.created - b.created;
        }

        return a.id - b.id;
    };
}

function crosses(side, price, resting) {
    return side === 'buy' ? resting.price <= price : resting.price >= price;
}

function matchOffer(book, offer) {
    const opposite = offer.side === 'buy' ? 'sell' : 'buy';
    let remaining = remainderOf(offer);

    const candidates = book
        .filter(
            (resting) =>
                resting.side === opposite &&
                resting.playerId !== offer.playerId &&
                remainderOf(resting) > 0 &&
                crosses(offer.side, offer.price, resting)
        )
        .sort(compareResting(offer.side));

    const fills = [];

    for (const resting of candidates) {
        if (remaining <= 0) {
            break;
        }

        const qty = Math.min(remaining, remainderOf(resting));

        fills.push({ restingId: resting.id, qty, price: resting.price });
        remaining -= qty;
    }

    return { fills, remaining };
}

module.exports = { matchOffer };
