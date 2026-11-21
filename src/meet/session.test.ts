/**
 * The bot side of a Google Meet recording, driven through a scripted meet-recorder Worker
 * with the clock under test control. R2 is in memory; emails go to the fake sender.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, FAKE_MEET_AUTH, fakeMeetRecorder, flush, mockEmail, mockR2, r2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
const worker = fakeMeetRecorder();
const { MeetSession, MeetRefused, activeMeets } = await import("./session.js");
const { users } = await import("../users/store.js");
const { keys } = await import("../storage/keys.js");
const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("../config.js");

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 12, 3, 0, 0);
const MEET = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
const ALICE = "alice@example.com";

function harness(meet = MEET, startedBy = ALICE) {
  const finished: any[] = [];
  const onFinished = (m: any) => void finished.push(structuredClone(m));
  const info = { ...meet, title: "Weekly standup", trigger: "web" as const, startedBy, recipients: ["bob@example.com", startedBy] };
  const start = () => MeetSession.start(info, onFinished);
  return { finished, onFinished, start };
}
const remote = (id: string) => worker.recordings.get(id)!;
const stored = (id: string) => JSON.parse(r2.get(keys.manifest(id))!.toString());
const mailsTo = (to: string) => sentEmails.filter((e) => e.to === to);
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await flush(20); // a poll goes through fetch, Response.json() and the R2 mock
};

beforeEach(() => {
  worker.down = false;
  worker.failStart = false;
  sentEmails.length = 0;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
});
afterEach(async () => {
  for (const s of activeMeets.values()) await s.shutdown();
  activeMeets.clear();
  mock.timers.reset();
});

test("starting sends the link, the session file and the timings to the recorder, and stores a Meet manifest without Discord fields or the session", async () => {
  const s = await harness().start();
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
  assert.equal(activeMeets.get(MEET.code), s);
  assert.equal(s.state, "starting");
  const raw = r2.get(keys.manifest(s.id))!.toString();
  assert.deepEqual(JSON.parse(raw).meet, {
    ...MEET,
    title: "Weekly standup",
    trigger: "web",
    startedBy: ALICE,
    recipients: [ALICE, "bob@example.com"],
  });
  assert.equal(JSON.parse(raw).guildId, undefined);
  assert.ok(!raw.includes("fake-session-cookie"), "the bot account session never reaches R2");
});

test("the recorder's state is followed quietly, and when everyone left the meeting goes to processing", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "waiting", segments: [] };
  await advance(5_000);
  assert.equal(s.state, "waiting", "the web page shows the state, so it is polled every 5 s");
  rec.status = { state: "recording", captureStartedAt: NOW + 40_000, consentPosted: true, segments: [] };
  await advance(5_000);
  assert.equal(s.state, "recording");
  assert.equal(sentEmails.length, 0, "no email while things go well");

  rec.status = {
    ...rec.status,
    state: "ended",
    segments: [{ index: 0, samples: SEGMENT_SAMPLES }, { index: 1, samples: 10 * SAMPLE_RATE }],
    end: { reason: "alone", leftCleanly: true },
  };
  await advance(15_000);
  assert.equal(activeMeets.get(MEET.code), undefined);
  assert.equal(stored(s.id).status, "processing");
  const m = h.finished.at(-1);
  assert.equal(m.status, "processing");
  assert.equal(m.startedAt, NOW + 40_000);
  assert.equal(m.endedAt, NOW + 40_000 + 310_000, "5 min + 10 s of audio");
  assert.equal(m.endReason, "ไม่มีผู้เข้าร่วมคนอื่นอยู่ในห้องแล้ว");
  assert.deepEqual(m.participants.meet, {
    displayName: "เสียงรวมจาก Google Meet",
    utterances: [],
    segments: [0, 1],
    uploaded: [0, 1],
  });
});

test("if the notice could not be posted in the Meet chat, the starter gets one email asking them to tell the participants", async () => {
  const s = await harness().start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: false, segments: [] };
  await advance(15_000);
  await advance(15_000);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]!.to, ALICE);
  assert.match(sentEmails[0]!.subject, /กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึก/);
});

test("stop asks the recorder to leave and keeps its reason once the recorder reports the end", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.end("หยุดโดย dave@example.com จากหน้าเว็บ");
  assert.equal(rec.stopped, true);
  assert.equal(s.stopping, true);
  assert.equal(activeMeets.get(MEET.code), s, "still active until the recorder confirms");
  rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
  await advance(15_000);
  assert.equal(h.finished.at(-1).endReason, "หยุดโดย dave@example.com จากหน้าเว็บ");
  assert.equal(h.finished.at(-1).endedAt, NOW + 60_000);
});

test("a stop whose reply comes after the poll already saw the end still keeps its reason", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  const realFetch = globalThis.fetch;
  let reply!: () => void;
  const held = new Promise<void>((resolve) => (reply = resolve));
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST" && String(url).endsWith("/stop")) await held;
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const stopping = s.end("หยุดโดย dave@example.com จากหน้าเว็บ");
    rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
    await advance(15_000);
    reply();
    await stopping;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(h.finished.at(-1).endReason, "หยุดโดย dave@example.com จากหน้าเว็บ");
});

test("a stop that cannot reach the recorder throws, and the recording goes on", async () => {
  const s = await harness().start();
  worker.down = true;
  await assert.rejects(s.end("หยุดโดย dave@example.com จากหน้าเว็บ"));
  assert.equal(s.stopping, false);
  assert.equal(activeMeets.get(MEET.code), s);
});

test("a call the bot never got into is marked failed, is not processed, and the starter gets a reason-specific email", async () => {
  for (const [reason, expected] of [
    ["denied", /ไม่อนุญาตให้บอทเข้า/],
    ["not_admitted", /ภายใน 15 นาที/],
    ["auth_expired", /หมดอายุการเข้าสู่ระบบ.*npm run meet:login/],
    ["stopped", /ถูกหยุดก่อนบอทเข้าห้อง/],
    ["join_failed", /หน้า Google Meet ไม่มีปุ่มเข้าร่วม/],
  ] as const) {
    const h = harness();
    const s = await h.start();
    remote(s.id).status = { state: "ended", segments: [], end: { reason, leftCleanly: true } };
    await advance(15_000);
    const mail = mailsTo(ALICE).at(-1)!;
    assert.match(mail.text, expected, reason);
    assert.match(mail.subject, /บันทึก Google Meet ไม่สำเร็จ - Weekly standup/, reason);
    assert.equal(mailsTo("bob@example.com").length, 0, "failures go to the starter only");
    assert.equal(h.finished.length, 0, reason);
    assert.equal(stored(s.id).status, "failed", reason);
    assert.equal(activeMeets.get(MEET.code), undefined, reason);
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
  assert.equal(m.endReason, "เครื่องบันทึก Google Meet หยุดทำงานโดยไม่คาดคิด");
});

test("a network outage does not end the meeting: the bot keeps following the recorder and processes it when it is back", async () => {
  const h = harness();
  const s = await h.start();
  worker.down = true;
  await advance(30 * MIN);
  assert.equal(activeMeets.get(MEET.code), s, "still following");
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

test("the bot gives up only after the recorder's own deadline has passed, and emails the starter", async () => {
  await harness().start();
  worker.down = true;
  const giveUp = (15 + 240 + 60) * MIN; // admit timeout + MEET_MAX_DURATION_MIN + GIVE_UP_GRACE_MS
  await advance(giveUp - 15_000);
  assert.ok(activeMeets.get(MEET.code), "still following");
  await advance(15_000);
  assert.equal(activeMeets.get(MEET.code), undefined);
  assert.match(mailsTo(ALICE).at(-1)!.text, /หยุดทำงานโดยไม่คาดคิด/);
});

test("after a bot restart a Meet recording is re-attached by its Meet code and nobody is emailed again", async () => {
  const h = harness();
  const s = await h.start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.shutdown();
  activeMeets.clear();

  MeetSession.resume(structuredClone(s.manifest), h.onFinished);
  await flush();
  assert.ok(activeMeets.get(MEET.code), "re-registered");
  remote(s.id).status = { ...remote(s.id).status, state: "ended", segments: [{ index: 0, samples: SEGMENT_SAMPLES }], end: { reason: "meeting_ended", leftCleanly: true } };
  await advance(15_000);
  assert.equal(sentEmails.length, 0);
  assert.equal(h.finished.at(-1).id, s.id);
  assert.equal(h.finished.at(-1).recovered, undefined);
});

test("if the recorder cannot start, a stop is still sent, the error reaches the caller, and nothing blocks the next try", async () => {
  const h = harness();
  worker.failStart = true;
  await assert.rejects(h.start(), /HTTP 500/);
  await flush(20);
  assert.match(worker.requests.at(-1)!, /^POST \/recordings\/[\w-]+\/stop$/, "a start that timed out on our side must not leave a bot joining");
  assert.equal(activeMeets.get(MEET.code), undefined);
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

test("one recording per Meet call and at most two at once; refused starts reach no recorder, and a finished call frees its slot", async () => {
  const first = await harness().start();
  const other = { url: "https://meet.google.com/pqr-stuv-wxy", code: "pqr-stuv-wxy" };
  const third = { url: "https://meet.google.com/xyz-abcd-efg", code: "xyz-abcd-efg" };
  const before = worker.requests.length;
  await assert.rejects(harness().start(), (err) => err instanceof MeetRefused && err.reason === "already_recording");
  assert.equal(worker.requests.length, before, "nothing sent for a refused start");
  // Different starters, so the per-person limit of Task 7b is not what refuses here.
  await harness(other, "carol@example.com").start();
  await assert.rejects(harness(third, "dave@example.com").start(), (err) => err instanceof MeetRefused && err.reason === "busy");
  assert.equal(activeMeets.size, 2);
  remote(first.id).status = { state: "ended", segments: [], end: { reason: "denied", leftCleanly: true } };
  await advance(15_000);
  assert.ok(await harness(third, "dave@example.com").start(), "the slot is free again");
});

test("one person runs one recording at a time and starts at most 5 in 24 hours; refused starts reach no recorder", async () => {
  const pat = "pat@example.com";
  users().signIn(pat, NOW);
  const other = { url: "https://meet.google.com/pqr-stuv-wxy", code: "pqr-stuv-wxy" };
  const first = await harness(MEET, pat).start();
  const before = worker.requests.length;
  await assert.rejects(harness(other, pat).start(), (err) => err instanceof MeetRefused && err.reason === "user_busy");
  assert.equal(worker.requests.length, before, "nothing sent for a refused start");
  const end = async (id: string) => {
    remote(id).status = { state: "ended", segments: [], end: { reason: "denied", leftCleanly: true } };
    await advance(15_000);
  };
  await end(first.id);
  for (let i = 2; i <= 5; i++) await end((await harness(MEET, pat).start()).id);
  assert.equal(users().startsToday(pat, Date.now()), 5);
  await assert.rejects(harness(MEET, pat).start(), (err) => err instanceof MeetRefused && err.reason === "daily_limit");
  await advance(24 * 60 * MIN);
  assert.ok(await harness(MEET, pat).start(), "allowed again a day after the first start");
});
