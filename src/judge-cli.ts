/**
 * Judge entry point for the migration: reprocess an already-recorded meeting
 * through the real pipeline without Discord, then dump the minutes message.
 * Usage: node --import tsx src/judge-cli.ts process <meetingId>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { loadLocal, saveEverywhere } from "./storage/manifest.js";
import { buildMinutesMessage } from "./pipeline/publish.js";
import { runPipeline } from "./pipeline/run.js";
import { logger } from "./util/log.js";

const log = logger("judge-cli");

const [cmd, meetingId] = process.argv.slice(2);
if (cmd !== "process" || !meetingId) {
  log.error("usage: node --import tsx src/judge-cli.ts process <meetingId>");
  process.exit(2);
}
const pin = process.env.JUDGE_PIN ?? "";
if (!/^\d{6}$/.test(pin)) {
  log.error("JUDGE_PIN must be a 6-digit PIN");
  process.exit(2);
}

const m = loadLocal(meetingId);
if (!m) {
  log.error(`no local meeting ${meetingId} under ${config().DATA_DIR}`);
  process.exit(1);
}

const result = await runPipeline(m, pin);
m.status = "done";
await saveEverywhere(m);

const message = buildMinutesMessage(m, {
  pin,
  shortSummary: result.shortSummary,
  fullSummary: result.fullSummary,
  transcript: result.transcript,
  note: result.notes.join(" / ") || undefined,
});
writeFileSync(join(config().DATA_DIR, "judge-publish.json"), JSON.stringify(message, null, 2));
log.info(`${m.id}: judge-publish.json written`);
