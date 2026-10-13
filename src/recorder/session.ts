import { join } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Guild,
  type Message,
  type VoiceBasedChannel,
} from "discord.js";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { config, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { meetingDir, saveEverywhere, saveLocal, type Manifest } from "../storage/manifest.js";
import { newSessionId } from "../util/pin.js";
import { logger } from "../util/log.js";
import { TrackWriter, segmentPath } from "./track-writer.js";
import { SegmentUploader } from "./segment-uploader.js";

const log = logger("session");

export const CONTINUE_BUTTON_PREFIX = "meeting-continue:";
/** Wait this long past a segment boundary before closing it, so late packets still land. */
const SEGMENT_GRACE_SAMPLES = SAMPLE_RATE * 15;
const TICK_MS = 15_000;

/** One active recording per guild (a bot can only be in one voice channel per guild). */
export const activeSessions = new Map<string, MeetingSession>();

type OnFinished = (manifest: Manifest) => void;

export class MeetingSession {
  readonly manifest: Manifest;
  private connection!: VoiceConnection;
  private readonly writers = new Map<string, TrackWriter>();
  private readonly uploader: SegmentUploader;
  private readonly startedAtMs: number;
  private tick?: NodeJS.Timeout;
  private promptTimer?: NodeJS.Timeout;
  private promptTimeout?: NodeJS.Timeout;
  private promptMessage?: Message;
  private emptyTimer?: NodeJS.Timeout;
  private ending?: Promise<void>;

  private constructor(
    private readonly client: Client,
    private readonly guild: Guild,
    channel: VoiceBasedChannel,
    commandChannelId: string,
    startedBy: { id: string; name: string },
    private readonly onFinished: OnFinished,
  ) {
    this.startedAtMs = Date.now();
    this.manifest = {
      id: newSessionId(),
      guildId: guild.id,
      guildName: guild.name,
      voiceChannelId: channel.id,
      voiceChannelName: channel.name,
      commandChannelId,
      startedBy,
      startedAt: this.startedAtMs,
      heartbeatAt: this.startedAtMs,
      status: "recording",
      participants: {},
    };
    this.uploader = new SegmentUploader(this.manifest);
  }

  static async start(opts: {
    client: Client;
    guild: Guild;
    channel: VoiceBasedChannel;
    commandChannelId: string;
    startedBy: { id: string; name: string };
    onFinished: OnFinished;
  }): Promise<MeetingSession> {
    const s = new MeetingSession(
      opts.client,
      opts.guild,
      opts.channel,
      opts.commandChannelId,
      opts.startedBy,
      opts.onFinished,
    );
    activeSessions.set(opts.guild.id, s);
    try {
      await s.join(opts.channel);
      await saveEverywhere(s.manifest);
    } catch (err) {
      activeSessions.delete(opts.guild.id);
      s.connection?.destroy();
      throw err;
    }
    s.tick = setInterval(() => s.onTick(), TICK_MS);
    s.schedulePrompt();
    s.checkEmpty();
    log.info(`recording ${s.manifest.id} in #${opts.channel.name} (${opts.guild.name})`);
    return s;
  }

  get id(): string {
    return this.manifest.id;
  }

  /** Current position on the meeting timeline, in samples. */
  private nowSample(): number {
    return Math.floor(((Date.now() - this.startedAtMs) * SAMPLE_RATE) / 1000);
  }

  private async join(channel: VoiceBasedChannel): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: true,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this.connection.receiver.speaking.on("start", (userId) => this.subscribe(userId));

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord moves or reconnects the bot sometimes; give it a moment.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        void this.end("the bot was disconnected from the voice channel");
      }
    });
    this.connection.on("error", (err) => log.error(`voice connection error ${this.id}`, err));
  }

  private writerFor(userId: string): TrackWriter {
    let w = this.writers.get(userId);
    if (!w) {
      const dir = join(meetingDir(this.id), "segments", userId);
      w = new TrackWriter(dir, (index) => {
        const p = this.manifest.participants[userId];
        if (p && !p.segments.includes(index)) p.segments.push(index);
      });
      this.writers.set(userId, w);
    }
    return w;
  }

  private ensureParticipant(userId: string): void {
    if (this.manifest.participants[userId]) return;
    const member = this.guild.members.cache.get(userId);
    this.manifest.participants[userId] = {
      displayName: member?.displayName ?? userId,
      utterances: [],
      segments: [],
      uploaded: [],
    };
    if (!member) {
      this.guild.members
        .fetch(userId)
        .then((m) => {
          this.manifest.participants[userId]!.displayName = m.displayName;
        })
        .catch(() => {});
    }
  }

  private subscribe(userId: string): void {
    if (this.ending) return;
    const receiver = this.connection.receiver;
    if (receiver.subscriptions.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;

    this.ensureParticipant(userId);
    const writer = this.writerFor(userId);
    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 },
    });
    // A fresh decoder per utterance: Discord sends 48 kHz Opus, libopus decodes straight to 24 kHz mono.
    const decoder = new OpusScript(SAMPLE_RATE as 24000, 1, OpusScript.Application.VOIP);
    let started = false;
    let finished = false;

    stream.on("data", (packet: Buffer) => {
      if (finished) return;
      if (!started) {
        writer.beginUtterance(this.nowSample());
        started = true;
      }
      try {
        writer.write(decoder.decode(packet));
      } catch {
        // Corrupt or undecryptable packet: skip it.
      }
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      const u = writer.endUtterance();
      if (u) this.manifest.participants[userId]!.utterances.push(u);
      try {
        decoder.delete();
      } catch {}
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.on("error", (err) => {
      log.warn(`receive stream error for ${userId}`, err);
      finish();
    });
  }

  /** Heartbeat + close and upload segments that are complete. */
  private onTick(): void {
    this.manifest.heartbeatAt = Date.now();
    const safeBoundary = Math.floor((this.nowSample() - SEGMENT_GRACE_SAMPLES) / SEGMENT_SAMPLES);
    for (const [userId, writer] of this.writers) {
      for (const index of writer.openSegments()) {
        const segEnd = (index + 1) * SEGMENT_SAMPLES;
        if (index < safeBoundary && (!writer.speaking || writer.cursor >= segEnd)) {
          const path = writer.closeSegment(index);
          this.uploader.enqueue(userId, index, path);
        }
      }
    }
    try {
      saveLocal(this.manifest);
    } catch (err) {
      log.error("could not save manifest", err);
    }
  }

  // ---- auto-end rules -------------------------------------------------------

  private schedulePrompt(): void {
    const c = config();
    clearTimeout(this.promptTimer);
    this.promptTimer = setTimeout(() => void this.showPrompt(), c.CONTINUE_PROMPT_AFTER_MIN * 60_000);
  }

  private async showPrompt(): Promise<void> {
    if (this.ending) return;
    const c = config();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTINUE_BUTTON_PREFIX}${this.id}`)
        .setLabel("Continue recording")
        .setStyle(ButtonStyle.Primary),
    );
    const content =
      `This meeting in **${this.manifest.voiceChannelName}** has been recording for ` +
      `${c.CONTINUE_PROMPT_AFTER_MIN} minutes. Continue recording? ` +
      `If nobody clicks within ${c.CONTINUE_PROMPT_TIMEOUT_MIN} minutes, I will end the recording.`;
    try {
      const channel = await this.client.channels.fetch(this.manifest.commandChannelId);
      if (channel?.isSendable()) this.promptMessage = await channel.send({ content, components: [row] });
    } catch (err) {
      log.warn("could not post continue prompt", err);
    }
    this.promptTimeout = setTimeout(
      () => void this.end(`nobody clicked "Continue recording" within ${c.CONTINUE_PROMPT_TIMEOUT_MIN} minutes`),
      c.CONTINUE_PROMPT_TIMEOUT_MIN * 60_000,
    );
  }

  async handleContinue(interaction: ButtonInteraction): Promise<void> {
    if (this.ending || !this.promptTimeout) {
      await interaction.reply({ content: "This recording has already ended.", flags: MessageFlags.Ephemeral });
      return;
    }
    clearTimeout(this.promptTimeout);
    this.promptTimeout = undefined;
    const name = interaction.member && "displayName" in interaction.member ? interaction.member.displayName : interaction.user.username;
    await interaction.update({
      content: `Recording continues in **${this.manifest.voiceChannelName}** (confirmed by ${name}).`,
      components: [],
    });
    this.promptMessage = undefined;
    this.schedulePrompt();
  }

  /** Called on every voice state change in this guild. */
  checkEmpty(): void {
    if (this.ending) return;
    const channel = this.guild.channels.cache.get(this.manifest.voiceChannelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
    if (humans > 0) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    } else if (!this.emptyTimer) {
      const min = config().EMPTY_CHANNEL_TIMEOUT_MIN;
      this.emptyTimer = setTimeout(
        () => void this.end(`everyone left the channel for ${min} minutes`),
        min * 60_000,
      );
    }
  }

  // ---- stop -----------------------------------------------------------------

  /** Stop recording and hand the meeting to the processing pipeline. Safe to call more than once. */
  end(reason: string): Promise<void> {
    this.ending ??= this.doEnd(reason);
    return this.ending;
  }

  private async doEnd(reason: string): Promise<void> {
    log.info(`ending ${this.id}: ${reason}`);
    clearInterval(this.tick);
    clearTimeout(this.promptTimer);
    clearTimeout(this.promptTimeout);
    clearTimeout(this.emptyTimer);
    if (this.promptMessage) {
      this.promptMessage.edit({ content: `Recording ended: ${reason}.`, components: [] }).catch(() => {});
    }

    // Stop receiving and flush utterances still in progress.
    for (const stream of this.connection.receiver.subscriptions.values()) stream.destroy();
    for (const [userId, writer] of this.writers) {
      const u = writer.endUtterance();
      if (u) this.manifest.participants[userId]?.utterances.push(u);
    }
    try {
      this.connection.destroy();
    } catch {}
    activeSessions.delete(this.guild.id);

    const endSample = Math.max(this.nowSample(), ...[...this.writers.values()].map((w) => w.cursor));
    this.manifest.endedAt = this.startedAtMs + Math.round((endSample * 1000) / SAMPLE_RATE);
    this.manifest.endReason = reason;

    // Close every open segment; the last one is cut to the meeting length.
    for (const [userId, writer] of this.writers) {
      for (const index of writer.openSegments()) {
        const len = Math.min(SEGMENT_SAMPLES, endSample - index * SEGMENT_SAMPLES);
        this.uploader.enqueue(userId, index, writer.closeSegment(index, len));
      }
      writer.closeAll();
    }
    await this.uploader.drain();

    this.manifest.status = "processing";
    try {
      await saveEverywhere(this.manifest);
    } catch (err) {
      log.error("could not upload manifest, continuing with local copy", err);
      saveLocal(this.manifest);
    }
    this.onFinished(this.manifest);
  }
}

export { segmentPath };
