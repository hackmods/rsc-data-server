CREATE TABLE IF NOT EXISTS `worlds` (
    `id` integer not null primary key,
    `ip` varchar(45),
    `tcp_port` integer default '43594',
    `websocket_port` integer default '43595',
    `country` char(3),
    `members` boolean default '0'
);

CREATE TABLE IF NOT EXISTS `players` (
    `id` integer not null primary key autoincrement,
    `username` varchar(12) collate nocase,
    `rank` integer default '0',
    `password` char(60),
    `x` integer default '122',
    `y` integer default '657',
    `quest_points` integer default '0',
    `fatigue` integer default '0',
    `combat_style` integer default '0',
    `block_chat` boolean default '0',
    `block_private_chat` boolean default '0',
    `block_trade` boolean default '0',
    `block_duel` boolean default '0',
    `camera_auto` boolean default '1',
    `one_mouse_button` boolean default '0',
    `sound_on` boolean default '1',
    `hair_colour` integer default '2',
    `top_colour` integer default '8',
    `trouser_colour` integer default '14',
    `skin_colour` integer default '0',
    `head_sprite` integer default '1',
    `body_sprite` integer default '2',
    `skulled` integer default '0',
    `cur_attack` integer default '1',
    `exp_attack` integer default '0',
    `cur_defense` integer default '1',
    `exp_defense` integer default '0',
    `cur_strength` integer default '1',
    `exp_strength` integer default '0',
    `cur_hits` integer default '10',
    `exp_hits` integer default '4616',
    `cur_ranged` integer default '1',
    `exp_ranged` integer default '0',
    `cur_prayer` integer default '1',
    `exp_prayer` integer default '0',
    `cur_magic` integer default '1',
    `exp_magic` integer default '0',
    `cur_cooking` integer default '1',
    `exp_cooking` integer default '0',
    `cur_woodcutting` integer default '1',
    `exp_woodcutting` integer default '0',
    `cur_fletching` integer default '1',
    `exp_fletching` integer default '0',
    `cur_fishing` integer default '1',
    `exp_fishing` integer default '0',
    `cur_firemaking` integer default '1',
    `exp_firemaking` integer default '0',
    `cur_crafting` integer default '1',
    `exp_crafting` integer default '0',
    `cur_smithing` integer default '1',
    `exp_smithing` integer default '0',
    `cur_mining` integer default '1',
    `exp_mining` integer default '0',
    `cur_herblaw` integer default '1',
    `exp_herblaw` integer default '0',
    `cur_agility` integer default '1',
    `exp_agility` integer default '0',
    `cur_thieving` integer default '1',
    `exp_thieving` integer default '0',
    `total_level` integer default '18',
    `rank_attack` integer default '0',
    `rank_defense` integer default '0',
    `rank_strength` integer default '0',
    `rank_hits` integer default '0',
    `rank_ranged` integer default '0',
    `rank_prayer` integer default '0',
    `rank_magic` integer default '0',
    `rank_cooking` integer default '0',
    `rank_woodcutting` integer default '0',
    `rank_fletching` integer default '0',
    `rank_fishing` integer default '0',
    `rank_firemaking` integer default '0',
    `rank_crafting` integer default '0',
    `rank_smithing` integer default '0',
    `rank_mining` integer default '0',
    `rank_herblaw` integer default '0',
    `rank_agility` integer default '0',
    `rank_thieving` integer default '0',
    `rank_total` integer default '0',
    `recovery` json default '{}',
    `friends` json default '[]',
    `ignores` json default '[]',
    `inventory` json default '[]',
    `bank` json default '[]',
    `creation_ip` varchar(45),
    `creation_date` datetime default (strftime('%s', 'now')),
    `login_ip` varchar(45),
    `login_date` datetime default '0',
    `time_logged_in` integer default '0',
    `world` integer default '0',
    `ban_end_date` datetime default '0',
    `mute_end_date` datetime default '0',
    `membership_end_date` datetime default '0',
    `quest_stages` json default '{}',
    `cache` json default '{"sendAppearance": true}'
);

CREATE UNIQUE INDEX IF NOT EXISTS `players_username_unique` on `players`
(`username`);

CREATE TABLE IF NOT EXISTS `player_messages` (
    `id` integer not null primary key autoincrement,
    `to_player` integer not null REFERENCES `players`,
    `from` varchar(255),
    `subject` varchar(255),
    `date` datetime default (strftime('%s', 'now')),
    `unread` boolean default '1',
    `message` TEXT
);

CREATE INDEX IF NOT EXISTS `to_player_index` ON `player_messages` (`to_player`);

