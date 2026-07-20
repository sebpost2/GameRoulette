# Handoff: Game Roulette

Friend-group game-picking roulette. Built via TDD across sessions. This doc exists so a fresh session (after `/clear`) can pick up without re-deriving context.

## Current state: lobby feature complete, frontend changes uncommitted

The match-lobby feature (join before spin) is now fully implemented, frontend included. `public/index.html` and `public/app.js` were updated this session to add the lobby stage (Task 7 from the prior handoff) — these changes are **uncommitted**, verify and commit when ready.

## Run it

```
cd d:\3_Hobbies\GameRoulette
npm start          # http://localhost:3000 (loads .env via --env-file)
npm test           # 89 tests, node's built-in runner
npm run test:coverage
```

`.env` (gitignored) is already filled in and working — Discord login is live and tested. `.env.example` documents the shape for anyone else self-hosting this. Required: `SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`. Optional: `INITIAL_LEADER_DISCORD_ID` (bootstraps that Discord account as leader, no invite needed), `STEAM_API_KEY`, `PORT`, `DB_PATH`, `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (see below).

**If you rotate the Discord client secret** (it was pasted in a chat session, so rotation was recommended — check whether that was actually done), update `.env` and restart.

## Stack (deliberately minimal)

- Node.js + Express + `@libsql/client` (SQLite-compatible; works against a local file **or** a remote Turso database — switched from `node:sqlite` because Vercel's filesystem is ephemeral and can't hold a local SQLite file between serverless invocations)
- Plain HTML/CSS/JS frontend in `public/` — no build step, no framework
- Tests: Node's built-in `node --test`, no Jest/Vitest
- Auth: hand-rolled Discord OAuth + HMAC-signed session cookies in `src/auth.js` — no `passport`/`cookie-session` dependency
- Deployed on **Vercel** — linked via `.vercel/project.json` (project `game-roulette`), routed through `api/index.js` per `vercel.json`. **Not** connected to a git remote/GitHub, so nothing auto-deploys on commit — deploys are manual (`vercel --prod`) from whoever's local machine has the CLI and is linked.

## Git status

This **is** now a git repo (it wasn't, as of the previous handoff). Recent history:

```
cb2e9df feat: add match lobby - join before start, skip restricted to joined players
849b0de test: add reproducer for match lobby (join/start before spin)
dfb96ec Add friendly empty states, security hardening, and leader promote/demote
cba4d49 Disable Vercel's Express auto-detection
2591a6e Initial commit: Game Roulette
```

Working tree is clean as of this handoff (no uncommitted changes). No GitHub remote configured. The `vercel --prod` deploy now includes the full lobby feature (backend + frontend, through `56730db`) — live at <https://game-roulette-psi.vercel.app>, now including the cancel/replay/share-link work below.

## Lobby cancel, replay, and share link

Follow-up session after the lobby feature above. Three gaps the user reported after using the lobby: no way to cancel a match short of reloading, no way to start a new match after one completes without reloading, and no shareable link when opening a lobby.

- **Backend**: `POST /api/matches/:id/cancel` (`src/app.js`), leader-only (`requireLeader`, mirrors other CRUD routes). Allowed from `'waiting'` or `'in_progress'`, sets `status = 'cancelled'`; 409 if already `'complete'`/`'cancelled'`, 404 if unknown. TDD'd in `test/match.test.js` (`Match cancel (leader-only)` describe block, 6 tests) — RED/GREEN checkpoint commits `d81acb3`/`daed42b`.
- **Frontend** (`public/app.js` + `public/index.html`, commit `c9fa4a9`):
  - `#cancel-match-btn` — persistent button, leader-only (checked in JS via `isLeaderUser()`, not the global `.leader-only` class — that class is driven purely by role in `showApp()` and would fight with the match-status-based visibility here), shown whenever `currentMatch` is `waiting`/`in_progress`. Calls `resetPlayStage()` on confirm.
  - `resetPlayStage()` — the shared "back to setup" reset: stops lobby polling, clears `currentMatch`/`wheelGames`, re-shows `#play-setup`, hides `#play-lobby`/`.wheel-stage`/cancel button, reloads the roulette dropdown. Used by both cancel and the new "Play Another Roulette" button that `resolveMatch()` renders into `#play-actions` once `status === 'complete'`.
  - `#lobby-link` — leader-only, visible only in the lobby stage. Copies `${location.origin}/?match=<id>` to the clipboard (mirrors the existing `invite-btn` clipboard pattern).
  - `bootstrap()` now reads `?match=<id>` from the URL (`joinLobbyFromLink()`); if that match exists and is still `'waiting'`, it jumps straight into `enterLobby()` instead of the normal setup screen. If the match already started/ended/doesn't exist, it silently falls through to normal setup — no attempt to resume as a spectator into an in-progress match (that's out of scope, flagged in the original plan).
  - Manually verified via the Playwright-mocked-`/api/*` technique (no real second Discord account available): cancel-from-lobby returns to setup, cancel-from-in-progress returns to setup, complete → "Play Another Roulette" → setup, copy-link writes the expected URL to clipboard, and `?match=<id>` for a waiting match jumps straight into that lobby.
