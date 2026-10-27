/**
 * Pipeline scenarios 6-11: full process against the fake services, transcription
 * fallback behavior, the short-summary length limit, the no-utterance meeting,
 * segment restore from the R2 FLAC backup, and crash recovery at the heartbeat.
 * Every scenario runs the real `judge-cli process` (or `recover`) with real
 * ffmpeg, then asserts the same expected values for either implementation.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import { FIRST_SPEAKER, SECOND_SPEAKER } from "../fixtures.mjs";

const SAMPLE_RATE = 24_000;
/** Frozen Thai strings from the pipeline (src/pipeline/summarize.ts, transcribe.ts, run.ts). */
const EMPTY_FULL = "# สรุปการประชุม\n\nไม่พบเสียงพูดในการบันทึกนี้";
const FAILED_MARK = "[ถอดเสียงช่วงนี้ไม่สำเร็จ]";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

function expectedR2Keys(id) {
  return [
    `meetings/${id}/manifest.json`,
    `meetings/${id}/tracks/${FIRST_SPEAKER}.ogg`,
    `meetings/${id}/tracks/${SECOND_SPEAKER}.ogg`,
    `meetings/${id}/meeting.mp3`,
    `meetings/${id}/transcript.txt`,
    `meetings/${id}/summary-full.md`,
    `meetings/${id}/summary-short.md`,
    `meetings/${id}/segments/${FIRST_SPEAKER}/0000.flac`,
    `meetings/${id}/segments/${FIRST_SPEAKER}/0001.flac`,
    `meetings/${id}/segments/${SECOND_SPEAKER}/0000.flac`,
    `meetings/${id}/segments/${SECOND_SPEAKER}/0001.flac`,
  ].sort();
}

/** pin.salt/hash are random per run; both sides get the same placeholder. */
export function normalizePin(m) {
  if (m?.pin) m.pin = { salt: "<salt>", hash: "<hash>" };
  return m;
}

