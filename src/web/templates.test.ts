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
  assert.match(html, /รอผู้จัดรับเข้าห้อง · จากปฏิทิน/);
  assert.match(html, /name="id" value="AbCdEfGhIjKlMnOp"/);
  assert.match(html, /กำลังหยุด · จากหน้าเว็บ/);
  assert.doesNotMatch(html, /value="QrStUvWxYz012345"/, "no second stop button once stopping");
  assert.match(html, /value="&quot;&gt;&lt;script&gt;"/);
  assert.match(html, /<textarea[^>]*>bob@example.com<\/textarea>/);
  assert.match(html, /class="err">ลิงก์นี้ไม่ใช่ลิงก์ Google Meet/);
  assert.match(page.meetRecorder({ email: "a@example.com", recordings: [] }), /ยังไม่มีการบันทึกที่กำลังทำงาน/);
});

test("the login pages post to /meet and the confirm page carries the token only in a form", () => {
  assert.match(page.meetLogin({}), /action="\/meet\/login"/);
  assert.match(page.meetLogin({}), /การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้/, "the same form signs people up");
  assert.doesNotMatch(page.meetLoginSent(), /สิทธิ์/, "the answer does not hint whether the address has an account");
  assert.match(page.meetAccountDisabled(), /ถูกปิดการใช้งาน/);
  const confirm = page.meetConfirm({ token: "tok<en>" });
  assert.match(confirm, /action="\/meet\/auth"/);
  assert.match(confirm, /type="hidden" name="t" value="tok&lt;en&gt;"/);
});

test("the PIN page keeps its big centered input and no longer mentions Discord", () => {
  const html = page.pin({ id: "AbCdEfGhIjKlMnOp", title: "daily-standup" });
  assert.match(html, /<input id="pin" class="pin"/);
  assert.doesNotMatch(html, /Discord/);
});

test("the admin page lists accounts with their state, escapes addresses, and has no button for the admin's own account", () => {
  const html = page.meetAdmin({
    email: "root@example.com",
    users: [
      { email: "root@example.com", status: "active", isAdmin: true, createdAt: Date.UTC(2026, 10, 20, 3), recentStarts: [] },
      { email: "x<y@example.com", status: "disabled", isAdmin: false, createdAt: Date.UTC(2026, 10, 21, 3), lastLoginAt: Date.UTC(2026, 10, 21, 4), recentStarts: [] },
    ],
  });
  assert.match(html, /2 บัญชี/);
  assert.match(html, /root@example\.com<small>ผู้ดูแล · ใช้งานได้/);
  assert.match(html, /x&lt;y@example\.com<small>ปิดการใช้งาน/);
  assert.equal(html.match(/<form /g)?.length, 1, "only the other account has a button");
  assert.match(html, /name="status" value="active"><button class="enable" type="submit">เปิดการใช้งาน/);
});
