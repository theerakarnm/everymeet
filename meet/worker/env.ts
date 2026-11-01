import type { MeetRecorder } from "./recorder.js";

export interface Env {
  MEET_RECORDER: DurableObjectNamespace<MeetRecorder>;
  BUCKET: R2Bucket;
  /** Shared with the bot as MEET_RECORDER_TOKEN; set with `wrangler secret put RECORDER_TOKEN`. */
  RECORDER_TOKEN?: string;
}
