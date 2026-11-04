// ARSC Iron Man mode: players.iron_man and hc_ironman_death persist through
// playerUpdate/getPlayer, and an older database gains the columns on sync.

const assert = require('assert');
const test = require('node:test');
const Database = require('better-sqlite3');
const QueryHandler = require('../src/query-handler');
const { savePlayer } = require('../src/player-save');

function fresh(database = new Database(':memory:')) {
    const queryHandler = new QueryHandler(database);
    queryHandler.sync();
    return queryHandler;
}

function insert(queryHandler, username) {
    queryHandler.insertPlayer({ username, password: 'x', ip: '127.0.0.1' });
    return queryHandler.getPlayer(username);
}

// what the game server sends: its getSaveMessage shape
function saveOf(player, changes) {
    const { username, loginDate, loginIP, ...save } = player;
    return { handler: 'playerUpdate', token: 1, ...save, ...changes };
}

test('a new player is not an Iron Man', () => {
    const queryHandler = fresh();
    const player = insert(queryHandler, 'newbie');

    assert.strictEqual(player.ironMan, 0);
    assert.strictEqual(player.hcIronmanDeath, 0);
});

test('the mode and the HC death mark round-trip through a save', () => {
    const queryHandler = fresh();
    const player = insert(queryHandler, 'ferrum');

    savePlayer(queryHandler, saveOf(player, { ironMan: 3 }));
    assert.strictEqual(queryHandler.getPlayer('ferrum').ironMan, 3);

    savePlayer(queryHandler, saveOf(player, { ironMan: 1, hcIronmanDeath: 1 }));
    const after = queryHandler.getPlayer('ferrum');
    assert.strictEqual(after.ironMan, 1);
    assert.strictEqual(after.hcIronmanDeath, 1);
});

test('a save without the Iron Man fields stores 0 (older game server)', () => {
    const queryHandler = fresh();
    const player = insert(queryHandler, 'oldsave');
    const save = saveOf(player, {});

    delete save.ironMan;
    delete save.hcIronmanDeath;

    savePlayer(queryHandler, save);
    assert.strictEqual(queryHandler.getPlayer('oldsave').ironMan, 0);
});

test('sync adds the columns to a database made before them', () => {
    const database = new Database(':memory:');
    database.exec(
        'CREATE TABLE `players` (`id` integer not null primary key ' +
            "autoincrement, `username` varchar(12), `password` char(60), `creation_ip` varchar(45), `world` integer default '0')"
    );
    database.exec("INSERT INTO `players` (`username`) VALUES ('veteran')");

    // the rest of create-tables.sql fails on the stripped table's missing
    // columns only when it reads them; migrate alone is what is under test
    const queryHandler = new QueryHandler(database);
    queryHandler.migrate();

    const columns = database
        .prepare('PRAGMA table_info(`players`)')
        .all()
        .map((column) => column.name);

    assert.ok(columns.includes('iron_man'));
    assert.ok(columns.includes('hc_ironman_death'));
    assert.strictEqual(
        database.prepare("SELECT `iron_man` FROM `players` WHERE `username` = 'veteran'").pluck().get(),
        0
    );

    // running it again changes nothing
    queryHandler.migrate();
});
