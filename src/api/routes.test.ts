import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeMeetRecorder, mockEmail, mockR2, r2 } from "../test/setup.js";

mockR2();
mockEmail();
const worker = fakeMeetRecorder();
process.env.TRUST_PROXY = "true";
const { createApp } = await import("../web/server.js");
const { MeetSession, activeMeets } = await import("../meet/session.js");
const { keys } = await import("../storage/keys.js");
const { newSessionId } = await import("../util/pin.js");

const app = createApp({ startMeet: (meet) => MeetSession.start(meet, () => {}) });
const SERVICE = `Bearer ${"k".repeat(40)}`;
const OPS = `Bearer ${"o".repeat(40)}`;
const JKU = "https://meet.google.com/abc-defg-hij";
const api = (path: string, o: { body?: unknown; method?: string; auth?: string; ip?: string } = {}) =>
  app.request(`/api/v1${path}`, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers: { authorization: o.auth ?? SERVICE, "content-type": "application/json", "x-forwarded-for": o.ip ?? "10.9.0.1" },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
const start = (over: Record<string, unknown> = {}, auth = SERVICE) =>
  api("/recordings", { auth, body: { meetUrl: JKU, ownerId: "team-1", metadata: { plan: "pro" }, delivery: { mode: "webhook" }, ...over } });

afterEach(async () => {
  for (const s of activeMeets.values()) await s.shutdown();
  activeMeets.clear();
});

test("without a valid API key the API answers 401 in JSON, and many bad keys from one IP get 429", async () => {
  const res = await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
  assert.equal(res.status, 401);
  assert.deepEqual((await res.json()).error.code, "unauthorized");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await api("/recordings?ownerId=team-1", { auth: "", ip: "10.9.1.1" })).status, 401);
  for (let i = 0; i < 28; i++) await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
  const limited = await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("a client starts a recording, reads it, and stops it; another client can neither see nor stop it", async () => {
  const res = await start();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(res.headers.get("location"), `/api/v1/recordings/${body.id}`);
  assert.equal(body.state, "starting");
  assert.equal(body.ownerId, "team-1");
  assert.deepEqual(body.metadata, { plan: "pro" });
  assert.equal(body.delivery, "webhook");
  const s = activeMeets.get("abc-defg-hij")!;
  assert.deepEqual(s.manifest.meet.api, { client: "service", ownerId: "team-1", metadata: { plan: "pro" }, delivery: "webhook", webhookUrl: "https://service.example.com/hooks/everymeet" });
  assert.equal(s.manifest.meet.trigger, "api");
  assert.ok(worker.recordings.has(body.id));
  assert.ok([...r2.keys()].some((k) => k.startsWith(keys.ownerPrefix("service", "team-1")) && k.endsWith(body.id)));
  assert.equal((await api(`/recordings/${body.id}`)).status, 200);
  assert.equal((await api(`/recordings/${body.id}`, { auth: OPS })).status, 404);
  assert.equal((await api(`/recordings/${body.id}/stop`, { method: "POST", auth: OPS })).status, 404);
  const stopped = await api(`/recordings/${body.id}/stop`, { method: "POST" });
  assert.equal(stopped.status, 202);
  assert.equal((await stopped.json()).stopping, true);
  assert.equal(worker.recordings.get(body.id)!.stopped, true);
});

test("bad input is refused with a code: the body, the Meet link, and the webhook URL", async () => {
  const codeOf = async (res: Response) => [res.status, (await res.json()).error.code];
  assert.deepEqual(await codeOf(await start({ ownerId: "has space" })), [400, "invalid_request"]);
  assert.deepEqual(await codeOf(await start({ ownerId: ".." })), [400, "invalid_request"]);
  assert.deepEqual(await codeOf(await start({ extra: 1 })), [400, "invalid_request"]);
  assert.deepEqual(await codeOf(await start({ meetUrl: "https://zoom.us/j/1" })), [400, "invalid_meet_url"]);
  assert.deepEqual(await codeOf(await start({ webhookUrl: "https://evil.test/h" })), [400, "webhook_url_not_allowed"]);
  assert.deepEqual(await codeOf(await start({ webhookUrl: "http://other.example.com/h" })), [400, "webhook_url_not_allowed"]);
  const raw = await app.request("/api/v1/recordings", { method: "POST", headers: { authorization: SERVICE, "content-type": "application/json" }, body: "{not json" });
  assert.deepEqual(await codeOf(raw), [400, "invalid_request"]);
  assert.equal(activeMeets.size, 0, "nothing was started");
  const ok = await start({ webhookUrl: "https://other.example.com/h" });
  assert.equal(ok.status, 201);
  assert.equal(activeMeets.get("abc-defg-hij")!.manifest.meet.api!.webhookUrl, "https://other.example.com/h");
});

test("email delivery passes the starter and recipients through, and the global limits answer 409 and 503", async () => {
  const res = await start({ delivery: { mode: "email", starter: "Ann@Example.com", recipients: ["bob@example.com"] } });
  assert.equal(res.status, 201);
  const id = (await res.json()).id;
  const meet = activeMeets.get("abc-defg-hij")!.manifest.meet;
  assert.equal(meet.startedBy, "ann@example.com");
  assert.deepEqual(meet.recipients, ["ann@example.com", "bob@example.com"]);
  const again = await (await start()).json();
  assert.deepEqual(again.error, { code: "already_recording", message: "This Google Meet call is already being recorded.", recordingId: id });
  assert.equal((await (await start({}, OPS)).json()).error.recordingId, undefined, "another client does not learn the id");
  assert.equal((await start({ meetUrl: "https://meet.google.com/pqr-stuv-wxy" })).status, 201);
  const busy = await start({ meetUrl: "https://meet.google.com/xyz-abcd-efg" });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "60");
});

test("an owner's recordings are listed newest first, page by page, only for the client that started them", async () => {
  const T = Date.UTC(2026, 10, 20, 3);
  const seed = (startedAt: number, client = "service") => {
    const id = newSessionId();
    const m = {
      id, startedAt, endedAt: startedAt + 60_000, heartbeatAt: startedAt + 60_000, status: "done", endCode: "alone",
      participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [0], uploaded: [0] } },
      pin: { salt: "s", hash: "h" },
      meet: { url: JKU, code: "abc-defg-hij", title: "Weekly", trigger: "api", recipients: [], api: { client, ownerId: "team-2", metadata: {}, delivery: "webhook" } },
    };
    r2.set(keys.manifest(id), Buffer.from(JSON.stringify(m)));
    r2.set(keys.ownerIndex(client, "team-2", startedAt, id), Buffer.alloc(0));
    return id;
  };
  const older = seed(T);
  const newer = seed(T + 60 * 60_000);
  seed(T, "ops");
  r2.set(keys.summaryShort(newer), Buffer.from("สรุปสั้น"));
  const first = await (await api("/recordings?ownerId=team-2&limit=1")).json();
  assert.deepEqual(first.items.map((i: { id: string }) => i.id), [newer]);
  assert.ok(first.nextCursor);
  const second = await (await api(`/recordings?ownerId=team-2&limit=1&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map((i: { id: string }) => i.id), [older]);
  assert.equal(second.nextCursor, undefined);
  const one = await (await api(`/recordings/${newer}`)).json();
  assert.equal(one.state, "done");
  assert.equal(one.durationSeconds, 60);
  assert.equal(one.summaryShort, "สรุปสั้น");
  assert.equal(one.playbackUrl, `https://meet.example.com/m/${newer}`);
  assert.equal((await api("/recordings?ownerId=")).status, 400);
});