CREATE TABLE IF NOT EXISTS `login_attempts` (
    `id` integer not null primary key autoincrement,
    `ip` varchar(45),
    `attempts` integer default '1',
    `last_attempt_date` datetime default (strftime('%s', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS `login_attempts_ip_unique` on `login_attempts`
(`ip`);

CREATE TABLE IF NOT EXISTS `news` (
    `id` integer not null primary key autoincrement,
    `date` datetime default (strftime('%s', 'now')),
    `category` integer default '0',
    `title` varchar(255),
    `body` TEXT
);

CREATE TABLE IF NOT EXISTS `god_letters` (
    `id` integer not null primary key autoincrement,
    `date` datetime default (strftime('%s', 'now')),
    `title` varchar(255),
    `body` TEXT
);

CREATE TABLE IF NOT EXISTS `uploads` (
    `id` integer not null primary key autoincrement,
    `name` varchar(255),
    `file` blob
);

CREATE UNIQUE INDEX IF NOT EXISTS `name_unique` on `uploads` (`name`);

-- Grand Exchange (ARSC): docs/GRAND_EXCHANGE.md in hackmods/Autonomous-RSC.
-- Times are epoch milliseconds. Coins are item id 10.

CREATE TABLE IF NOT EXISTS `exchange_offers` (
    `id` integer not null primary key,
    `player_id` integer not null,
    `username` varchar(12),
    `slot` integer not null, -- 0-7: the lowest slot no open offer of that player holds; house listings 1000 + item_id
    `side` text not null check (`side` in ('buy', 'sell')),
    `item_id` integer not null,
    `qty` integer not null,
    `filled` integer not null default 0,
    `price` integer not null,
    `coins_moved` integer not null default 0, -- coins paid (buy) or gross proceeds (sell) so far
    `state` text not null default 'open'
        check (`state` in ('open', 'done', 'cancelled')),
    `created` integer not null,
    `updated` integer not null
);

CREATE INDEX IF NOT EXISTS `exchange_offers_book` ON `exchange_offers`
(`item_id`, `side`, `state`, `price`, `created`);

CREATE INDEX IF NOT EXISTS `exchange_offers_player` ON `exchange_offers`
(`player_id`, `state`);

-- one open offer per slot per player
CREATE UNIQUE INDEX IF NOT EXISTS `exchange_offers_open_slot` ON
`exchange_offers` (`player_id`, `slot`) WHERE `state` = 'open';

CREATE TABLE IF NOT EXISTS `exchange_fills` (
    `id` integer not null primary key,
    `buy_id` integer not null,
    `sell_id` integer not null,
    `item_id` integer not null,
    `qty` integer not null,
    `price` integer not null,
    `tax` integer not null default 0,
    `at` integer not null
);

CREATE INDEX IF NOT EXISTS `exchange_fills_item_at` ON `exchange_fills`
(`item_id`, `at`);

-- the collection box: claimed_at is null until the player collects the row
CREATE TABLE IF NOT EXISTS `exchange_collect` (
    `id` integer not null primary key,
    `player_id` integer not null,
    `item_id` integer not null,
    `amount` integer not null,
    `reason` text, -- bought|sold|refund|cancel|stake|void
    `offer_id` integer,
    `created` integer not null,
    `claimed_at` integer
);

CREATE INDEX IF NOT EXISTS `exchange_collect_player` ON `exchange_collect`
(`player_id`, `claimed_at`);

CREATE TABLE IF NOT EXISTS `exchange_limits` (
    `player_id` integer not null,
    `item_id` integer not null,
    `window_start` integer not null,
    `bought` integer not null default 0,
    primary key (`player_id`, `item_id`)
);

-- per-item buy limit overrides (default 1000, stackable 25000)
CREATE TABLE IF NOT EXISTS `exchange_limit_overrides` (
    `item_id` integer not null primary key,
    `buy_limit` integer not null
);

-- idempotency: every write reply by opId
CREATE TABLE IF NOT EXISTS `exchange_ops` (
    `op_id` text not null primary key,
    `player_id` integer,
    `kind` text,
    `result` text,
    `at` integer
);

CREATE TABLE IF NOT EXISTS `economy_ledger` (
    `id` integer not null primary key,
    `at` integer not null,
    `kind` text not null, -- tax|stake|refund|taint_trade
    `player_id` integer,
    `item_id` integer,
    `amount` integer,
    `note` text
);

CREATE INDEX IF NOT EXISTS `economy_ledger_at` ON `economy_ledger` (`at`);
