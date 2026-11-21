import "../test/setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, type MeetRecordingView } from "./templates.js";

const rec = (o: Partial<MeetRecordingView> = {}): MeetRecordingView => ({
  id: "AbCdEfGhIjKlMnOp",
  title: "Weekly <standup>",
  code: "abc-defg-hij",
  state: "waiting",
  trigger: "calendar",
  startedBy: "alice@planthia.test",
  stopping: false,
  ...o,
});

test("the recorder page lists recordings with a Thai state and a stop button, and escapes what people typed", () => {
  const html = page.meetRecorder({
    email: "alice@example.com",
    recordings: [rec(), rec({ id: "QrStUvWxYz012345", title: "Google Meet abc-defg-hij", trigger: "web", stopping: true })],
    error: "ลิงก์นี้ไม่ใช่ลิงก์ Google Meet",
    values: { url: '"><script>', emails: "bob@example.com" },
  });
  assert.match(html, /Weekly &lt;standup&gt;/);
  assert.match(html, /<p class="state">[^<]*<span class="steps"[^>]*><i class="on"><\/i><i class="on"><\/i><i><\/i><\/span>ขั้นที่ 2 จาก 3: รอผู้จัดกดอนุญาตให้บอทเข้าห้อง<\/p><small>abc-defg-hij · จากปฏิทิน/);
  assert.match(html, /name="id" value="AbCdEfGhIjKlMnOp"/);
  assert.match(html, /<p class="state">กำลังหยุด<\/p><small>abc-defg-hij · จากหน้าเว็บ/);
  assert.doesNotMatch(html, /value="QrStUvWxYz012345"/, "no second stop button once stopping");
  assert.match(html, /value="&quot;&gt;&lt;script&gt;"/);
  assert.match(html, /<textarea[^>]*>bob@example.com<\/textarea>/);
  assert.match(html, /class="err">ลิงก์นี้ไม่ใช่ลิงก์ Google Meet/);
  assert.match(page.meetRecorder({ email: "a@example.com", recordings: [] }), /ยังไม่มีการบันทึกที่กำลังทำงาน/);
});

test("each recording state is one of three steps with what to expect, and the step dots fill up to the current step", () => {
  const states = {
    starting: [1, "ขั้นที่ 1 จาก 3: กำลังเตรียมบอท (ประมาณ 1 นาที)"],
    joining: [2, "ขั้นที่ 2 จาก 3: บอทกำลังขอเข้าห้อง"],
    waiting: [2, "ขั้นที่ 2 จาก 3: รอผู้จัดกดอนุญาตให้บอทเข้าห้อง"],
    recording: [3, "ขั้นที่ 3 จาก 3: กำลังบันทึกอยู่ในห้อง"],
    ended: [3, "จบแล้ว กำลังสรุปการประชุม"],
  } as const;
  for (const [state, [step, text]] of Object.entries(states)) {
    const html = page.meetRecorder({ email: "a@example.com", recordings: [rec({ state: state as MeetRecordingView["state"] })] });
    const dots = /<span class="steps"[^>]*>(.*?)<\/span>([^<]*)<\/p>/.exec(html)!;
    assert.equal(dots[1]!.match(/<i class="on">/g)?.length, step, state);
    assert.equal(dots[1]!.match(/<i/g)?.length, 3, state);
    assert.equal(dots[2], text);
    assert.equal(html.includes('action="/meet/stop"'), state !== "ended", "nothing to stop once the recording ended");
  }
});

test("the recorder page reloads itself every 5 seconds only while a recording is still getting into the room, and never over an error", () => {
  const REFRESH = '<meta http-equiv="refresh" content="5">';
  const with_ = (...states: MeetRecordingView["state"][]) =>
    page.meetRecorder({ email: "a@example.com", recordings: states.map((state) => rec({ state })) });
  for (const state of ["starting", "joining", "waiting"] as const) assert.ok(with_("recording", state).includes(REFRESH), state);
  assert.ok(!with_("recording", "ended").includes(REFRESH));
  assert.ok(!with_().includes(REFRESH));
  const failed = page.meetRecorder({ email: "a@example.com", recordings: [rec({ state: "starting" })], error: "x", values: { url: "u", emails: "" } });
  assert.ok(!failed.includes(REFRESH), "a reload would drop the error and what was typed");
});

test("the login pages post to /meet and the confirm page carries the token only in a form", () => {
  assert.match(page.meetLogin({}), /action="\/meet\/login"/);
  assert.doesNotMatch(page.meetLogin({}), /สร้างบัญชี/, "there are no accounts to create");
  assert.doesNotMatch(page.meetLoginSent(), /สิทธิ์/, "the answer does not hint whether the address has an account");
  const confirm = page.meetConfirm({ token: "tok<en>" });
  assert.match(confirm, /action="\/meet\/auth"/);
  assert.match(confirm, /type="hidden" name="t" value="tok&lt;en&gt;"/);
});

test("the PIN page keeps its big centered input and no longer mentions Discord", () => {
  const html = page.pin({ id: "AbCdEfGhIjKlMnOp", title: "daily-standup" });
  assert.match(html, /<input id="pin" class="pin"/);
  assert.doesNotMatch(html, /Discord/);
});

test("every page links the source code under its license", () => {
  for (const html of [page.notFound(), page.pin({ id: "AbCdEfGhIjKlMnOp", title: "t" }), page.meetLogin({})]) {
    assert.match(html, /<footer><a href="https:\/\/github\.com\/[^"]+\/everymeet">ซอร์สโค้ด<\/a> · AGPL-3\.0<\/footer>/);
  }
});
