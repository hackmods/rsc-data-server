// Wilderness clans and the PvP record (src/pvp/store.js). Every reply carries
// the request's token, like the Grand Exchange handlers.

const log = require('bole')('pvp');

function reply(client, message, method) {
    let body;

    try {
        body = client.server.queryHandler.pvp[method](message);
    } catch (e) {
        log.error(e);
        body = { success: false, code: 'DOWN' };
    }

    client.socket.sendMessage({ token: message.token, ...body });
}

async function pvpRecord(message) {
    reply(this, message, 'record');
}

async function pvpEvents(message) {
    reply(this, message, 'events');
}

async function pvpHiscores(message) {
    reply(this, message, 'hiscores');
}

async function clanLoad(message) {
    reply(this, message, 'clans');
}

async function clanSave(message) {
    reply(this, message, 'saveClan');
}

async function clanDelete(message) {
    reply(this, message, 'deleteClan');
}

async function clanBattleSave(message) {
    reply(this, message, 'saveBattle');
}

async function clanBattles(message) {
    reply(this, message, 'battles');
}

module.exports = {
    pvpRecord,
    pvpEvents,
    pvpHiscores,
    clanLoad,
    clanSave,
    clanDelete,
    clanBattleSave,
    clanBattles
};
