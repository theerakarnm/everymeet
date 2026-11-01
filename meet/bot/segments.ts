import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const BYTES_PER_SAMPLE = 2;

export interface FinishedSegment {
  index: number;
  path: string;
  samples: number;
}

/**
 * Cuts a continuous mono s16le stream into raw files of exactly `segmentSamples` samples (the last one
 * shorter), so segment i starts at sample i * segmentSamples of the capture.
 */
export class SegmentSplitter {
  private index = 0;
  private fd?: number;
  /** Bytes written to the segment in progress. */
  private written = 0;

  constructor(
    private readonly dir: string,
    private readonly segmentSamples: number,
    private readonly onSegment: (s: FinishedSegment) => void,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  write(chunk: Buffer): void {
    const size = this.segmentSamples * BYTES_PER_SAMPLE;
    let offset = 0;
    while (offset < chunk.length) {
      this.fd ??= openSync(this.path(), "w");
      const n = Math.min(size - this.written, chunk.length - offset);
      writeSync(this.fd, chunk, offset, n);
      this.written += n;
      offset += n;
      if (this.written === size) this.close();
    }
  }

  /** Closes the segment in progress; a trailing half sample is dropped. */
  finish(): void {
    if (this.fd !== undefined) this.close();
  }

  private path(): string {
    return join(this.dir, `${String(this.index).padStart(4, "0")}.pcm`);
  }

  private close(): void {
    closeSync(this.fd!);
    this.fd = undefined;
    const segment = { index: this.index, path: this.path(), samples: Math.floor(this.written / BYTES_PER_SAMPLE) };
    this.index++;
    this.written = 0;
    if (segment.samples > 0) this.onSegment(segment);
    else unlinkSync(segment.path);
  }
}
