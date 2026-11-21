import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir, mockWebhooks, sentWebhooks } from "../test/setup.js";

let answer: () => number = () => 200;
mockWebhooks({ status: () => answer() });
const { deliverDue, enqueueWebhook, pendingWebhooks, RETRY_DELAYS_MS } = await import("./outbox.js");
const { verifyWebhook } = await import("./signature.js");

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // WEBHOOK_SECRET of src/test/setup.ts
const URL_ = "https://service.example.com/hooks/everymeet";
const T0 = Date.UTC(2026, 10, 21, 3, 0, 0);

beforeEach(() => {
  sentWebhooks.length = 0;
  answer = () => 200;
  rmSync(join(dataDir, "webhooks"), { recursive: true, force: true });
});

test("an event is on disk before it is sent, is signed with a stable id, and is removed once delivered", async () => {
  const e = enqueueWebhook(URL_, "minutes.ready", { id: "r1" }, T0);
  assert.match(e.id, /^msg_[\w-]{22}$/);
  assert.deepEqual(pendingWebhooks().map((p) => p.id), [e.id]);
  await deliverDue(() => T0);
  assert.equal(sentWebhooks.length, 1);
  const w = sentWebhooks[0]!;
  assert.equal(w.url, URL_);
  assert.equal(w.headers["webhook-id"], e.id);
  assert.equal(w.headers["webhook-timestamp"], String(T0 / 1000));
  const h = { id: e.id, timestamp: w.headers["webhook-timestamp"]!, signature: w.headers["webhook-signature"]! };
  assert.ok(verifyWebhook(SECRET, h, w.body, T0 / 1000));
  assert.deepEqual(JSON.parse(w.body), { type: "minutes.ready", timestamp: new Date(T0).toISOString(), data: { id: "r1" } });
  assert.deepEqual(pendingWebhooks(), []);
});

test("a refused delivery is retried with backoff, keeps its id and body, and moves to failed/ after the eighth attempt", async () => {
  answer = () => 500;
  const e = enqueueWebhook(URL_, "recording.failed", { id: "r2" }, T0);
  let now = T0;
  await deliverDue(() => now);
  assert.equal(pendingWebhooks()[0]!.nextAt, T0 + 30_000);
  await deliverDue(() => now + 29_000);
  assert.equal(sentWebhooks.length, 1, "not due yet");
  for (const wait of RETRY_DELAYS_MS) {
    now += wait;
    await deliverDue(() => now);
  }
  assert.equal(sentWebhooks.length, 8);
  assert.ok(sentWebhooks.every((w) => w.headers["webhook-id"] === e.id && w.body === sentWebhooks[0]!.body));
  assert.notEqual(sentWebhooks[7]!.headers["webhook-timestamp"], sentWebhooks[0]!.headers["webhook-timestamp"], "each attempt is signed at its own time");
  assert.deepEqual(pendingWebhooks(), []);
  assert.ok(existsSync(join(dataDir, "webhooks", "failed", `${e.id}.json`)));
});

test("a network error is a failed attempt, and the next success delivers the event", async () => {
  answer = () => {
    throw new TypeError("fetch failed");
  };
  enqueueWebhook(URL_, "recording.ended", { id: "r3" }, T0);
  await deliverDue(() => T0);
  assert.equal(pendingWebhooks()[0]!.attempts, 1);
  answer = () => 204;
  await deliverDue(() => T0 + 30_000);
  assert.deepEqual(pendingWebhooks(), []);
});