function ffprobeJson(file) {
  const run = spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`ffprobe failed for ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** Overall RMS/peak levels in dB, from the "Overall" block of astats output. */
function astatsOverall(file) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a", "-af", "astats", "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`ffmpeg astats failed for ${file}: ${run.stderr.slice(-2000)}`);
  const lines = run.stderr.split(/\r?\n/);
  const overallIdx = lines.findIndex((l) => l.trimEnd().endsWith(" Overall"));
  if (overallIdx === -1) throw new Error("astats output has no Overall block");
  const grab = (name) => {
    const line = lines.slice(overallIdx).find((l) => l.includes(name));
    if (!line) throw new Error(`astats Overall ${name} not found`);
    return Number(line.split(":").pop());
  };
  return { rms: grab("RMS level dB"), peak: grab("Peak level dB") };
}

/** Codec, channel count, duration and loudness of the pipeline's audio outputs. */
function probeMedia(ctx) {
  const probeDir = join(ctx.dataDir, "probe");
  mkdirSync(probeDir, { recursive: true });
  const mp3 = join(probeDir, "meeting.mp3");
  writeFileSync(mp3, ctx.s3Bytes(`meetings/${ctx.id}/meeting.mp3`));
  const info = ffprobeJson(mp3);
  if (info.streams.length !== 1) throw new Error(`expected one stream in meeting.mp3, got ${info.streams.length}`);
  const stats = astatsOverall(mp3);
  const oggCodecs = [FIRST_SPEAKER, SECOND_SPEAKER].map((userId) => {
    const ogg = join(probeDir, `track-${userId}.ogg`);
    writeFileSync(ogg, ctx.s3Bytes(`meetings/${ctx.id}/tracks/${userId}.ogg`));
    const streams = ffprobeJson(ogg).streams;
    if (streams.length === 0) throw new Error(`no streams in ${userId}.ogg`);
    return streams.map((s) => s.codec_name);
  });
  return {
    audioCodec: info.streams[0].codec_name,
    channels: info.streams[0].channels,
    duration: Number(info.format.duration),
    ...stats,
    oggCodecs,
  };
}

function sttMultiset(ctx) {
  return ctx.orCalls
    .filter((c) => c.path.endsWith("/audio/transcriptions"))
    .map((c) => [c.body.model, sha256Hex(Buffer.from(c.body.input_audio.data, "base64"))])
    .sort();
}

const chatCalls = (ctx) => ctx.orCalls.filter((c) => c.path.endsWith("/chat/completions"));

const publishOf = (ctx) => JSON.parse(readFileSync(join(ctx.dataDir, "judge-publish.json"), "utf8"));

function goldenMediaDiffers(media, golden) {
  return Math.abs(media.duration - golden.duration) <= 0.05 &&
    Math.abs(media.rms - golden.rms) <= 0.5 &&
    Math.abs(media.peak - golden.peak) <= 0.5;
}

export async function happy(open) {
  const ctx = await open();
  ctx.seedFixture();
  await ctx.processMeeting();

  assert.deepEqual([...ctx.s3objects.keys()].sort(), expectedR2Keys(ctx.id), "exact R2 key set after process");

  const transcript = ctx.s3Text(`meetings/${ctx.id}/transcript.txt`);
  const stt = sttMultiset(ctx);
  const chats = chatCalls(ctx).map((c) => ({ model: c.body.model, max_tokens: c.body.max_tokens, messages: c.body.messages }));
  const manifest = normalizePin(JSON.parse(ctx.s3Text(`meetings/${ctx.id}/manifest.json`)));
  const publish = publishOf(ctx);
  const media = probeMedia(ctx);

  assert.equal(media.audioCodec, "mp3");
  assert.equal(media.channels, 1);
  assert.deepEqual(media.oggCodecs, [["opus"], ["opus"]], "both per-speaker tracks are opus");

  if (ctx.recordGolden) {
    ctx.writeGolden("transcript.txt", transcript);
    ctx.writeGolden("stt.json", `${JSON.stringify(stt, null, 2)}\n`);
    ctx.writeGolden("chat.json", `${JSON.stringify(chats, null, 2)}\n`);
    ctx.writeGolden("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    ctx.writeGolden("media.json", `${JSON.stringify({ duration: media.duration, rms: media.rms, peak: media.peak }, null, 2)}\n`);
    ctx.writeGolden("publish.json", `${JSON.stringify(publish, null, 2)}\n`);
    return;
  }

  assert.equal(transcript, ctx.readGolden("transcript.txt"), "transcript.txt differs from golden");
  assert.deepEqual(stt, JSON.parse(ctx.readGolden("stt.json")), "STT (model, wav hash) multiset differs from golden");
  assert.deepEqual(chats, JSON.parse(ctx.readGolden("chat.json")), "chat calls (order, models, prompts) differ from golden");
  assert.deepEqual(manifest, JSON.parse(ctx.readGolden("manifest.json")), "final manifest differs from golden");
  const goldenMedia = JSON.parse(ctx.readGolden("media.json"));
  assert.ok(
    goldenMediaDiffers(media, goldenMedia),
    `mp3 duration/RMS/peak ${media.duration}/${media.rms}/${media.peak} vs golden ${goldenMedia.duration}/${goldenMedia.rms}/${goldenMedia.peak}`,
  );
  assert.deepEqual(publish, JSON.parse(ctx.readGolden("publish.json")), "judge-publish.json differs from golden");
}

const assertHappyGoldens = (ctx) => {
  assert.equal(ctx.s3Text(`meetings/${ctx.id}/transcript.txt`), ctx.readGolden("transcript.txt"), "transcript differs from golden");
  assert.deepEqual(sttMultiset(ctx), JSON.parse(ctx.readGolden("stt.json")), "STT multiset differs from golden");
  assert.deepEqual(
    chatCalls(ctx).map((c) => ({ model: c.body.model, max_tokens: c.body.max_tokens, messages: c.body.messages })),
    JSON.parse(ctx.readGolden("chat.json")),
    "chat calls differ from golden",
  );
  assert.deepEqual(
    normalizePin(JSON.parse(ctx.s3Text(`meetings/${ctx.id}/manifest.json`))),
    JSON.parse(ctx.readGolden("manifest.json")),
    "manifest differs from golden",
  );
  assert.deepEqual(publishOf(ctx), JSON.parse(ctx.readGolden("publish.json")), "publish payload differs from golden");
  const media = probeMedia(ctx);
  const goldenMedia = JSON.parse(ctx.readGolden("media.json"));
  assert.ok(goldenMediaDiffers(media, goldenMedia), "mixed audio loudness/duration differs from golden");
};

export async function segmentFromR2(open) {
  const ctx = await open();
  ctx.seedFixture();
  // Drop one locally recorded segment that was uploaded: only the R2 FLAC can restore it.
  rmSync(join(ctx.dataDir, "meetings", ctx.id, "segments", SECOND_SPEAKER, "0001.pcm"));
  await ctx.processMeeting();
  assertHappyGoldens(ctx);
}

/** Scripted chat: the full-summary call is answered once, short-summary asks get the scripted replies. */
const chatScript = (shortReplies, full = "# สรุปการประชุม\n\n## ภาพรวม\nประชุมทดสอบจาก fake") => {
  let asked = 0;
  return (call) => {
    if (!call.path.endsWith("/chat/completions")) return undefined;
    if (call.body.max_tokens > 2_000) return { status: 200, body: { choices: [{ message: { content: full } }] } };
    const reply = shortReplies[Math.min(asked, shortReplies.length - 1)];
    asked++;
    return { status: 200, body: { choices: [{ message: { content: reply } }] } };
  };
};

const shortChats = (ctx) => chatCalls(ctx).filter((c) => c.body.max_tokens <= 2_000);

export async function fallback(open) {
  // Sub-run 1: the primary transcribe model refuses everything with HTTP 400.
  const ctx = await open({
    script: (call) =>
      call.path.endsWith("/audio/transcriptions") && call.body.model === ctx.env.TRANSCRIBE_MODEL_PRIMARY
        ? { status: 400, body: { error: { message: "judge: primary is down" } } }
        : undefined,
  });
  ctx.seedFixture();
  await ctx.processMeeting();

  const byChunk = new Map();
  for (const call of ctx.orCalls.filter((c) => c.path.endsWith("/audio/transcriptions"))) {
    const sha = sha256Hex(Buffer.from(call.body.input_audio.data, "base64"));
    if (!byChunk.has(sha)) byChunk.set(sha, []);
    byChunk.get(sha).push(call);
  }
  assert.equal(byChunk.size, 2, "one chunk per speaker");
  for (const [sha, calls] of byChunk) {
    const primaryCalls = calls.filter((c) => c.body.model === ctx.env.TRANSCRIBE_MODEL_PRIMARY);
    const fallbackCalls = calls.filter((c) => c.body.model === ctx.env.TRANSCRIBE_MODEL_FALLBACK);
    assert.equal(primaryCalls.length, 2, `chunk ${sha.slice(0, 8)}: verbose request then plain retry, nothing more`);
    assert.deepEqual(
      primaryCalls.map((c) => Boolean(c.body.response_format)),
      [true, false],
      `chunk ${sha.slice(0, 8)}: verbose first, then the plain retry`,
    );
    assert.equal(fallbackCalls.length, 1, `chunk ${sha.slice(0, 8)}: the fallback model takes over`);
    assert.equal(fallbackCalls[0].body.response_format, "verbose_json");
  }
  assert.ok(!ctx.s3Text(`meetings/${ctx.id}/transcript.txt`).includes(FAILED_MARK), "fallback saved every chunk");
  assert.ok(!publishOf(ctx).content.includes("ถอดเสียงไม่สำเร็จ"), "no failure note when the fallback worked");

  // Sub-run 2: every transcription model refuses; marks and the publish note appear.
  const ctx2 = await open({
    script: (call) =>
      call.path.endsWith("/audio/transcriptions")
        ? { status: 400, body: { error: { message: "judge: every model refuses" } } }
        : undefined,
  });
  ctx2.seedFixture();
  await ctx2.processMeeting();
  assert.equal(
    (ctx2.s3Text(`meetings/${ctx2.id}/transcript.txt`).split(FAILED_MARK).length - 1),
    2,
    "one failed-chunk mark per speaker",
  );
  assert.match(publishOf(ctx2).content, /ถอดเสียงไม่สำเร็จ 2 จาก 2 ช่วง/);
  assert.equal(chatCalls(ctx2).length, 2, "summaries still ran");
}

export async function shortSummaryLimit(open) {
  const lastPrompt = (call) => call.body.messages.at(-1).content;

  // (a) first short reply is exactly 1500 chars: one more ask (the 800-char one) is made.
  {
    const ctx = await open({ script: chatScript(["x".repeat(1500), "สรุปสั้น"]) });
    ctx.seedFixture();
    await ctx.processMeeting();
    const shorts = shortChats(ctx);
    assert.equal(shorts.length, 2, "(a) the 1500-char reply triggers one more ask");
    assert.match(lastPrompt(shorts[0]), /ความยาวไม่เกิน 1200 ตัวอักษร/);
    assert.match(lastPrompt(shorts[1]), /ความยาวไม่เกิน 800 ตัวอักษร/);
    assert.equal(ctx.s3Text(`meetings/${ctx.id}/summary-short.md`), "สรุปสั้น");
  }
  // (b) first short reply is exactly 1499 chars: accepted as is.
  {
    const ctx = await open({ script: chatScript(["y".repeat(1499)]) });
    ctx.seedFixture();
    await ctx.processMeeting();
    const shorts = shortChats(ctx);
    assert.equal(shorts.length, 1, "(b) 1499 chars needs no second ask");
    assert.equal(ctx.s3Text(`meetings/${ctx.id}/summary-short.md`), "y".repeat(1499));
  }
  // (c) both replies are 1600 chars with a line break past 60%: cut at that break.
  {
    const reply = `${"a".repeat(1000)}\n${"b".repeat(599)}`;
    assert.equal(reply.length, 1600);
    const ctx = await open({ script: chatScript([reply, reply]) });
    ctx.seedFixture();
    await ctx.processMeeting();
    const shorts = shortChats(ctx);
    assert.equal(shorts.length, 2, "(c) both asks are made before truncating");
    const short = ctx.s3Text(`meetings/${ctx.id}/summary-short.md`);
    assert.equal(short, `${"a".repeat(1000)}…`, "(c) cut at the last line break with an ellipsis");
    assert.ok(short.length <= 1499, `(c) ${short.length} chars is under the limit`);
  }
}

export async function empty(open) {
  const ctx = await open();
  ctx.seedFixture();
  // Same meeting, but nobody ever spoke.
  const manifestPath = join(ctx.dataDir, "meetings", ctx.id, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const p of Object.values(m.participants)) {
    p.utterances = [];
    p.segments = [];
    p.uploaded = [];
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  await ctx.processMeeting();

  assert.equal(ctx.orCalls.length, 0, "no OpenRouter calls at all");
  assert.equal(ctx.s3Text(`meetings/${ctx.id}/summary-full.md`), EMPTY_FULL);
  assert.equal(publishOf(ctx).embed.description, "ไม่พบเสียงพูดในการบันทึกนี้");
}

export async function closesAtHeartbeat(open) {
  const ctx = await open();
  ctx.seedFixture();
  // Rewind the on-disk manifest to what a crashed /record leaves behind.
  const manifestPath = join(ctx.dataDir, "meetings", ctx.id, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete m.endedAt;
  delete m.endReason;
  m.status = "recording";
  m.heartbeatAt = m.startedAt + 290_000; // crashed 290 s in: the 295-305 utterance never made it to disk
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  const run = await ctx.judgeCli(["recover", ctx.id]);
  assert.equal(run.code, 0, `judge-cli recover failed:\n${run.stderr}${run.stdout}`);

  const saved = JSON.parse(ctx.s3Text(`meetings/${ctx.id}/manifest.json`));
  assert.equal(saved.status, "done");
  assert.equal(saved.recovered, true);
  assert.equal(saved.endedAt, m.heartbeatAt, "closed at the last heartbeat");
  assert.equal(saved.endReason, "the bot restarted during the meeting");
  assert.deepEqual(
    saved.participants[FIRST_SPEAKER].utterances,
    [
      { start: 1 * SAMPLE_RATE, end: 6 * SAMPLE_RATE },
      { start: 8.5 * SAMPLE_RATE, end: 13 * SAMPLE_RATE },
      { start: 103 * SAMPLE_RATE, end: 118 * SAMPLE_RATE },
    ],
    "utterances beyond the heartbeat are clipped away",
  );
  assert.deepEqual(
    saved.participants[SECOND_SPEAKER].utterances,
    [{ start: 20 * SAMPLE_RATE, end: 50 * SAMPLE_RATE }],
    "the 400-415 s utterance is clipped away, the 20-50 s one is kept",
  );
  assert.deepEqual(saved.participants[FIRST_SPEAKER].segments, [0]);
  assert.deepEqual(saved.participants[SECOND_SPEAKER].segments, [0]);
  assert.match(publishOf(ctx).content, /บอทรีสตาร์ทระหว่างประชุม/);
}
