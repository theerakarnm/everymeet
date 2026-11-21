import type { EndReason, EventReply, RecordingJob, RecordingStatus, RunnerEvent } from "../../src/meet/protocol.js";

/** No report from the container for this long means it is gone. */
export const WATCHDOG_MS = 3 * 60_000;
/** Extra time past admit timeout + max duration before the hard deadline. */
export const DEADLINE_GRACE_MS = 10 * 60_000;
/** The container gets this long to exit by itself after reporting the end. */
export const DESTROY_AFTER_END_MS = 30_000;
/** State is kept this long after the end so a restarted bot can still read it. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;

/** What the Durable Object stores. Never holds the job's authState. */
export interface RecordingRecord extends RecordingStatus {
  id: string;
  hardDeadline: number;
  lastEventAt: number;
  stopRequested: boolean;
  endedAt?: number;
}

/** Everything the core needs from Cloudflare, injected so it runs under node:test. */
export interface RecorderPorts {
  load(): Promise<RecordingRecord | undefined>;
  save(r: RecordingRecord): Promise<void>;
  /** Deletes all stored state and the alarm. */
  clear(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  /** Starts the container and the runner with `job` on its stdin. */
  launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void>;
  /** Keeps work running after the current call returns (ctx.waitUntil). */
  background(task: Promise<void>): void;
  /** Stops the container if it runs. */
  destroy(reason: string): Promise<void>;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

/** One Google Meet recording: its state, its deadlines, and its container's lifecycle. */
export class RecorderCore {
  constructor(private readonly p: RecorderPorts) {}

  async start(id: string, job: RecordingJob): Promise<"started" | "exists"> {
    if (await this.p.load()) return "exists";
    const now = this.p.now();
    const r: RecordingRecord = {
      id,
      state: "starting",
      segments: [],
      stopRequested: false,
      lastEventAt: now,
      hardDeadline: now + job.admitTimeoutMs + job.maxDurationMs + DEADLINE_GRACE_MS,
    };
    await this.p.save(r);
    await this.p.setAlarm(now + WATCHDOG_MS);
    this.p.log({ id, event: "start", meetUrl: job.meetUrl, signedIn: job.authState !== undefined });
    this.p.background(this.launch(id, job, r.hardDeadline));
    return "started";
  }

  private async launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void> {
    try {
      await this.p.launch(id, job, hardDeadline);
    } catch (err) {
      const r = await this.p.load();
      if (r && r.state !== "ended") await this.finish(r, "crashed", `container start failed: ${(err as Error).message}`);
      return;
    }
    // An image pull can take minutes; the watchdog counts from the moment the runner is running.
    const r = await this.p.load();
    if (r?.state === "starting") {
      r.lastEventAt = this.p.now();
      await this.p.save(r);
      await this.p.setAlarm(r.lastEventAt + WATCHDOG_MS);
    }
  }

  async status(): Promise<RecordingStatus | undefined> {
    const r = await this.p.load();
    if (!r) return undefined;
    const { state, captureStartedAt, consentPosted, segments, end } = r;
    return { state, captureStartedAt, consentPosted, segments, end };
  }

  async stop(): Promise<boolean> {
    const r = await this.p.load();
    if (!r) return false;
    if (r.state !== "ended" && !r.stopRequested) {
      r.stopRequested = true;
      await this.p.save(r);
      this.p.log({ id: r.id, event: "stop requested" });
    }
    return true;
  }

  async event(e: RunnerEvent): Promise<EventReply> {
    const r = await this.p.load();
    if (!r || r.state === "ended") return { stop: true };
    r.lastEventAt = this.p.now();
    this.p.log({ id: r.id, ...e });
    switch (e.type) {
      case "joining":
      case "waiting":
        r.state = e.type;
        break;
      case "recording":
        r.state = "recording";
        r.captureStartedAt = e.captureStartedAt;
        r.consentPosted = e.consentPosted;
        break;
      case "heartbeat":
        break;
      case "ended":
        await this.finish(r, e.reason, e.detail, e.leftCleanly);
        return { stop: true };
    }
    await this.p.save(r);
    return { stop: r.stopRequested };
  }

  /** The callback entrypoint stored a segment in R2; list it once, sorted (a retried upload replaces it). */
  async segmentStored(index: number, samples: number): Promise<void> {
    const r = await this.p.load();
    if (!r) throw new Error("unknown recording");
    r.segments = [...r.segments.filter((s) => s.index !== index), { index, samples }].sort((a, b) => a.index - b.index);
    r.lastEventAt = this.p.now();
    await this.p.save(r);
    this.p.log({ id: r.id, event: "segment", index, samples });
  }

  /** The runner process exited; normally right after it reported the end. */
  async runnerExited(code: number): Promise<void> {
    const r = await this.p.load();
    if (!r) return;
    if (r.state !== "ended") await this.finish(r, "crashed", `runner exited with code ${code}`);
    await this.destroy(r.id, "runner exited");
  }

  async alarm(): Promise<void> {
    const r = await this.p.load();
    if (!r) return;
    const now = this.p.now();
    if (r.state === "ended") {
      await this.destroy(r.id, "recording ended");
      if (now >= r.endedAt! + RETENTION_MS) await this.p.clear();
      else await this.p.setAlarm(r.endedAt! + RETENTION_MS);
      return;
    }
    if (now >= r.hardDeadline) {
      await this.finish(r, "max_duration", "hard deadline reached");
    } else if (now - r.lastEventAt >= WATCHDOG_MS) {
      await this.finish(r, "container_lost", `no report for ${WATCHDOG_MS / 60_000} minutes`);
    } else {
      await this.p.setAlarm(Math.min(r.lastEventAt + WATCHDOG_MS, r.hardDeadline));
      return;
    }
    await this.destroy(r.id, r.end!.reason);
  }

  private async finish(r: RecordingRecord, reason: EndReason, detail?: string, leftCleanly = false): Promise<void> {
    r.state = "ended";
    r.end = detail === undefined ? { reason, leftCleanly } : { reason, detail, leftCleanly };
    r.endedAt = this.p.now();
    await this.p.save(r);
    await this.p.setAlarm(r.endedAt + DESTROY_AFTER_END_MS);
    this.p.log({ id: r.id, event: "ended", reason, detail, leftCleanly });
  }

  private async destroy(id: string, reason: string): Promise<void> {
    this.p.log({ id, event: "destroy", reason });
    await this.p.destroy(reason);
  }
}
