import { readFileSync, rmSync } from "node:fs";
import type { Client } from "discord.js";
import { config, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { activeSessions, type ActiveRecording } from "../recorder/active.js";
import { meetingDir, saveEverywhere, saveLocal, type Manifest } from "../storage/manifest.js";
import { logger } from "../util/log.js";
import { newSessionId } from "../util/pin.js";
import { MEET_PARTICIPANT_ID, type EndReason, type RecordingEnd, type RecordingStatus } from "./protocol.js";
import { recorder } from "./recorder-client.js";

const log = logger("meet");
const TICK_MS = 15_000;
/** How long the bot waits in the Meet lobby for someone to let it in. */
export const ADMIT_TIMEOUT_MS = 5 * 60_000;
/**
 * While the recorder is unreachable the bot keeps polling; it gives up only this long after the recorder's
 * own hard deadline (admit timeout + max duration + 10 min), when the recorder must have ended.
 */
export const GIVE_UP_GRACE_MS = 60 * 60_000;
export const MEET_SPEAKER_NAME = "เสียงรวมจาก Google Meet";

type OnFinished = (manifest: Manifest) => void;

/**
 * A Google Meet recording. The meet-recorder Worker's container (meet/) does the recording;
 * this side owns the manifest, polls the recorder, talks to Discord, and hands the result to processing.
 */
export class MeetSession implements ActiveRecording {
  private tick?: NodeJS.Timeout;
  private polling = false;
  private readonly giveUpAt: number;
  private stopReason?: string;
  private finishing?: Promise<void>;

  private constructor(
    private readonly client: Client,
    readonly manifest: Manifest,
    private readonly onFinished: OnFinished,
  ) {
    this.giveUpAt = manifest.startedAt + ADMIT_TIMEOUT_MS + config().MEET_MAX_DURATION_MIN * 60_000 + GIVE_UP_GRACE_MS;
  }

  static async start(o: {
    client: Client;
    guildId: string;
    guildName: string;
    commandChannelId: string;
    startedBy: { id: string; name: string };
    meet: { url: string; code: string };
    onFinished: OnFinished;
  }): Promise<MeetSession> {
    const c = config();
    const now = Date.now();
    const manifest: Manifest = {
      id: newSessionId(),
      guildId: o.guildId,
      guildName: o.guildName,
      voiceChannelId: o.meet.code,
      voiceChannelName: `Google Meet ${o.meet.code}`,
      commandChannelId: o.commandChannelId,
      meet: o.meet,
      startedBy: o.startedBy,
      startedAt: now,
      heartbeatAt: now,
      status: "recording",
      participants: {},
    };
    const s = new MeetSession(o.client, manifest, o.onFinished);
    activeSessions.set(o.guildId, s);
    try {
      // Saved before the recorder starts, so recoverUnfinished() re-attaches if this process dies right after.
      saveLocal(manifest);
      await recorder.start(manifest.id, {
        meetUrl: o.meet.url,
        authState: c.MEET_AUTH_STATE_FILE ? readAuthState(c.MEET_AUTH_STATE_FILE) : undefined,
        sampleRate: SAMPLE_RATE,
        segmentSamples: SEGMENT_SAMPLES,
        admitTimeoutMs: ADMIT_TIMEOUT_MS,
        aloneTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
        maxDurationMs: c.MEET_MAX_DURATION_MIN * 60_000,
      });
    } catch (err) {
      // The request may have reached the Worker even though it failed here (a timeout): make sure no bot joins.
      recorder.stop(manifest.id).catch(() => {});
      activeSessions.delete(o.guildId);
      rmSync(meetingDir(manifest.id), { recursive: true, force: true });
      throw err;
    }
    await s.save();
    s.tick = setInterval(() => void s.poll(), TICK_MS);
    log.info(`recording Google Meet ${o.meet.code} as ${manifest.id} (${o.guildName})`);
    return s;
  }

  /** Re-attach to a recording that kept running on Cloudflare while this process restarted. */
  static resume(client: Client, manifest: Manifest, onFinished: OnFinished): MeetSession {
    const s = new MeetSession(client, manifest, onFinished);
    activeSessions.set(manifest.guildId, s);
    s.tick = setInterval(() => void s.poll(), TICK_MS);
    void s.poll();
    log.info(`re-attached to Google Meet recording ${manifest.id}`);
    return s;
  }

  get id(): string {
    return this.manifest.id;
  }

  private get code(): string {
    return this.manifest.meet!.code;
  }

  /** Asks the recorder to leave the call; processing starts when it reports the end. */
  async end(reason: string): Promise<void> {
    if (this.finishing) return;
    this.stopReason ??= reason;
    try {
      await recorder.stop(this.id);
    } catch (err) {
      log.warn(`could not ask the Google Meet recorder to stop ${this.id}`, err);
      await this.say(
        `I could not reach the Google Meet recorder to stop **${this.code}**. ` +
          "It stops by itself when the call is empty or reaches the time limit, and the minutes follow then.",
      );
    }
  }

  /** The recording goes on in the cloud; boot re-attaches to it. */
  async shutdown(): Promise<void> {
    clearInterval(this.tick);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.finishing) return;
    this.polling = true;
    try {
      let status: RecordingStatus | undefined;
      try {
        status = await recorder.status(this.id);
      } catch (err) {
        log.warn(`could not reach the Google Meet recorder for ${this.id}`, err);
        // An outage is like a restart: the recording goes on in the cloud, so keep following it.
        if (Date.now() >= this.giveUpAt) await this.finish(undefined);
        return;
      }
      if (status?.state === "recording" && !this.manifest.participants[MEET_PARTICIPANT_ID]) {
        await this.recordingStarted(status);
      }
      if (!status || status.state === "ended") {
        await this.finish(status);
        return;
      }
      this.manifest.heartbeatAt = Date.now();
      try {
        saveLocal(this.manifest);
      } catch (err) {
        log.error("could not save manifest", err);
      }
    } finally {
      this.polling = false;
    }
  }

  private async recordingStarted(status: RecordingStatus): Promise<void> {
    this.manifest.startedAt = status.captureStartedAt!;
    this.manifest.participants[MEET_PARTICIPANT_ID] = {
      displayName: MEET_SPEAKER_NAME,
      utterances: [],
      segments: [],
      uploaded: [],
    };
    await this.save();
    await this.say(
      `🔴 I am recording the Google Meet call ${this.code}` +
        (status.consentPosted ? "" : ". I could not post the recording notice in the Meet chat, so please tell the participants."),
    );
  }

  private finish(status: RecordingStatus | undefined): Promise<void> {
    this.finishing ??= this.doFinish(status);
    return this.finishing;
  }

  private async doFinish(status: RecordingStatus | undefined): Promise<void> {
    clearInterval(this.tick);
    activeSessions.delete(this.manifest.guildId);
    const m = this.manifest;
    const end = status?.end;
    const segments = status?.segments ?? [];
    m.endReason = this.stopReason ?? describeEnd(end?.reason);

    if (!status || status.captureStartedAt === undefined || segments.length === 0) {
      m.status = "failed";
      m.endedAt = Date.now();
      m.error = `nothing was recorded (${end ? `${end.reason}${end.detail ? `: ${end.detail}` : ""}` : "the recorder lost this recording"})`;
      await this.save();
      await this.say(notRecordedMessage(this.code, end));
      log.warn(`Google Meet recording ${m.id} ended without audio: ${m.error}`);
      return;
    }

    const lastSample = Math.max(...segments.map((s) => s.index * SEGMENT_SAMPLES + s.samples));
    m.startedAt = status.captureStartedAt;
    m.endedAt = m.startedAt + Math.round((lastSample * 1000) / SAMPLE_RATE);
    m.heartbeatAt = m.endedAt;
    if (end?.reason === "container_lost" || end?.reason === "crashed") m.recovered = true;
    const p = (m.participants[MEET_PARTICIPANT_ID] ??= {
      displayName: MEET_SPEAKER_NAME,
      utterances: [],
      segments: [],
      uploaded: [],
    });
    p.segments = segments.map((s) => s.index).sort((a, b) => a - b);
    p.uploaded = [...p.segments]; // the Worker lists only segments it stored in R2
    m.status = "processing";
    await this.save();
    log.info(`Google Meet recording ${m.id} ended: ${m.endReason}`);
    this.onFinished(m);
  }

  private async save(): Promise<void> {
    try {
      await saveEverywhere(this.manifest);
    } catch (err) {
      log.error(`could not upload manifest ${this.id}, keeping the local copy`, err);
      saveLocal(this.manifest);
    }
  }

  private async say(text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(this.manifest.commandChannelId);
      if (channel?.isSendable()) await channel.send(text);
    } catch (err) {
      log.warn(`could not post in the command channel for ${this.id}`, err);
    }
  }
}

