import { signSession } from '../src/auth.js';

export const TEST_SESSION_SECRET = 'test-session-secret';

// Sorts after any test-created player name starting with A-Y, so index-based
// assertions on GET /api/players (ordered by name) keep working unchanged.
const LEADER_NAME = 'Zz_TestLeader';

export async function seedLeader(db) {
  const month = new Date().toISOString().slice(0, 7);
  const result = await db
    .prepare(
      `INSERT INTO players (name, discord_id, discord_username, role, skip_quota, skips_remaining, skip_month)
       VALUES (?, ?, ?, 'leader', 1, 1, ?)`
    )
    .run(LEADER_NAME, `discord-${LEADER_NAME}`, LEADER_NAME, month);
  return result.lastInsertRowid;
}

export async function leaderCookie(db, secret = TEST_SESSION_SECRET) {
  const id = await seedLeader(db);
  return `gr_session=${signSession(id, secret)}`;
}

export function sessionCookieFor(playerId, secret = TEST_SESSION_SECRET) {
  return `gr_session=${signSession(playerId, secret)}`;
}
