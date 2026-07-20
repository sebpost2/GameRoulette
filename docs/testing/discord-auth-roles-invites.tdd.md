# TDD Evidence Report: Discord Login, Roles, and Invite Links

**Source plan**: agreed inline in conversation (no `*.plan.md` file — plan was presented in chat, revised once per user feedback, and confirmed before implementation).

## User Journeys

1. As a group leader, I want to log in with Discord (one click, no password), so friends aren't blocked by signup friction.
2. As a group leader, I want the deployment gated so random Discord users can't join — only people who redeem an invite link I generate, so my group's roster stays private.
3. As a returning player, I want to log in again without needing the invite link a second time, so I'm not re-gated every visit.
4. As a group leader, I want to manage the game/player/roulette catalog while regular members can only play (spin, skip, view), so one person doesn't accidentally wipe the roster.
5. As the deployer, I want the very first login (my own Discord account) to become leader automatically, so there's a bootstrapping path with no chicken-and-egg invite problem.

## Task Report

| Task | Summary | Validation command | Result |
|---|---|---|---|
| 1. DB schema | Added `discord_id`/`discord_username`/`discord_avatar_url`/`role` to `players`, new `invites` table, and an idempotent `ALTER TABLE`-if-missing migration so it's safe to run against an existing `roulette.db` | `node --test test/db.test.js` | RED (missing columns/table) → GREEN (5/5) |
| 2. Auth core | `src/auth.js`: Discord OAuth code exchange, HMAC-signed session cookies (90-day TTL, tamper- and expiry-checked via `crypto.timingSafeEqual`), invite token generation, cookie parsing — zero new dependencies | `node --test test/auth.test.js` | RED (missing module) → GREEN (14/14) |
| 3. Auth + invite routes | `GET /auth/discord` (redirect + CSRF-nonce cookie), `GET /auth/discord/callback` (exchanges code, enforces invite-or-initial-leader gate, sets session), `POST /auth/logout`, `GET /api/me`, `POST /api/invites` (leader-only, optional `max_uses`/`expires_at`) | `node --test test/auth-routes.test.js` | RED (404s) → GREEN (12/12) |
| 4. Route guards | Global `requireAuth` on all `/api/*`; `requireLeader` added to game/player/roulette CRUD and Steam import; match spin/resolve/skip left open to any authenticated member | `node --test` (full suite) | RED (existing tests 401'd) → GREEN (75/75) after wiring a shared leader session cookie into every existing integration test file |
| 5. Frontend | Login screen (redirects to `/auth/discord`, preserves `?invite=` from the URL), auth bar (avatar/name/logout/copy-invite-link), `.leader-only` elements hidden client-side for members | Manual only — no browser/E2E test infra exists in this repo | Not automated (see Coverage and known gaps) |
| 6. Server wiring | `src/server.js` fails fast at startup if `SESSION_SECRET`/`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`/`DISCORD_REDIRECT_URI` are unset; `.env.example` documents all required/optional vars for self-hosters | Manual read-through (no test — pure env-var wiring) | N/A |

## Test Specification

| # | What is guaranteed | Test file | Type | Result |
|---|---|---|---|---|
| 1 | `players` gains Discord/role columns; new `invites` table exists; migration path is idempotent for pre-existing DB files | `test/db.test.js` | unit | PASS |
| 2 | Session cookies verify only with the matching secret, reject tampering, and reject expiry | `test/auth.test.js` | unit | PASS |
| 3 | Invite tokens are unique and URL-safe | `test/auth.test.js` | unit | PASS |
| 4 | Discord code-exchange maps the API response to `{discordId, username, avatarUrl}`, handles missing avatar, and throws on either HTTP failure | `test/auth.test.js` | unit | PASS |
| 5 | `GET /auth/discord` sets a CSRF-nonce cookie and redirects with the right client id/state | `test/auth-routes.test.js` | integration | PASS |
| 6 | Callback: configured `INITIAL_LEADER_DISCORD_ID` becomes leader with no invite; unknown Discord users with no invite are rejected (403); OAuth state mismatch is rejected (400, CSRF guard) | `test/auth-routes.test.js` | integration | PASS |
| 7 | Valid invite redemption creates a member and increments `use_count`; redemption is rejected once `max_uses` is hit or after `expires_at` | `test/auth-routes.test.js` | integration | PASS |
| 8 | A returning player (existing `discord_id`) logs in again without an invite and without creating a duplicate row | `test/auth-routes.test.js` | integration | PASS |
| 9 | `POST /api/invites` requires auth and the leader role; `GET /api/me` requires auth | `test/auth-routes.test.js` | integration | PASS |
| 10 | Every pre-existing route (games, players, roulettes, matches, Steam import) now requires a valid session; leader-only routes reject a member session | full suite | integration | PASS (75/75) |

## Coverage and known gaps

`node --experimental-test-coverage --test`: **94.66% line / 84.49% branch / 92.00% function**, all four `src/` files above the 80% bar (`auth.js` and `db.js` are 100% line-covered).

Known, intentional gaps:
- **Frontend (Task 5) has no automated test.** This repo has no browser/E2E test harness (no Playwright/Vitest-DOM config exists), and adding one wasn't part of the agreed scope — flagging per the plan's own risk table rather than silently skipping it. Recommend manual verification before relying on it for the public release: log in as leader, confirm full access; open an invite link in a private window, confirm member-only view (no leader-only buttons, disabled roulette-membership checkboxes).
- **No invite-revoke-by-token endpoint.** Called out as an accepted v1 gap in the original plan's risk table — leader can stop *sharing* a link but can't invalidate one already sent. Add if it becomes a real problem (YAGNI).
- **`src/server.js` env-var wiring has no test** — it's pure `process.env` plumbing with no branching logic worth a reproducer; the fail-fast check was verified by reading, not executing (starting the real process requires live Discord credentials).

## Merge evidence

No git repository exists for this project (`git init` was never run), so there are no checkpoint commits to preserve — this report is the durable record of the RED/GREEN evidence for all six tasks.
