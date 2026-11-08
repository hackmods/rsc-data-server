const assert = require('assert');
const test = require('node:test');
const Database = require('better-sqlite3');
const QueryHandler = require('../src/query-handler');
const handlers = require('../src/handlers');

// a data server on an in-memory database built from the real create-tables.sql
function makeServer() {
    const queryHandler = new QueryHandler(new Database(':memory:'));
    queryHandler.sync();

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
        assert.strictEqual(message.token, token, `${handler} replies token`);
        delete message.token;
        return message;
    }

    function addPlayer(username, pvp) {
        queryHandler.insertPlayer({ username, password: 'x', ip: '1.1.1.1' });
        const player = queryHandler.getPlayer(username);
        delete player.username;
        delete player.loginDate;
        delete player.loginIP;
        player.cache = pvp ? { pvp } : {};
        queryHandler.updatePlayer(JSON.parse(JSON.stringify(player)));
    }

    return { call, addPlayer, queryHandler };
}

test('pvpRecord stores a kill and pvpEvents lists it newest first', async () => {
    const { call } = makeServer();

    const first = await call('pvpRecord', {
        event: {
            at: 1000,
            killer: 'crow talon',
            victim: 'fang rook',
            killerClan: 'CROW',
            victimClan: 'FANG',
            wildLevel: 7,
            x: 191,
            y: 408,
            style: 'melee',
            assists: ['crow hex'],
            lootValue: 1200,
            victimSkulled: true
        }
    });

    assert.strictEqual(first.success, true);

    await call('pvpRecord', { event: { at: 2000, killer: 'fang ember', victim: 'crow talon' } });

    const list = await call('pvpEvents', { since: 0 });
    assert.strictEqual(list.total, 2);
    assert.deepStrictEqual(
        list.events.map((e) => e.killer),
        ['fang ember', 'crow talon']
    );
    assert.deepStrictEqual(list.events[1].assists, ['crow hex']);
    assert.strictEqual(list.events[1].victimSkulled, true);
    assert.strictEqual(list.events[1].wildLevel, 7);

    const newer = await call('pvpEvents', { since: first.id });
    assert.deepStrictEqual(newer.events.map((e) => e.killer), ['fang ember']);
});

test('pvpHiscores ranks the counters kept in players.cache.pvp', async () => {
    const { call, addPlayer } = makeServer();

    addPlayer('alpha', { kills: 5, deaths: 1, bestStreak: 4, deepest: 30, loot: 900 });
    addPlayer('bravo', { kills: 9, deaths: 9, bestStreak: 2, deepest: 50 });
    addPlayer('charlie', { kills: 0, deaths: 3 });
    addPlayer('delta');

    const kills = await call('pvpHiscores', { board: 'kills' });
    assert.deepStrictEqual(kills.rows.map((r) => r.username), ['bravo', 'alpha']);
    assert.strictEqual(kills.rows[0].rank, 1);

    const kd = await call('pvpHiscores', { board: 'kd' });
    assert.deepStrictEqual(kd.rows.map((r) => r.username), ['alpha', 'bravo']);
    assert.strictEqual(kd.rows[0].kd, 5);

    const streak = await call('pvpHiscores', { board: 'streak' });
    assert.deepStrictEqual(streak.rows.map((r) => r.username), ['alpha', 'bravo']);

    const deaths = await call('pvpHiscores', { board: 'deaths' });
    assert.deepStrictEqual(deaths.rows.map((r) => r.username), ['bravo', 'charlie', 'alpha']);

    const bad = await call('pvpHiscores', { board: 'nope' });
    assert.strictEqual(bad.success, false);
});

test('clans save, load with kill totals, and delete', async () => {
    const { call } = makeServer();

    const saved = await call('clanSave', {
        clan: {
            tag: 'FANG',
            name: 'Crimson Fang',
            leader: 'fang rook',
            members: [{ username: 'fang rook', rank: 'leader', joined: 1 }]
        }
    });
    assert.strictEqual(saved.success, true);

    await call('clanSave', { clan: { tag: 'CROW', name: 'Ashen Crows', leader: 'crow talon' } });
    assert.strictEqual((await call('clanSave', { clan: { tag: 'bad tag', name: 'x' } })).success, false);

    await call('pvpRecord', { event: { killer: 'crow talon', victim: 'fang rook', killerClan: 'CROW', victimClan: 'FANG' } });

    // an update keeps the row
    await call('clanSave', {
        clan: { tag: 'FANG', name: 'Crimson Fang', leader: 'fang rook', battlesWon: 2, members: [] }
    });

    const loaded = await call('clanLoad');
    const fang = loaded.clans.find((c) => c.tag === 'FANG');
    const crow = loaded.clans.find((c) => c.tag === 'CROW');
    assert.strictEqual(loaded.clans.length, 2);
    assert.strictEqual(fang.battlesWon, 2);
    assert.strictEqual(fang.deaths, 1);
    assert.strictEqual(crow.kills, 1);

    await call('clanDelete', { tag: 'CROW' });
    assert.strictEqual((await call('clanLoad')).clans.length, 1);
});

test('clan battles insert, update and list open ones with the clans', async () => {
    const { call } = makeServer();

    const created = await call('clanBattleSave', {
        battle: { challenger: 'FANG', defender: 'CROW', front: 'edgeville', created: 5 }
    });
    assert.ok(created.id);

    let loaded = await call('clanLoad');
    assert.strictEqual(loaded.battles.length, 1);
    assert.strictEqual(loaded.battles[0].status, 'challenged');

    await call('clanBattleSave', {
        battle: {
            id: created.id,
            challenger: 'FANG',
            defender: 'CROW',
            front: 'edgeville',
            status: 'done',
            killsChallenger: 3,
            killsDefender: 1,
            winner: 'FANG'
        }
    });

    loaded = await call('clanLoad');
    assert.strictEqual(loaded.battles.length, 0);

    const recent = await call('clanBattles');
    assert.strictEqual(recent.battles[0].winner, 'FANG');
    assert.strictEqual(recent.battles[0].killsChallenger, 3);
});
