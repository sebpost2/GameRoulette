import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, ensureSkipsCurrent } from '../src/db.js';

describe('createDb', () => {
  test('creates all required tables on an in-memory database', async () => {
    const db = await createDb(':memory:');
    const tables = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
    ).map((row) => row.name);

    assert.deepEqual(tables, [
      'games',
      'invites',
      'match_rounds',
      'matches',
      'player_games',
      'players',
      'roulette_games',
      'roulettes',
    ]);
    db.close();
  });

  test('players table has Discord account and role columns', async () => {
    const db = await createDb(':memory:');
    const columns = (await db.prepare('PRAGMA table_info(players)').all()).map((c) => c.name);
    assert.ok(columns.includes('discord_id'));
    assert.ok(columns.includes('discord_username'));
    assert.ok(columns.includes('discord_avatar_url'));
    assert.ok(columns.includes('role'));
    db.close();
  });

  test('migrates a pre-existing database file that has the old players schema', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'game-roulette-test-'));
    const fileUrl = `file:${path.join(dir, 'roulette.db')}`;

    const legacy = createClient({ url: fileUrl });
    await legacy.executeMultiple(`
      CREATE TABLE players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        steam_id64 TEXT,
        skip_quota INTEGER NOT NULL DEFAULT 1,
        skips_remaining INTEGER NOT NULL DEFAULT 1,
        skip_month TEXT NOT NULL
      );
    `);
    await legacy.execute({
      sql: 'INSERT INTO players (name, skip_quota, skips_remaining, skip_month) VALUES (?, 1, 1, ?)',
      args: ['Legacy Player', '2026-07'],
    });
    legacy.close();

    const migrated = await createDb(fileUrl);
    const columns = (await migrated.prepare('PRAGMA table_info(players)').all()).map((c) => c.name);
    assert.ok(columns.includes('discord_id'));
    const existing = await migrated.prepare('SELECT * FROM players WHERE name = ?').get('Legacy Player');
    assert.equal(existing.role, 'member');
    migrated.close();
  });
});

describe('ensureSkipsCurrent', () => {
  test('leaves skips_remaining untouched when skip_month matches current month', async () => {
    const db = await createDb(':memory:');
    await db
      .prepare('INSERT INTO players (id, name, skip_quota, skips_remaining, skip_month) VALUES (1, ?, 1, 0, ?)')
      .run('Alice', '2026-07');

    await ensureSkipsCurrent(db, 1, new Date('2026-07-15T00:00:00Z'));

    const player = await db.prepare('SELECT * FROM players WHERE id = 1').get();
    assert.equal(player.skips_remaining, 0);
    assert.equal(player.skip_month, '2026-07');
    db.close();
  });

  test('resets skips_remaining to quota when the month has rolled over', async () => {
    const db = await createDb(':memory:');
    await db
      .prepare('INSERT INTO players (id, name, skip_quota, skips_remaining, skip_month) VALUES (1, ?, 2, 0, ?)')
      .run('Bob', '2026-06');

    await ensureSkipsCurrent(db, 1, new Date('2026-07-01T00:00:00Z'));

    const player = await db.prepare('SELECT * FROM players WHERE id = 1').get();
    assert.equal(player.skips_remaining, 2);
    assert.equal(player.skip_month, '2026-07');
    db.close();
  });

  test('throws for an unknown player id', async () => {
    const db = await createDb(':memory:');
    await assert.rejects(() => ensureSkipsCurrent(db, 999, new Date()));
    db.close();
  });
});
