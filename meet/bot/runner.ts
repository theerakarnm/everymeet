/**
 * Container entry for one Google Meet recording. Reads the RecordingJob from stdin, joins the call,
 * records it, and reports to its Durable Object through http://meet-recorder.internal.
 */
import type { EndReason, RecordingEnd, RecordingJob } from "../../src/meet/protocol.js";
import { sendEvent, uploadDebug } from "./callback.js";
import { startCapture } from "./capture.js";
import { sleep } from "./human.js";
import { CONSENT_MESSAGE, MeetPage } from "./meet-page.js";
import { nextEnd, type CallObservation, type RuleState } from "./rules.js";

const GUEST_NAME = "Meeting Minutes Bot";
const HEARTBEAT_MS = 5_000;
const OBSERVE_MS = 2_000;
const LOST_UI_MS = 30_000;
const SEGMENT_DIR = "/work/segments";
/** Ends where a screenshot shows what Meet displayed. */
const FAILURES: EndReason[] = ["not_admitted", "denied", "auth_expired", "join_failed", "crashed"];

let stopRequested = false;
let participants: number | undefined;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function attend(page: MeetPage, job: RecordingJob): Promise<RecordingEnd> {
  if (job.authState && (await page.signedOut())) return { reason: "auth_expired", leftCleanly: true };
  if (!(await page.prejoin(job.authState ? undefined : GUEST_NAME))) {
    return { reason: "join_failed", detail: "no join button", leftCleanly: true };
  }
  stopRequested ||= (await sendEvent({ type: "waiting" })).stop;
  const admission = await page.waitForAdmission(job.admitTimeoutMs, () => stopRequested);
  if (admission !== "admitted") return { reason: admission, leftCleanly: true };

  // The notice goes up before the first sample is recorded (consent / PDPA).
  const consentPosted = await page.postChat(CONSENT_MESSAGE);
  const capture = startCapture(SEGMENT_DIR, job);
  stopRequested ||= (await sendEvent({ type: "recording", captureStartedAt: capture.startedAt, consentPosted })).stop;

  const state: RuleState = { recordingSince: capture.startedAt };
  const rules = { aloneTimeoutMs: job.aloneTimeoutMs, waitForOthersMs: job.admitTimeoutMs, maxDurationMs: job.maxDurationMs, lostUiMs: LOST_UI_MS };
  let reason: EndReason | undefined;
  let detail: string | undefined;
  // Whatever happens in the loop or while leaving, the open segment is flushed and uploaded before "ended" goes out.
  try {
    while (!reason) {
      await sleep(OBSERVE_MS);
      if (!capture.alive) {
        reason = "crashed";
        detail = "audio capture stopped";
        break;
      }
      // Meet re-renders can make page.evaluate throw; treat that moment as "call UI not seen" and let the 30 s rule decide.
      const seen = await page.observe().catch((): CallObservation => ({ inCall: false }));
      participants = seen.participants;
      reason = nextEnd(state, seen, Date.now(), stopRequested, rules);
    }
    const leftCleanly = reason === "removed" || reason === "meeting_ended" ? true : await page.leave().catch(() => false);
    return detail ? { reason, detail, leftCleanly } : { reason, leftCleanly };
  } finally {
    await capture.stop();
  }
}

async function main(): Promise<void> {
  const job = JSON.parse(await readStdin()) as RecordingJob;
  process.once("SIGTERM", () => {
    stopRequested = true;
  });
  const beat = setInterval(() => {
    sendEvent({ type: "heartbeat", participants }).then(
      (reply) => {
        stopRequested ||= reply.stop;
      },
      () => {},
    );
  }, HEARTBEAT_MS);

  let page: MeetPage | undefined;
  let end: RecordingEnd;
  try {
    stopRequested ||= (await sendEvent({ type: "joining" })).stop;
    if (stopRequested) {
      end = { reason: "stopped", leftCleanly: true }; // the bot gave up on this start before the container came up
    } else {
      page = await MeetPage.open(job.meetUrl, job.authState);
      end = await attend(page, job);
    }
  } catch (err) {
    end = { reason: "crashed", detail: String((err as Error)?.message ?? err).slice(0, 300), leftCleanly: false };
  }
  clearInterval(beat);
  if (page && FAILURES.includes(end.reason)) {
    await page
      .screenshot()
      .then((png) => uploadDebug("failure.png", png))
      .catch(() => {});
  }
  await sendEvent({ type: "ended", ...end }).catch(() => {});
  await page?.close().catch(() => {});
}

await main();
process.exit(0);
