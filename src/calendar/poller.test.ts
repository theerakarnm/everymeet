import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir, mockEmail, sentEmails } from "../test/setup.js";

mockEmail();
const { pollCalendar } = await import("./poller.js");
const { MeetRefused } = await import("../meet/session.js");
const { config } = await import("../config.js");

const ICS = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
const handledFile = join(dataDir, "calendar-handled.json");
let feedStatus = 200;
globalThis.fetch = (async (url: string) => {
  assert.equal(url, process.env.CALENDAR_ICAL_URL);
  return new Response(feedStatus === 200 ? ICS : "error", { status: feedStatus });
}) as typeof fetch;

let started: { code: string; title: string; trigger: string; startedBy: string; recipients: string[] }[] = [];
let refuse: Error | undefined;
const startMeet = async (meet: any) => {
  if (refuse) throw refuse;
  started.push({ code: meet.code, title: meet.title, trigger: meet.trigger, startedBy: meet.startedBy, recipients: meet.recipients });
  return {} as any;
};
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  started = [];
  refuse = undefined;
  feedStatus = 200;
  sentEmails.length = 0;
  rmSync(handledFile, { force: true });
});

test("from one minute before the start, occurrences of allowed organizers with a Meet link start once; strangers and events without a link do not", async () => {
  await pollCalendar(startMeet, at("2026-11-23T02:58:59Z"));
  assert.equal(started.length, 0, "too early");
  await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
  assert.deepEqual(
    started.sort((a, b) => a.code.localeCompare(b.code)),
    [
      { code: "abc-defg-hij", title: "Weekly standup", trigger: "calendar", startedBy: "alice@planthia.test", recipients: ["alice@planthia.test", "bob@example.com"] },
      { code: "pqr-stuv-wxy", title: "Budget review", trigger: "calendar", startedBy: "carol@planthia.test", recipients: ["carol@planthia.test"] },
    ],
  );
  await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
  assert.equal(started.length, 2, "never twice");
  assert.equal(sentEmails.length, 0, "nobody is emailed about skipped events");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(handledFile, "utf8"))).sort(), [
    "desc-link@google.com|2026-11-23T03:00:00.000Z",
    "no-link@google.com|2026-11-23T03:00:00.000Z",
    "stranger@google.com|2026-11-23T03:00:00.000Z",
    "weekly-standup@google.com|2026-11-23T03:00:00.000Z",
  ]);
});

test("a deleted week and a cancelled week never start, and a moved week starts at its new time", async () => {
  for (const iso of ["2026-11-30T02:59:30Z", "2026-12-07T02:59:30Z", "2026-12-14T02:59:30Z"]) await pollCalendar(startMeet, at(iso));
  assert.equal(started.length, 0);
  await pollCalendar(startMeet, at("2026-12-07T05:59:30Z"));
  assert.deepEqual(started.map((s) => [s.code, s.title]), [["abc-defg-hij", "Weekly standup (moved)"]]);
  assert.ok("weekly-standup@google.com|2026-12-07T03:00:00.000Z" in JSON.parse(readFileSync(handledFile, "utf8")));
});

test("a bot that was down at the start still starts up to 15 minutes late, and not later", async () => {
  await pollCalendar(startMeet, at("2026-11-23T03:15:01Z"));
  assert.deepEqual(started, []);
  await pollCalendar(startMeet, at("2026-11-23T03:15:00Z"));
  assert.equal(started.length, 2);
});

test("when two recordings already run, each organizer is emailed once and nothing is retried", async () => {
  refuse = new MeetRefused("busy");
  await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
  await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
  assert.deepEqual(sentEmails.map((e) => [e.to, e.subject]).sort(), [
    ["alice@planthia.test", "ไม่ได้บันทึก Google Meet - Weekly standup"],
    ["carol@planthia.test", "ไม่ได้บันทึก Google Meet - Budget review"],
  ]);
});

test("a Meet room still recorded for an earlier meeting is retried, its organizer is told once, and a recorder error emails the organizer", async () => {
  refuse = new MeetRefused("already_recording");
  await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
  await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
  assert.deepEqual(started, []);
  assert.deepEqual(sentEmails.map((e) => e.to).sort(), ["alice@planthia.test", "carol@planthia.test"], "each organizer told once");
  assert.match(sentEmails[0]!.text, /กำลังถูกบันทึกอยู่แล้ว/);
  refuse = undefined;
  await pollCalendar(startMeet, at("2026-11-23T03:01:00Z"));
  assert.equal(started.length, 2, "started once the room is free");
  started = [];
  sentEmails.length = 0;
  rmSync(handledFile, { force: true });
  refuse = new Error("starting the Google Meet recorder failed: HTTP 500");
  await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
  assert.equal(sentEmails.length, 2);
  assert.match(sentEmails[0]!.text, /เปิดเครื่องบันทึกไม่สำเร็จ/);
});

test("a poll that starts while the previous one is still busy does nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = async (meet: any) => {
    await gate;
    return startMeet(meet);
  };
  const first = pollCalendar(slow, at("2026-11-23T02:59:00Z"));
  await pollCalendar(slow, at("2026-11-23T03:00:00Z"));
  release();
  await first;
  assert.deepEqual(started.map((s) => s.code).sort(), ["abc-defg-hij", "pqr-stuv-wxy"], "each occurrence once");
});

test("an organizer not on ALLOWED_EMAILS is skipped quietly, and the occurrence is not started later", async () => {
  const allow = config().ALLOWED_EMAILS;
  allow.domains.splice(allow.domains.indexOf("planthia.test"), 1);
  allow.emails.push("alice@planthia.test"); // carol is no longer allowed, alice still is
  try {
    await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
    assert.deepEqual(started.map((s) => s.startedBy), ["alice@planthia.test"]);
    assert.equal(sentEmails.length, 0, "no email to an organizer who is not allowed");
  } finally {
    allow.domains.push("planthia.test");
    allow.emails.splice(allow.emails.indexOf("alice@planthia.test"), 1);
  }
  await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
  assert.equal(started.length, 1, "each occurrence is acted on once, also when it was skipped");
});

test("a feed error names the HTTP status but never the secret address", async () => {
  feedStatus = 500;
  await assert.rejects(pollCalendar(startMeet, at("2026-11-23T02:59:00Z")), (err: Error) => /HTTP 500/.test(err.message) && !err.message.includes("private-secret"));
  assert.deepEqual(started, []);
});
