import type { EndReason } from "../../src/meet/protocol.js";

/** What the runner sees in the Meet tab at one moment. */
export interface CallObservation {
  /** The call UI (participant tiles or the self tile) is on screen. */
  inCall: boolean;
  /** An end screen Meet shows after the bot was removed or the call ended. */
  endScreen?: "removed" | "meeting_ended";
  /** Everyone in the call including the bot (People button count); undefined when it could not be read. */
  participants?: number;
}

export interface RuleConfig {
  aloneTimeoutMs: number;
  maxDurationMs: number;
  /** The call UI may vanish briefly while Meet reconnects; only a longer gap ends the recording. */
  lostUiMs: number;
}

export interface RuleState {
  recordingSince: number;
  aloneSince?: number;
  outOfCallSince?: number;
}

/** Decides whether the recording ends now. Keeps its timers in `s`. */
export function nextEnd(
  s: RuleState,
  o: CallObservation,
  now: number,
  stopRequested: boolean,
  c: RuleConfig,
): EndReason | undefined {
  if (stopRequested) return "stopped";
  if (o.endScreen) return o.endScreen;
  if (now - s.recordingSince >= c.maxDurationMs) return "max_duration";
  // Exactly one tile is the bot itself; 0 or unknown means the count is not trustworthy.
  s.aloneSince = o.participants === 1 ? (s.aloneSince ?? now) : undefined;
  if (s.aloneSince !== undefined && now - s.aloneSince >= c.aloneTimeoutMs) return "alone";
  s.outOfCallSince = o.inCall ? undefined : (s.outOfCallSince ?? now);
  if (s.outOfCallSince !== undefined && now - s.outOfCallSince >= c.lostUiMs) return "meeting_ended";
  return undefined;
}
