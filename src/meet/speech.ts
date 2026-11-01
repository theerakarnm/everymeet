import { readFileSync } from "node:fs";
import { SEGMENT_SAMPLES } from "../config.js";
import { ensureSegment } from "../pipeline/assemble.js";
import type { Manifest } from "../storage/manifest.js";
import { MEET_PARTICIPANT_ID } from "./protocol.js";
import { detectUtterances } from "./vad.js";

/**
 * A Google Meet recording arrives as continuous mixed audio without speech marks.
 * Finds the speech in every segment so transcription skips silence like it does for Discord.
 */
export async function markMeetSpeech(m: Manifest): Promise<void> {
  const p = m.participants[MEET_PARTICIPANT_ID];
  if (!p) return;
  p.utterances = [];
  for (const index of [...p.segments].sort((a, b) => a - b)) {
    const raw = await ensureSegment(m, MEET_PARTICIPANT_ID, index);
    if (raw) p.utterances.push(...detectUtterances(readFileSync(raw), index * SEGMENT_SAMPLES));
  }
}
