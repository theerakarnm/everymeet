import { closeSync, openSync, readSync } from "node:fs";
import { BYTES_PER_SAMPLE, SAMPLE_RATE, config } from "../config.js";
import type { Manifest } from "../storage/manifest.js";
import { pcmToWav } from "../util/wav.js";
import { pLimit } from "../util/limit.js";
import { hms, bangkokDateTime, durationTh } from "../util/time.js";
import { logger } from "../util/log.js";
import { buildTurns, mergeLines, packChunks, toSessionSample, type Chunk, type Line } from "./plan.js";
import { transcribe } from "./openrouter.js";
import { totalSamples } from "./assemble.js";

const log = logger("transcribe");
const FAILED_MARK = "[ถอดเสียงช่วงนี้ไม่สำเร็จ]";

function readChunkAudio(rawPath: string, chunk: Chunk): Buffer {
  const pcm = Buffer.alloc(chunk.length * BYTES_PER_SAMPLE); // zero-filled = joining silence
  const fd = openSync(rawPath, "r");
  try {
    for (const p of chunk.pieces) {
      readSync(fd, pcm, p.chunkOffset * BYTES_PER_SAMPLE, p.length * BYTES_PER_SAMPLE, p.sessionStart * BYTES_PER_SAMPLE);
    }
  } finally {
    closeSync(fd);
  }
  return pcmToWav(pcm);
}

export interface TranscriptResult {
  lines: Line[];
  text: string;
  modelsUsed: string[];
  failedChunks: number;
  totalChunks: number;
}

/** Transcribe every speaker's own track, then interleave by time into one transcript. */
export async function transcribeMeeting(m: Manifest, rawTracks: Record<string, string>): Promise<TranscriptResult> {
  const limit = pLimit(config().TRANSCRIBE_CONCURRENCY);
  const jobs: Promise<Line[]>[] = [];
  const models = new Set<string>();
  let failed = 0;
  let total = 0;

  for (const [userId, raw] of Object.entries(rawTracks)) {
    const chunks = packChunks(buildTurns(m.participants[userId]!.utterances));
    total += chunks.length;
    for (const chunk of chunks) {
      jobs.push(
        limit(async () => {
          try {
            const res = await transcribe(readChunkAudio(raw, chunk));
            models.add(res.model);
            if (res.segments) {
              return res.segments.map((s) => ({
                userId,
                start: toSessionSample(chunk, Math.round(s.start * SAMPLE_RATE)),
                text: s.text,
              }));
            }
            return [{ userId, start: chunk.pieces[0]!.sessionStart, text: res.text }];
          } catch (err) {
            failed++;
            log.error(`chunk failed for ${userId} in ${m.id}`, err);
            return [{ userId, start: chunk.pieces[0]!.sessionStart, text: FAILED_MARK }];
          }
        }),
      );
    }
  }

  const lines = mergeLines((await Promise.all(jobs)).flat());
  return { lines, text: formatTranscript(m, lines), modelsUsed: [...models], failedChunks: failed, totalChunks: total };
}

export function speakerName(m: Manifest, userId: string): string {
  return m.participants[userId]?.displayName ?? userId;
}

export function formatTranscript(m: Manifest, lines: Line[]): string {
  const speakers = [...new Set(lines.map((l) => speakerName(m, l.userId)))];
  const header = [
    `บันทึกการถอดเสียงการประชุม (Transcript)`,
    `เซิร์ฟเวอร์: ${m.guildName}`,
    `ห้องเสียง: ${m.voiceChannelName}`,
    `เริ่ม: ${bangkokDateTime(m.startedAt)} | ระยะเวลา: ${durationTh(totalSamples(m) / SAMPLE_RATE)}`,
    `ผู้พูด: ${speakers.join(", ") || "-"}`,
    "",
    "-".repeat(60),
    "",
  ];
  const body = lines.map((l) => `[${hms(l.start / SAMPLE_RATE)}] ${speakerName(m, l.userId)}: ${l.text}`);
  return [...header, ...body, ""].join("\n");
}
