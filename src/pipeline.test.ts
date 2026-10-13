import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import OpusScript from "opusscript";
import { dataDir } from "./test/setup.js";

const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("./config.js");
const { TrackWriter } = await import("./recorder/track-writer.js");
const { meetingDir } = await import("./storage/manifest.js");
const { buildRawTracks, mixTracks, totalSamples } = await import("./pipeline/assemble.js");
const plan = await import("./pipeline/plan.js");
const pin = await import("./util/pin.js");
const { truncate } = await import("./pipeline/summarize.js");
const { formatTranscript } = await import("./pipeline/transcribe.js");

const sec = (s: number) => Math.round(s * SAMPLE_RATE);

function tone(seconds: number, freq = 440): Buffer {
  const n = sec(seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)), i * 2);
  return b;
}

test("Discord 48 kHz stereo Opus decodes to 24 kHz mono frames", () => {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const frame = Buffer.alloc(960 * 2 * 2); // 20 ms stereo s16
  for (let i = 0; i < 960; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    frame.writeInt16LE(v, i * 4);
    frame.writeInt16LE(v, i * 4 + 2);
  }
  const packet = enc.encode(frame, 960);
  const dec = new OpusScript(24000, 1, OpusScript.Application.VOIP);
  const pcm = dec.decode(packet);
  assert.equal(pcm.length, 480 * 2); // 20 ms at 24 kHz mono
  enc.delete();
  dec.delete();
});

test("plan: turns merge short pauses, split long ones, and map back to meeting time", () => {
  const turns = plan.buildTurns([
    { start: sec(10), end: sec(12) },
    { start: sec(13), end: sec(15) }, // 1 s pause -> merged
    { start: sec(30), end: sec(30.2) }, // too short -> dropped
    { start: sec(100), end: sec(250) }, // 150 s monologue -> split in 60 s pieces
  ]);
  assert.deepEqual(
    turns.map((t) => [t.start / SAMPLE_RATE, t.end / SAMPLE_RATE]),
    [
      [10, 15],
      [100, 160],
      [160, 220],
      [220, 250],
    ],
  );
  const chunks = plan.packChunks(turns);
  assert.ok(chunks.every((c) => c.length <= plan.DEFAULT_PLAN.maxChunk));
  // Second piece of chunk 0 starts after 5 s of audio + 0.6 s gap; 2 s into it is meeting time 102 s.
  const c0 = chunks[0]!;
  assert.equal(c0.pieces[1]!.sessionStart, sec(100));
  assert.equal(plan.toSessionSample(c0, c0.pieces[1]!.chunkOffset + sec(2)), sec(102));
  assert.equal(plan.toSessionSample(c0, sec(1)), sec(11));
});

test("plan: lines are interleaved by time and same-speaker runs are joined", () => {
  const lines = plan.mergeLines([
    { userId: "b", start: sec(20), text: "ครับ" },
    { userId: "a", start: sec(1), text: "สวัสดีครับ" },
    { userId: "a", start: sec(5), text: "เริ่ม sprint planning" },
    { userId: "a", start: sec(40), text: "ต่อเลย" },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.userId, l.text]),
    [
      ["a", "สวัสดีครับ เริ่ม sprint planning"],
      ["b", "ครับ"],
      ["a", "ต่อเลย"],
    ],
  );
});

test("recording -> segments -> aligned per-speaker tracks -> mixed mp3", async () => {
  const id = "testMeeting00001";
  const startedAt = Date.UTC(2026, 9, 12, 3, 0, 0);
  const totalSec = 620; // spans 3 segments of 5 min
  const segs: Record<string, number[]> = { a: [], b: [] };
  const wa = new TrackWriter(join(meetingDir(id), "segments", "a"), (i) => segs.a!.push(i));
  const wb = new TrackWriter(join(meetingDir(id), "segments", "b"), (i) => segs.b!.push(i));

  // A speaks at 1 s; B speaks across the 300 s boundary; A again at 600 s.
  wa.beginUtterance(sec(1));
  wa.write(tone(2, 440));
  const ua1 = wa.endUtterance()!;
  wb.beginUtterance(sec(298));
  for (let i = 0; i < 4; i++) wb.write(tone(1, 660));
  const ub = wb.endUtterance()!;
  wa.beginUtterance(sec(600));
  wa.write(tone(3, 440));
  const ua2 = wa.endUtterance()!;

  assert.deepEqual(segs.a, [0, 2]);
  assert.deepEqual(segs.b, [0, 1]);
  const end = sec(totalSec);
  for (const w of [wa, wb]) {
    for (const i of w.openSegments()) w.closeSegment(i, Math.min(SEGMENT_SAMPLES, end - i * SEGMENT_SAMPLES));
  }

  const m: any = {
    id,
    guildId: "g",
    guildName: "Planthia",
    voiceChannelId: "v",
    voiceChannelName: "daily-standup",
    commandChannelId: "t",
    startedBy: { id: "a", name: "Alice" },
    startedAt,
    endedAt: startedAt + totalSec * 1000,
    heartbeatAt: startedAt,
    status: "processing",
    participants: {
      a: { displayName: "Alice", utterances: [ua1, ua2], segments: segs.a, uploaded: [] },
      b: { displayName: "Bob", utterances: [ub], segments: segs.b, uploaded: [] },
    },
  };
  assert.equal(totalSamples(m), end);

  const raw = await buildRawTracks(m);
  for (const p of Object.values(raw)) assert.equal(statSync(p).size, end * 2);

  // B's audio sits exactly at 298 s and crosses into segment 1 without a gap.
  const b = readFileSync(raw.b!);
  const at = (buf: Buffer, s: number) => Math.abs(buf.readInt16LE(sec(s) * 2));
  const peak = (buf: Buffer, from: number, to: number) => {
    let max = 0;
    for (let i = sec(from); i < sec(to); i++) max = Math.max(max, Math.abs(buf.readInt16LE(i * 2)));
    return max;
  };
  assert.equal(at(b, 297.9), 0);
  assert.ok(peak(b, 299.9, 300.1) > 4000, "audio continues across the segment boundary");
  assert.ok(peak(b, 301.5, 301.9) > 4000);
  assert.equal(peak(b, 302.1, 310), 0);
  const a = readFileSync(raw.a!);
  assert.ok(peak(a, 600.5, 602.5) > 4000);
  assert.equal(peak(a, 3.5, 599), 0, "silence between utterances is kept as zeros");

  const mp3 = await mixTracks(m, raw);
  const dur = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString(),
  );
  assert.ok(Math.abs(dur - totalSec) < 1, `mixed duration ${dur}s should be ~${totalSec}s`);

  const transcript = formatTranscript(m, [
    { userId: "a", start: sec(1), text: "สวัสดีครับ" },
    { userId: "b", start: sec(298), text: "deploy วันศุกร์" },
  ]);
  assert.match(transcript, /\[00:00:01\] Alice: สวัสดีครับ/);
  assert.match(transcript, /\[00:04:58\] Bob: deploy วันศุกร์/);
});

