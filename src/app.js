import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureSkipsCurrent } from './db.js';
import { fetchOwnedGames, searchStoreGames } from './steam.js';
import {
  buildDiscordAuthUrl,
  exchangeDiscordCode,
  signSession,
  verifySession,
  generateInviteToken,
  parseCookies,
  SESSION_TTL_MS,
} from './auth.js';

const SESSION_COOKIE = 'gr_session';
const OAUTH_STATE_COOKIE = 'gr_oauth_state';

// Express 4 doesn't forward a rejected promise from an async handler to the
// error middleware on its own (that's an Express 5 behavior) — without this,
// a DB error would just hang the request instead of returning a response.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp(
  db,
  {
    steamApiKey,
    fetchImpl = fetch,
    rng = Math.random,
    sessionSecret,
    discordClientId,
    discordClientSecret,
    discordRedirectUri,
    initialLeaderDiscordId,
  } = {}
) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
        "script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'"
    );
    next();
  });

  // --- Auth ---

  const requireAuth = ah(async (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const playerId = verifySession(cookies[SESSION_COOKIE], sessionSecret);
    const player = playerId ? await db.prepare('SELECT * FROM players WHERE id = ?').get(playerId) : null;
    if (!player) {
      return res.status(401).json({ error: 'authentication required' });
    }
    req.player = player;
    next();
  });

  function requireLeader(req, res, next) {
    if (req.player.role !== 'leader') {
      return res.status(403).json({ error: 'leader role required' });
    }
    next();
  }

  app.use('/api', requireAuth);

  app.get('/auth/discord', (req, res) => {
    const invite = req.query.invite ?? '';
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, `${nonce}.${invite}`, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000,
    });
    res.redirect(
      buildDiscordAuthUrl({ clientId: discordClientId, redirectUri: discordRedirectUri, state: nonce })
    );
  });

  app.get(
    '/auth/discord/callback',
    ah(async (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      const stored = cookies[OAUTH_STATE_COOKIE];
      const [nonce, invite] = (stored ?? '').split('.');
      if (!stored || !req.query.state || req.query.state !== nonce) {
        return res.status(400).send('Invalid or expired login attempt. Please try logging in again.');
      }

      let discordUser;
      try {
        discordUser = await exchangeDiscordCode(req.query.code, {
          clientId: discordClientId,
          clientSecret: discordClientSecret,
          redirectUri: discordRedirectUri,
          fetchImpl,
        });
      } catch (err) {
        return res.status(502).send('Discord login failed. Please try again.');
      }

      let player = await db.prepare('SELECT * FROM players WHERE discord_id = ?').get(discordUser.discordId);

      if (!player) {
        const isInitialLeader = Boolean(initialLeaderDiscordId) && discordUser.discordId === initialLeaderDiscordId;
        let role = 'member';

        if (!isInitialLeader) {
          const inviteRow = invite ? await db.prepare('SELECT * FROM invites WHERE token = ?').get(invite) : null;
          const now = new Date().toISOString();
          const valid =
            inviteRow &&
            (!inviteRow.expires_at || inviteRow.expires_at > now) &&
            (inviteRow.max_uses == null || inviteRow.use_count < inviteRow.max_uses);
          if (!valid) {
            return res
              .status(403)
              .send('This invite link is invalid or expired. Ask your group leader for a new one.');
          }
          await db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?').run(inviteRow.id);
        } else {
          role = 'leader';
        }

        const result = await db
          .prepare(
            `INSERT INTO players (name, discord_id, discord_username, discord_avatar_url, role, skip_quota, skips_remaining, skip_month)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?)`
          )
          .run(
            discordUser.username,
            discordUser.discordId,
            discordUser.username,
            discordUser.avatarUrl,
            role,
            currentMonth()
          );
        player = await db.prepare('SELECT * FROM players WHERE id = ?').get(result.lastInsertRowid);
      }

      res.cookie(SESSION_COOKIE, signSession(player.id, sessionSecret), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS,
      });
      res.clearCookie(OAUTH_STATE_COOKIE);
      res.redirect('/');
    })
  );

  app.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  app.get('/api/me', (req, res) => {
    const { id, name, role, discord_username, discord_avatar_url } = req.player;
    res.json({ id, name, role, discord_username, discord_avatar_url });
  });

  app.post(
    '/api/invites',
    requireLeader,
    ah(async (req, res) => {
      const { max_uses = null, expires_at = null } = req.body ?? {};
      const token = generateInviteToken();
      await db
        .prepare('INSERT INTO invites (token, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(token, req.player.id, max_uses, expires_at, new Date().toISOString());
      res.status(201).json({ token, url: `/auth/discord?invite=${token}` });
    })
  );

  // --- Games ---

  app.get(
    '/api/games',
    ah(async (req, res) => {
      const includeInactive = req.query.all === '1';
      const rows = includeInactive
        ? await db.prepare('SELECT * FROM games ORDER BY title').all()
        : await db.prepare('SELECT * FROM games WHERE active = 1 ORDER BY title').all();
      res.json(rows);
    })
  );

  app.post(
    '/api/games',
    requireLeader,
    ah(async (req, res) => {
      const { title, steam_appid = null, cover_url = null } = req.body ?? {};
      if (!title || typeof title !== 'string') {
        return res.status(400).json({ error: 'title is required' });
      }
      const result = await db
        .prepare('INSERT INTO games (title, steam_appid, cover_url, active) VALUES (?, ?, ?, 1)')
        .run(title, steam_appid, cover_url);
      const game = await db.prepare('SELECT * FROM games WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(game);
    })
  );

  app.put(
    '/api/games/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'game not found' });
      }
      const title = req.body?.title ?? existing.title;
      const steam_appid = req.body?.steam_appid ?? existing.steam_appid;
      const cover_url = req.body?.cover_url ?? existing.cover_url;
      await db.prepare('UPDATE games SET title = ?, steam_appid = ?, cover_url = ? WHERE id = ?').run(
        title,
        steam_appid,
        cover_url,
        req.params.id
      );
      res.json(await db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id));
    })
  );

  app.delete(
    '/api/games/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'game not found' });
      }
      const hasHistory = await db
        .prepare('SELECT 1 FROM match_rounds WHERE spun_game_id = ? LIMIT 1')
        .get(req.params.id);
      if (hasHistory) {
        return res.status(409).json({ error: 'cannot delete a game that appears in match history' });
      }
      await db.prepare('DELETE FROM roulette_games WHERE game_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
      res.status(204).end();
    })
  );

  // --- Players ---

  function currentMonth() {
    return new Date().toISOString().slice(0, 7);
  }

  app.get(
    '/api/players',
    ah(async (req, res) => {
      const players = await db.prepare('SELECT id FROM players').all();
      for (const p of players) {
        await ensureSkipsCurrent(db, p.id);
      }
      res.json(await db.prepare('SELECT * FROM players ORDER BY name').all());
    })
  );

  app.post(
    '/api/players',
    requireLeader,
    ah(async (req, res) => {
      const { name, skip_quota = 1, steam_id64 = null } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      const result = await db
        .prepare('INSERT INTO players (name, steam_id64, skip_quota, skips_remaining, skip_month) VALUES (?, ?, ?, ?, ?)')
        .run(name, steam_id64, skip_quota, skip_quota, currentMonth());
      res.status(201).json(await db.prepare('SELECT * FROM players WHERE id = ?').get(result.lastInsertRowid));
    })
  );

  app.put(
    '/api/players/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'player not found' });
      }
      const name = req.body?.name ?? existing.name;
      const skip_quota = req.body?.skip_quota ?? existing.skip_quota;
      const steam_id64 = req.body?.steam_id64 ?? existing.steam_id64;
      const skips_remaining = req.body?.skips_remaining ?? existing.skips_remaining;
      const role = req.body?.role ?? existing.role;
      if (role !== 'leader' && role !== 'member') {
        return res.status(400).json({ error: "role must be 'leader' or 'member'" });
      }
      if (existing.role === 'leader' && role === 'member') {
        const { count } = await db.prepare("SELECT COUNT(*) AS count FROM players WHERE role = 'leader'").get();
        if (count <= 1) {
          return res.status(409).json({ error: 'cannot demote the only remaining leader' });
        }
      }
      await db
        .prepare('UPDATE players SET name = ?, skip_quota = ?, steam_id64 = ?, skips_remaining = ?, role = ? WHERE id = ?')
        .run(name, skip_quota, steam_id64, skips_remaining, role, req.params.id);
      res.json(await db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id));
    })
  );

  app.delete(
    '/api/players/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'player not found' });
      }
      await db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
      res.status(204).end();
    })
  );

  app.post(
    '/api/players/:id/steam-import',
    requireLeader,
    ah(async (req, res) => {
      const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
      if (!player) {
        return res.status(404).json({ error: 'player not found' });
      }
      if (!player.steam_id64) {
        return res.status(400).json({ error: 'player has no steam_id64 set' });
      }

      let games;
      try {
        games = await fetchOwnedGames(player.steam_id64, { apiKey: steamApiKey, fetchImpl });
      } catch (err) {
        return res.status(502).json({ error: 'failed to reach Steam API' });
      }

      const upsertGame = db.prepare(
        `INSERT INTO games (title, steam_appid, active) VALUES (?, ?, 1)
         ON CONFLICT(steam_appid) DO UPDATE SET title = excluded.title`
      );
      const linkOwnership = db.prepare('INSERT OR IGNORE INTO player_games (player_id, appid) VALUES (?, ?)');

      await db.prepare('DELETE FROM player_games WHERE player_id = ?').run(player.id);
      for (const g of games) {
        await upsertGame.run(g.name, g.appid);
        await linkOwnership.run(player.id, g.appid);
      }

      res.json({ imported: games.length });
    })
  );

  app.get(
    '/api/steam/search',
    ah(async (req, res) => {
      const q = (req.query.q ?? '').trim();
      if (q.length < 2) {
        return res.status(400).json({ error: 'q must be at least 2 characters' });
      }
      try {
        const results = await searchStoreGames(q, { fetchImpl });
        res.json(results);
      } catch (err) {
        res.status(502).json({ error: 'failed to reach Steam store search' });
      }
    })
  );

  app.get(
    '/api/steam/common',
    ah(async (req, res) => {
      const ids = (req.query.playerIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length < 2) {
        return res.status(400).json({ error: 'provide at least 2 playerIds' });
      }
      const placeholders = ids.map(() => '?').join(',');
      const rows = await db
        .prepare(
          `SELECT g.* FROM games g
           JOIN player_games pg ON pg.appid = g.steam_appid
           WHERE pg.player_id IN (${placeholders})
           GROUP BY g.id
           HAVING COUNT(DISTINCT pg.player_id) = ?
           ORDER BY g.title`
        )
        .all(...ids, ids.length);
      res.json(rows);
    })
  );

  // --- Roulettes ---

  app.get(
    '/api/roulettes',
    ah(async (req, res) => {
      res.json(await db.prepare('SELECT * FROM roulettes ORDER BY name').all());
    })
  );

  app.get(
    '/api/roulettes/:id',
    ah(async (req, res) => {
      const roulette = await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(req.params.id);
      if (!roulette) {
        return res.status(404).json({ error: 'roulette not found' });
      }
      const games = await db
        .prepare(
          `SELECT g.* FROM games g
           JOIN roulette_games rg ON rg.game_id = g.id
           WHERE rg.roulette_id = ?
           ORDER BY g.title`
        )
        .all(req.params.id);
      res.json({ ...roulette, games });
    })
  );

  app.post(
    '/api/roulettes',
    requireLeader,
    ah(async (req, res) => {
      const { name } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      const result = await db.prepare('INSERT INTO roulettes (name) VALUES (?)').run(name);
      res.status(201).json(await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(result.lastInsertRowid));
    })
  );

  app.put(
    '/api/roulettes/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'roulette not found' });
      }
      const name = req.body?.name ?? existing.name;
      await db.prepare('UPDATE roulettes SET name = ? WHERE id = ?').run(name, req.params.id);
      res.json(await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(req.params.id));
    })
  );

  app.delete(
    '/api/roulettes/:id',
    requireLeader,
    ah(async (req, res) => {
      const existing = await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'roulette not found' });
      }
      await db.prepare('DELETE FROM roulette_games WHERE roulette_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM roulettes WHERE id = ?').run(req.params.id);
      res.status(204).end();
    })
  );

  app.post(
    '/api/roulettes/:id/games',
    requireLeader,
    ah(async (req, res) => {
      const roulette = await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(req.params.id);
      if (!roulette) {
        return res.status(404).json({ error: 'roulette not found' });
      }
      const { game_id } = req.body ?? {};
      const game = await db.prepare('SELECT * FROM games WHERE id = ?').get(game_id);
      if (!game) {
        return res.status(400).json({ error: 'game_id is invalid' });
      }
      await db
        .prepare('INSERT OR IGNORE INTO roulette_games (roulette_id, game_id) VALUES (?, ?)')
        .run(req.params.id, game_id);
      res.status(204).end();
    })
  );

  app.delete(
    '/api/roulettes/:id/games/:gameId',
    requireLeader,
    ah(async (req, res) => {
      await db
        .prepare('DELETE FROM roulette_games WHERE roulette_id = ? AND game_id = ?')
        .run(req.params.id, req.params.gameId);
      res.status(204).end();
    })
  );

  // --- Matches ---

  async function getPool(matchId, rouletteId) {
    return db
      .prepare(
        `SELECT g.* FROM games g
         JOIN roulette_games rg ON rg.game_id = g.id
         WHERE rg.roulette_id = ? AND g.active = 1
           AND g.id NOT IN (
             SELECT spun_game_id FROM match_rounds WHERE match_id = ? AND outcome = 'eliminated'
           )
         ORDER BY g.id`
      )
      .all(rouletteId, matchId);
  }

  async function getRoundInfo(match) {
    const settled = (
      await db
        .prepare("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND outcome IN ('eliminated', 'won')")
        .get(match.id)
    ).n;
    const round_number = settled + 1;
    const round_type = round_number <= match.elimination_rounds ? 'elimination' : 'final';
    return { round_number, round_type };
  }

  app.post(
    '/api/matches',
    ah(async (req, res) => {
      const { roulette_id, elimination_rounds } = req.body ?? {};
      const roulette = await db.prepare('SELECT * FROM roulettes WHERE id = ?').get(roulette_id);
      if (!roulette) {
        return res.status(400).json({ error: 'roulette_id is invalid' });
      }
      if (!Number.isInteger(elimination_rounds) || elimination_rounds < 0) {
        return res.status(400).json({ error: 'elimination_rounds must be a non-negative integer' });
      }
      const now = new Date().toISOString();
      const result = await db
        .prepare("INSERT INTO matches (roulette_id, created_at, elimination_rounds, status) VALUES (?, ?, ?, 'waiting')")
        .run(roulette_id, now, elimination_rounds);
      await db
        .prepare('INSERT INTO match_players (match_id, player_id, joined_at) VALUES (?, ?, ?)')
        .run(result.lastInsertRowid, req.player.id, now);
      res.status(201).json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(result.lastInsertRowid));
    })
  );

  app.post(
    '/api/matches/:id/join',
    ah(async (req, res) => {
      const match = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      if (match.status !== 'waiting') {
        return res.status(409).json({ error: 'this match has already started' });
      }
      const already = await db
        .prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?')
        .get(match.id, req.player.id);
      if (!already) {
        await db
          .prepare('INSERT INTO match_players (match_id, player_id, joined_at) VALUES (?, ?, ?)')
          .run(match.id, req.player.id, new Date().toISOString());
      }
      res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
    })
  );

  app.post(
    '/api/matches/:id/start',
    ah(async (req, res) => {
      const match = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      if (match.status !== 'waiting') {
        return res.status(409).json({ error: 'this match has already started' });
      }
      const { count } = await db
        .prepare('SELECT COUNT(*) AS count FROM match_players WHERE match_id = ?')
        .get(match.id);
      if (count < 1) {
        return res.status(409).json({ error: 'at least one player must join before starting' });
      }
      await db.prepare("UPDATE matches SET status = 'in_progress' WHERE id = ?").run(match.id);
      res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
    })
  );

  app.post(
    '/api/matches/:id/cancel',
    requireLeader,
    ah(async (req, res) => {
      const match = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      if (match.status === 'complete' || match.status === 'cancelled') {
        return res.status(409).json({ error: 'match is already complete' });
      }
      await db.prepare("UPDATE matches SET status = 'cancelled' WHERE id = ?").run(match.id);
      res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
    })
  );

  app.post(
    '/api/matches/:id/spin',
    ah(async (req, res) => {
      const match = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      if (match.status === 'waiting') {
        return res.status(409).json({ error: 'start the match before spinning' });
      }
      if (match.status !== 'in_progress') {
        return res.status(409).json({ error: 'match is already complete' });
      }
      if (match.pending_game_id) {
        return res.status(409).json({ error: 'resolve the current spin before spinning again' });
      }

      const pool = await getPool(match.id, match.roulette_id);
      if (pool.length === 0) {
        return res.status(409).json({ error: 'no games left in the pool' });
      }

      const { round_number, round_type } = await getRoundInfo(match);
      if (round_type === 'elimination' && pool.length <= 1) {
        return res.status(409).json({ error: 'not enough games left to eliminate further' });
      }

      const spun_game = pool[Math.floor(rng() * pool.length)];
      await db.prepare('UPDATE matches SET pending_game_id = ? WHERE id = ?').run(spun_game.id, match.id);

      res.json({ round_number, round_type, spun_game });
    })
  );

  app.post(
    '/api/matches/:id/resolve',
    ah(async (req, res) => {
      const match = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      if (!match.pending_game_id) {
        return res.status(409).json({ error: 'no pending spin to resolve' });
      }

      const { outcome, skip_used_by } = req.body ?? {};
      const { round_number, round_type } = await getRoundInfo(match);

      if (outcome === 'skip') {
        if (req.player.role !== 'leader' && skip_used_by !== req.player.id) {
          return res.status(403).json({ error: 'can only use your own skip' });
        }
        const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(skip_used_by);
        if (!player) {
          return res.status(400).json({ error: 'skip_used_by must be a valid player id' });
        }
        const joined = await db
          .prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?')
          .get(match.id, player.id);
        if (!joined) {
          return res.status(400).json({ error: 'player did not join this match' });
        }
        await ensureSkipsCurrent(db, player.id);
        const current = await db.prepare('SELECT * FROM players WHERE id = ?').get(player.id);
        if (current.skips_remaining <= 0) {
          return res.status(400).json({ error: 'player has no skips remaining this month' });
        }
        await db.prepare('UPDATE players SET skips_remaining = skips_remaining - 1 WHERE id = ?').run(player.id);
        await db
          .prepare(
            "INSERT INTO match_rounds (match_id, round_number, round_type, spun_game_id, outcome, skip_used_by) VALUES (?, ?, ?, ?, 'skipped', ?)"
          )
          .run(match.id, round_number, round_type, match.pending_game_id, player.id);
        await db.prepare('UPDATE matches SET pending_game_id = NULL WHERE id = ?').run(match.id);
        return res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
      }

      if (outcome === 'eliminate') {
        if (round_type !== 'elimination') {
          return res.status(400).json({ error: 'eliminate is only valid on elimination rounds' });
        }
        await db
          .prepare(
            "INSERT INTO match_rounds (match_id, round_number, round_type, spun_game_id, outcome) VALUES (?, ?, ?, ?, 'eliminated')"
          )
          .run(match.id, round_number, round_type, match.pending_game_id);
        await db.prepare('UPDATE matches SET pending_game_id = NULL WHERE id = ?').run(match.id);
        return res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
      }

      if (outcome === 'confirm_win') {
        if (round_type !== 'final') {
          return res.status(400).json({ error: 'confirm_win is only valid on the final round' });
        }
        await db
          .prepare(
            "INSERT INTO match_rounds (match_id, round_number, round_type, spun_game_id, outcome) VALUES (?, ?, ?, ?, 'won')"
          )
          .run(match.id, round_number, round_type, match.pending_game_id);
        await db
          .prepare("UPDATE matches SET pending_game_id = NULL, status = 'complete', result_game_id = ? WHERE id = ?")
          .run(match.pending_game_id, match.id);
        return res.json(await db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
      }

      res.status(400).json({ error: 'outcome must be one of: eliminate, skip, confirm_win' });
    })
  );

  // --- History ---

  app.get(
    '/api/matches',
    ah(async (req, res) => {
      const rows = await db
        .prepare(
          `SELECT m.*, r.name AS roulette_name
           FROM matches m
           JOIN roulettes r ON r.id = m.roulette_id
           ORDER BY m.created_at DESC`
        )
        .all();
      res.json(rows);
    })
  );

  app.get(
    '/api/matches/:id',
    ah(async (req, res) => {
      const match = await db
        .prepare(
          `SELECT m.*, r.name AS roulette_name, g.title AS result_game_title
           FROM matches m
           JOIN roulettes r ON r.id = m.roulette_id
           LEFT JOIN games g ON g.id = m.result_game_id
           WHERE m.id = ?`
        )
        .get(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'match not found' });
      }
      const rounds = await db
        .prepare(
          `SELECT mr.*, g.title AS spun_game_title, p.name AS skip_used_by_name
           FROM match_rounds mr
           JOIN games g ON g.id = mr.spun_game_id
           LEFT JOIN players p ON p.id = mr.skip_used_by
           WHERE mr.match_id = ?
           ORDER BY mr.id`
        )
        .all(req.params.id);
      const players = await db
        .prepare(
          `SELECT p.id, p.name, p.role
           FROM match_players mp
           JOIN players p ON p.id = mp.player_id
           WHERE mp.match_id = ?
           ORDER BY mp.joined_at`
        )
        .all(req.params.id);
      res.json({ ...match, rounds, players });
    })
  );

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
