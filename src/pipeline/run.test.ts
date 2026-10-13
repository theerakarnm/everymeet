/**
 * End-to-end processing of a recorded meeting: real audio files and ffmpeg,
 * with R2, OpenRouter and Discord replaced by fakes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, Collection } from "discord.js";
import { chatReply, dataDir, flush, mockOpenRouter, mockR2, r2, r2Text, type OpenRouterCall } from "../test/setup.js";

mockR2();
const { processMeeting, recoverUnfinished } = await import("./run.js");
const { saveLocal, meetingDir } = await import("../storage/manifest.js");
const { keys } = await import("../storage/r2.js");
const { TrackWriter } = await import("../recorder/track-writer.js");
const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("../config.js");
const { verifyPin, newSessionId } = await import("../util/pin.js");

const sec = (s: number) => Math.round(s * SAMPLE_RATE);
const tone = (seconds: number, freq: number) => {
  const b = Buffer.alloc(sec(seconds) * 2);
  for (let i = 0; i < sec(seconds); i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)), i * 2);
  return b;
};

/** A 20-second meeting as the recorder leaves it on disk: Alice, Bob, then Alice again. */
function recordedMeeting(overrides: Record<string, unknown> = {}) {
  const id = newSessionId();
  const startedAt = Date.UTC(2026, 9, 12, 3, 0, 0);
  const total = 20;
  const talk = (userId: string, freq: number, turns: [number, number][]) => {
    const segments: number[] = [];
    const w = new TrackWriter(join(meetingDir(id), "segments", userId), (i) => segments.push(i));
    const utterances = turns.map(([at, len]) => {
      w.beginUtterance(sec(at));
      w.write(tone(len, freq));
      return w.endUtterance()!;
    });
    for (const i of w.openSegments()) w.closeSegment(i, Math.min(SEGMENT_SAMPLES, sec(total) - i * SEGMENT_SAMPLES));
    return { utterances, segments, uploaded: [] as number[] };
  };
  return {
    id,
    guildId: "g1",
    guildName: "Planthia",
    voiceChannelId: "voice1",
    voiceChannelName: "daily-standup",
    commandChannelId: "cmd",
    startedBy: { id: "alice", name: "Alice" },
    startedAt,
    endedAt: startedAt + total * 1000,
    heartbeatAt: startedAt + total * 1000,
    endReason: "ended by Alice with /end",
    status: "processing" as const,
    participants: {
      alice: { displayName: "Alice", ...talk("alice", 440, [[1, 3], [10, 2]]) },
      bob: { displayName: "Bob", ...talk("bob", 660, [[5, 3]]) },
    },
    ...overrides,
  };
}

/** Seconds of audio in a transcription request. */
const wavSeconds = (call: OpenRouterCall) => (Buffer.from(call.body.input_audio.data, "base64").length - 44) / 2 / SAMPLE_RATE;

const FULL = "# สรุปการประชุม\n## Action Items\n- [ ] deploy วันศุกร์ - ผู้รับผิดชอบ: Bob - กำหนดเสร็จ: ไม่ระบุ";
const SHORT = "**ภาพรวม:** วางแผน sprint\n**Action Items:**\n- Bob: deploy วันศุกร์";

/** OpenRouter that answers like the real models; `fail` lists models that return an error. */
function openRouter(opts: { fail?: string[]; short?: (attempt: number) => string } = {}) {
  let shortAttempts = 0;
  return mockOpenRouter((call) => {
    if (opts.fail?.includes(call.body.model)) return new Response("model unavailable", { status: 400 });
    if (call.path === "/audio/transcriptions") {
      // Alice's two turns are packed into one request: 3 s + 0.6 s gap + 2 s.
      if (Math.abs(wavSeconds(call) - 5.6) < 0.01) {
        return Response.json({
          text: "",
          segments: [
            { start: 0.1, end: 2.9, text: "สวัสดีครับ เริ่ม sprint planning กัน" },
            { start: 3.7, end: 5.5, text: "Bob ช่วย deploy วันศุกร์ได้ไหม" },
          ],
        });
      }
      return Response.json({ text: "", segments: [{ start: 0.2, end: 2.8, text: "ได้ครับ ผม deploy วันศุกร์" }] });
    }
    const isShort = call.body.max_tokens <= 2_000;
    return chatReply(isShort ? (opts.short?.(++shortAttempts) ?? SHORT) : FULL);
  });
}