/**
 * Reads the bot account session and checks it is JSON before a container is paid for.
 * The error never quotes the file: JSON.parse messages can contain a piece of the session.
 */
function readAuthState(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    JSON.parse(text);
  } catch {
    throw new Error("the bot account session file (MEET_AUTH_STATE_FILE) is missing or not valid JSON");
  }
  return text;
}

function describeEnd(reason: EndReason | undefined): string {
  switch (reason) {
    case "stopped":
      return "ended with /end";
    case "alone":
      return `everyone left the Google Meet call for ${config().EMPTY_CHANNEL_TIMEOUT_MIN} minutes`;
    case "removed":
      return "the bot was removed from the Google Meet call";
    case "meeting_ended":
      return "the Google Meet call ended";
    case "max_duration":
      return `the recording reached the ${config().MEET_MAX_DURATION_MIN}-minute limit`;
    case "not_admitted":
      return "nobody let the bot into the Google Meet call";
    case "denied":
      return "the bot was not allowed to join the Google Meet call";
    case "auth_expired":
      return "the bot's Google account session expired";
    case "join_failed":
      return "the Google Meet page offered no way to join";
    default:
      return "the Google Meet recorder stopped unexpectedly";
  }
}

function notRecordedMessage(code: string, end: RecordingEnd | undefined): string {
  if (end?.detail?.startsWith("container start failed")) {
    return `I could not start a recorder for Google Meet **${code}**. At most 2 Meet recordings run at once; please try again later.`;
  }
  const reason = end?.reason;
  switch (reason) {
    case "auth_expired":
      return (
        `I could not join Google Meet **${code}**: the bot's Google account session has expired. ` +
        "An admin needs to run `npm run meet:login` in meet/ and replace the session file on the server (MEET_AUTH_STATE_FILE)."
      );
    case "not_admitted":
      return `Nobody let the bot into Google Meet **${code}** within ${ADMIT_TIMEOUT_MS / 60_000} minutes, so nothing was recorded.`;
    case "denied":
      return `Google Meet **${code}** did not let the bot join (the host denied it or Meet refused it), so nothing was recorded.`;
    case "stopped":
      return `Recording of Google Meet **${code}** was stopped before the bot got in, so nothing was recorded.`;
    default:
      return `I could not record Google Meet **${code}** (${describeEnd(reason)}).`;
  }
}