- **Known follow-up**: a GitHub Actions bot flagged a possible "authorization-bypass in src/app.js" on the cancel-endpoint commit via an automated background review, but the review's own output was malformed/unreadable beyond that one-line summary. Manual re-check of the diff (route registered after `app.use('/api', requireAuth)`, gated with `requireLeader` same as every other leader-only route) didn't turn up an actual issue — flagged here in case it resurfaces with better detail next session.

## What's built (all TDD'd, 89/89 passing)

- `src/db.js` — schema (`players`, `games`, `roulettes`, `roulette_games`, `matches`, `match_players` **(new)**, `match_rounds`, `player_games`, `invites`) + monthly skip-reset logic + idempotent migration for `players`' Discord/role columns
- `src/auth.js` — Discord OAuth code exchange, signed session cookies (90-day TTL), invite token generation, cookie parsing
- `src/app.js` — all REST routes (see below for the new lobby ones). `requireAuth` guards all of `/api/*`; `requireLeader` additionally guards games/players/roulettes CRUD + Steam import + role promote/demote.
- `src/steam.js` — Steam Web API `GetOwnedGames` wrapper + `searchStoreGames`
- `src/server.js` — entry point; fails fast at startup if required auth env vars are missing
- `public/index.html` + `app.js` + `style.css` — login screen, auth bar, tabs: Play, Games, Roulettes, Players, History. Empty-state messages on every tab when there's nothing to show yet (e.g. "No games added to this roulette yet"). Dark green/gold/red theme, animated CSS conic-gradient roulette wheel, bottom nav + card-style tables on mobile.
- `docs/design/frontend-redesign.md`, `docs/testing/game-roulette.tdd.md`, `docs/testing/discord-auth-roles-invites.tdd.md` — prior design/TDD evidence docs

## Auth model

- **Login**: Discord OAuth only, no passwords.
- **Access gate**: new Discord accounts need a valid invite token (leader-generated via `POST /api/invites`, "Copy invite link" button) *or* to match `INITIAL_LEADER_DISCORD_ID`. Default invite links have **no expiry and no use limit** — every friend can join off the same link. Returning accounts skip the invite requirement.
- **Roles**: `leader` vs `member`. **New this session**: leaders can now promote/demote *other* players between roles via `PUT /api/players/:id` (`{ role: 'leader' | 'member' }`), with a guard against demoting the sole remaining leader (409). Players tab shows a 👑 badge + Promote/Demote button per row (leader-only UI, but the underlying route is what's actually authoritative — it's `requireLeader`-gated).
- **Sessions**: HMAC-signed cookie (`gr_session`), 90-day TTL, tamper/expiry-checked via `crypto.timingSafeEqual`.
- **Security hardening (this session)**: CSP + security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS) on every response; `secure` flag on session/OAuth-state cookies; JSON body size capped at 100kb; skip usage (`resolve` outcome `'skip'`) requires `skip_used_by === req.player.id` unless the caller is a leader.
- **Known gap**: no invite-revoke-by-token endpoint.

## Match engine + the new lobby feature (in progress)

**Why this exists**: the user wanted a Kahoot-style flow — someone opens a roulette session, friends who are around join, and whoever's ready starts the game even if not everyone joined (e.g. start with 6 of 8 friends). Design was worked through via `/plan` and approved before implementation; see the conversation history for the full plan doc content (it was not written to a spec file — this was a deliberately lightweight/inline plan given the scope).

