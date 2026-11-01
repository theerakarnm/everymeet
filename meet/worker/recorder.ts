import { DurableObject } from "cloudflare:workers";
import { CALLBACK_HOST, type EventReply, type RecordingJob, type RecordingStatus, type RunnerEvent } from "../../src/meet/protocol.js";
import { RecorderCore, type RecordingRecord } from "./core.js";
import type { Env } from "./env.js";
import type { RecorderApi } from "./http.js";

/** Exec does not inherit the image ENV, so the variables the Playwright image relies on are set here. */
const RUNNER_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  HOME: "/root",
};
const KEY = "recording";

/** One Durable Object per Google Meet recording (name = manifest id); it owns one container. */
export class MeetRecorder extends DurableObject<Env> implements RecorderApi {
  private readonly core = new RecorderCore({
    load: () => this.ctx.storage.get<RecordingRecord>(KEY),
    save: (r) => this.ctx.storage.put(KEY, r),
    clear: async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    },
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    launch: (id, job, hardDeadline) => this.launch(id, job, hardDeadline),
    background: (task) => this.ctx.waitUntil(task),
    destroy: async (reason) => {
      if (this.ctx.container?.running) await this.ctx.container.destroy(reason);
    },
    now: () => Date.now(),
    log: (entry) => console.log(JSON.stringify(entry)),
  });

  start(id: string, job: RecordingJob): Promise<"started" | "exists"> {
    return this.core.start(id, job);
  }
  status(): Promise<RecordingStatus | undefined> {
    return this.core.status();
  }
  stop(): Promise<boolean> {
    return this.core.stop();
  }
  event(e: RunnerEvent): Promise<EventReply> {
    return this.core.event(e);
  }
  segmentStored(index: number, samples: number): Promise<void> {
    return this.core.segmentStored(index, samples);
  }
  override alarm(): Promise<void> {
    return this.core.alarm();
  }

  /** Container lifecycle as in Cellar's job runner: keep-alive entrypoint, then the runner via exec with the job on stdin. */
  private async launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container configured");
    c.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
    await c.setInactivityTimeout(Math.max(hardDeadline - Date.now(), 0));
    await c.interceptOutboundHttp(CALLBACK_HOST, this.ctx.exports.RecorderCallback({ props: { recordingId: id } }));
    const proc = await c.exec(["/app/entrypoint.sh"], {
      cwd: "/app",
      env: RUNNER_ENV,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    const writer = proc.stdin!.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(job)));
    await writer.close();
    this.ctx.waitUntil(proc.exitCode.then((code) => this.core.runnerExited(code)));
  }
}
