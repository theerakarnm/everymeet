import { config } from "./src/config.js";

const c = config();
const api = "https://discord.com/api/v10";
const headers = { Authorization: `Bot ${c.DISCORD_TOKEN}` };

const me = await (await fetch(`${api}/oauth2/applications/@me`, { headers })).json();
console.log("application id:", me.id, "| name:", me.name);
const guilds = await (await fetch(`${api}/users/@me/guilds`, { headers })).json();
console.log("bot is member of guilds:");
for (const g of guilds) console.log(`  ${g.id}  ${g.name}`);
const gcmds = await (await fetch(`${api}/applications/${c.DISCORD_CLIENT_ID}/guilds/${c.DISCORD_GUILD_ID}/commands`, { headers })).json();
console.log(`commands registered in guild ${c.DISCORD_GUILD_ID}:`, Array.isArray(gcmds) ? gcmds.map((x: any) => x.name) : gcmds);
const acmds = await (await fetch(`${api}/applications/${c.DISCORD_CLIENT_ID}/commands`, { headers })).json();
console.log("global commands:", Array.isArray(acmds) ? acmds.map((x: any) => x.name) : acmds);
