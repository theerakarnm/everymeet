import { spawn } from "node:child_process";

/** Run ffmpeg with the given args; rejects with the stderr tail on failure. */
export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/** Input args for a raw 24 kHz mono s16le file. */
export const rawInput = (path: string) => ["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", path];
