import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BYTES_PER_SAMPLE, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { segmentPath } from "../recorder/track-writer.js";
import { meetingDir, type Manifest } from "../storage/manifest.js";
import { downloadTo, keys } from "../storage/r2.js";
import { ffmpeg, rawInput } from "../util/ffmpeg.js";
import { logger } from "../util/log.js";

const log = logger("assemble");

export const totalSamples = (m: Manifest) =>
  Math.max(1, Math.round((((m.endedAt ?? m.heartbeatAt) - m.startedAt) * SAMPLE_RATE) / 1000));

/** Get a segment's raw PCM locally, downloading the FLAC backup from R2 if the local file is gone. */
async function ensureSegment(m: Manifest, userId: string, index: number): Promise<string | undefined> {
  const dir = join(meetingDir(m.id), "segments", userId);
  const raw = segmentPath(dir, index);
  if (existsSync(raw)) return raw;
  if (!m.participants[userId]?.uploaded.includes(index)) {
    log.warn(`segment ${index} of ${userId} in ${m.id} is missing locally and in R2`);
    return undefined;
  }
  mkdirSync(dir, { recursive: true });
  const flac = `${raw}.flac`;
  await downloadTo(keys.segment(m.id, userId, index), flac);
  await ffmpeg(["-i", flac, "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", raw]);
  unlinkSync(flac);
  return raw;
}

/**
 * Join each speaker's segments into one full-length raw track (silence kept,
 * aligned to the meeting start). All-zero blocks are skipped so the file stays sparse.
 * Returns userId -> raw file path for speakers that have audio.
 */
export async function buildRawTracks(m: Manifest): Promise<Record<string, string>> {
  const total = totalSamples(m);
  const outDir = join(meetingDir(m.id), "tracks");
  mkdirSync(outDir, { recursive: true });
  const result: Record<string, string> = {};
  const block = Buffer.alloc(1 << 20);
  const zeros = Buffer.alloc(block.length);

  for (const [userId, p] of Object.entries(m.participants)) {
    if (p.utterances.length === 0) continue;
    const outPath = join(outDir, `${userId}.raw`);
    const out = openSync(outPath, "w+");
    ftruncateSync(out, total * BYTES_PER_SAMPLE);
    for (const index of [...p.segments].sort((a, b) => a - b)) {
      const segStart = index * SEGMENT_SAMPLES;
      if (segStart >= total) continue;
      const src = await ensureSegment(m, userId, index);
      if (!src) continue;
      const fd = openSync(src, "r");
      const limit = Math.min(SEGMENT_SAMPLES, total - segStart) * BYTES_PER_SAMPLE;
      let pos = 0;
      while (pos < limit) {
        const n = readSync(fd, block, 0, Math.min(block.length, limit - pos), pos);
        if (n <= 0) break;
        if (!block.subarray(0, n).equals(zeros.subarray(0, n))) {
          writeSync(out, block, 0, n, segStart * BYTES_PER_SAMPLE + pos);
        }
        pos += n;
      }
      closeSync(fd);
    }
    closeSync(out);
    result[userId] = outPath;
  }
  return result;
}

/** Per-speaker Opus tracks for archiving. */
export async function encodeTracks(rawTracks: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [userId, raw] of Object.entries(rawTracks)) {
    const ogg = raw.replace(/\.raw$/, ".ogg");
    await ffmpeg([...rawInput(raw), "-c:a", "libopus", "-b:a", "32k", "-application", "voip", ogg]);
    out[userId] = ogg;
  }
  return out;
}

/** One mixed MP3 everybody can play in a browser. */
export async function mixTracks(m: Manifest, rawTracks: Record<string, string>): Promise<string> {
  const out = join(meetingDir(m.id), "meeting.mp3");
  const inputs = Object.values(rawTracks);
  const encode = ["-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", out];
  if (inputs.length === 0) {
    const seconds = totalSamples(m) / SAMPLE_RATE;
    await ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`, "-t", seconds.toFixed(2), ...encode]);
  } else if (inputs.length === 1) {
    await ffmpeg([...rawInput(inputs[0]!), ...encode]);
  } else {
    const filter = `amix=inputs=${inputs.length}:duration=longest:normalize=0,alimiter=limit=0.95`;
    await ffmpeg([...inputs.flatMap(rawInput), "-filter_complex", filter, ...encode]);
  }
  return out;
}