/** A Discord server with the given text channels; `blocked` channels deny the bot. */
function discord(channelNames: string[], blocked: string[] = []) {
  const posts: { channel: string; payload: any }[] = [];
  const channel = (name: string) => ({
    name,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => !blocked.includes(name) }),
    isTextBased: () => true,
    isDMBased: () => false,
    send: async (payload: any) => {
      posts.push({ channel: name, payload });
      return { url: `https://discord.com/channels/g1/${name}/1` };
    },
  });
  const channels = new Collection(channelNames.map((n) => [n, channel(n)] as const));
  const client: any = {
    guilds: { fetch: async () => ({ members: { me: {} }, channels: { fetch: async () => channels } }) },
    channels: { fetch: async (id: string) => (id === "cmd" ? channel("cmd") : null) },
  };
  return { client, posts };
}

function readPost(payload: any) {
  const embed = payload.embeds[0].toJSON();
  const button = payload.components[0].toJSON().components[0];
  const files = Object.fromEntries(payload.files.map((f: any) => [f.name, f.attachment.toString("utf8")]));
  return { content: payload.content as string, embed, button, files };
}

const manifestIn = (id: string) => JSON.parse(r2Text(keys.manifest(id))!);

test("a finished meeting ends up in R2 and in #meeting-of-minutes with Thai minutes, transcript and a PIN link", async () => {
  const m = recordedMeeting();
  const calls = openRouter();
  const { client, posts } = discord(["general", "meeting-of-minutes"]);
  await processMeeting(client, m as any);

  // R2: per-speaker tracks, mixed audio, transcript and both summaries.
  for (const key of [
    keys.track(m.id, "alice"),
    keys.track(m.id, "bob"),
    keys.mixed(m.id),
    keys.transcript(m.id),
    keys.summaryFull(m.id),
    keys.summaryShort(m.id),
  ]) {
    assert.ok(r2.has(key), key);
  }
  const mp3 = join(dataDir, `${m.id}.mp3`);
  writeFileSync(mp3, r2.get(keys.mixed(m.id))!);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]));
  assert.ok(Math.abs(seconds - 20) < 0.5, `mixed audio keeps the silence: ${seconds}s`);

  // Transcript: real names, interleaved by when they spoke.
  const transcript = r2Text(keys.transcript(m.id))!;
  const body = transcript.split("-".repeat(60))[1]!.trim().split("\n");
  assert.deepEqual(body, [
    "[00:00:01] Alice: สวัสดีครับ เริ่ม sprint planning กัน",
    "[00:00:05] Bob: ได้ครับ ผม deploy วันศุกร์",
    "[00:00:10] Alice: Bob ช่วย deploy วันศุกร์ได้ไหม",
  ]);

  // Models: primary transcription and primary summary model.
  assert.ok(calls.filter((c) => c.path === "/audio/transcriptions").every((c) => c.body.model === "microsoft/mai-transcribe-2"));
  const chats = calls.filter((c) => c.path === "/chat/completions");
  assert.ok(chats.every((c) => c.body.model === "anthropic/claude-sonnet-5.5"));
  const fullPrompt = chats[0]!.body.messages.map((x: any) => x.content).join("\n");
  assert.match(fullPrompt, /ภาษาไทย/);
  assert.match(fullPrompt, /Alice: สวัสดีครับ/, "the summary model sees the named transcript");

  // Discord post.
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, "meeting-of-minutes");
  const post = readPost(posts[0]!.payload);
  assert.equal(post.embed.description, SHORT);
  assert.match(post.embed.title, /สรุปการประชุม - daily-standup/);
  assert.equal(post.button.url, `https://meet.example.com/m/${m.id}`);
  const pin = post.content.match(/PIN: `(\d{6})`/)?.[1];
  assert.ok(pin, "PIN is in the message");
  const transcriptFile = Object.entries(post.files).find(([n]) => n.startsWith("transcript-"))![1];
  const summaryFile = Object.entries(post.files).find(([n]) => n.startsWith("summary-full-"))![1];
  assert.equal(transcriptFile, transcript, "full transcript attached");
  assert.equal(summaryFile, FULL, "full summary attached");

  // Manifest: done, PIN stored only as a hash that matches the posted PIN.
  const saved = manifestIn(m.id);
  assert.equal(saved.status, "done");
  assert.ok(verifyPin(pin, saved.pin.salt, saved.pin.hash));
  assert.ok(!JSON.stringify(saved).includes(`"${pin}"`), "the PIN itself is never stored");
  assert.equal(existsSync(meetingDir(m.id)), false, "local working files are cleaned up");
});

