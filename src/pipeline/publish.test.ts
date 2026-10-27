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
  assert.equal(msg.linkLabel, "ฟังเสียงบันทึกการประชุม");
  assert.equal(msg.linkUrl, "https://meet.example.com/m/abcdefghij012345");
  assert.match(msg.content, /PIN: `123456`/);
});
