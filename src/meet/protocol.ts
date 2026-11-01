/**
 * Contract between the bot (VPS), the meet-recorder Worker (meet/worker) and the recorder
 * container (meet/bot). Types and constants only: all three bundle this file, so it imports nothing.
 */

/** Participant id of the single mixed Google Meet track, also its R2 segment folder. */
export const MEET_PARTICIPANT_ID = "meet";

/** Host the container calls; interceptOutboundHttp routes it to the recording's Durable Object. */
export const CALLBACK_HOST = "meet-recorder.internal";

export type RecordingState = "starting" | "joining" | "waiting" | "recording" | "ended";

export type EndReason =
  | "stopped" // /end in Discord
  | "alone" // only the bot left in the call
  | "removed" // a host removed the bot
  | "meeting_ended" // the call ended or its UI disappeared
  | "max_duration"
  | "not_admitted" // nobody let the bot in before the admit timeout
  | "denied" // the host or Meet refused the join
  | "auth_expired" // the bot account session is no longer signed in
  | "join_failed" // the Meet page did not show a join button
  | "container_lost" // the recorder stopped reporting
  | "crashed"; // the recorder hit an unexpected error

/** What the bot sends to start a recording; the Worker passes it to the container's stdin unchanged. */
export interface RecordingJob {
  meetUrl: string;
  /** Playwright storageState JSON of the signed-in bot account; never stored on Cloudflare. */
  authState?: string;
  sampleRate: number;
  segmentSamples: number;
  admitTimeoutMs: number;
  aloneTimeoutMs: number;
  maxDurationMs: number;
}

export interface SegmentInfo {
  index: number;
  samples: number;
}

export interface RecordingEnd {
  reason: EndReason;
  detail?: string;
  /** The bot clicked "Leave call" and saw that it left (true when it was never in the call). */
  leftCleanly: boolean;
}

export interface RecordingStatus {
  state: RecordingState;
  /** Epoch ms when audio capture started; the meeting timeline starts here. */
  captureStartedAt?: number;
  consentPosted?: boolean;
  /** Segments stored in R2, sorted by index. */
  segments: SegmentInfo[];
  end?: RecordingEnd;
}

/** Reports the container sends to its Durable Object. */
export type RunnerEvent =
  | { type: "joining" }
  | { type: "waiting" }
  | { type: "recording"; captureStartedAt: number; consentPosted: boolean }
  | { type: "heartbeat"; participants?: number }
  | ({ type: "ended" } & RecordingEnd);

export interface EventReply {
  /** True once /end was used in Discord; the container leaves the call. */
  stop: boolean;
}
