import { test } from "node:test";
import assert from "node:assert/strict";
import { nextEnd, type CallObservation, type RuleState } from "./rules.js";

const MIN = 60_000;
const config = { aloneTimeoutMs: 3 * MIN, maxDurationMs: 240 * MIN, lostUiMs: 30_000 };
const inCall = (participants?: number): CallObservation => ({ inCall: true, participants });
const fresh = (): RuleState => ({ recordingSince: 0 });

test("/end, removal and the end screens end the recording at once, in that priority", () => {
  assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "removed" }, 1, true, config), "stopped");
  assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "removed" }, 1, false, config), "removed");
  assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "meeting_ended" }, 1, false, config), "meeting_ended");
  assert.equal(nextEnd(fresh(), inCall(5), 1, false, config), undefined);
});

test("the bot alone for the full timeout ends the recording; anyone coming back resets the timer", () => {
  const s = fresh();
  assert.equal(nextEnd(s, inCall(1), 10_000, false, config), undefined);
  assert.equal(nextEnd(s, inCall(1), 10_000 + 3 * MIN - 1, false, config), undefined);
  assert.equal(nextEnd(s, inCall(2), 10_000 + 3 * MIN, false, config), undefined, "someone rejoined");
  assert.equal(nextEnd(s, inCall(1), 20 * MIN, false, config), undefined);
  assert.equal(nextEnd(s, inCall(1), 23 * MIN, false, config), "alone");
});

test("an uncountable participant list never counts as alone", () => {
  const s = fresh();
  for (const t of [0, 5 * MIN, 10 * MIN]) {
    assert.equal(nextEnd(s, inCall(undefined), t, false, config), undefined);
    assert.equal(nextEnd(s, inCall(0), t + 1, false, config), undefined);
  }
});

test("the call UI gone for 30 s ends the recording, a shorter blip does not", () => {
  const s = fresh();
  assert.equal(nextEnd(s, { inCall: false }, 1_000, false, config), undefined);
  assert.equal(nextEnd(s, inCall(3), 20_000, false, config), undefined, "back after a reconnect");
  assert.equal(nextEnd(s, { inCall: false }, 40_000, false, config), undefined);
  assert.equal(nextEnd(s, { inCall: false }, 70_000, false, config), "meeting_ended");
});

test("the maximum duration ends even a busy call", () => {
  assert.equal(nextEnd({ recordingSince: 1_000 }, inCall(8), 1_000 + 240 * MIN, false, config), "max_duration");
});
