import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let db;
let server;
let baseUrl;

const SESSION_SECRET = 'test-session-secret';
const DISCORD_USERS = {
  CODE_LEADER: { id: 'discord-leader-1', username: 'LeaderLee', avatar: 'aaa' },
  CODE_MEMBER: { id: 'discord-member-1', username: 'MemberMo', avatar: null },
  CODE_OTHER: { id: 'discord-other-1', username: 'OtherOwen', avatar: null },
  CODE_STRANGER: { id: 'discord-stranger-1', username: 'StrangerSam', avatar: null },
};

async function fakeDiscordFetch(url, options) {
  if (url.includes('/oauth2/token')) {
    const code = new URLSearchParams(options.body.toString()).get('code');
    return { ok: true, json: async () => ({ access_token: `TOKEN-${code}` }) };
  }
  if (url.includes('/users/@me')) {
    const code = options.headers.authorization.replace('Bearer TOKEN-', '');
    const user = DISCORD_USERS[code];
    if (!user) return { ok: false, status: 401 };
    return { ok: true, json: async () => user };
  }
  throw new Error(`unexpected discord url ${url}`);
}

beforeEach(async () => {
  db = await createDb(':memory:');
  const app = createApp(db, {
    fetchImpl: fakeDiscordFetch,
    sessionSecret: SESSION_SECRET,
    discordClientId: 'CID',
    discordClientSecret: 'CSECRET',
    discordRedirectUri: 'http://localhost/auth/discord/callback',
    initialLeaderDiscordId: 'discord-leader-1',
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function setCookiesOf(res) {
  return res.headers.getSetCookie();
}

function cookieValue(setCookies, name) {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function startOAuth(invite) {
  const url = invite ? `${baseUrl}/auth/discord?invite=${invite}` : `${baseUrl}/auth/discord`;
  const res = await fetch(url, { redirect: 'manual' });
  const location = new URL(res.headers.get('location'));
  return {
    state: location.searchParams.get('state'),
    stateCookie: cookieValue(setCookiesOf(res), 'gr_oauth_state'),
  };
}

async function loginAs(code, invite) {
  const { state, stateCookie } = await startOAuth(invite);
  const res = await fetch(`${baseUrl}/auth/discord/callback?code=${code}&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: `gr_oauth_state=${stateCookie}` },
  });
  return res;
}

async function sessionCookieFor(code, invite) {
  const res = await loginAs(code, invite);
  assert.equal(res.status, 302, `expected login to succeed for ${code}`);
  return cookieValue(setCookiesOf(res), 'gr_session');
}

async function authed(path, cookie, options) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: `gr_session=${cookie}`, ...(options?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('GET /auth/discord', () => {
  test('redirects to Discord with client id + state and sets an oauth-state cookie', async () => {
    const res = await fetch(`${baseUrl}/auth/discord`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.match(location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
    assert.match(location, /client_id=CID/);
    assert.ok(location.includes('state='));
    assert.ok(cookieValue(setCookiesOf(res), 'gr_oauth_state'));
  });
});

describe('GET /auth/discord/callback', () => {
  test('logs in the configured initial leader as role=leader without an invite', async () => {
    const res = await loginAs('CODE_LEADER');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.ok(cookieValue(setCookiesOf(res), 'gr_session'));

    const player = await db.prepare('SELECT * FROM players WHERE discord_id = ?').get('discord-leader-1');
    assert.equal(player.role, 'leader');
    assert.equal(player.discord_username, 'LeaderLee');
  });

  test('rejects a first-time login with no invite and no leader match', async () => {
    const res = await loginAs('CODE_STRANGER');
    assert.equal(res.status, 403);
    const player = await db.prepare('SELECT * FROM players WHERE discord_id = ?').get('discord-stranger-1');
    assert.equal(player, undefined);
  });

  test('rejects when the OAuth state does not match the cookie (CSRF guard)', async () => {
    const { stateCookie } = await startOAuth();
    const res = await fetch(`${baseUrl}/auth/discord/callback?code=CODE_LEADER&state=wrong-nonce`, {
      redirect: 'manual',
      headers: { cookie: `gr_oauth_state=${stateCookie}` },
    });
    assert.equal(res.status, 400);
  });

  test('creates a member account when redeeming a valid invite', async () => {
    const leaderCookie = await sessionCookieFor('CODE_LEADER');
    const invite = await authed('/api/invites', leaderCookie, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(invite.status, 201);

    const res = await loginAs('CODE_MEMBER', invite.body.token);
    assert.equal(res.status, 302);
    const player = await db.prepare('SELECT * FROM players WHERE discord_id = ?').get('discord-member-1');
    assert.equal(player.role, 'member');

    const inviteRow = await db.prepare('SELECT * FROM invites WHERE token = ?').get(invite.body.token);
    assert.equal(inviteRow.use_count, 1);
  });

  test('rejects redemption of an invite that has hit max_uses', async () => {
    const leaderCookie = await sessionCookieFor('CODE_LEADER');
    const invite = await authed('/api/invites', leaderCookie, {
      method: 'POST',
      body: JSON.stringify({ max_uses: 1 }),
    });
    await loginAs('CODE_MEMBER', invite.body.token);

    const res = await loginAs('CODE_OTHER', invite.body.token);
    assert.equal(res.status, 403);
    const player = await db.prepare('SELECT * FROM players WHERE discord_id = ?').get('discord-other-1');
    assert.equal(player, undefined);
  });

  test('rejects redemption of an expired invite', async () => {
    const leaderCookie = await sessionCookieFor('CODE_LEADER');
    const invite = await authed('/api/invites', leaderCookie, { method: 'POST', body: JSON.stringify({}) });
    await db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', invite.body.token);

    const res = await loginAs('CODE_MEMBER', invite.body.token);
    assert.equal(res.status, 403);
  });

  test('a returning player logs in again without needing an invite', async () => {
    await loginAs('CODE_LEADER');
    const res = await loginAs('CODE_LEADER');
    assert.equal(res.status, 302);
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM players WHERE discord_id = ?').get('discord-leader-1')).n;
    assert.equal(count, 1);
  });
});

describe('POST /api/invites', () => {
  test('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  test('rejects members (non-leaders)', async () => {
    const leaderCookie = await sessionCookieFor('CODE_LEADER');
    const invite = await authed('/api/invites', leaderCookie, { method: 'POST', body: JSON.stringify({}) });
    const memberCookie = await sessionCookieFor('CODE_MEMBER', invite.body.token);

    const res = await authed('/api/invites', memberCookie, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/me', () => {
  test('returns the authenticated player identity', async () => {
    const leaderCookie = await sessionCookieFor('CODE_LEADER');
    const res = await authed('/api/me', leaderCookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'leader');
    assert.equal(res.body.discord_username, 'LeaderLee');
  });

  test('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/me`);
    assert.equal(res.status, 401);
  });
});
