import { test } from "node:test";
import assert from "node:assert/strict";
import "../test/setup.js"; // fake env: PUBLIC_BASE_URL and a temp DATA_DIR
import type { Manifest } from "../storage/manifest.js";
import { buildMinutesMessage } from "./publish.js";

const manifest = (): Manifest => ({
  id: "abcdefghij012345",
  guildId: "g1",
  guildName: "Planthia",
  voiceChannelId: "voice1",
  voiceChannelName: "daily-standup",
  commandChannelId: "cmd",
  startedBy: { id: "alice", name: "Alice" },
  startedAt: Date.UTC(2026, 9, 12, 17, 30),
  endedAt: Date.UTC(2026, 9, 12, 18, 0),
  heartbeatAt: Date.UTC(2026, 9, 12, 18, 0),
  endReason: "ended by Alice with /end",
  status: "processing",
  participants: {
    alice: { displayName: "Alice", utterances: [{ start: 0, end: 96_000 }], segments: [0], uploaded: [0] },
    bob: { displayName: "Bob", utterances: [], segments: [], uploaded: [] },
  },
});

test("buildMinutesMessage builds the exact minutes post that publishMinutes sends", () => {
  const msg = buildMinutesMessage(manifest(), {
    pin: "123456",
    shortSummary: "**ภาพรวม:** วางแผน sprint",
    fullSummary: "# สรุปการประชุม",
    transcript: "[00:00:01] Alice: สวัสดีครับ",
  });
  assert.equal(msg.embed.title, "สรุปการประชุม - daily-standup");
  assert.deepEqual(
    msg.embed.fields.map((f) => f.name),
    ["เริ่มประชุม", "ระยะเวลา", "ผู้พูด"],
  );
  assert.deepEqual(
    msg.files.map((f) => f.name),
    ["summary-full-2026-10-12.md", "transcript-2026-10-12.txt"],
  );
  assert.equal(msg.embed.description, "**ภาพรวม:** วางแผน sprint");
  assert.equal(msg.embed.color, 0x5865f2);
  assert.equal(msg.embed.footer, "เริ่มบันทึกโดย Alice | จบเพราะ: ended by Alice with /end");
  assert.equal(msg.embed.fields[2].value, "Alice");
  assert.equal(msg.linkLabel, "ฟังเสียงบันทึกการประชุม");
  assert.equal(msg.linkUrl, "https://meet.example.com/m/abcdefghij012345");
  assert.match(msg.content, /PIN: `123456`/);
});

test("buildMinutesMessage truncates the speaker field at Discord's 1024 limit", () => {
  const m = manifest();
  for (let i = 0; i < 40; i++) {
    m.participants[`u${i}`] = {
      displayName: `นักพูดคนที่ ${i} ${"x".repeat(60)}`,
      utterances: [{ start: 0, end: 96_000 }],
      segments: [0],
      uploaded: [0],
    };
  }
  const msg = buildMinutesMessage(m, {
    pin: "123456",
    shortSummary: "สรุปสั้น",
    fullSummary: "# สรุป",
    transcript: "t",
  });
  const speakers = Object.values(m.participants)
    .filter((p) => p.utterances.length > 0)
    .map((p) => p.displayName);
  const field = msg.embed.fields.find((f) => f.name === "ผู้พูด");
  assert.ok(field, "speaker field missing");
  assert.equal(field.value.length, 1024);
  assert.ok(field.value.length <= 1024);
  assert.equal(field.value, speakers.join(", ").slice(0, 1024));
});

test("buildMinutesMessage truncates the footer at Discord's 2048 limit", () => {
  const m = manifest();
  m.startedBy = { id: "alice", name: "A".repeat(2100) };
  const msg = buildMinutesMessage(m, {
    pin: "123456",
    shortSummary: "สรุปสั้น",
    fullSummary: "# สรุป",
    transcript: "t",
  });
  assert.ok(msg.embed.footer.length <= 2048);
  assert.equal(msg.embed.footer, `เริ่มบันทึกโดย ${"A".repeat(2100)} | จบเพราะ: ${m.endReason ?? "-"}`.slice(0, 2048));
});

test("buildMinutesMessage appends the warning note line only when a note is given", () => {
  const withNote = buildMinutesMessage(manifest(), {
    pin: "123456",
    shortSummary: "สรุปสั้น",
    fullSummary: "# สรุป",
    transcript: "t",
    note: "ถอดเสียงไม่สำเร็จ 1 จาก 2 ช่วง",
  });
  assert.match(withNote.content, /⚠️ ถอดเสียงไม่สำเร็จ 1 จาก 2 ช่วง/);

  const withoutNote = buildMinutesMessage(manifest(), {
    pin: "123456",
    shortSummary: "สรุปสั้น",
    fullSummary: "# สรุป",
    transcript: "t",
  });
  assert.doesNotMatch(withoutNote.content, /⚠️/);
});