test("when the primary models fail, Gemini transcribes and GPT summarizes", async () => {
  const m = recordedMeeting();
  const calls = openRouter({ fail: ["microsoft/mai-transcribe-2", "anthropic/claude-sonnet-5.5"] });
  const { client, posts } = discord(["meeting-of-minutes"]);
  await processMeeting(client, m as any);

  const stt = calls.filter((c) => c.path === "/audio/transcriptions" && c.body.model === "google/gemini-3.5-transcribe");
  assert.equal(stt.length, 2, "one fallback request per speaker chunk");
  const chats = calls.filter((c) => c.path === "/chat/completions");
  assert.deepEqual(
    [...new Set(chats.map((c) => c.body.model))],
    ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol-pro"],
  );
  assert.equal(manifestIn(m.id).status, "done");
  assert.match(r2Text(keys.transcript(m.id))!, /Bob: ได้ครับ/);
  assert.equal(posts.length, 1);
});

test("the short summary is always under 1500 characters", async () => {
  const m = recordedMeeting();
  const tooLong = Array.from({ length: 120 }, (_, i) => `- ประเด็นที่ ${i} รายละเอียดยาวมาก`).join("\n");
  const calls = openRouter({ short: () => tooLong });
  const { client, posts } = discord(["meeting-of-minutes"]);
  await processMeeting(client, m as any);

  const shortCalls = calls.filter((c) => c.path === "/chat/completions" && c.body.max_tokens <= 2_000);
  assert.equal(shortCalls.length, 2, "asks once more for a shorter version");
  const description = readPost(posts[0]!.payload).embed.description as string;
  assert.ok(description.length < 1500, `${description.length} chars`);
  assert.ok(r2Text(keys.summaryShort(m.id))!.length < 1500);
});

test("minutes go to #general when #meeting-of-minutes is missing or not writable, else to the /record channel", async () => {
  openRouter();
  for (const [channels, blocked, expected] of [
    [["general"], [], "general"],
    [["meeting-of-minutes", "general"], ["meeting-of-minutes"], "general"],
    [["random"], [], "cmd"],
  ] as const) {
    const { client, posts } = discord([...channels], [...blocked]);
    await processMeeting(client, recordedMeeting() as any);
    assert.equal(posts[0]?.channel, expected, `channels ${channels.join(",")} blocked ${blocked.join(",")}`);
  }
});

test("if summarizing fails completely, the audio is still in R2 and the channel is told", async () => {
  const m = recordedMeeting();
  openRouter({ fail: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol-pro"] });
  const { client, posts } = discord(["meeting-of-minutes"]);
  await processMeeting(client, m as any);

  assert.ok(r2.has(keys.mixed(m.id)));
  assert.ok(r2.has(keys.transcript(m.id)));
  const saved = manifestIn(m.id);
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /All summary models failed/);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.payload, /ไม่สำเร็จ/);
  assert.match(posts[0]!.payload, new RegExp(m.id));
});

test("after a crash mid-meeting, the recording is closed at the last heartbeat and still posted", async () => {
  const m = recordedMeeting({ status: "recording", endedAt: undefined, endReason: undefined });
  m.heartbeatAt = m.startedAt + 9_000; // crashed 9 s in: Alice's second turn (10 s) was never saved
  saveLocal(m as any);
  openRouter();
  const { client, posts } = discord(["meeting-of-minutes"]);
  await recoverUnfinished(client);
  const deadline = performance.now() + 20_000;
  while (posts.length === 0 && performance.now() < deadline) await flush();

  const post = readPost(posts[0]!.payload);
  assert.match(post.content, /บอทรีสตาร์ทระหว่างประชุม/);
  const saved = manifestIn(m.id);
  assert.equal(saved.status, "done");
  assert.equal(saved.recovered, true);
  assert.equal(saved.endedAt, m.heartbeatAt);
  const lines = r2Text(keys.transcript(m.id))!.split("\n").filter((l) => l.startsWith("["));
  assert.deepEqual(
    lines.map((l) => l.split(":").slice(0, 3).join(":")),
    ["[00:00:01] Alice", "[00:00:05] Bob"],
    "everything up to the heartbeat is kept, nothing after it",
  );
});
