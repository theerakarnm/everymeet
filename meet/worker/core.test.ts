import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecordingJob } from "../../src/meet/protocol.js";
import { DESTROY_AFTER_END_MS, RecorderCore, RETENTION_MS, WATCHDOG_MS, type RecordingRecord } from "./core.js";

const MIN = 60_000;
const T0 = 1_000_000;
const job: RecordingJob = {
  meetUrl: "https://meet.google.com/abc-defg-hij",
  authState: '{"cookies":[{"value":"secret-cookie"}]}',
  sampleRate: 24_000,
  segmentSamples: 7_200_000,
  admitTimeoutMs: 5 * MIN,
  aloneTimeoutMs: 3 * MIN,
  maxDurationMs: 240 * MIN,
};

function fakePorts() {
  const f = {
    now: T0,
    stored: undefined as RecordingRecord | undefined,
    alarm: undefined as number | undefined,
    launched: [] as { id: string; job: RecordingJob; hardDeadline: number }[],
    destroyed: [] as string[],
    logs: [] as Record<string, unknown>[],
    launchFails: false,
    pending: [] as Promise<void>[],
  };
  const core = new RecorderCore({
    load: async () => structuredClone(f.stored),
    save: async (r) => {
      f.stored = structuredClone(r);
    },
    clear: async () => {
      f.stored = undefined;
      f.alarm = undefined;
    },
    setAlarm: async (at) => {
      f.alarm = at;
    },
    launch: async (id, j, hardDeadline) => {
      if (f.launchFails) throw new Error("no container instance available");
      f.launched.push({ id, job: j, hardDeadline });
    },
    background: (task) => void f.pending.push(task),
    destroy: async (reason) => void f.destroyed.push(reason),
    now: () => f.now,
    log: (e) => void f.logs.push(e),
  });
  return { f, core };
}

test("start keeps the bot account session out of storage and logs, launches the container with it, and arms the watchdog", async () => {
  const { f, core } = fakePorts();
  assert.equal(await core.start("rec1", job), "started");
  await Promise.all(f.pending);
  assert.equal(f.launched[0]!.job.authState, job.authState);
  assert.equal(f.launched[0]!.hardDeadline, T0 + 5 * MIN + 240 * MIN + 10 * MIN);
  assert.ok(!JSON.stringify(f.stored).includes("secret-cookie"));
  assert.ok(!JSON.stringify(f.logs).includes("secret-cookie"));
  assert.equal(f.alarm, T0 + WATCHDOG_MS);
  assert.equal((await core.status())!.state, "starting");
  assert.equal(await core.start("rec1", job), "exists");
  assert.equal(f.launched.length, 1);
});

test("runner events move the state along, and /end reaches the runner in its next reply", async () => {
  const { core } = fakePorts();
  await core.start("rec1", job);
  assert.deepEqual(await core.event({ type: "joining" }), { stop: false });
  await core.event({ type: "waiting" });
  assert.equal((await core.status())!.state, "waiting");
  await core.event({ type: "recording", captureStartedAt: 1_234, consentPosted: true });
  const s = (await core.status())!;
  assert.equal(s.state, "recording");
  assert.equal(s.captureStartedAt, 1_234);
  assert.equal(s.consentPosted, true);
  assert.equal(await core.stop(), true);
  assert.deepEqual(await core.event({ type: "heartbeat", participants: 2 }), { stop: true });
});

test("a stop requested while the container is still starting reaches the runner at its first event", async () => {
  const { f, core } = fakePorts();
  await core.start("rec1", job);
  await Promise.all(f.pending);
  assert.equal(await core.stop(), true);
  assert.deepEqual(await core.event({ type: "joining" }), { stop: true });
  await core.event({ type: "ended", reason: "stopped", leftCleanly: true });
  assert.equal((await core.status())!.state, "ended");
});

test("stored segments are listed once and sorted, even when an upload is retried", async () => {
  const { core } = fakePorts();
  await core.start("rec1", job);
  await core.segmentStored(1, 240_000);
  await core.segmentStored(0, 7_200_000);
  await core.segmentStored(1, 240_000);
  assert.deepEqual((await core.status())!.segments, [
    { index: 0, samples: 7_200_000 },
    { index: 1, samples: 240_000 },
  ]);
});

test("after the runner reports the end, the container is destroyed and the state is deleted 7 days later", async () => {
  const { f, core } = fakePorts();
  await core.start("rec1", job);
  assert.deepEqual(await core.event({ type: "ended", reason: "alone", leftCleanly: true }), { stop: true });
  assert.deepEqual((await core.status())!.end, { reason: "alone", leftCleanly: true });
  assert.equal(f.alarm, T0 + DESTROY_AFTER_END_MS);
  f.now = f.alarm!;
  await core.alarm();
  assert.deepEqual(f.destroyed, ["recording ended"]);
  assert.equal(f.alarm, T0 + RETENTION_MS);
  f.now = f.alarm!;
  await core.alarm();
  assert.equal(await core.status(), undefined);
  assert.deepEqual(await core.event({ type: "heartbeat" }), { stop: true }, "a late runner is told to stop");
});

test("a container that stops reporting for 3 minutes is ended as container_lost; an earlier alarm only re-arms", async () => {
  const { f, core } = fakePorts();
  await core.start("rec1", job);
  await Promise.all(f.pending);
  f.now = T0 + 2 * MIN;
  await core.event({ type: "heartbeat" });
  f.now = T0 + WATCHDOG_MS;
  await core.alarm();
  assert.equal((await core.status())!.state, "starting");
  assert.equal(f.alarm, T0 + 2 * MIN + WATCHDOG_MS);
  f.now = f.alarm!;
  await core.alarm();
  assert.deepEqual((await core.status())!.end, { reason: "container_lost", detail: "no report for 3 minutes", leftCleanly: false });
  assert.deepEqual(f.destroyed, ["container_lost"]);
});

test("the hard deadline ends a recording even while the container keeps reporting", async () => {
  const { f, core } = fakePorts();
  await core.start("rec1", job);
  await Promise.all(f.pending);
  f.now = f.launched[0]!.hardDeadline;
  await core.event({ type: "heartbeat" });
  await core.alarm();
  assert.deepEqual((await core.status())!.end, { reason: "max_duration", detail: "hard deadline reached", leftCleanly: false });
  assert.deepEqual(f.destroyed, ["max_duration"]);
});

test("a runner that exits without reporting the end, or a container that cannot start, ends the recording as crashed", async () => {
  const a = fakePorts();
  await a.core.start("rec1", job);
  await a.core.runnerExited(137);
  assert.deepEqual((await a.core.status())!.end, { reason: "crashed", detail: "runner exited with code 137", leftCleanly: false });
  assert.deepEqual(a.f.destroyed, ["runner exited"]);

  const b = fakePorts();
  b.f.launchFails = true;
  assert.equal(await b.core.start("rec2", job), "started", "the bot's start request never waits for the container");
  await Promise.all(b.f.pending);
  assert.deepEqual((await b.core.status())!.end, {
    reason: "crashed",
    detail: "container start failed: no container instance available",
    leftCleanly: false,
  });
});
