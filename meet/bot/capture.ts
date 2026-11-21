import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import type { RecordingJob } from "../../src/meet/protocol.js";
import { uploadSegment } from "./callback.js";
import { SegmentSplitter, type FinishedSegment } from "./segments.js";

const run = promisify(execFile);

export interface Capture {
  /** Epoch ms of the first captured sample; the meeting timeline starts here. */
  readonly startedAt: number;
  /** False once ffmpeg stopped on its own. */
  readonly alive: boolean;
  /** Stops capturing and resolves when every segment is uploaded (or failed). */
  stop(): Promise<void>;
}

/**
 * Records the PulseAudio sink Chromium plays Meet into, as 24 kHz mono segments of exactly
 * job.segmentSamples, each sent to R2 as FLAC while the call goes on.
 */
export function startCapture(dir: string, job: Pick<RecordingJob, "sampleRate" | "segmentSamples">): Capture {
  let chain = Promise.resolve();
  const splitter = new SegmentSplitter(dir, job.segmentSamples, (s) => {
    chain = chain.then(() => encodeAndUpload(s, job.sampleRate));
  });
  const startedAt = Date.now();
  const ff = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "meet.monitor", "-ac", "1", "-ar", String(job.sampleRate), "-f", "s16le", "pipe:1"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let alive = true;
  let stopping = false;
  ff.stdout.on("data", (chunk: Buffer) => splitter.write(chunk));
  ff.on("error", () => {}); // a failed spawn also emits "close", which marks the capture dead
  const exited = new Promise<void>((resolve) =>
    ff.once("close", () => {
      alive = stopping;
      resolve();
    }),
  );
  return {
    startedAt,
    get alive() {
      return alive;
    },
    async stop() {
      stopping = true;
      ff.kill("SIGTERM");
      await exited;
      splitter.finish();
      await chain;
    },
  };
}

async function encodeAndUpload(s: FinishedSegment, sampleRate: number): Promise<void> {
  const flac = `${s.path}.flac`;
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", s.path, "-c:a", "flac", flac]);
    await uploadSegment(s.index, s.samples, flac);
  } catch {
    // The segment is lost; the Durable Object's segment list shows the gap and the pipeline skips it.
  } finally {
    rmSync(s.path, { force: true });
    rmSync(flac, { force: true });
  }
}
