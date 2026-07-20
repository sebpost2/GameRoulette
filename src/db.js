import { createClient } from '@libsql/client';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  steam_id64 TEXT,
  skip_quota INTEGER NOT NULL DEFAULT 1,
  skips_remaining INTEGER NOT NULL DEFAULT 1,
  skip_month TEXT NOT NULL,
  discord_id TEXT,
  discord_username TEXT,
  discord_avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member'
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES players(id),
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  steam_appid INTEGER UNIQUE,
  cover_url TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS player_games (
  player_id INTEGER NOT NULL REFERENCES players(id),
  appid INTEGER NOT NULL,
  PRIMARY KEY (player_id, appid)
);

CREATE TABLE IF NOT EXISTS roulettes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roulette_games (
  roulette_id INTEGER NOT NULL REFERENCES roulettes(id),
  game_id INTEGER NOT NULL REFERENCES games(id),
  PRIMARY KEY (roulette_id, game_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roulette_id INTEGER NOT NULL REFERENCES roulettes(id),
  created_at TEXT NOT NULL,
  elimination_rounds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  result_game_id INTEGER,
  pending_game_id INTEGER
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  round_number INTEGER NOT NULL,
  round_type TEXT NOT NULL,
  spun_game_id INTEGER NOT NULL REFERENCES games(id),
  outcome TEXT NOT NULL,
  skip_used_by INTEGER REFERENCES players(id)
);
`;

const PLAYER_COLUMN_MIGRATIONS = [
  ['discord_id', 'ALTER TABLE players ADD COLUMN discord_id TEXT'],
  ['discord_username', 'ALTER TABLE players ADD COLUMN discord_username TEXT'],
  ['discord_avatar_url', 'ALTER TABLE players ADD COLUMN discord_avatar_url TEXT'],
  ['role', "ALTER TABLE players ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"],
];

// Thin async shim over @libsql/client matching node:sqlite's prepare().get/all/run
// shape, so every call site elsewhere just adds `await` instead of being rewritten
// to the client's native {sql, args} form. rows from @libsql/client already behave
// like plain objects (support both `row.col` and spread), so no column-mapping needed.
function wrapClient(client) {
  return {
    prepare(sql) {
      return {
        async get(...args) {
          const result = await client.execute({ sql, args });
          return result.rows[0] ? { ...result.rows[0] } : undefined;
        },
        async all(...args) {
          const result = await client.execute({ sql, args });
          return result.rows.map((row) => ({ ...row }));
        },
        async run(...args) {
          const result = await client.execute({ sql, args });
          return {
            lastInsertRowid:
              result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : undefined,
            changes: result.rowsAffected,
          };
        },
      };
    },
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    close() {
      client.close();
    },
  };
}

async function migratePlayersColumns(db) {
  const existing = (await db.prepare('PRAGMA table_info(players)').all()).map((c) => c.name);
  for (const [column, ddl] of PLAYER_COLUMN_MIGRATIONS) {
    if (!existing.includes(column)) await db.exec(ddl);
  }
  // SQLite forbids UNIQUE on ADD COLUMN, so uniqueness lives here instead of
  // inline on the column — this also covers fresh databases (harmless if
  // already implied) and migrated ones uniformly.
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_discord_id ON players (discord_id)');
}

export async function createDb(url, authToken) {
  const client = createClient(authToken ? { url, authToken } : { url });
  const db = wrapClient(client);
  await db.exec(SCHEMA);
  await migratePlayersColumns(db);
  return db;
}

function currentMonth(now) {
  return now.toISOString().slice(0, 7);
}

export async function ensureSkipsCurrent(db, playerId, now = new Date()) {
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) {
    throw new Error(`Unknown player id: ${playerId}`);
  }

  const month = currentMonth(now);
  if (player.skip_month !== month) {
    await db.prepare('UPDATE players SET skips_remaining = ?, skip_month = ? WHERE id = ?').run(
      player.skip_quota,
      month,
      playerId
    );
  }
}
