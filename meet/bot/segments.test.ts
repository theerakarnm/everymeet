import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SegmentSplitter, type FinishedSegment } from "./segments.js";

test("a stream arriving in odd-sized chunks is cut into segments of exactly N samples", () => {
  const dir = mkdtempSync(join(tmpdir(), "meet-segments-"));
  const done: FinishedSegment[] = [];
  const splitter = new SegmentSplitter(dir, 4, (s) => done.push(s)); // 4 samples = 8 bytes
  const stream = Buffer.from(Array.from({ length: 19 }, (_, i) => i));
  for (const [from, to] of [[0, 3], [3, 8], [8, 15], [15, 19]]) splitter.write(stream.subarray(from, to));
  assert.deepEqual(done.map((s) => [s.index, s.samples]), [[0, 4], [1, 4]]);
  splitter.finish();
  assert.deepEqual(done.map((s) => [s.index, s.samples]), [[0, 4], [1, 4], [2, 1]]);
  assert.deepEqual(readFileSync(done[0]!.path), stream.subarray(0, 8));
  assert.deepEqual(readFileSync(done[1]!.path), stream.subarray(8, 16));
  assert.deepEqual(readFileSync(done[2]!.path), stream.subarray(16, 19), "the half sample stays in the file; ffmpeg ignores it");
});

test("finishing exactly on a boundary emits no empty segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "meet-segments-"));
  const done: FinishedSegment[] = [];
  const splitter = new SegmentSplitter(dir, 2, (s) => done.push(s));
  splitter.write(Buffer.alloc(8));
  splitter.finish();
  assert.deepEqual(done.map((s) => s.index), [0, 1]);
});
