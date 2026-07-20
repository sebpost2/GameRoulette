import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { TEST_SESSION_SECRET, leaderCookie } from './helpers.js';

let db;
let server;
let baseUrl;

const LIBRARIES = {
  '111': [
    { appid: 620, name: 'Portal 2' },
    { appid: 730, name: 'Counter-Strike 2' },
  ],
  '222': [
    { appid: 620, name: 'Portal 2' },
    { appid: 440, name: 'Team Fortress 2' },
  ],
};

const STORE_RESULTS = {
  'call of duty': [
    { id: 1938090, name: 'Call of Duty: Modern Warfare II', tiny_image: null },
    { id: 10090, name: 'Call of Duty: World at War', tiny_image: null },
  ],
};

function fakeFetchImpl(url) {
  if (url.includes('storesearch')) {
    const term = new URL(url).searchParams.get('term');
    const items = STORE_RESULTS[term] ?? [];
    return Promise.resolve({ ok: true, json: async () => ({ items }) });
  }
  const steamid = new URL(url).searchParams.get('steamid');
  const games = LIBRARIES[steamid] ?? [];
  return Promise.resolve({ ok: true, json: async () => ({ response: { games } }) });
}

let cookie;

beforeEach(async () => {
  db = await createDb(':memory:');
  const app = createApp(db, {
    steamApiKey: 'TESTKEY',
    fetchImpl: fakeFetchImpl,
    sessionSecret: TEST_SESSION_SECRET,
  });
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

describe('Steam import', () => {
  test('imports a player library into the games catalog', async () => {
    const player = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb', steam_id64: '111' }),
    });
    const importRes = await json(`/api/players/${player.body.id}/steam-import`, { method: 'POST' });
    assert.equal(importRes.status, 200);
    assert.equal(importRes.body.imported, 2);

    const games = await json('/api/games');
    const titles = games.body.map((g) => g.title).sort();
    assert.deepEqual(titles, ['Counter-Strike 2', 'Portal 2']);
  });

  test('returns 400 importing for a player with no steam_id64', async () => {
    const player = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'NoSteam' }),
    });
    const importRes = await json(`/api/players/${player.body.id}/steam-import`, { method: 'POST' });
    assert.equal(importRes.status, 400);
  });

  test('returns 404 importing for an unknown player', async () => {
    const importRes = await json('/api/players/999/steam-import', { method: 'POST' });
    assert.equal(importRes.status, 404);
  });

  test('computes the intersection of owned games across players', async () => {
    const p1 = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seb', steam_id64: '111' }),
    });
    const p2 = await json('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alex', steam_id64: '222' }),
    });
    await json(`/api/players/${p1.body.id}/steam-import`, { method: 'POST' });
    await json(`/api/players/${p2.body.id}/steam-import`, { method: 'POST' });

    const common = await json(`/api/steam/common?playerIds=${p1.body.id},${p2.body.id}`);
    assert.equal(common.status, 200);
    assert.equal(common.body.length, 1);
    assert.equal(common.body[0].title, 'Portal 2');
  });

  test('rejects intersection requests with fewer than 2 player ids', async () => {
    const res = await json('/api/steam/common?playerIds=1');
    assert.equal(res.status, 400);
  });

  test('searches the Steam store catalog by name', async () => {
    const res = await json('/api/steam/search?q=call%20of%20duty');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].title, 'Call of Duty: Modern Warfare II');
    assert.equal(res.body[0].appid, 1938090);
  });

  test('rejects store search queries shorter than 2 characters', async () => {
    const res = await json('/api/steam/search?q=a');
    assert.equal(res.status, 400);
  });
});
