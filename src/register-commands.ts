import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands.js";

const c = config();
if (!c.DISCORD_TOKEN || !c.DISCORD_CLIENT_ID) throw new Error("set DISCORD_TOKEN and DISCORD_CLIENT_ID to register slash commands");
const rest = new REST().setToken(c.DISCORD_TOKEN);
const route = c.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(c.DISCORD_CLIENT_ID, c.DISCORD_GUILD_ID)
  : Routes.applicationCommands(c.DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(
  `Registered ${commands.length} commands ${c.DISCORD_GUILD_ID ? `to guild ${c.DISCORD_GUILD_ID}` : "globally (may take up to an hour to appear)"}`,
);
