import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { createApp } from './app.js';

const REQUIRED_ENV_VARS = [
  'SESSION_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
];
const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`
  );
}

const dbUrl =
  process.env.TURSO_DATABASE_URL ??
  `file:${process.env.DB_PATH ?? fileURLToPath(new URL('../roulette.db', import.meta.url))}`;
const db = await createDb(dbUrl, process.env.TURSO_AUTH_TOKEN);
const app = createApp(db, {
  steamApiKey: process.env.STEAM_API_KEY,
  sessionSecret: process.env.SESSION_SECRET,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI,
  initialLeaderDiscordId: process.env.INITIAL_LEADER_DISCORD_ID,
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`Game Roulette listening on http://localhost:${port}`);
});
