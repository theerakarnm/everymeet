/**
 * The bot side of a Google Meet recording, driven through a scripted meet-recorder Worker
 * with the clock under test control. R2 is in memory; Discord is one fake text channel.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, FAKE_MEET_AUTH, fakeMeetRecorder, flush, mockR2, r2 } from "../test/setup.js";

mockR2();
const worker = fakeMeetRecorder();
const { MeetSession } = await import("./session.js");
const { activeSessions } = await import("../recorder/active.js");
const { keys } = await import("../storage/keys.js");
const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("../config.js");

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 12, 3, 0, 0);
const MEET = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
let guildSeq = 0;

function harness() {
  const said: string[] = [];
  const finished: any[] = [];
  const guildId = `meet-guild${++guildSeq}`;
  const client: any = {
    channels: { fetch: async () => ({ isSendable: () => true, send: async (t: string) => void said.push(t) }) },
  };
  const onFinished = (m: any) => void finished.push(structuredClone(m));
  const start = () =>
    MeetSession.start({
      client,
      guildId,
      guildName: "Planthia",
      commandChannelId: "cmd",
      startedBy: { id: "alice", name: "Alice" },
      meet: MEET,
      onFinished,
    });
  return { said, finished, guildId, client, onFinished, start };
}
const remote = (id: string) => worker.recordings.get(id)!;
const stored = (id: string) => JSON.parse(r2.get(keys.manifest(id))!.toString());
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await flush(20); // a poll goes through fetch, Response.json() and the R2 mock
};

beforeEach(() => {
  worker.down = false;
  worker.failStart = false;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
});
afterEach(async () => {
  for (const s of activeSessions.values()) await s.shutdown();
  activeSessions.clear();
  mock.timers.reset();
});

test("starting sends the link, the session file and the timings to the recorder, and never stores the session", async () => {
  const h = harness();
  const s = await h.start();
  assert.deepEqual(remote(s.id).job, {
    meetUrl: MEET.url,
    authState: FAKE_MEET_AUTH,
    sampleRate: SAMPLE_RATE,
    segmentSamples: SEGMENT_SAMPLES,
    admitTimeoutMs: 15 * MIN,
    aloneTimeoutMs: 3 * MIN,
    maxDurationMs: 240 * MIN,
  });
  assert.equal(worker.authorizations.at(-1), `Bearer ${"m".repeat(40)}`);
  assert.equal(activeSessions.get(h.guildId), s);
  const raw = r2.get(keys.manifest(s.id))!.toString();
  assert.deepEqual(JSON.parse(raw).meet, MEET);
  assert.equal(JSON.parse(raw).voiceChannelName, "Google Meet abc-defg-hij");
  assert.ok(!raw.includes("fake-session-cookie"), "the bot account session never reaches R2");
});

test("the channel is told once recording starts, and when everyone left the meeting goes to processing", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "recording", captureStartedAt: NOW + 40_000, consentPosted: true, segments: [] };
  await advance(15_000);
  assert.deepEqual(h.said, ["🔴 I am recording the Google Meet call abc-defg-hij"]);
  await advance(15_000);
  assert.equal(h.said.length, 1, "announced once");

  rec.status = {
    ...rec.status,
    state: "ended",
    segments: [{ index: 0, samples: SEGMENT_SAMPLES }, { index: 1, samples: 10 * SAMPLE_RATE }],
    end: { reason: "alone", leftCleanly: true },
  };
  await advance(15_000);
  const m = h.finished.at(-1);
  assert.equal(m.status, "processing");
  assert.equal(m.startedAt, NOW + 40_000);
  assert.equal(m.endedAt, NOW + 40_000 + 310_000, "5 min + 10 s of audio");
  assert.equal(m.endReason, "everyone left the Google Meet call for 3 minutes");
  assert.deepEqual(m.participants.meet, {
    displayName: "เสียงรวมจาก Google Meet",
    utterances: [],
    segments: [0, 1],
    uploaded: [0, 1],
  });
  assert.equal(activeSessions.get(h.guildId), undefined);
  assert.equal(stored(s.id).status, "processing");
});

test("if the notice could not be posted in the Meet chat, the Discord announcement asks people to tell the participants", async () => {
  const h = harness();
  const s = await h.start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: false, segments: [] };
  await advance(15_000);
  assert.match(h.said[0]!, /could not post the recording notice in the Meet chat/);
});

test("/end asks the recorder to stop and keeps the Discord reason once the recorder reports the end", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.end("ended by Dave with /end");
  assert.equal(rec.stopped, true);
  assert.equal(activeSessions.get(h.guildId), s, "still active until the recorder confirms");
  rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
  await advance(15_000);
  assert.equal(h.finished.at(-1).endReason, "ended by Dave with /end");
  assert.equal(h.finished.at(-1).endedAt, NOW + 60_000);
});

test("a call the bot never got into is marked failed with a reason-specific message and is not processed", async () => {
  for (const [reason, expected] of [
    ["denied", /did not let the bot join/],
    ["not_admitted", /Nobody let the bot into Google Meet \*\*abc-defg-hij\*\* within 15 minutes/],
    ["auth_expired", /session has expired.*npm run meet:login/],
    ["stopped", /stopped before the bot got in/],
    ["join_failed", /could not record Google Meet \*\*abc-defg-hij\*\* \(the Google Meet page offered no way to join\)/],
  ] as const) {
    const h = harness();
    const s = await h.start();
    remote(s.id).status = { state: "ended", segments: [], end: { reason, leftCleanly: true } };
    await advance(15_000);
    assert.match(h.said.at(-1)!, expected, reason);
    assert.equal(h.finished.length, 0, reason);
    assert.equal(stored(s.id).status, "failed", reason);
    assert.equal(activeSessions.get(h.guildId), undefined, reason);
  }
});

test("audio from a recorder that died mid-call is still processed and flagged as recovered", async () => {
  const h = harness();
  const s = await h.start();
  remote(s.id).status = {
    state: "ended",
    captureStartedAt: NOW,
    consentPosted: true,
    segments: [{ index: 0, samples: 90 * SAMPLE_RATE }],
    end: { reason: "container_lost", detail: "no report for 3 minutes", leftCleanly: false },
  };
  await advance(15_000);
  const m = h.finished.at(-1);
  assert.equal(m.recovered, true);
  assert.equal(m.endReason, "the Google Meet recorder stopped unexpectedly");
});

test("a network outage does not end the meeting: the bot keeps following the recorder and processes it when it is back", async () => {
  const h = harness();
  const s = await h.start();
  worker.down = true;
  await advance(30 * MIN);
  assert.equal(activeSessions.get(h.guildId), s, "still following");
  worker.down = false;
  remote(s.id).status = {
    state: "ended",
    captureStartedAt: NOW + 60_000,
    consentPosted: true,
    segments: [{ index: 0, samples: SEGMENT_SAMPLES }],
    end: { reason: "alone", leftCleanly: true },
  };
  await advance(15_000);
  assert.equal(h.finished.at(-1).id, s.id);
  assert.equal(h.finished.at(-1).status, "processing");
});

test("the bot gives up only after the recorder's own deadline has passed, and tells the channel", async () => {
  const h = harness();
  await h.start();
  worker.down = true;
  const giveUp = (15 + 240 + 60) * MIN; // admit timeout + MEET_MAX_DURATION_MIN + GIVE_UP_GRACE_MS
  await advance(giveUp - 15_000);
  assert.ok(activeSessions.get(h.guildId), "still following");
  await advance(15_000);
  assert.equal(activeSessions.get(h.guildId), undefined);
  assert.match(h.said.at(-1)!, /could not record Google Meet \*\*abc-defg-hij\*\* \(the Google Meet recorder stopped unexpectedly\)/);
});

test("after a bot restart a Meet recording is re-attached, not closed, and not announced again", async () => {
  const h = harness();
  const s = await h.start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.shutdown();
  activeSessions.clear();

  MeetSession.resume(h.client, structuredClone(s.manifest), h.onFinished);
  await flush();
  assert.ok(activeSessions.get(h.guildId), "re-registered");
  remote(s.id).status = { ...remote(s.id).status, state: "ended", segments: [{ index: 0, samples: SEGMENT_SAMPLES }], end: { reason: "meeting_ended", leftCleanly: true } };
  await advance(15_000);
  assert.equal(h.said.length, 1, "announced only before the restart");
  assert.equal(h.finished.at(-1).id, s.id);
  assert.equal(h.finished.at(-1).recovered, undefined);
});

test("if the recorder cannot start, a stop is still sent, the error reaches the caller, and nothing blocks the next try", async () => {
  const h = harness();
  worker.failStart = true;
  await assert.rejects(h.start(), /HTTP 500/);
  await flush(20);
  assert.match(worker.requests.at(-1)!, /^POST \/recordings\/[\w-]+\/stop$/, "a start that timed out on our side must not leave a bot joining");
  assert.equal(activeSessions.get(h.guildId), undefined);
  worker.failStart = false;
  assert.ok(await h.start());
});

test("a broken session file is reported without quoting it, before any recorder is started", async () => {
  const h = harness();
  const path = join(dataDir, "meet-auth.json");
  writeFileSync(path, '{"cookies":[{"value":"leaky-cookie"');
  try {
    const before = worker.requests.length;
    await assert.rejects(h.start(), (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes("leaky"));
    assert.ok(worker.requests.slice(before).every((r) => r.endsWith("/stop")), "no start request was sent");
  } finally {
    writeFileSync(path, FAKE_MEET_AUTH);
  }
});
