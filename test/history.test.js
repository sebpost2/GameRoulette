import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { TEST_SESSION_SECRET, leaderCookie, sessionCookieFor } from './helpers.js';

let db;
let server;
let baseUrl;
let rngQueue;
let cookie;

beforeEach(async () => {
  db = await createDb(':memory:');
  rngQueue = [];
  const app = createApp(db, {
    rng: () => (rngQueue.length ? rngQueue.shift() : 0),
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

async function jsonReq(path, options) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json', cookie, ...(options?.headers ?? {}) },
    ...options,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('Match history', () => {
  test('lists completed and in-progress matches with roulette name', async () => {
    const gA = (await jsonReq('/api/games', { method: 'POST', body: JSON.stringify({ title: 'Game A' }) })).body;
    const roulette = (
      await jsonReq('/api/roulettes', { method: 'POST', body: JSON.stringify({ name: 'Solo' }) })
    ).body;
    await jsonReq(`/api/roulettes/${roulette.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gA.id }),
    });
    const match = (
      await jsonReq('/api/matches', {
        method: 'POST',
        body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
      })
    ).body;
    await jsonReq(`/api/matches/${match.id}/start`, { method: 'POST' });

    const list = await jsonReq('/api/matches');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, match.id);
    assert.equal(list.body[0].roulette_name, 'Solo');
  });

  test('returns full round-by-round detail for a match, including skip and eliminated/won game titles', async () => {
    const gA = (await jsonReq('/api/games', { method: 'POST', body: JSON.stringify({ title: 'Game A' }) })).body;
    const gB = (await jsonReq('/api/games', { method: 'POST', body: JSON.stringify({ title: 'Game B' }) })).body;
    const roulette = (
      await jsonReq('/api/roulettes', { method: 'POST', body: JSON.stringify({ name: 'Duo' }) })
    ).body;
    await jsonReq(`/api/roulettes/${roulette.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gA.id }),
    });
    await jsonReq(`/api/roulettes/${roulette.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gB.id }),
    });
    const player = (
      await jsonReq('/api/players', { method: 'POST', body: JSON.stringify({ name: 'Seb', skip_quota: 1 }) })
    ).body;

    const match = (
      await jsonReq('/api/matches', {
        method: 'POST',
        body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
      })
    ).body;
    await jsonReq(`/api/matches/${match.id}/join`, {
      method: 'POST',
      headers: { cookie: sessionCookieFor(player.id) },
    });
    await jsonReq(`/api/matches/${match.id}/start`, { method: 'POST' });

    rngQueue = [0]; // pool [A, B] -> A
    await jsonReq(`/api/matches/${match.id}/spin`, { method: 'POST' });
    await jsonReq(`/api/matches/${match.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'skip', skip_used_by: player.id }),
    });
    rngQueue = [0.9]; // same round respins, pool [A, B] -> B
    await jsonReq(`/api/matches/${match.id}/spin`, { method: 'POST' });
    await jsonReq(`/api/matches/${match.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'eliminate' }),
    });
    rngQueue = [0]; // final round, pool [A] -> A
    await jsonReq(`/api/matches/${match.id}/spin`, { method: 'POST' });
    await jsonReq(`/api/matches/${match.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'confirm_win' }),
    });

    const detail = await jsonReq(`/api/matches/${match.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, 'complete');
    assert.equal(detail.body.result_game_title, 'Game A');
    assert.equal(detail.body.rounds.length, 3);
    assert.equal(detail.body.rounds[0].outcome, 'skipped');
    assert.equal(detail.body.rounds[0].skip_used_by_name, 'Seb');
    assert.equal(detail.body.rounds[1].outcome, 'eliminated');
    assert.equal(detail.body.rounds[1].spun_game_title, 'Game B');
    assert.equal(detail.body.rounds[2].outcome, 'won');
    assert.equal(detail.body.rounds[2].spun_game_title, 'Game A');
  });

  test('returns 404 for an unknown match id', async () => {
    const res = await jsonReq('/api/matches/999');
    assert.equal(res.status, 404);
  });
});
