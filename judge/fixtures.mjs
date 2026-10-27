/**
 * Deterministic meeting fixture for the migration judge.
 *
 * Writes {dataDir}/meetings/{id}/manifest.json and the local PCM segments, and
 * seeds the FLAC segment backups (what the recorder would have uploaded) into
 * s3.objects under their R2 keys, marking them uploaded.
 *
 * Timeline (seconds from meeting start), 24 kHz mono s16le tones:
 * - speaker 900000000000000002 (440 Hz) joins first: 1-6, 8.5-13, 103-118, 295-305
 * - speaker 100000000000000001 (660 Hz) joins second: 20-50, 400-415
 * The 1-6/8.5-13 pair leaves a 2.5 s same-speaker pause: above mergeGap (2 s),
 * so buildTurns keeps two turns, but inside the 45 s transcript join, so the
 * lines merge back. The 13 -> 103 gap is a 90 s silence, past the 45 s join,
 * so those lines stay separate. 295-305 spans the 300 s segment boundary.
 * The ids sort in the opposite order of the join, on purpose.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** 16 chars, matches ^[A-Za-z0-9_-]{16}$; fixed so goldens are stable. */
export const FIXTURE_ID = "FIXTUREFIXTURE12";
/** 2026-12-31T17:30:00Z: 2026-12-31 in UTC but already 2027-01-01 (B.E. 2570) in Bangkok. */
export const FIXTURE_STARTED_AT = Date.UTC(2026, 11, 31, 17, 30, 0);

const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
const SEGMENT_SECONDS = 300;
const SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS;
const MEETING_SECONDS = 600;
const TONE_AMPLITUDE = 8192; // 0.25 full scale, safe under the amix limiter

export const FIRST_SPEAKER = "900000000000000002";
export const SECOND_SPEAKER = "100000000000000001";

const SPEAKERS = [
  { userId: FIRST_SPEAKER, displayName: "สมชาย", toneHz: 440, utterances: [[1, 6], [8.5, 13], [103, 118], [295, 305]] },
  { userId: SECOND_SPEAKER, displayName: "สมหญิง", toneHz: 660, utterances: [[20, 50], [400, 415]] },
];

const segmentKey = (id, userId, index) =>
  `meetings/${id}/segments/${userId}/${String(index).padStart(4, "0")}.flac`;

const samples = (seconds) => Math.round(seconds * SAMPLE_RATE);

function segmentsTouched(utterances) {
  const out = new Set();
  for (const [us, ue] of utterances) {
    for (let i = Math.floor(samples(us) / SEGMENT_SAMPLES); i <= Math.floor((samples(ue) - 1) / SEGMENT_SAMPLES); i++) {
      out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const toneSample = (hz, i) => Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));

/** Full-length segment file, like the recorder's closeSegment padding. */
function writeSegmentPcm(userDir, index, spec) {
  const segStart = index * SEGMENT_SAMPLES;
  const buf = Buffer.alloc(SEGMENT_SAMPLES * BYTES_PER_SAMPLE);
  for (const [us, ue] of spec.utterances) {
    const from = Math.max(samples(us), segStart);
    const to = Math.min(samples(ue), segStart + SEGMENT_SAMPLES);
    for (let i = from; i < to; i++) buf.writeInt16LE(toneSample(spec.toneHz, i), (i - segStart) * BYTES_PER_SAMPLE);
  }
  const path = join(userDir, `${String(index).padStart(4, "0")}.pcm`);
  writeFileSync(path, buf);
  return path;
}

/** The recorder uploads FLAC backups while the meeting runs; make real ones so
    scenario 10 can drop the local PCM and decode the R2 copy back to equal bytes. */
function flacBackup(pcmPath) {
  const flacPath = `${pcmPath}.flac`;
  const run = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", pcmPath, "-c:a", "flac", flacPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (run.status !== 0) throw new Error(`ffmpeg FLAC encode failed for ${pcmPath}: ${run.stderr}`);
  const bytes = readFileSync(flacPath);
  unlinkSync(flacPath);
  return bytes;
}

export function makeMeetingFixture(dataDir, s3) {
  const id = FIXTURE_ID;
  const dir = join(dataDir, "meetings", id);
  const startedAt = FIXTURE_STARTED_AT;
  const endedAt = startedAt + MEETING_SECONDS * 1000;
  const participants = {};
  for (const spec of SPEAKERS) {
    const userDir = join(dir, "segments", spec.userId);
    mkdirSync(userDir, { recursive: true });
    const touched = segmentsTouched(spec.utterances);
    for (const index of touched) {
      const pcm = writeSegmentPcm(userDir, index, spec);
      s3.objects.set(segmentKey(id, spec.userId, index), flacBackup(pcm));
    }
    participants[spec.userId] = {
      displayName: spec.displayName,
      utterances: spec.utterances.map(([us, ue]) => ({ start: samples(us), end: samples(ue) })),
      segments: touched,
      // The pipeline never uploads segments (the recorder does); assemble reads
      // `uploaded` before falling back to the R2 copy.
      uploaded: touched,
    };
  }
  const manifest = {
    id,
    guildId: "000000000000000001",
    guildName: "daily-standup",
    voiceChannelId: "000000000000000002",
    voiceChannelName: "ห้องประชุมหลัก",
    commandChannelId: "000000000000000003",
    startedBy: { id: FIRST_SPEAKER, name: "สมชาย" },
    startedAt,
    endedAt,
    endReason: "ended by สมชาย with /end",
    heartbeatAt: endedAt,
    // On-disk state between /end and the pipeline finishing.
    status: "processing",
    participants,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { id, manifest };
}
