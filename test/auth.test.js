import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession,
  verifySession,
  generateInviteToken,
  parseCookies,
  buildDiscordAuthUrl,
  exchangeDiscordCode,
} from '../src/auth.js';

describe('signSession / verifySession', () => {
  test('verifies a session signed with the same secret', () => {
    const cookie = signSession(42, 'secret-a', Date.now());
    assert.equal(verifySession(cookie, 'secret-a'), 42);
  });

  test('rejects a session signed with a different secret', () => {
    const cookie = signSession(42, 'secret-a', Date.now());
    assert.equal(verifySession(cookie, 'secret-b'), null);
  });

  test('rejects a tampered payload', () => {
    const cookie = signSession(42, 'secret-a', Date.now());
    const tampered = cookie.replace(/^\d+/, '999');
    assert.equal(verifySession(tampered, 'secret-a'), null);
  });

  test('rejects an expired session', () => {
    const now = Date.now();
    const cookie = signSession(42, 'secret-a', now - 200 * 24 * 60 * 60 * 1000);
    assert.equal(verifySession(cookie, 'secret-a', now), null);
  });

  test('rejects malformed cookie values', () => {
    assert.equal(verifySession('not-a-valid-cookie', 'secret-a'), null);
    assert.equal(verifySession(undefined, 'secret-a'), null);
    assert.equal(verifySession('', 'secret-a'), null);
  });
});

describe('generateInviteToken', () => {
  test('generates unique url-safe tokens', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });
});

describe('parseCookies', () => {
  test('parses a cookie header into a key/value map', () => {
    assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  });

  test('returns an empty object for a missing header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('url-decodes values', () => {
    assert.deepEqual(parseCookies('gr_session=abc%2Edef'), { gr_session: 'abc.def' });
  });
});

describe('buildDiscordAuthUrl', () => {
  test('builds an authorize URL with client id, redirect uri, and state', () => {
    const url = buildDiscordAuthUrl({
      clientId: 'CID',
      redirectUri: 'http://localhost:3000/auth/discord/callback',
      state: 'abc123',
    });
    assert.match(url, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
    assert.match(url, /client_id=CID/);
    assert.match(url, /state=abc123/);
    assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fdiscord%2Fcallback/);
  });
});

describe('exchangeDiscordCode', () => {
  test('exchanges a code for an access token, then fetches the Discord profile', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url);
      if (url.includes('/oauth2/token')) {
        return { ok: true, json: async () => ({ access_token: 'TOKEN123' }) };
      }
      if (url.includes('/users/@me')) {
        assert.equal(options.headers.authorization, 'Bearer TOKEN123');
        return {
          ok: true,
          json: async () => ({ id: '999', username: 'seb', avatar: 'abc123' }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    };

    const user = await exchangeDiscordCode('CODE', {
      clientId: 'CID',
      clientSecret: 'SECRET',
      redirectUri: 'http://localhost:3000/auth/discord/callback',
      fetchImpl,
    });

    assert.equal(user.discordId, '999');
    assert.equal(user.username, 'seb');
    assert.equal(user.avatarUrl, 'https://cdn.discordapp.com/avatars/999/abc123.png');
    assert.equal(calls.length, 2);
  });

  test('returns a null avatarUrl when the user has no Discord avatar set', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'T' }) };
      return { ok: true, json: async () => ({ id: '1', username: 'noavatar', avatar: null }) };
    };
    const user = await exchangeDiscordCode('CODE', {
      clientId: 'CID',
      clientSecret: 'SECRET',
      redirectUri: 'http://x/callback',
      fetchImpl,
    });
    assert.equal(user.avatarUrl, null);
  });

  test('throws when the token exchange fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400 });
    await assert.rejects(() =>
      exchangeDiscordCode('BAD', { clientId: 'C', clientSecret: 'S', redirectUri: 'http://x', fetchImpl })
    );
  });

  test('throws when the profile fetch fails', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'T' }) };
      return { ok: false, status: 401 };
    };
    await assert.rejects(() =>
      exchangeDiscordCode('CODE', { clientId: 'C', clientSecret: 'S', redirectUri: 'http://x', fetchImpl })
    );
  });
});
