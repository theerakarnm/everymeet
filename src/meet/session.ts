import { readFileSync, rmSync } from "node:fs";
import { config, MEET_ADMIT_TIMEOUT_MS, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { consentMissingMail, describeMeetEnd, notRecordedMail, type Mail } from "../email/messages.js";
import { sendEmail } from "../email/send.js";
import { emailStarter, meetingDir, saveEverywhere, saveLocal, type MeetInfo, type MeetManifest } from "../storage/manifest.js";
import { logger } from "../util/log.js";
import { newSessionId } from "../util/pin.js";
import { MEET_PARTICIPANT_ID, type RecordingState, type RecordingStatus } from "./protocol.js";
import { recorder } from "./recorder-client.js";

const log = logger("meet");
/** As often as the container reports (meet/bot/runner.ts), so the web page shows a state at most about 10 s old. */
const TICK_MS = 5_000;
/**
 * While the recorder is unreachable the bot keeps polling; it gives up only this long after the recorder's
 * own hard deadline (admit timeout + max duration + 10 min), when the recorder must have ended.
 */
export const GIVE_UP_GRACE_MS = 60 * 60_000;
export const MEET_SPEAKER_NAME = "เสียงรวมจาก Google Meet";

type OnFinished = (manifest: MeetManifest) => void;

/** How the web page and the calendar poller start a recording (src/index.ts binds the processing callback). */
export type StartMeet = (meet: MeetInfo) => Promise<MeetSession>;

/** The meet-recorder Worker runs at most this many containers (max_instances in meet/wrangler.jsonc). */
export const MAX_MEET_RECORDINGS = 2;

/** Google Meet recordings in progress, by Meet code: one per call, at most MAX_MEET_RECORDINGS at once. */
export const activeMeets = new Map<string, MeetSession>();

/** Why a start was refused before anything reached the recorder. */
export type RefusalReason = "already_recording" | "busy";

const REFUSALS: Record<RefusalReason, string> = {
  already_recording: "this Google Meet call is already being recorded",
  busy: `at most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once`,
};

/** A start that the limits refuse; nothing was sent to the recorder. */
export class MeetRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(REFUSALS[reason]);
  }
}

/**
 * A Google Meet recording. The meet-recorder Worker's container (meet/) does the recording; this side owns
 * the manifest, polls the recorder, emails the starter about problems, and hands the result to processing.
 */
export class MeetSession {
  private tick?: NodeJS.Timeout;
  private polling = false;
  private readonly giveUpAt: number;
  private stopReason?: string;
  private finishing?: Promise<void>;
  /** What the recorder reported last; the web page shows it. */
  state: RecordingState = "starting";

  private constructor(
    readonly manifest: MeetManifest,
    private readonly onFinished: OnFinished,
  ) {
    this.giveUpAt = manifest.startedAt + MEET_ADMIT_TIMEOUT_MS + config().MEET_MAX_DURATION_MIN * 60_000 + GIVE_UP_GRACE_MS;
  }

