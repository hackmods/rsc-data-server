// Grand Exchange handlers. Every write is one database transaction with an
// opId (src/exchange/store.js); every reply carries the request's token.
// Contract: docs/GRAND_EXCHANGE.md in hackmods/Autonomous-RSC.

const log = require('bole')('exchange');

// run store[method](message) and reply; an unexpected error replies DOWN
// (writes already store their own DOWN in exchange_ops)
function reply(client, message, method) {
    let body;

    try {
        body = client.server.queryHandler.exchange[method](message);
    } catch (e) {
        log.error(e);
        body = { success: false, code: 'DOWN' };
    }

    client.socket.sendMessage({ token: message.token, ...body });
}

async function exchangePlace(message) {
    reply(this, message, 'place');
}

async function exchangeCancel(message) {
    reply(this, message, 'cancel');
}

async function exchangeCollect(message) {
    reply(this, message, 'claim');
}

async function exchangeOp(message) {
    reply(this, message, 'op');
}

async function exchangeVoid(message) {
    reply(this, message, 'voidOp');
}

async function exchangeState(message) {
    reply(this, message, 'state');
}

async function exchangeBook(message) {
    reply(this, message, 'book');
}

async function exchangePrices(message) {
    reply(this, message, 'prices');
}

async function exchangeHistory(message) {
    reply(this, message, 'history');
}

async function exchangeLedger(message) {
    reply(this, message, 'ledgerTotals');
}

async function exchangeStake(message) {
    reply(this, message, 'stake');
}

async function exchangeLog(message) {
    reply(this, message, 'log');
}

module.exports = {
    exchangePlace,
    exchangeCancel,
    exchangeCollect,
    exchangeOp,
    exchangeVoid,
    exchangeState,
    exchangeBook,
    exchangePrices,
    exchangeHistory,
    exchangeLedger,
    exchangeStake,
    exchangeLog
};