**Backend is done** (`src/app.js`, `src/db.js`, tests in `test/match.test.js`):

- `POST /api/matches` — now creates a match in **`'waiting'`** status (was `'in_progress'` before), and the creator is auto-inserted into the new `match_players` table.
- `POST /api/matches/:id/join` — **new**. Any authenticated player can join a `'waiting'` match (idempotent — joining twice is a no-op). 409 if the match already started.
- `POST /api/matches/:id/start` — **new**. Transitions `'waiting'` → `'in_progress'`. Requires ≥1 joined player (409 otherwise — practically unreachable since the creator auto-joins, but guarded anyway). 409 if already started. **Any player can start it** (not leader-restricted) — confirmed decision, matches the pre-existing (undocumented) behavior where match creation had no leader restriction either.
- `POST /api/matches/:id/spin` — unchanged logic, but now also rejects with a clear `409 "start the match before spinning"` if status is still `'waiting'` (previously the generic "match is already complete" message covered this case too, now split out).
- `POST /api/matches/:id/resolve` (outcome `'skip'`) — **new restriction**: `skip_used_by` must be a player who joined *this specific match* (checked against `match_players`), not just any player in the whole roster with skips remaining. Confirmed decision from planning.
- `GET /api/matches/:id` — now includes a `players: [{id, name, role}]` array of who joined, ordered by join time.

**Frontend is done** (built this session, from the approved plan's Task 7):

- `public/index.html`: Play tab now has two stages — `#play-setup` (pick roulette + rounds, "Open Lobby" button) and `#play-lobby` (joined-player chips, "Join" button, "Start Game" button); `.wheel-stage` starts hidden and is revealed only after the match starts.
- `public/app.js`: `play-start` click calls `POST /api/matches` then `enterLobby()`; polls `GET /api/matches/:id` every 3s while `status === 'waiting'` via `refreshLobby()`/`renderLobby()` (no websockets — polling is the agreed-upon simplest approach); "Join" calls the join endpoint; "Start Game" calls start, stops polling, hides the lobby, reveals the wheel, and proceeds into the existing `renderPlayActions()`/wheel flow. `loadPlayersForSkip()` now intersects the full roster with `GET /api/matches/:id`'s `players` array so the skip dropdown in `renderResolveActions` only offers players who joined this specific match.
- `public/style.css`: no changes needed — the lobby reuses the existing `.game-chip`/`.empty-state`/`.row`/`.hidden` patterns.
- Manually verified via Playwright with `/api/*` routes mocked (route-intercept technique, since there's no real multi-user way to test the join flow without two logged-in Discord accounts): confirmed the joined-player list renders and updates on the 3s poll (simulated a second player joining mid-poll), confirmed "Start Game" reveals the wheel and transitions match status, and confirmed the skip dropdown excludes a player who has skips remaining but never joined the match.

## Assumptions made (confirm/revisit if wrong)

- Skip quota defaults to 1/player/month, editable per-player.
- One deployment = one friend group (no multi-tenancy).
- No live-sync across simultaneous viewers beyond the new lobby's polling — everything else still updates via DB, seen on refresh.
- Games are hard-deleted; blocked with `409` if they appear in match history.
- Any logged-in player (not just leaders) can open a lobby and start a match — confirmed via `/plan` questioning.
- Skip eligibility during a match is scoped to players who joined that match — confirmed via `/plan` questioning.

## Known gaps / explicitly NOT built yet

- **The lobby frontend changes are uncommitted and undeployed** — commit and `vercel --prod` when ready.
- **No automated E2E test suite** — UI flows verified manually/via mocked-Playwright spot-checks, not a maintained `tests/e2e/*.spec.js`.
- **Steam "common games" intersection has no UI** — `GET /api/steam/common?playerIds=1,2,3` works and is tested, but nothing in the Roulettes tab surfaces it.
- **Error surfacing in the UI is raw `alert()` calls** for most flows — functional but not polished.
- **Roulette rename (`PUT /api/roulettes/:id`) has no UI.**
- **No invite-revoke-by-token endpoint.**
- **No GitHub remote / CI** — deploys are manual `vercel --prod` from a linked local machine.

## Where things are

Everything lives in `d:\3_Hobbies\GameRoulette\` — no other part of `d:\3_Hobbies` was touched. Real Discord OAuth credentials are in `.env` (gitignored) — do not print or commit its contents.
