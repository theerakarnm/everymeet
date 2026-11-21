import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/** Keys are kept this long after their occurrence started, far longer than an occurrence stays due. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
const file = () => join(config().DATA_DIR, "calendar-handled.json");

/** Calendar occurrences the bot already acted on (started, refused, or skipped), by key, with their start time. */
export function loadHandled(): Map<string, number> {
  if (!existsSync(file())) return new Map();
  return new Map(Object.entries(JSON.parse(readFileSync(file(), "utf8")) as Record<string, number>));
}

export function saveHandled(handled: Map<string, number>, now: number): void {
  for (const [key, start] of handled) if (start < now - KEEP_MS) handled.delete(key);
  mkdirSync(config().DATA_DIR, { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(handled)));
  renameSync(tmp, file()); // atomic replace
}