test("PIN hashing and signed access cookies", () => {
  const p = pin.generatePin();
  assert.match(p, /^\d{6}$/);
  const h = pin.hashPin(p);
  assert.ok(pin.verifyPin(p, h.salt, h.hash));
  assert.ok(!pin.verifyPin(p === "000000" ? "000001" : "000000", h.salt, h.hash));
  assert.ok(!pin.verifyPin("12ab56", h.salt, h.hash));

  const id = pin.newSessionId();
  assert.match(id, pin.SESSION_ID_RE);
  const cookie = pin.signAccess(id, "secret".repeat(8), 60_000);
  assert.ok(pin.verifyAccess(id, cookie, "secret".repeat(8)));
  assert.ok(!pin.verifyAccess(pin.newSessionId(), cookie, "secret".repeat(8)), "cookie is bound to one meeting");
  assert.ok(!pin.verifyAccess(id, cookie, "other".repeat(8)));
  assert.ok(!pin.verifyAccess(id, pin.signAccess(id, "secret".repeat(8), -1), "secret".repeat(8)), "expired");
});

test("short summary truncation stays under the limit", () => {
  const long = Array.from({ length: 80 }, (_, i) => `- ข้อที่ ${i} รายละเอียดการประชุม`).join("\n");
  const t = truncate(long, 1500);
  assert.ok(t.length <= 1500);
  assert.ok(t.endsWith("…"));
});

test("transcription: falls back to the second model and maps segment times to the meeting", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { transcribeMeeting } = await import("./pipeline/transcribe.js");
  const dir = join(dataDir, "stt");
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, "a.raw");
  writeFileSync(rawPath, Buffer.alloc(sec(200) * 2));
  const m: any = {
    id: "sttMeeting000001",
    startedAt: 0,
    endedAt: 200_000,
    heartbeatAt: 0,
    guildName: "g",
    voiceChannelName: "v",
    participants: {
      a: { displayName: "Alice", utterances: [{ start: sec(10), end: sec(14) }, { start: sec(100), end: sec(106) }], segments: [], uploaded: [] },
    },
  };
  const calls: { model: string; verbose: boolean; bytes: number }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, verbose: body.response_format === "verbose_json", bytes: body.input_audio.data.length });
    if (body.model === "microsoft/mai-transcribe-2") return new Response("bad request", { status: 400 });
    // 4 s piece + 0.6 s gap, so the second turn starts at 4.6 s inside the request.
    return Response.json({
      text: "สวัสดี ok",
      segments: [
        { start: 0.5, end: 3, text: "สวัสดีครับ" },
        { start: 5.6, end: 9, text: "ok deploy เลย" },
      ],
    });
  }) as typeof fetch;
  try {
    const r = await transcribeMeeting(m, { a: rawPath });
    assert.equal(r.failedChunks, 0);
    assert.deepEqual(r.modelsUsed, ["google/gemini-3.5-transcribe"]);
    assert.deepEqual(
      calls.map((c) => [c.model, c.verbose]),
      [
        ["microsoft/mai-transcribe-2", true],
        ["microsoft/mai-transcribe-2", false],
        ["google/gemini-3.5-transcribe", true],
      ],
    );
    assert.match(r.text, /\[00:00:10\] Alice: สวัสดีครับ/);
    assert.match(r.text, /\[00:01:41\] Alice: ok deploy เลย/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
