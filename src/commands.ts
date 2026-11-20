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
].map((c) => c.toJSON());
