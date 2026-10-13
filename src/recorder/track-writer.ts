import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BYTES_PER_SAMPLE, SEGMENT_SAMPLES } from "../config.js";
import type { Utterance } from "../storage/manifest.js";

export const segmentPath = (userDir: string, index: number) =>
  join(userDir, `${String(index).padStart(4, "0")}.pcm`);

/**
 * Writes one speaker's audio onto the shared meeting timeline.
 *
 * Discord sends nothing while someone is silent, so each utterance is placed at
 * the sample position matching the wall clock when it started. The gap before it
 * is never written: positional writes leave holes that read back as zeros
 * (sparse files), which keeps silence free on disk and in CPU.
 *
 * Audio is split into fixed segments (5 min) so finished segments can be
 * uploaded to R2 while the meeting is still running.
 */
export class TrackWriter {
  /** Next free sample position on the timeline. */
  cursor = 0;
  private current: Utterance | undefined;
  private readonly fds = new Map<number, number>();
  private readonly touched = new Set<number>();

  constructor(
    readonly userDir: string,
    private readonly onSegmentTouched: (index: number) => void = () => {},
  ) {
    mkdirSync(userDir, { recursive: true });
  }

  get speaking(): boolean {
    return this.current !== undefined;
  }

  /** Start an utterance at the given timeline position (never earlier than what is already written). */
  beginUtterance(expectedSample: number): void {
    if (this.current) this.endUtterance();
    const start = Math.max(this.cursor, Math.floor(expectedSample));
    this.cursor = start;
    this.current = { start, end: start };
  }

  /** Append mono s16le PCM to the current utterance. */
  write(pcm: Buffer): void {
    if (!this.current) this.beginUtterance(this.cursor);
    let offset = 0;
    while (offset < pcm.length) {
      const index = Math.floor(this.cursor / SEGMENT_SAMPLES);
      const posInSeg = this.cursor - index * SEGMENT_SAMPLES;
      const room = (SEGMENT_SAMPLES - posInSeg) * BYTES_PER_SAMPLE;
      const len = Math.min(room, pcm.length - offset);
      writeSync(this.fd(index), pcm, offset, len, posInSeg * BYTES_PER_SAMPLE);
      offset += len;
      this.cursor += len / BYTES_PER_SAMPLE;
    }
    this.current!.end = this.cursor;
  }

  endUtterance(): Utterance | undefined {
    const u = this.current;
    this.current = undefined;
    return u && u.end > u.start ? u : undefined;
  }

  openSegments(): number[] {
    return [...this.fds.keys()];
  }

  touchedSegments(): number[] {
    return [...this.touched].sort((a, b) => a - b);
  }

  /**
   * Close a segment and pad it with silence to `lengthSamples`
   * (a full segment, or less for the meeting's last one). Returns the file path.
   */
  closeSegment(index: number, lengthSamples = SEGMENT_SAMPLES): string {
    const fd = this.fds.get(index);
    const path = segmentPath(this.userDir, index);
    if (fd !== undefined) {
      ftruncateSync(fd, Math.max(0, lengthSamples) * BYTES_PER_SAMPLE);
      closeSync(fd);
      this.fds.delete(index);
    }
    return path;
  }

  closeAll(): void {
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
  }

  private fd(index: number): number {
    let fd = this.fds.get(index);
    if (fd === undefined) {
      const path = segmentPath(this.userDir, index);
      fd = openSync(path, existsSync(path) ? "r+" : "w+");
      this.fds.set(index, fd);
      if (!this.touched.has(index)) {
        this.touched.add(index);
        this.onSegmentTouched(index);
      }
    }
    return fd;
  }
}
