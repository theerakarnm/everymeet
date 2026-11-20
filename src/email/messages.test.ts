import { test } from "node:test";
import assert from "node:assert/strict";
import "../test/setup.js";
import { calendarRefusedMail, loginMail, minutesMail, notRecordedMail } from "./messages.js";

test("the minutes email carries the short summary, the playback link, the PIN, and the note, in text and HTML", () => {
  const m = minutesMail({
    id: "AbCdEfGhIjKlMnOp",
    title: "Weekly <standup>",
    startedAt: Date.UTC(2026, 10, 23, 3, 0),
    seconds: 3720,
    startedBy: "alice@planthia.test",
    endReason: "การประชุม Google Meet จบแล้ว",
    shortSummary: "**ภาพรวม:** วางแผน sprint",
    pin: "042137",
    note: "ถอดเสียงไม่สำเร็จ 1 จาก 4 ช่วง",
  });
  assert.equal(m.subject, "สรุปการประชุม - Weekly <standup>");
  for (const part of ["**ภาพรวม:** วางแผน sprint", "PIN: 042137", "https://meet.example.com/m/AbCdEfGhIjKlMnOp", "1 ชม. 2 นาที", "⚠️ ถอดเสียงไม่สำเร็จ", "alice@planthia.test"]) {
    assert.ok(m.text.includes(part), part);
  }
  assert.match(m.html, /<strong>ภาพรวม:<\/strong> วางแผน sprint/);
  assert.match(m.html, /href="https:\/\/meet\.example\.com\/m\/AbCdEfGhIjKlMnOp"/);
  assert.ok(m.html.includes("Weekly &lt;standup&gt;"), "titles are escaped in HTML");
  assert.ok(!m.html.includes("<standup>"));
});

test("failure emails say why in Thai and point to the web page", () => {
  const expired = notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "auth_expired", leftCleanly: true } });
  assert.match(expired.text, /หมดอายุการเข้าสู่ระบบ.*npm run meet:login/);
  assert.match(notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "not_admitted", leftCleanly: true } }).text, /ภายใน 15 นาที/);
  const full = notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "crashed", detail: "container start failed: no instance", leftCleanly: false } });
  assert.match(full.text, /สูงสุด 2 ห้อง/);
  assert.match(notRecordedMail({ title: "t", code: "abc-defg-hij" }).text, /หยุดทำงานโดยไม่คาดคิด/);
  assert.ok(expired.text.includes("https://meet.example.com/meet"));
  assert.match(calendarRefusedMail({ title: "Weekly standup", code: "abc-defg-hij", reason: "busy" }).text, /2 ห้องแล้ว/);
  const daily = calendarRefusedMail({ title: "Weekly standup", code: "abc-defg-hij", reason: "daily_limit" });
  assert.match(daily.text, /ครบ 5 ครั้งใน 24 ชั่วโมง/);
  assert.ok(!daily.text.includes("/meet"), "no web-page button when the person's own limit refused it");
  assert.match(calendarRefusedMail({ title: "t", code: "abc-defg-hij", reason: "user_busy" }).text, /อยู่ 1 ห้อง ซึ่งเป็นจำนวนสูงสุดต่อคน/);
});

test("the login email holds the link once and says how long it works", () => {
  const m = loginMail("https://meet.example.com/meet/auth?t=abc");
  assert.equal(m.text.split("https://meet.example.com/meet/auth?t=abc").length, 2);
  assert.match(m.text, /15 นาที/);
});
