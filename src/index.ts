import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { activeSessions } from "./recorder/session.js";
import { activeMeets, MeetSession, type StartMeet } from "./meet/session.js";
import { processMeeting, recoverUnfinished } from "./pipeline/run.js";
import { handleInteraction, handleVoiceStateUpdate } from "./interactions.js";
import { startWebServer } from "./web/server.js";
import { logger } from "./util/log.js";

const log = logger("bot");
const c = config(); // fail fast on bad env

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/** Both Google Meet triggers (the web page and the calendar) start recordings through this. */
const startMeet: StartMeet = (meet) => MeetSession.start(meet, (m) => void processMeeting(client, m));

client.on(Events.InteractionCreate, (interaction) => handleInteraction(client, interaction));
client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);

client.once(Events.ClientReady, async (ready) => {
  log.info(`logged in as ${ready.user.tag}`);
  await recoverUnfinished(client, "discord");
});

async function shutdown(signal: string) {
  log.info(`${signal} received, stopping active recordings`);
  // Discord recordings end now; Google Meet recordings keep running on Cloudflare and are re-attached on boot.
  await Promise.allSettled([...activeSessions.values()].map((s) => s.shutdown()));
  for (const s of activeMeets.values()) await s.shutdown();
  // Processing continues after restart thanks to recoverUnfinished().
  await client.destroy();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));

// Google Meet recordings run on Cloudflare and need no Discord login: re-attach them before anything can start a new one.
await recoverUnfinished(client, "meet");
startWebServer({ startMeet });
await client.login(c.DISCORD_TOKEN);
