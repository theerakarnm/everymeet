import { InteractionContextType, SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("record")
    .setDescription("Start recording the voice channel you are in")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("end")
    .setDescription("Stop recording and post the meeting minutes")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("record-meet")
    .setDescription("Send the bot into a Google Meet call and record it")
    .addStringOption((o) =>
      o.setName("url").setDescription("Google Meet link, e.g. https://meet.google.com/abc-defg-hij").setRequired(true),
    )
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());
