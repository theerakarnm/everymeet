import { config } from "../config.js";
import { MEET_PARTICIPANT_ID, type RecordingState } from "../meet/protocol.js";
import type { MeetManifest } from "../storage/manifest.js";
import { logger } from "../util/log.js";
import { enqueueWebhook } from "./outbox.js";

const log = logger("webhooks");

export type WebhookType = "recording.notice_failed" | "recording.ended" | "recording.failed" | "minutes.ready";
export type ApiState = "starting" | "joining" | "waiting" | "recording" | "processing" | "done" | "failed";

/** A recording as the API and webhooks show it. */
export interface RecordingView {
  id: string;
  client: string;
  ownerId: string;
  metadata: Record<string, string>;
  state: ApiState;
  stopping: boolean;
  meetCode: string;
  title: string;
  delivery: "email" | "webhook";
  /** ISO time: when the start was asked, then (once audio capture began) when capture started. */
  startedAt: string;
  endedAt?: string;
  endCode?: string;
  endReason?: string;
  durationSeconds?: number;
  playbackUrl?: string;
  summaryShort?: string;
  error?: string;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

function stateOf(m: MeetManifest, live?: { state: RecordingState }): ApiState {
  if (m.status !== "recording") return m.status;
  if (live) return live.state === "ended" ? "processing" : live.state;
  return m.participants[MEET_PARTICIPANT_ID] ? "recording" : "starting";
}

/**
 * The one shape of a recording for API answers and webhook bodies. Never the PIN, the transcript, the full
 * summary, audio links, or recipient addresses (Decision 7).
 */
export function recordingView(m: MeetManifest, live?: { state: RecordingState; stopping: boolean }, summaryShort?: string): RecordingView {
  const api = m.meet.api!;
  const captured = !!m.participants[MEET_PARTICIPANT_ID];
  return {
    id: m.id,
    client: api.client,
    ownerId: api.ownerId,
    metadata: api.metadata,
    state: stateOf(m, live),
    stopping: live?.stopping ?? false,
    meetCode: m.meet.code,
    title: m.meet.title,
    delivery: api.delivery,
    startedAt: iso(m.startedAt)!,
    endedAt: iso(m.endedAt),
    endCode: m.endCode,
    endReason: m.endReason,
    durationSeconds: captured && m.endedAt !== undefined ? Math.round((m.endedAt - m.startedAt) / 1000) : undefined,
    playbackUrl: m.status === "done" ? `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${m.id}` : undefined,
    summaryShort,
    error: m.status === "failed" ? m.error : undefined,
  };
}

/** Queues a webhook for an API recording that has a webhook URL; other recordings are ignored. Never throws. */
export function emitWebhook(m: MeetManifest, type: WebhookType, summaryShort?: string): void {
  const url = m.meet.api?.webhookUrl;
  if (!url) return;
  try {
    enqueueWebhook(url, type, recordingView(m, undefined, summaryShort));
  } catch (err) {
    log.error(`could not queue webhook ${type} for ${m.id}`, err);
  }
}
