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

function queueRng() {
  return () => (rngQueue.length ? rngQueue.shift() : 0);
}

beforeEach(async () => {
  db = await createDb(':memory:');
  rngQueue = [];
  const app = createApp(db, { rng: queueRng(), sessionSecret: TEST_SESSION_SECRET });
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

async function makeGame(title) {
  const res = await jsonReq('/api/games', { method: 'POST', body: JSON.stringify({ title }) });
  return res.body;
}

async function makeRoulette(name, gameIds) {
  const res = await jsonReq('/api/roulettes', { method: 'POST', body: JSON.stringify({ name }) });
  for (const game_id of gameIds) {
    await jsonReq(`/api/roulettes/${res.body.id}/games`, {
      method: 'POST',
      body: JSON.stringify({ game_id }),
    });
  }
  return res.body;
}

async function makePlayer(name, skip_quota = 1) {
  const res = await jsonReq('/api/players', {
    method: 'POST',
    body: JSON.stringify({ name, skip_quota }),
  });
  return res.body;
}

async function startMatch(matchId) {
  return jsonReq(`/api/matches/${matchId}/start`, { method: 'POST' });
}

async function joinMatch(matchId, playerId) {
  return jsonReq(`/api/matches/${matchId}/join`, {
    method: 'POST',
    headers: { cookie: sessionCookieFor(playerId) },
  });
}

describe('Match engine', () => {
  test('runs a full 2-elimination-round match down to a final winner', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const gC = await makeGame('Game C');
    const roulette = await makeRoulette('Test Roulette', [gA.id, gB.id, gC.id]);

    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 2 }),
    });
    assert.equal(match.status, 201);
    assert.equal(match.body.status, 'waiting');
    await startMatch(match.body.id);

    // Pool ordered by game id: [A, B, C]. rng=0 -> index 0 -> A.
    rngQueue = [0];
    const spin1 = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin1.status, 200);
    assert.equal(spin1.body.round_number, 1);
    assert.equal(spin1.body.round_type, 'elimination');
    assert.equal(spin1.body.spun_game.id, gA.id);

    const resolve1 = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'eliminate' }),
    });
    assert.equal(resolve1.status, 200);

    // Pool is now [B, C]. rng=0.9 -> index 1 -> C.
    rngQueue = [0.9];
    const spin2 = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin2.body.round_number, 2);
    assert.equal(spin2.body.round_type, 'elimination');
    assert.equal(spin2.body.spun_game.id, gC.id);

    await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'eliminate' }),
    });

    // Pool is now [B] only. Final round.
    rngQueue = [0];
    const spin3 = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin3.body.round_number, 3);
    assert.equal(spin3.body.round_type, 'final');
    assert.equal(spin3.body.spun_game.id, gB.id);

    const final = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'confirm_win' }),
    });
    assert.equal(final.status, 200);
    assert.equal(final.body.status, 'complete');
    assert.equal(final.body.result_game_id, gB.id);
  });

  test('a skip vetoes elimination, forces a respin of the same round, and decrements the skip', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('Skip Test', [gA.id, gB.id]);
    const player = await makePlayer('Seb', 1);

    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await joinMatch(match.body.id, player.id);
    await startMatch(match.body.id);

    rngQueue = [0];
    const spin1 = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin1.body.spun_game.id, gA.id);

    const skip = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'skip', skip_used_by: player.id }),
    });
    assert.equal(skip.status, 200);

    const playerAfter = await jsonReq('/api/players');
    assert.equal(playerAfter.body[0].skips_remaining, 0);

    // Same round respins - round_number stays 1.
    rngQueue = [0];
    const spin2 = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin2.body.round_number, 1);
    assert.equal(spin2.body.round_type, 'elimination');
  });

  test('rejects a skip when the player has no skips remaining', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('No Skips', [gA.id, gB.id]);
    const player = await makePlayer('Broke', 0);

    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await joinMatch(match.body.id, player.id);
    await startMatch(match.body.id);
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const skip = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'skip', skip_used_by: player.id }),
    });
    assert.equal(skip.status, 400);
  });

  test('rejects eliminate outcome on the final round', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Single', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    await startMatch(match.body.id);
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const resolve = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'eliminate' }),
    });
    assert.equal(resolve.status, 400);
  });

  test('rejects confirm_win outcome on an elimination round', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('Two', [gA.id, gB.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await startMatch(match.body.id);
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const resolve = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'confirm_win' }),
    });
    assert.equal(resolve.status, 400);
  });

  test('rejects spinning again while a spin is pending resolution', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('Pending', [gA.id, gB.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await startMatch(match.body.id);
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const secondSpin = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(secondSpin.status, 409);
  });

  test('rejects resolving when there is no pending spin', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Empty', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    await startMatch(match.body.id);

    const resolve = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'confirm_win' }),
    });
    assert.equal(resolve.status, 409);
  });

  test('returns 404 spinning for an unknown match', async () => {
    const res = await jsonReq('/api/matches/999/spin', { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('Match lobby (join before start)', () => {
  test('a new match starts in waiting status with its creator already joined', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    assert.equal(match.status, 201);
    assert.equal(match.body.status, 'waiting');

    const detail = await jsonReq(`/api/matches/${match.body.id}`);
    assert.equal(detail.body.players.length, 1);
  });

  test('spinning before the match is started is rejected', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    const spin = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin.status, 409);
  });

  test('a player can join a waiting match, and joining twice does not duplicate', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });

    const join = await jsonReq(`/api/matches/${match.body.id}/join`, { method: 'POST' });
    assert.equal(join.status, 200);
    await jsonReq(`/api/matches/${match.body.id}/join`, { method: 'POST' });

    const detail = await jsonReq(`/api/matches/${match.body.id}`);
    assert.equal(detail.body.players.length, 1); // the leader cookie's own player, joined idempotently
  });

  test('rejects joining a match that already started', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });

    const join = await jsonReq(`/api/matches/${match.body.id}/join`, { method: 'POST' });
    assert.equal(join.status, 409);
  });

  test('starting a waiting match transitions it to in_progress and allows spinning', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });

    const start = await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });
    assert.equal(start.status, 200);
    assert.equal(start.body.status, 'in_progress');

    rngQueue = [0];
    const spin = await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });
    assert.equal(spin.status, 200);
  });

  test('rejects starting a match that already started', async () => {
    const gA = await makeGame('Game A');
    const roulette = await makeRoulette('Lobby', [gA.id]);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 0 }),
    });
    await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });

    const start2 = await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });
    assert.equal(start2.status, 409);
  });

  test('rejects a skip from a player who never joined the match', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('Lobby', [gA.id, gB.id]);
    const outsider = await makePlayer('Outsider', 1);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const skip = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'skip', skip_used_by: outsider.id }),
    });
    assert.equal(skip.status, 400);
  });

  test('allows a skip from a player who joined the match', async () => {
    const gA = await makeGame('Game A');
    const gB = await makeGame('Game B');
    const roulette = await makeRoulette('Lobby', [gA.id, gB.id]);
    const joiner = await makePlayer('Joiner', 1);
    const match = await jsonReq('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ roulette_id: roulette.id, elimination_rounds: 1 }),
    });
    await jsonReq(`/api/matches/${match.body.id}/join`, {
      method: 'POST',
      headers: { cookie: sessionCookieFor(joiner.id) },
    });
    await jsonReq(`/api/matches/${match.body.id}/start`, { method: 'POST' });
    rngQueue = [0];
    await jsonReq(`/api/matches/${match.body.id}/spin`, { method: 'POST' });

    const skip = await jsonReq(`/api/matches/${match.body.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'skip', skip_used_by: joiner.id }),
    });
    assert.equal(skip.status, 200);
  });
});
