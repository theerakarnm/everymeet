import { SAMPLE_RATE } from "../config.js";
import type { Utterance } from "../storage/manifest.js";

/**
 * Energy-based speech detection for mixed Google Meet audio. Pure, so it is unit testable.
 * Positions are samples on the meeting timeline.
 */
export interface VadOptions {
  /** Samples per analysis frame. */
  frame: number;
  /** Frames at least this loud (RMS, dBFS) count as speech. */
  thresholdDb: number;
  /** Speech runs closer than this are one utterance. */
  bridge: number;
  /** Kept around each utterance so first and last syllables are not clipped. */
  pad: number;
}

export const DEFAULT_VAD: VadOptions = {
  frame: SAMPLE_RATE / 50,
  thresholdDb: -50,
  bridge: Math.round(0.3 * SAMPLE_RATE),
  pad: Math.round(0.2 * SAMPLE_RATE),
};

/** Speech in a mono s16le buffer that starts at `offset` on the meeting timeline. */
export function detectUtterances(pcm: Buffer, offset: number, o: VadOptions = DEFAULT_VAD): Utterance[] {
  const total = Math.floor(pcm.length / 2);
  const threshold = 32768 * 10 ** (o.thresholdDb / 20);
  const runs: Utterance[] = [];
  for (let f = 0; f + o.frame <= total; f += o.frame) {
    let sum = 0;
    for (let i = f; i < f + o.frame; i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    if (Math.sqrt(sum / o.frame) < threshold) continue;
    const last = runs.at(-1);
    if (last && f - last.end <= o.bridge) last.end = f + o.frame;
    else runs.push({ start: f, end: f + o.frame });
  }
  return runs.map((r) => ({
    start: offset + Math.max(0, r.start - o.pad),
    end: offset + Math.min(total, r.end + o.pad),
  }));
}
