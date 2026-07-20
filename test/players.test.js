import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { TEST_SESSION_SECRET, leaderCookie } from './helpers.js';

let db;
let server;
let baseUrl;
let cookie;

beforeEach(async () => {
  db = await createDb(':memory:');
  const app = createApp(db, { sessionSecret: TEST_SESSION_SECRET });
  cookie = await leaderCookie(db);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function json(path, options) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json', cookie, ...(options?.headers ?? {}) },
    ...options,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('Players CRUD + skips', () => {
  test('creates a player with default skip quota of 1 and full skips remaining', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb' }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.name, 'Seb');
    assert.equal(create.body.skip_quota, 1);
    assert.equal(create.body.skips_remaining, 1);
  });

  test('creates a player with a custom skip quota', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alex', skip_quota: 3 }),
    });
    assert.equal(create.body.skip_quota, 3);
    assert.equal(create.body.skips_remaining, 3);
  });

  test('rejects creating a player without a name', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(create.status, 400);
  });

  test('lists players', async () => {
    await json('/api/players', { method: 'POST', body: JSON.stringify({ name: 'A' }) });
    await json('/api/players', { method: 'POST', body: JSON.stringify({ name: 'B' }) });
    const list = await json('/api/players');
    assert.equal(list.body.length, 3); // A, B, and the seeded leader account
  });

  test('updates a player name and skip quota', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb' }),
    });
    const update = await json(`/api/players/${create.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Sebastian', skip_quota: 2 }),
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.name, 'Sebastian');
    assert.equal(update.body.skip_quota, 2);
  });

  test('updates a player skips_remaining directly', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb', skip_quota: 1 }),
    });
    const update = await json(`/api/players/${create.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ skips_remaining: 0 }),
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.skips_remaining, 0);
    assert.equal(update.body.skip_quota, 1);
  });

  test('returns 404 updating an unknown player', async () => {
    const update = await json('/api/players/999', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Nope' }),
    });
    assert.equal(update.status, 404);
  });

  test('deletes a player', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Temp' }),
    });
    const del = await json(`/api/players/${create.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const list = await json('/api/players');
    assert.equal(list.body.length, 1); // just the seeded leader account remains
  });

  test('GET /api/players applies the monthly skip reset before returning', async () => {
    const create = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb', skip_quota: 1 }),
    });
    // Simulate skips having been used in a prior month.
    await db.prepare('UPDATE players SET skips_remaining = 0, skip_month = ? WHERE id = ?').run(
      '2000-01',
      create.body.id
    );

    const list = await json('/api/players');
    assert.equal(list.body[0].skips_remaining, 1);
    assert.notEqual(list.body[0].skip_month, '2000-01');
  });
});
