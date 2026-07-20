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

describe('Games CRUD', () => {
  test('creates a game and lists only active games by default', async () => {
    const create = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Deep Rock Galactic' }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.title, 'Deep Rock Galactic');
    assert.ok(create.body.id);

    const list = await json('/api/games');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].title, 'Deep Rock Galactic');
  });

  test('rejects creating a game without a title', async () => {
    const create = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(create.status, 400);
  });

  test('updates a game title', async () => {
    const create = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Typo Nmae' }),
    });
    const update = await json(`/api/games/${create.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Correct Name' }),
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.title, 'Correct Name');
  });

  test('returns 404 updating an unknown game', async () => {
    const update = await json('/api/games/999', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Nope' }),
    });
    assert.equal(update.status, 404);
  });

  test('deleting a game with no match history removes it entirely', async () => {
    const create = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'To Remove' }),
    });
    const del = await json(`/api/games/${create.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const list = await json('/api/games');
    assert.equal(list.body.length, 0);

    const listAll = await json('/api/games?all=1');
    assert.equal(listAll.body.length, 0);
  });

  test('returns 404 deleting an unknown game', async () => {
    const del = await json('/api/games/999', { method: 'DELETE' });
    assert.equal(del.status, 404);
  });

  test('rejects deleting a game that appears in match history', async () => {
    const game = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Played Game' }),
    });
    const roulette = await json('/api/roulettes', {
      method: 'POST',
      body: JSON.stringify({ name: 'History Test' }),
    });
    await json(`/api/roulettes/${roulette.body.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id: game.body.id }),
    });
    const match = await json('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.body.id, elimination_rounds: 0 }),
    });
    await json(`/api/matches/${match.body.id}/start`, { method: 'POST' });
    await json(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    await json(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'confirm_win' }),
    });

    const del = await json(`/api/games/${game.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 409);

    const list = await json('/api/games');
    assert.equal(list.body.length, 1);
  });
});

describe('Roulettes CRUD + membership', () => {
  test('creates a roulette and adds/removes games from it', async () => {
    const game = await json('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Lethal Company' }),
    });
    const roulette = await json('/api/roulettes', {
      method: 'POST',
      body: JSON.stringify({ name: 'Co-op picks' }),
    });
    assert.equal(roulette.status, 201);
    assert.equal(roulette.body.name, 'Co-op picks');

    const add = await json(`/api/roulettes/${roulette.body.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id: game.body.id }),
    });
    assert.equal(add.status, 204);

    const withGames = await json(`/api/roulettes/${roulette.body.id}`);
    assert.equal(withGames.body.games.length, 1);
    assert.equal(withGames.body.games[0].title, 'Lethal Company');

    const remove = await json(`/api/roulettes/${roulette.body.id}/games/${game.body.id}`, {
      method: 'DELETE',
    });
    assert.equal(remove.status, 204);

    const withoutGames = await json(`/api/roulettes/${roulette.body.id}`);
    assert.equal(withoutGames.body.games.length, 0);
  });

  test('returns 404 for an unknown roulette', async () => {
    const res = await json('/api/roulettes/999');
    assert.equal(res.status, 404);
  });

  test('rejects creating a roulette without a name', async () => {
    const res = await json('/api/roulettes', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
