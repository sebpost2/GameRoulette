# Game Roulette

A shared roulette for a friend group that can never agree on what to play. Players join a lobby, the wheel spins
through elimination rounds down to one game, and anyone can burn one of their limited skips to veto a result.

**Live:** [game-roulette-psi.vercel.app](https://game-roulette-psi.vercel.app) (Discord login; accounts are invite-only)

## Features

- **Match lobby** — a match starts in *waiting*; players join, the leader starts it, then the spins begin.
- **Elimination rounds** — each spin eliminates a game until one winner is confirmed.
- **Skips** — every player has a skip quota; a skip vetoes the current result and forces a respin of the same round.
- **Roles and invites** — a leader manages players, skip quotas and matches; new members join through leader-generated invite links with a use limit and an expiry.
- **History** — every match is kept round by round: eliminations, skips and the winner.
- **Steam import** (optional) — search and import games from a Steam library.

## Stack

Node.js + Express · plain HTML/CSS/JS frontend (no build step) · libSQL (a local SQLite file in development, Turso in
production) · Discord OAuth and HMAC-signed session cookies written by hand in [`src/auth.js`](src/auth.js), without
passport or cookie-session · deployed on Vercel.

## Run it locally

```bash
npm install
cp .env.example .env   # fill in SESSION_SECRET and the Discord OAuth values
npm start              # http://localhost:3000
```

`.env.example` documents every variable. Leave `TURSO_DATABASE_URL` unset locally and the app uses a SQLite file.

## Tests

```bash
npm test               # Node's built-in test runner (node:test), no Jest/Vitest
npm run test:coverage
```

The suite covers the match state machine (lobby, rounds, skips, cancelling), players and roles, invites, the Discord
auth routes and session cookies, history, and the Steam import.
