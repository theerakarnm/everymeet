import { test } from "node:test";
import assert from "node:assert/strict";
import { mockR2, r2 } from "../test/setup.js";

mockR2();
process.env.TRUST_PROXY = "true"; // as behind Nginx; the tests send X-Forwarded-For
const { createApp } = await import("./server.js");
const { generatePin, hashPin, newSessionId } = await import("../util/pin.js");
const { keys } = await import("../storage/r2.js");

function storeMeeting(status: "processing" | "done", pin = generatePin()) {
  const id = newSessionId();
  const manifest = {
    id,
    guildName: "Planthia",
    voiceChannelName: "daily-standup",
    startedAt: Date.UTC(2026, 9, 12, 3),
    endedAt: Date.UTC(2026, 9, 12, 4),
    heartbeatAt: 0,
    status,
    participants: { u1: { displayName: "Alice", utterances: [], segments: [], uploaded: [] } },
    pin: hashPin(pin),
    outputs: { tracks: { u1: keys.track(id, "u1") } },
  };
  r2.set(keys.manifest(id), Buffer.from(JSON.stringify(manifest)));
  return { id, pin, manifest };
}

const app = createApp();
let ipCounter = 0;
const newIp = () => `10.0.0.${++ipCounter}`;

const submitPin = (id: string, pin: string, ip = newIp()) =>
  app.request(`/m/${id}`, {
    method: "POST",
    body: new URLSearchParams({ pin }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
  });

test("the link asks for the PIN before showing anything", async () => {
  const { id } = storeMeeting("done");
  const res = await app.request(`/m/${id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /name="pin"/);
  assert.doesNotMatch(html, /<audio/);

  const file = await app.request(`/m/${id}/file/audio`);
  assert.equal(file.status, 303, "files need the PIN too");
  assert.equal(file.headers.get("location"), `/m/${id}`);
});

test("anyone with the PIN can listen to the meeting and download every file", async () => {
  const { id, pin } = storeMeeting("done");
  const login = await submitPin(id, pin);
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  const headers = { cookie: cookie.split(";")[0]! };

  const page = await app.request(`/m/${id}`, { headers });
  const html = await page.text();
  assert.match(html, /<audio controls/);
  assert.match(html, /daily-standup/);
  assert.match(html, /Alice/, "per-speaker track is listed by name");

  for (const [path, key] of [
    ["audio", keys.mixed(id)],
    ["transcript", keys.transcript(id)],
    ["summary", keys.summaryFull(id)],
    ["track/u1", keys.track(id, "u1")],
  ] as const) {
    const res = await app.request(`/m/${id}/file/${path}`, { headers });
    assert.equal(res.status, 302, path);
    assert.ok(res.headers.get("location")!.startsWith(`https://r2.example.com/${key}?`), path);
  }
  assert.equal((await app.request(`/m/${id}/file/track/someone-else`, { headers })).status, 404);
});

test("a PIN cookie only opens the meeting it was issued for", async () => {
  const a = storeMeeting("done");
  const b = storeMeeting("done");
  const cookie = (await submitPin(a.id, a.pin)).headers.get("set-cookie")!.split(";")[0]!;
  const res = await app.request(`/m/${b.id}`, { headers: { cookie: cookie.replace(a.id, b.id) } });
  assert.match(await res.text(), /name="pin"/);
});

test("wrong PINs are counted and lock the IP after 5 tries", async () => {
  const { id, pin } = storeMeeting("done");
  const wrong = pin === "000000" ? "111111" : "000000";
  const ip = newIp();
  for (let left = 4; left >= 0; left--) {
    const res = await submitPin(id, wrong, ip);
    assert.equal(res.status, 401);
    assert.match(await res.text(), new RegExp(`เหลือ ${left} ครั้ง`));
  }
  const locked = await submitPin(id, pin, ip);
  assert.equal(locked.status, 429, "even the right PIN is refused while locked");
  assert.equal((await submitPin(id, pin, newIp())).status, 303, "other people are not affected");
});

test("a meeting that is still processing is not reachable, and becomes reachable once done", async () => {
  const { id, pin, manifest } = storeMeeting("processing");
  assert.equal((await app.request(`/m/${id}`)).status, 404);
  r2.set(keys.manifest(id), Buffer.from(JSON.stringify({ ...manifest, status: "done" })));
  assert.equal((await app.request(`/m/${id}`)).status, 200, "the not-ready state must not be cached");
  assert.equal((await submitPin(id, pin)).status, 303);
});

test("health check, malformed ids, and security headers", async () => {
  assert.equal((await app.request("/healthz")).status, 200);
  assert.equal((await app.request("/m/..%2F..%2Fetc")).status, 404);
  const res = await app.request("/m/short");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});
