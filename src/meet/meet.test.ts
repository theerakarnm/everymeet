import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RATE } from "../config.js";
import { detectUtterances } from "./vad.js";
import { parseMeetUrl } from "./meet-url.js";

const sec = (s: number) => Math.round(s * SAMPLE_RATE);

/** Mono s16le made of [seconds, amplitude] pieces of a 440 Hz sine; amplitude 0 is digital silence. */
function audio(pieces: [number, number][]): Buffer {
  const b = Buffer.alloc(pieces.reduce((n, [s]) => n + sec(s), 0) * 2);
  let i = 0;
  for (const [s, amp] of pieces) {
    for (let k = 0; k < sec(s); k++, i++) {
      b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * k) / SAMPLE_RATE)), i * 2);
    }
  }
  return b;
}

test("speech detection keeps a short pause inside one utterance and ignores very quiet noise", () => {
  // speech 1-3 s, 0.2 s pause, speech 3.2-4.2 s, silence, -61 dBFS hum at 7.2-7.7 s
  const pcm = audio([[1, 0], [2, 8000], [0.2, 0], [1, 8000], [3, 0], [0.5, 40], [0.3, 0]]);
  assert.deepEqual(detectUtterances(pcm, 0), [{ start: sec(0.8), end: sec(4.4) }]);
});

test("a long pause starts a new utterance, and positions are shifted to the segment's place on the timeline", () => {
  const pcm = audio([[0.5, 0], [1, 8000], [2, 0], [1, 8000]]);
  const offset = 5 * 60 * SAMPLE_RATE;
  assert.deepEqual(detectUtterances(pcm, offset), [
    { start: offset + sec(0.3), end: offset + sec(1.7) },
    { start: offset + sec(3.3), end: offset + sec(4.5) }, // padding stops at the end of the segment
  ]);
});

test("Meet links and codes are normalized, and anything else is refused", () => {
  const ok = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
  for (const input of [
    "https://meet.google.com/abc-defg-hij",
    " meet.google.com/abc-defg-hij?authuser=1 ",
    "http://meet.google.com/ABC-DEFG-HIJ/",
    "abc-defg-hij",
  ]) {
    assert.deepEqual(parseMeetUrl(input), ok, input);
  }
  for (const input of [
    "https://evil.example.com/abc-defg-hij",
    "https://meet.google.com.evil.example.com/abc-defg-hij",
    "https://meet.google.com/lookup/abcdefghij",
    "https://meet.google.com/",
    "abc-defg",
  ]) {
    assert.equal(parseMeetUrl(input), undefined, input);
  }
});