  /** Sends the bot into `meet`. The starter always gets the minutes too. Throws MeetRefused when a limit is reached. */
  static async start(meet: MeetInfo, onFinished: OnFinished): Promise<MeetSession> {
    const c = config();
    const now = Date.now();
    // Checked and registered in one synchronous block, so two starts at the same moment cannot both pass.
    if (activeMeets.has(meet.code)) throw new MeetRefused("already_recording");
    if (activeMeets.size >= MAX_MEET_RECORDINGS) throw new MeetRefused("busy");
    const manifest: MeetManifest = {
      id: newSessionId(),
      meet: { ...meet, recipients: [...new Set([meet.startedBy, ...meet.recipients].filter((e): e is string => !!e))] },
      startedAt: now,
      heartbeatAt: now,
      status: "recording",
      participants: {},
    };
    const s = new MeetSession(manifest, onFinished);
    activeMeets.set(meet.code, s);
    try {
      // Saved before the recorder starts, so recoverUnfinished() re-attaches if this process dies right after.
      saveLocal(manifest);
      await recorder.start(manifest.id, {
        meetUrl: meet.url,
        authState: c.MEET_AUTH_STATE_FILE ? readAuthState(c.MEET_AUTH_STATE_FILE) : undefined,
        sampleRate: SAMPLE_RATE,
        segmentSamples: SEGMENT_SAMPLES,
        admitTimeoutMs: MEET_ADMIT_TIMEOUT_MS,
        aloneTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
        maxDurationMs: c.MEET_MAX_DURATION_MIN * 60_000,
      });
    } catch (err) {
      // The request may have reached the Worker even though it failed here (a timeout): make sure no bot joins.
      recorder.stop(manifest.id).catch(() => {});
      activeMeets.delete(meet.code);
      rmSync(meetingDir(manifest.id), { recursive: true, force: true });
      throw err;
    }
    await s.save();
    s.tick = setInterval(() => void s.poll(), TICK_MS);
    log.info(`recording Google Meet ${meet.code} as ${manifest.id} (${meet.trigger}, started by ${meet.startedBy ?? `API client ${meet.api?.client}`})`);
    return s;
  }

  /** Re-attach to a recording that kept running on Cloudflare while this process restarted. */
  static resume(manifest: MeetManifest, onFinished: OnFinished): MeetSession {
    const s = new MeetSession(manifest, onFinished);
    activeMeets.set(manifest.meet.code, s);
    s.tick = setInterval(() => void s.poll(), TICK_MS);
    void s.poll();
    log.info(`re-attached to Google Meet recording ${manifest.id}`);
    return s;
  }

  get id(): string {
    return this.manifest.id;
  }

  private get code(): string {
    return this.manifest.meet.code;
  }

  /** True once someone asked the recorder to stop. */
  get stopping(): boolean {
    return this.stopReason !== undefined;
  }

  /**
   * Asks the recorder to leave the call; processing starts when it reports the end.
   * Throws when the recorder cannot be reached (it still stops by itself when the call empties or hits the limit).
   */
  async end(reason: string): Promise<void> {
    if (this.finishing) return;
    // Set before the await: the poll can see the end while the stop request is still on its way.
    const before = this.stopReason;
    this.stopReason ??= reason;
    try {
      await recorder.stop(this.id);
    } catch (err) {
      this.stopReason = before;
      throw err;
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
      if (status) this.state = status.state;
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
    // The Meet chat notice is the only consent notice; if it failed, the starter has to tell people.
    if (!status.consentPosted) await this.email(consentMissingMail({ title: this.manifest.meet.title, code: this.code }));
  }

  private finish(status: RecordingStatus | undefined): Promise<void> {
    this.finishing ??= this.doFinish(status);
    return this.finishing;
  }

  private async doFinish(status: RecordingStatus | undefined): Promise<void> {
    clearInterval(this.tick);
    activeMeets.delete(this.code);
    const m = this.manifest;
    const end = status?.end;
    const segments = status?.segments ?? [];
    m.endReason = this.stopReason ?? describeMeetEnd(end?.reason);
    m.endCode = this.stopReason ? "stopped" : (end?.reason ?? "recorder_lost");

    if (!status || status.captureStartedAt === undefined || segments.length === 0) {
      m.status = "failed";
      m.endedAt = Date.now();
      m.error = `nothing was recorded (${end ? `${end.reason}${end.detail ? `: ${end.detail}` : ""}` : "the recorder lost this recording"})`;
      await this.save();
      await this.email(notRecordedMail({ title: m.meet.title, code: this.code, end, api: !!m.meet.api }));
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

  /** Emails the person who started the recording (never in webhook mode); a failed email is logged, never fatal. */
  private async email(mail: Mail): Promise<void> {
    const to = emailStarter(this.manifest);
    if (!to) return;
    try {
      await sendEmail({ to, ...mail });
    } catch (err) {
      log.error(`could not email ${to} about Google Meet recording ${this.id}`, err);
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
