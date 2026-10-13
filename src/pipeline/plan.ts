import { SAMPLE_RATE } from "../config.js";
import type { Utterance } from "../storage/manifest.js";

/**
 * Pure planning helpers for transcription, kept free of I/O so they can be unit tested.
 * All positions are in samples on the meeting timeline.
 */

export interface PlanOptions {
  /** Merge a speaker's utterances when the pause between them is at most this long. */
  mergeGap: number;
  /** Upper bound for one merged turn. */
  maxTurn: number;
  /** Drop turns shorter than this (coughs, clicks). */
  minTurn: number;
  /** Upper bound for the audio sent in one API request. */
  maxChunk: number;
  /** Silence inserted between turns packed into the same request. */
  joinGap: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  mergeGap: 2 * SAMPLE_RATE,
  maxTurn: 60 * SAMPLE_RATE,
  minTurn: Math.round(0.4 * SAMPLE_RATE),
  maxChunk: 120 * SAMPLE_RATE,
  joinGap: Math.round(0.6 * SAMPLE_RATE),
};

export interface Piece {
  /** Where the piece starts inside the request audio. */
  chunkOffset: number;
  /** Where it starts on the meeting timeline. */
  sessionStart: number;
  length: number;
}

export interface Chunk {
  pieces: Piece[];
  /** Total request audio length, including the joining silence. */
  length: number;
}

export function buildTurns(utterances: Utterance[], o: PlanOptions = DEFAULT_PLAN): Utterance[] {
  const sorted = [...utterances].filter((u) => u.end > u.start).sort((a, b) => a.start - b.start);
  const turns: Utterance[] = [];
  for (const u of sorted) {
    const last = turns.at(-1);
    if (last && u.start - last.end <= o.mergeGap && Math.max(last.end, u.end) - last.start <= o.maxTurn) {
      last.end = Math.max(last.end, u.end);
    } else {
      turns.push({ ...u });
    }
  }
  // Split anything still longer than maxTurn (one very long monologue).
  const split: Utterance[] = [];
  for (const t of turns) {
    for (let s = t.start; s < t.end; s += o.maxTurn) split.push({ start: s, end: Math.min(t.end, s + o.maxTurn) });
  }
  return split.filter((t) => t.end - t.start >= o.minTurn);
}

/**
 * Packs one speaker's turns into requests of at most `maxChunk` samples so a long
 * meeting needs few API calls, while every piece remembers its real start time.
 */
export function packChunks(turns: Utterance[], o: PlanOptions = DEFAULT_PLAN): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;
  for (const t of turns) {
    const len = t.end - t.start;
    const needed = cur && cur.pieces.length > 0 ? o.joinGap + len : len;
    if (!cur || cur.length + needed > o.maxChunk) {
      cur = { pieces: [], length: 0 };
      chunks.push(cur);
    }
    const offset = cur.pieces.length > 0 ? cur.length + o.joinGap : 0;
    cur.pieces.push({ chunkOffset: offset, sessionStart: t.start, length: len });
    cur.length = offset + len;
  }
  return chunks;
}

/** Map a time inside a request (in samples) back to the meeting timeline. */
export function toSessionSample(chunk: Chunk, chunkSample: number): number {
  let piece = chunk.pieces[0]!;
  for (const p of chunk.pieces) {
    if (p.chunkOffset <= chunkSample) piece = p;
    else break;
  }
  const within = Math.min(Math.max(0, chunkSample - piece.chunkOffset), piece.length);
  return piece.sessionStart + within;
}

export interface Line {
  start: number;
  userId: string;
  text: string;
}

/** Sort lines by time and join consecutive lines from the same speaker. */
export function mergeLines(lines: Line[], maxJoinGap = 45 * SAMPLE_RATE): Line[] {
  const sorted = [...lines].filter((l) => l.text.trim()).sort((a, b) => a.start - b.start);
  const out: Line[] = [];
  let lastStart = -Infinity;
  for (const l of sorted) {
    const prev = out.at(-1);
    if (prev && prev.userId === l.userId && l.start - lastStart <= maxJoinGap) {
      prev.text = `${prev.text} ${l.text.trim()}`;
    } else {
      out.push({ ...l, text: l.text.trim() });
    }
    lastStart = l.start;
  }
  return out;
}
