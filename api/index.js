import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// Module-level (not per-request) so the DB connection is reused across warm
// invocations of this serverless function, instead of reconnecting every call.
const db = await createDb(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);
const app = createApp(db, {
  steamApiKey: process.env.STEAM_API_KEY,
  sessionSecret: process.env.SESSION_SECRET,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI,
  initialLeaderDiscordId: process.env.INITIAL_LEADER_DISCORD_ID,
});

export default app;
