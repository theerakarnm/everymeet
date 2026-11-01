import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, handleCallback, type RecorderApi } from "./http.js";

const TOKEN = "t".repeat(40);
const JOB = {
  meetUrl: "https://meet.google.com/abc-defg-hij",
  sampleRate: 24_000,
  segmentSamples: 7_200_000,
  admitTimeoutMs: 1,
  aloneTimeoutMs: 1,
  maxDurationMs: 1,
};

function fakeRecorder() {
  const calls: unknown[][] = [];
  let exists = false;
  const r: RecorderApi = {
    start: async (id, job) => {
      calls.push(["start", id, job]);
      if (exists) return "exists";
      exists = true;
      return "started";
    },
    status: async () => (exists ? { state: "recording", segments: [] } : undefined),
    stop: async () => exists,
    event: async (e) => {
      calls.push(["event", e]);
      return { stop: false };
    },
    segmentStored: async (index, samples) => void calls.push(["segmentStored", index, samples]),
  };
  const stored = new Map<string, { bytes: number; contentType: string }>();
  const store = async (key: string, body: ArrayBuffer, contentType: string) =>
    void stored.set(key, { bytes: body.byteLength, contentType });
  return { r, calls, stored, store };
}

const request = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
  return new Request(`https://recorder.example.com${path}`, { ...init, headers });
};

test("every API call needs the exact Bearer token", async () => {
  const { r } = fakeRecorder();
  const api = (req: Request) => handleApi(req, TOKEN, () => r);
  assert.equal((await api(request("/recordings/abc", { token: null }))).status, 401);
  assert.equal((await api(request("/recordings/abc", { token: "x".repeat(40) }))).status, 401);
  assert.equal((await handleApi(request("/recordings/abc"), undefined, () => r)).status, 401, "no secret configured");
  assert.equal((await api(request("/recordings/abc"))).status, 404, "right token, unknown recording");
});

test("the bot can start, read and stop a recording; bad ids, paths and links are refused", async () => {
  const { r, calls } = fakeRecorder();
  const api = (req: Request) => handleApi(req, TOKEN, () => r);
  const post = (path: string, body?: unknown) =>
    api(request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));
  assert.equal((await post("/recordings/abc", { ...JOB, meetUrl: "https://evil.example.com/x" })).status, 400);
  assert.equal((await post("/recordings/abc", { ...JOB, maxDurationMs: 7 * 60 * 60_000 })).status, 400, "Worker-side cost cap");
  assert.equal((await post("/recordings/abc", JOB)).status, 202);
  assert.deepEqual(calls.at(-1), ["start", "abc", JOB]);
  assert.equal((await post("/recordings/abc", JOB)).status, 409);
  const status = await api(request("/recordings/abc"));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: "recording", segments: [] });
  assert.equal((await post("/recordings/abc/stop")).status, 202);
  assert.equal((await api(request("/recordings/a%2Fb"))).status, 404);
  assert.equal((await api(request("/recordings/abc/stop/now", { method: "POST" }))).status, 404);
  assert.equal((await api(request("/other/abc"))).status, 404);
});

test("container callbacks reach the recorder, and uploads land in R2 under the recording", async () => {
  const { r, calls, stored, store } = fakeRecorder();
  const cb = (path: string, init: RequestInit) =>
    handleCallback(new Request(`http://meet-recorder.internal${path}`, init), "rec1", r, store);
  const reply = await cb("/event", { method: "POST", body: JSON.stringify({ type: "heartbeat", participants: 2 }) });
  assert.deepEqual(await reply.json(), { stop: false });
  assert.deepEqual(calls.at(-1), ["event", { type: "heartbeat", participants: 2 }]);
  assert.equal((await cb("/segments/3", { method: "PUT", headers: { "x-samples": "240000" }, body: new Uint8Array(7) })).status, 204);
  assert.deepEqual(stored.get("meetings/rec1/segments/meet/0003.flac"), { bytes: 7, contentType: "audio/flac" });
  assert.deepEqual(calls.at(-1), ["segmentStored", 3, 240000]);
  assert.equal((await cb("/segments/3", { method: "PUT", body: new Uint8Array(7) })).status, 400, "x-samples is required");
  assert.equal(
    (await cb("/segments/4", { method: "PUT", headers: { "x-samples": "1" }, body: new Uint8Array(33 * 1024 * 1024) })).status,
    413,
    "larger than any 5-minute segment",
  );
  assert.equal((await cb("/debug/failure.png", { method: "PUT", body: new Uint8Array(2) })).status, 204);
  assert.deepEqual(stored.get("meetings/rec1/debug/failure.png"), { bytes: 2, contentType: "image/png" });
  assert.equal((await cb("/debug/..%2Fx", { method: "PUT", body: new Uint8Array(2) })).status, 404);
  assert.equal((await cb("/event", { method: "POST", body: "x".repeat(20_000) })).status, 413);
});
