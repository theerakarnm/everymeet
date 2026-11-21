import { test } from "node:test";
import assert from "node:assert/strict";
import { mockEmail, mockR2, r2 } from "../test/setup.js";

mockR2();
mockEmail();
process.env.TRUST_PROXY = "true";
const { createApp } = await import("../web/server.js");
const { keys } = await import("../storage/keys.js");
const { hashPin, newSessionId } = await import("../util/pin.js");

const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
const issue = (id: string, key = "k".repeat(40)) =>
  app.request(`/api/v1/recordings/${id}/pin`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
const enter = (id: string, pin: string) =>
  app.request(`/m/${id}`, {
    method: "POST",
    body: new URLSearchParams({ pin }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.8.0.1", origin: "https://meet.example.com" },
  });
const seed = (status: "done" | "processing", oldPin = "111111") => {
  const id = newSessionId();
  const m = {
    id, startedAt: 0, endedAt: 60_000, heartbeatAt: 60_000, status, pin: hashPin(oldPin), outputs: {},
    participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [0], uploaded: [0] } },
    meet: { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij", title: "Weekly", trigger: "api", recipients: [], api: { client: "service", ownerId: "team-1", metadata: {}, delivery: "webhook" } },
  };
  r2.set(keys.manifest(id), Buffer.from(JSON.stringify(m)));
  return id;
};

test("a new PIN opens the playback page at once and the previous one stops working", async () => {
  const id = seed("done");
  assert.equal((await app.request(`/m/${id}`)).status, 200, "the page is cached with the old PIN");
  const res = await issue(id);
  assert.equal(res.status, 200);
  const { pin, playbackUrl } = await res.json();
  assert.match(pin, /^\d{6}$/);
  assert.equal(playbackUrl, `https://meet.example.com/m/${id}`);
  assert.ok(!r2.get(keys.manifest(id))!.toString().includes(`"${pin}"`), "only the hash is stored");
  const opened = await enter(id, pin);
  assert.equal(opened.status, 303);
  assert.match(opened.headers.get("set-cookie") ?? "", new RegExp(`^ma_${id}=`));
  if (pin !== "111111") assert.equal((await enter(id, "111111")).status, 401);
});

test("PINs are issued only for the caller's own recordings with finished minutes", async () => {
  assert.equal((await issue(seed("done"), "o".repeat(40))).status, 404);
  const busy = await issue(seed("processing"));
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, "not_ready");
});
