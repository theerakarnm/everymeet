import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatReply, dataDir, fakeMeetRecorder, flush, mockEmail, mockOpenRouter, mockR2, mockWebhooks, r2, sentEmails, sentWebhooks } from "../test/setup.js";

mockR2();
mockEmail();
mockWebhooks();
const worker = fakeMeetRecorder();
const recorderFetch = globalThis.fetch;
mockOpenRouter((call) =>
  call.path === "/audio/transcriptions"
    ? Response.json({ text: "", segments: [{ start: 0.3, end: 3, text: "สวัสดีครับ เริ่มประชุม" }] })
    : chatReply(call.body.max_tokens <= 2_000 ? "**ภาพรวม:** ทดสอบ" : "# สรุปการประชุม\nทดสอบ"),
);
const openRouterFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) =>
  (new URL(url).host === "meet-recorder.example.com" ? recorderFetch : openRouterFetch)(url, init)) as typeof fetch;
process.env.TRUST_PROXY = "true";
const { createApp } = await import("../web/server.js");
const { MeetSession } = await import("../meet/session.js");
const { processMeeting } = await import("../pipeline/run.js");
const { deliverDue } = await import("./outbox.js");
const { verifyWebhook } = await import("./signature.js");
const { keys } = await import("../storage/keys.js");
const { SAMPLE_RATE } = await import("../config.js");

const NOW = Date.UTC(2026, 10, 21, 3, 0, 0);
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
let processing: Promise<void> | undefined;
const app = createApp({ startMeet: (meet) => MeetSession.start(meet, (m) => { processing = processMeeting({} as any, m); }) });
const auth = { authorization: `Bearer ${"k".repeat(40)}`, "content-type": "application/json" };

test("API start to playback: webhooks are signed, the PIN comes from the API, nobody is emailed", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  try {
    const started = await app.request("/api/v1/recordings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ meetUrl: "https://meet.google.com/abc-defg-hij", ownerId: "team-1", delivery: { mode: "webhook" } }),
    });
    assert.equal(started.status, 201);
    const { id } = await started.json();

    // The recorder stores one 20 s segment of a tone and reports the end (as meet/worker does).
    const raw = join(dataDir, `${id}.raw`);
    const flac = join(dataDir, `${id}.flac`);
    const pcm = Buffer.alloc(SAMPLE_RATE * 20 * 2);
    for (let i = 0; i < SAMPLE_RATE * 3; i++) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), (SAMPLE_RATE + i) * 2); // 3 s tone at 1 s
    }
    writeFileSync(raw, pcm);
    execFileSync("ffmpeg", ["-v", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", raw, "-c:a", "flac", flac]);
    r2.set(keys.segment(id, "meet", 0), readFileSync(flac));
    worker.recordings.get(id)!.status = {
      state: "ended", captureStartedAt: NOW + 60_000, consentPosted: true,
      segments: [{ index: 0, samples: SAMPLE_RATE * 20 }], end: { reason: "alone", leftCleanly: true },
    };
    mock.timers.tick(5_000);
    await flush(20);
    assert.ok(processing, "the end reached processing");
    await processing;

    await deliverDue();
    const bodies = sentWebhooks.map((w) => JSON.parse(w.body));
    // Both were queued at the same frozen instant, so their order is not defined (receivers never rely on it).
    assert.deepEqual(bodies.map((b) => b.type).sort(), ["minutes.ready", "recording.ended"]);
    for (const w of sentWebhooks) {
      const h = { id: w.headers["webhook-id"]!, timestamp: w.headers["webhook-timestamp"]!, signature: w.headers["webhook-signature"]! };
      assert.ok(verifyWebhook(SECRET, h, w.body, Math.floor(Date.now() / 1000)));
      assert.equal(w.url, "https://service.example.com/hooks/everymeet");
    }
    assert.equal(bodies.find((b) => b.type === "minutes.ready").data.summaryShort, "**ภาพรวม:** ทดสอบ");

    const { pin, playbackUrl } = await (await app.request(`/api/v1/recordings/${id}/pin`, { method: "POST", headers: auth })).json();
    const entered = await app.request(new URL(playbackUrl).pathname, {
      method: "POST",
      body: new URLSearchParams({ pin }),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.7.0.1" },
    });
    assert.equal(entered.status, 303);
    const cookie = entered.headers.get("set-cookie")!.split(";")[0]!;
    const player = await app.request(`/m/${id}`, { headers: { cookie } });
    assert.equal(player.status, 200);
    assert.match(await player.text(), /<audio controls/);
    assert.deepEqual(sentEmails, []);
  } finally {
    mock.timers.reset();
  }
});
