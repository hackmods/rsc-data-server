// Wilderness clans and the PvP record (ARSC): the kill log, the clans and their
// battles. Per-player counters are in players.cache.pvp (the game server keeps
// them on the Player and saves them with the rest of the cache), so the
// personal boards read them with json_extract. Statements are prepared in
// QueryHandler.init() (PVP_STATEMENTS below).

const BOARDS = {
    kills: '$.pvp.kills',
    deaths: '$.pvp.deaths',
    assists: '$.pvp.assists',
    streak: '$.pvp.bestStreak',
    damage: '$.pvp.damage',
    deepest: '$.pvp.deepest',
    loot: '$.pvp.loot'
};

const MAX_ROWS = 100;

const PVP_STATEMENTS = {
    pvpInsertEvent:
        'INSERT INTO `pvp_events` (`at`, `killer_id`, `killer`, `victim_id`, ' +
        '`victim`, `killer_clan`, `victim_clan`, `wild_level`, `x`, `y`, ' +
        '`style`, `assists`, `loot_value`, `victim_skulled`, `battle_id`) ' +
        'VALUES (:at, :killer_id, :killer, :victim_id, :victim, :killer_clan, ' +
        ':victim_clan, :wild_level, :x, :y, :style, :assists, :loot_value, ' +
        ':victim_skulled, :battle_id)',
    pvpEventsSince:
        'SELECT * FROM `pvp_events` WHERE `id` > ? ORDER BY `id` DESC LIMIT ?',
    pvpEventCount: 'SELECT COUNT(1) FROM `pvp_events`',
    pvpClanKills:
        'SELECT `killer_clan` AS `tag`, COUNT(1) AS `kills` FROM `pvp_events` ' +
        'WHERE `killer_clan` IS NOT NULL GROUP BY `killer_clan`',
    pvpClanDeaths:
        'SELECT `victim_clan` AS `tag`, COUNT(1) AS `deaths` FROM `pvp_events` ' +
        'WHERE `victim_clan` IS NOT NULL GROUP BY `victim_clan`',
    pvpPlayersWithStats:
        "SELECT `username`, json_extract(`cache`, '$.pvp') AS `pvp` FROM " +
        "`players` WHERE json_extract(`cache`, '$.pvp') IS NOT NULL",
    clanAll: 'SELECT * FROM `clans` ORDER BY `created`',
    clanUpsert:
        'INSERT INTO `clans` (`tag`, `name`, `leader`, `motto`, `colour`, ' +
        '`created`, `battles_won`, `battles_lost`, `members`) VALUES (:tag, ' +
        ':name, :leader, :motto, :colour, :created, :battles_won, ' +
        ':battles_lost, :members) ON CONFLICT(`tag`) DO UPDATE SET ' +
        '`name` = :name, `leader` = :leader, `motto` = :motto, `colour` = ' +
        ':colour, `battles_won` = :battles_won, `battles_lost` = ' +
        ':battles_lost, `members` = :members',
    clanDelete: 'DELETE FROM `clans` WHERE `tag` = ?',
    battleInsert:
        'INSERT INTO `clan_battles` (`challenger`, `defender`, `front`, ' +
        '`created`, `starts_at`, `ends_at`, `status`, `kills_challenger`, ' +
        '`kills_defender`, `winner`) VALUES (:challenger, :defender, :front, ' +
        ':created, :starts_at, :ends_at, :status, :kills_challenger, ' +
        ':kills_defender, :winner)',
    battleUpdate:
        'UPDATE `clan_battles` SET `front` = :front, `starts_at` = :starts_at, ' +
        '`ends_at` = :ends_at, `status` = :status, `kills_challenger` = ' +
        ':kills_challenger, `kills_defender` = :kills_defender, `winner` = ' +
        ':winner WHERE `id` = :id',
    battleOpen:
        "SELECT * FROM `clan_battles` WHERE `status` IN ('challenged', " +
        "'scheduled', 'live') ORDER BY `id`",
    battleRecent: 'SELECT * FROM `clan_battles` ORDER BY `id` DESC LIMIT ?'
};

function toEvent(row) {
    let assists = [];

    try {
        assists = JSON.parse(row.assists || '[]');
    } catch (e) {
        assists = [];
    }

    return {
        id: row.id,
        at: row.at,
        killer: row.killer,
        victim: row.victim,
        killerClan: row.killer_clan || null,
        victimClan: row.victim_clan || null,
        wildLevel: row.wild_level || 0,
        x: row.x,
        y: row.y,
        style: row.style || null,
        assists,
        lootValue: row.loot_value || 0,
        victimSkulled: !!row.victim_skulled,
        battleId: row.battle_id || null
    };
}

function toClan(row) {
    let members = [];

    try {
        members = JSON.parse(row.members || '[]');
    } catch (e) {
        members = [];
    }

    return {
        tag: row.tag,
        name: row.name,
        leader: row.leader || null,
        motto: row.motto || '',
        colour: row.colour || null,
        created: row.created,
        battlesWon: row.battles_won || 0,
        battlesLost: row.battles_lost || 0,
        members
    };
}

function toBattle(row) {
    return {
        id: row.id,
        challenger: row.challenger,
        defender: row.defender,
        front: row.front || null,
        created: row.created,
        startsAt: row.starts_at || null,
        endsAt: row.ends_at || null,
        status: row.status,
        killsChallenger: row.kills_challenger || 0,
        killsDefender: row.kills_defender || 0,
        winner: row.winner || null
    };
}

