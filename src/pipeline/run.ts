import { rmSync } from "node:fs";
import type { Client } from "discord.js";
import { config, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { meetingDir, saveEverywhere, saveLocal, unfinishedLocal, type Manifest } from "../storage/manifest.js";
import { keys, putFile, putText } from "../storage/r2.js";
import { generatePin, hashPin } from "../util/pin.js";
import { pLimit } from "../util/limit.js";
import { logger } from "../util/log.js";
import { buildRawTracks, encodeTracks, mixTracks } from "./assemble.js";
import { transcribeMeeting } from "./transcribe.js";
import { fullSummary, shortSummary } from "./summarize.js";
import type { Line } from "./plan.js";
import { notifyFailure, publishMinutes } from "./publish.js";

const log = logger("pipeline");
/** ffmpeg and transcription are heavy; process at most two meetings at once. */
const queue = pLimit(2);

export function processMeeting(client: Client, m: Manifest): Promise<void> {
  return queue(() => run(client, m));
}

export interface PipelineResult {
  lines: Line[];
  shortSummary: string;
  fullSummary: string;
  transcript: string;
  notes: string[];
}

/**
 * Steps 1-4 of the pipeline, shared by the bot's run() and the judge CLI:
 * audio to R2, transcript, Thai summaries, PIN hash. Publishing differs.
 */
export async function runPipeline(m: Manifest, pin: string): Promise<PipelineResult> {
  m.outputs ??= {};

  // 1. Audio: per-speaker tracks + one mixed file, all to R2.
  const raw = await buildRawTracks(m);
  const tracks = await encodeTracks(raw);
  m.outputs.tracks = {};
  for (const [userId, path] of Object.entries(tracks)) {
    const key = keys.track(m.id, userId);
    await putFile(key, path, "audio/ogg");
    m.outputs.tracks[userId] = key;
  }
  const mixed = await mixTracks(m, raw);
  await putFile(keys.mixed(m.id), mixed, "audio/mpeg");
  m.outputs.mixed = keys.mixed(m.id);
  await saveEverywhere(m);

  // 2. Transcript.
  const t = await transcribeMeeting(m, raw);
  await putText(keys.transcript(m.id), t.text);
  m.outputs.transcript = keys.transcript(m.id);
  log.info(`${m.id}: ${t.lines.length} lines from ${t.totalChunks} requests (${t.failedChunks} failed) via ${t.modelsUsed.join(", ")}`);

  // 3. Summaries (Thai).
  let full: string;
  let short: string;
  if (t.lines.length === 0) {
    full = "# สรุปการประชุม\n\nไม่พบเสียงพูดในการบันทึกนี้";
    short = "ไม่พบเสียงพูดในการบันทึกนี้";
  } else {
    full = (await fullSummary(m, t.text)).text;
    short = (await shortSummary(m, full)).text;
  }
  await putText(keys.summaryFull(m.id), full, "text/markdown; charset=utf-8");
  await putText(keys.summaryShort(m.id), short, "text/markdown; charset=utf-8");
  m.outputs.summaryFull = keys.summaryFull(m.id);
  m.outputs.summaryShort = keys.summaryShort(m.id);

  // 4. PIN. Only the hash is stored.
  m.pin = hashPin(pin);
  await saveEverywhere(m);

  const notes: string[] = [];
  if (m.recovered) notes.push("บอทรีสตาร์ทระหว่างประชุม เสียงช่วงท้ายอาจขาดหายไปบางส่วน");
  if (t.failedChunks > 0) notes.push(`ถอดเสียงไม่สำเร็จ ${t.failedChunks} จาก ${t.totalChunks} ช่วง`);
  return { lines: t.lines, shortSummary: short, fullSummary: full, transcript: t.text, notes };
}

async function run(client: Client, m: Manifest): Promise<void> {
  const started = Date.now();
  log.info(`processing ${m.id}`);
  try {
    const pin = generatePin();
    const result = await runPipeline(m, pin);
    m.outputs!.postedMessageUrl = await publishMinutes(client, m, {
      pin,
      shortSummary: result.shortSummary,
      fullSummary: result.fullSummary,
      transcript: result.transcript,
      note: result.notes.join(" / ") || undefined,
    });

    m.status = "done";
    await saveEverywhere(m);
    log.info(`done ${m.id} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (config().CLEANUP_LOCAL) rmSync(meetingDir(m.id), { recursive: true, force: true });
  } catch (err) {
    log.error(`processing ${m.id} failed`, err);
    m.status = "failed";
    m.error = (err as Error).message;
    try {
      await saveEverywhere(m);
    } catch {
      saveLocal(m);
    }
    await notifyFailure(client, m, m.error);
  }
}

/**
 * After a crash or restart: meetings that were still recording are closed at
 * their last heartbeat and processed; meetings that were mid-processing are retried.
 */
/** Close a crashed recording at its last heartbeat; pure manifest edit, no I/O. */
export function closeAtHeartbeat(m: Manifest): Manifest {
  m.endedAt = m.heartbeatAt;
  m.endReason = "the bot restarted during the meeting";
  m.recovered = true;
  m.status = "processing";
  // Utterances still open at the crash are lost; everything written to disk is kept.
  const end = Math.round(((m.endedAt - m.startedAt) * SAMPLE_RATE) / 1000);
  for (const p of Object.values(m.participants)) {
    p.utterances = p.utterances.filter((u) => u.start < end).map((u) => ({ ...u, end: Math.min(u.end, end) }));
    p.segments = p.segments.filter((s) => s * SEGMENT_SAMPLES < end);
  }
  return m;
}

export async function recoverUnfinished(client: Client): Promise<void> {
  for (const m of unfinishedLocal()) {
    if (m.status === "recording") {
      log.warn(`recovering ${m.id}: recorder stopped unexpectedly, closing at last heartbeat`);
      closeAtHeartbeat(m);
      saveLocal(m);
    }
    void processMeeting(client, m);
  }
}
