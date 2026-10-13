import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type VoiceState,
} from "discord.js";
import { config } from "./config.js";
import { activeSessions, CONTINUE_BUTTON_PREFIX, MeetingSession } from "./recorder/session.js";
import { processMeeting } from "./pipeline/run.js";
import { logger } from "./util/log.js";

const log = logger("bot");

async function handleRecord(client: Client, interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const member = interaction.member;
  const channel = member.voice.channel;
  if (!channel) {
    await interaction.reply({ content: "Join a voice channel first, then use /record.", flags: MessageFlags.Ephemeral });
    return;
  }
  const existing = activeSessions.get(interaction.guildId);
  if (existing) {
    await interaction.reply({
      content: `I am already recording in **${existing.manifest.voiceChannelName}**. Use /end there first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const me = interaction.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    await interaction.reply({
      content: `I don't have permission to join **${channel.name}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await MeetingSession.start({
      client,
      guild: interaction.guild,
      channel,
      commandChannelId: interaction.channelId,
      startedBy: { id: member.id, name: member.displayName },
      onFinished: (m) => void processMeeting(client, m),
    });
  } catch (err) {
    log.error("could not start recording", err);
    await interaction.editReply("I couldn't join the voice channel. Please try again.");
    return;
  }

  const announcement = `I am recording the voice in channel ${channel.name}`;
  await interaction.editReply(announcement);
  // Also post in the voice channel's own chat so people who join later see it.
  if (channel.id !== interaction.channelId && channel.isSendable()) {
    channel.send(`🔴 ${announcement}`).catch(() => {});
  }
}

async function handleEnd(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const session = activeSessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "Nothing is being recorded right now.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(
    `Recording in **${session.manifest.voiceChannelName}** stopped. I'm preparing the transcript and summary ` +
      `and will post them in #${config().MINUTES_CHANNEL_NAME} (or #${config().FALLBACK_CHANNEL_NAME}).`,
  );
  await session.end(`ended by ${interaction.member.displayName} with /end`);
}

export async function handleInteraction(client: Client, interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: "Use this command in a server.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === "record") await handleRecord(client, interaction);
      else if (interaction.commandName === "end") await handleEnd(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(CONTINUE_BUTTON_PREFIX)) {
      const id = interaction.customId.slice(CONTINUE_BUTTON_PREFIX.length);
      const session = [...activeSessions.values()].find((s) => s.id === id);
      if (!session) {
        await interaction.update({ content: "This recording has already ended.", components: [] });
        return;
      }
      await session.handleContinue(interaction);
    }
  } catch (err) {
    log.error("interaction failed", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

/** Any join/leave/move in the recorded channel re-checks the empty-channel rule. */
export function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const session = activeSessions.get(newState.guild.id);
  if (!session) return;
  const id = session.manifest.voiceChannelId;
  if (oldState.channelId === id || newState.channelId === id) session.checkEmpty();
}