function num(value) {
    return Number.isFinite(+value) ? +value : 0;
}

class PvpStore {
    constructor(queryHandler) {
        this.queryHandler = queryHandler;
        this.statements = queryHandler.statements;
        this.now = () => Date.now();
    }

    record({ event = {} }) {
        const info = this.statements.pvpInsertEvent.run({
            at: num(event.at) || this.now(),
            killer_id: event.killerId == null ? null : num(event.killerId),
            killer: event.killer || null,
            victim_id: event.victimId == null ? null : num(event.victimId),
            victim: event.victim || null,
            killer_clan: event.killerClan || null,
            victim_clan: event.victimClan || null,
            wild_level: num(event.wildLevel),
            x: num(event.x),
            y: num(event.y),
            style: event.style || null,
            assists: JSON.stringify(Array.isArray(event.assists) ? event.assists : []),
            loot_value: num(event.lootValue),
            victim_skulled: event.victimSkulled ? 1 : 0,
            battle_id: event.battleId == null ? null : num(event.battleId)
        });

        return { success: true, id: Number(info.lastInsertRowid) };
    }

    events({ since = 0, limit = 50 } = {}) {
        const rows = this.statements.pvpEventsSince.all(
            num(since),
            Math.min(MAX_ROWS * 5, Math.max(1, num(limit) || 50))
        );

        return {
            success: true,
            total: this.statements.pvpEventCount.pluck().get(),
            events: rows.map(toEvent)
        };
    }

    // the personal boards, best first. kd ranks players with at least one kill
    hiscores({ board = 'kills', limit = 25 } = {}) {
        const rows = this.statements.pvpPlayersWithStats.all().map((row) => {
            let pvp = {};

            try {
                pvp = JSON.parse(row.pvp) || {};
            } catch (e) {
                pvp = {};
            }

            const stats = {
                kills: num(pvp.kills),
                deaths: num(pvp.deaths),
                assists: num(pvp.assists),
                streak: num(pvp.streak),
                bestStreak: num(pvp.bestStreak),
                damage: num(pvp.damage),
                deepest: num(pvp.deepest),
                loot: num(pvp.loot)
            };

            stats.kd = stats.deaths ? stats.kills / stats.deaths : stats.kills;

            return { username: row.username, ...stats };
        });

        const key = board === 'streak' ? 'bestStreak' : board;

        if (board !== 'kd' && !BOARDS[board]) {
            return { success: false, code: 'BOARD' };
        }

        const ranked = rows
            .filter((row) => (board === 'kd' ? row.kills > 0 : row[key] > 0))
            .sort(
                (a, b) =>
                    b[key] - a[key] ||
                    b.kills - a.kills ||
                    a.username.localeCompare(b.username)
            )
            .slice(0, Math.min(MAX_ROWS, Math.max(1, num(limit) || 25)))
            .map((row, index) => ({ rank: index + 1, ...row }));

        return { success: true, board, rows: ranked };
    }

    clans() {
        const kills = new Map(
            this.statements.pvpClanKills.all().map((row) => [row.tag, row.kills])
        );
        const deaths = new Map(
            this.statements.pvpClanDeaths.all().map((row) => [row.tag, row.deaths])
        );

        return {
            success: true,
            clans: this.statements.clanAll.all().map((row) => {
                const clan = toClan(row);
                clan.kills = kills.get(clan.tag) || 0;
                clan.deaths = deaths.get(clan.tag) || 0;
                return clan;
            }),
            battles: this.statements.battleOpen.all().map(toBattle)
        };
    }

    saveClan({ clan }) {
        if (!clan || !/^[A-Z]{2,4}$/.test(clan.tag || '') || !clan.name) {
            return { success: false, code: 'INVALID' };
        }

        this.statements.clanUpsert.run({
            tag: clan.tag,
            name: String(clan.name).slice(0, 24),
            leader: clan.leader || null,
            motto: clan.motto ? String(clan.motto).slice(0, 80) : null,
            colour: clan.colour || null,
            created: num(clan.created) || this.now(),
            battles_won: num(clan.battlesWon),
            battles_lost: num(clan.battlesLost),
            members: JSON.stringify(Array.isArray(clan.members) ? clan.members : [])
        });

        return { success: true };
    }

    deleteClan({ tag }) {
        this.statements.clanDelete.run(tag);
        return { success: true };
    }

    saveBattle({ battle }) {
        if (!battle || !battle.challenger || !battle.defender) {
            return { success: false, code: 'INVALID' };
        }

        const row = {
            front: battle.front || null,
            starts_at: battle.startsAt == null ? null : num(battle.startsAt),
            ends_at: battle.endsAt == null ? null : num(battle.endsAt),
            status: battle.status || 'challenged',
            kills_challenger: num(battle.killsChallenger),
            kills_defender: num(battle.killsDefender),
            winner: battle.winner || null
        };

        if (battle.id) {
            this.statements.battleUpdate.run({ id: num(battle.id), ...row });
            return { success: true, id: num(battle.id) };
        }

        const info = this.statements.battleInsert.run({
            challenger: battle.challenger,
            defender: battle.defender,
            created: num(battle.created) || this.now(),
            ...row
        });

        return { success: true, id: Number(info.lastInsertRowid) };
    }

    battles({ limit = 20 } = {}) {
        return {
            success: true,
            battles: this.statements.battleRecent
                .all(Math.min(MAX_ROWS, Math.max(1, num(limit) || 20)))
                .map(toBattle)
        };
    }
}

module.exports = { PVP_STATEMENTS, PvpStore, BOARDS };
