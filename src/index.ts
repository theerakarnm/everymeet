import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { activeSessions } from "./recorder/session.js";
import { recoverUnfinished } from "./pipeline/run.js";
import { handleInteraction, handleVoiceStateUpdate } from "./interactions.js";
import { startWebServer } from "./web/server.js";
import { logger } from "./util/log.js";

const log = logger("bot");
const c = config(); // fail fast on bad env

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.on(Events.InteractionCreate, (interaction) => handleInteraction(client, interaction));
client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);

client.once(Events.ClientReady, async (ready) => {
  log.info(`logged in as ${ready.user.tag}`);
  await recoverUnfinished(client);
});

async function shutdown(signal: string) {
  log.info(`${signal} received, ending active recordings`);
  await Promise.allSettled([...activeSessions.values()].map((s) => s.end("the bot is shutting down")));
  // Processing continues after restart thanks to recoverUnfinished().
  await client.destroy();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));

startWebServer();
await client.login(c.DISCORD_TOKEN);
