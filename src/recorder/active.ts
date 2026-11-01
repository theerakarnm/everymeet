import type { Manifest } from "../storage/manifest.js";

/** A recording in progress, from a Discord voice channel or a Google Meet call. */
export interface ActiveRecording {
  readonly manifest: Manifest;
  readonly id: string;
  /**
   * Stop recording. A Discord recording is handed to processing before this resolves;
   * a Google Meet recording is handed over once its recorder reports the end.
   */
  end(reason: string): Promise<void>;
  /** The bot process is about to exit. */
  shutdown(): Promise<void>;
}

/** One active recording per guild, whatever its source (storage keys and the bot's voice slot assume it). */
export const activeSessions = new Map<string, ActiveRecording>();
