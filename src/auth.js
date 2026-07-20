import crypto from 'node:crypto';

const DISCORD_API = 'https://discord.com/api';
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function buildDiscordAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export async function exchangeDiscordCode(code, { clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const tokenRes = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
  }
  const { access_token } = await tokenRes.json();

  const userRes = await fetchImpl(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discord profile fetch failed: ${userRes.status}`);
  }
  const user = await userRes.json();

  return {
    discordId: user.id,
    username: user.username,
    avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
  };
}

export function signSession(playerId, secret, now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  const payload = `${playerId}.${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifySession(cookieValue, secret, now = Date.now()) {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [playerId, expires, sig] = parts;
  if (!/^\d+$/.test(playerId) || !/^\d+$/.test(expires)) return null;

  const payload = `${playerId}.${expires}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  if (Number(expires) < now) return null;
  return Number(playerId);
}

export function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}
