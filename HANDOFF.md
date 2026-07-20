# Handoff: Game Roulette

Friend-group game-picking roulette. Built via TDD across sessions. This doc exists so a fresh session (after `/clear`) can pick up without re-deriving context.

## Run it

```
cd d:\3_Hobbies\GameRoulette
npm start          # http://localhost:3000 (loads .env via --env-file)
npm test           # 76 tests, node's built-in runner
npm run test:coverage
```

`.env` (gitignored) is already filled in and working — Discord login is live and tested. `.env.example` documents the shape for anyone else self-hosting this. Required: `SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`. Optional: `INITIAL_LEADER_DISCORD_ID` (bootstraps that Discord account as leader, no invite needed), `STEAM_API_KEY`, `PORT`, `DB_PATH`.

**If you rotate the Discord client secret** (it was pasted in a chat session, so rotation was recommended — check whether that was actually done), update `.env` and restart.

## Stack (deliberately minimal)

- Node.js + Express + `node:sqlite` (built-in, no native deps — no `better-sqlite3`/node-gyp pain on Windows)
- Plain HTML/CSS/JS frontend in `public/` — no build step, no framework
- Tests: Node's built-in `node --test`, no Jest/Vitest
- Auth: hand-rolled Discord OAuth + HMAC-signed session cookies in `src/auth.js` — no `passport`/`cookie-session` dependency, the whole thing is ~90 lines

## What's built (all TDD'd, 76/76 passing, 94.68% line coverage)

- `src/db.js` — schema (`players`, `games`, `roulettes`, `roulette_games`, `matches`, `match_rounds`, `player_games`, `invites`) + monthly skip-reset logic + idempotent migration for `players`' Discord/role columns (safe to run against an old-schema `roulette.db`)
- `src/auth.js` — Discord OAuth code exchange, signed session cookies (90-day TTL), invite token generation, cookie parsing
- `src/app.js` — all REST routes: auth (`/auth/discord`, `/auth/discord/callback`, `/auth/logout`), `/api/me`, `/api/invites`, games/roulettes CRUD, players CRUD + skip quotas, Steam import + common-games intersection + live catalog search, match engine (spin/eliminate/skip/resolve), match history. `requireAuth` guards all of `/api/*`; `requireLeader` additionally guards games/players/roulettes CRUD + Steam import.
- `src/steam.js` — Steam Web API `GetOwnedGames` wrapper + `searchStoreGames` (public storesearch endpoint, no API key needed)
- `src/server.js` — entry point; fails fast at startup if required auth env vars are missing
- `public/index.html` + `app.js` + `style.css` — login screen, auth bar (avatar/name/logout/copy-invite-link), tabs: Play, Games, Roulettes, Players, History. Leader-only controls (`.leader-only` class) hidden client-side for members. Dark green/gold/red theme, animated CSS conic-gradient roulette wheel, bottom nav + card-style tables on mobile
- `docs/design/frontend-redesign.md` — the visual redesign spec
- `docs/testing/game-roulette.tdd.md` — RED/GREEN evidence for the original app
- `docs/testing/discord-auth-roles-invites.tdd.md` — RED/GREEN evidence for auth/roles/invites

## Auth model (new this session — the big addition)

- **Login**: Discord OAuth only, no passwords. One click.
- **Access gate**: a brand-new Discord account can't just log in — it needs a valid invite token (leader-generated via `POST /api/invites`, `Copy invite link` button in the UI) *or* to match `INITIAL_LEADER_DISCORD_ID`. Returning accounts (`discord_id` already in `players`) skip the invite requirement.
- **Roles**: `leader` (manages games/players/roulettes/Steam import, generates invites) vs `member` (plays: spin, skip, view). A `players` row now doubles as both a game-roster entry *and* a login identity — logging in creates/updates a `players` row.
- **Sessions**: HMAC-signed cookie (`gr_session`), 90-day TTL, `SESSION_SECRET`-keyed, tamper/expiry-checked via `crypto.timingSafeEqual`.
- **Known gap**: no invite-revoke-by-token endpoint (leader can stop sharing a link, can't invalidate one already sent — accepted for v1, add if it becomes a real problem).

## Match engine rules (the core mechanic, in case it needs revisiting)

- `POST /api/matches {roulette_id, elimination_rounds}` starts a match.
- `POST /api/matches/:id/spin` picks a random game from the current pool, stores it as `pending_game_id`. Must resolve before spinning again (409 otherwise).
- `POST /api/matches/:id/resolve {outcome, skip_used_by?}`:
  - `eliminate` — only valid on elimination rounds (round_number ≤ elimination_rounds). Removes the game from the pool permanently.
  - `confirm_win` — only valid on the final round (round_number == elimination_rounds + 1). Sets the match result.
  - `skip` — valid on any round. Requires `skip_used_by` (a player with `skips_remaining > 0`), decrements their skip count, and does **not** eliminate/win — round_number stays the same, forcing a respin of the same round.
- Round type is derived, not stored redundantly: `round_number <= elimination_rounds ? 'elimination' : 'final'`.

## Assumptions made (confirm/revisit if wrong)

- Skip quota defaults to 1/player/month, editable per-player.
- One deployment = one friend group (no multi-tenancy). If this ever needs to serve multiple independent friend groups off one instance, that's a real data-model change, not just an auth tweak — see the auth-planning conversation this session for why that was ruled out for now.
- No live-sync across simultaneous viewers (no websockets) — state updates via DB, others see it on refresh.
- Games are hard-deleted (`DELETE /api/games/:id` removes the row entirely, and its `roulette_games` memberships). If a game already appears in match history (`match_rounds.spun_game_id`), deletion is blocked with `409` instead.

## Known gaps / explicitly NOT built yet

- **No automated E2E test suite.** The whole auth/login/invite/role UI flow (Task 5 of the auth plan) was verified manually in a real browser this session — works end-to-end — but isn't covered by a maintained test file. If the UI grows, add `tests/e2e/*.spec.js`.
- **Steam "common games" intersection has no UI** — `GET /api/steam/common?playerIds=1,2,3` works and is tested, but nothing in the Roulettes tab surfaces it.
- **No hosting/deployment set up beyond localhost.** For friends to actually reach it, needs a tunnel (like the playit.gg pattern used for the Minecraft servers in `GameServers/`) or a small always-on host. If deployed publicly, `DISCORD_REDIRECT_URI` must be updated to match the real domain, both in `.env` and in the Discord Developer Portal's registered redirect.
- **Error surfacing in the UI is raw `alert()` calls** — functional but not polished.
- **`node:sqlite` is still an experimental Node API** (stable enough in Node 24, worth knowing if a future Node upgrade changes its behavior).
- **Roulette rename (`PUT /api/roulettes/:id`) has no UI.**
- **Not a git repo yet** — nothing has been committed, ever. Worth `git init` + initial commit soon; `.gitignore` (excludes `.env`, `roulette.db`, `node_modules/`) is already in place for when that happens.

## Where things are

Everything lives in `d:\3_Hobbies\GameRoulette\` — no other part of `d:\3_Hobbies` was touched. Real Discord OAuth credentials are in `.env` (gitignored) — do not print or commit its contents.
