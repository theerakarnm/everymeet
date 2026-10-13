import { existsSync, statSync, unlinkSync } from "node:fs";
import { ffmpeg, rawInput } from "../util/ffmpeg.js";
import { logger } from "../util/log.js";
import { keys, putFile } from "../storage/r2.js";
import { saveEverywhere, type Manifest } from "../storage/manifest.js";

const log = logger("segments");

/**
 * Uploads finished 5-minute segments to R2 as FLAC, one at a time, so a crash
 * or a dead disk loses at most the segment in progress. Local PCM files are
 * kept: they are what the final processing reads first.
 */
export class SegmentUploader {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly manifest: Manifest) {}

  enqueue(userId: string, index: number, rawPath: string): void {
    this.chain = this.chain.then(() => this.upload(userId, index, rawPath));
  }

  /** Resolves when everything queued so far is uploaded (or has failed and been logged). */
  drain(): Promise<void> {
    return this.chain;
  }

  private async upload(userId: string, index: number, rawPath: string): Promise<void> {
    const participant = this.manifest.participants[userId];
    if (!participant || participant.uploaded.includes(index)) return;
    if (!existsSync(rawPath) || statSync(rawPath).size === 0) return;
    const flac = `${rawPath}.flac`;
    try {
      await ffmpeg([...rawInput(rawPath), "-c:a", "flac", flac]);
      await putFile(keys.segment(this.manifest.id, userId, index), flac, "audio/flac");
      participant.uploaded.push(index);
      await saveEverywhere(this.manifest);
    } catch (err) {
      // Not fatal: the local copy is still used at the end of the meeting.
      log.warn(`upload failed for ${this.manifest.id} user ${userId} segment ${index}`, err);
    } finally {
      if (existsSync(flac)) unlinkSync(flac);
    }
  }
}
