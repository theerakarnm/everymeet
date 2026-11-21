import { test } from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhook, webhookHeaders } from "./signature.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TS = 1614265330;
const BODY = '{"test": 2432232314}';

test("signatures match the Standard Webhooks example", () => {
  assert.equal(signWebhook(SECRET, ID, TS, BODY), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  assert.deepEqual(webhookHeaders(SECRET, ID, BODY, TS), {
    "webhook-id": ID,
    "webhook-timestamp": String(TS),
    "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  });
});

test("a receiver accepts the signed body, also among several signatures, and refuses changes and old timestamps", () => {
  const h = { id: ID, timestamp: String(TS), signature: `v1,bm9wZQ== ${signWebhook(SECRET, ID, TS, BODY)}` };
  assert.equal(verifyWebhook(SECRET, h, BODY, TS + 10), true);
  assert.equal(verifyWebhook(SECRET, h, BODY.replace("2", "3"), TS), false, "changed body");
  assert.equal(verifyWebhook(SECRET, { ...h, id: "msg_other" }, BODY, TS), false, "changed id");
  assert.equal(verifyWebhook(SECRET, h, BODY, TS + 301), false, "too old");
  assert.equal(verifyWebhook("whsec_" + Buffer.from("x".repeat(24)).toString("base64"), h, BODY, TS), false, "other secret");
});
