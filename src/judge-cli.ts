/**
 * Judge entry point for the migration: reprocess an already-recorded meeting
 * through the real pipeline without Discord, then dump the minutes message,
 * plus the small pure helpers the judge scenarios compare across implementations.
 * Usage: node --import tsx src/judge-cli.ts <command> ...
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { SESSION_ID_RE, signAccess, verifyAccess, verifyPin } from "./util/pin.js";
import { bangkokDateTime, durationTh } from "./util/time.js";
import { loadLocal, saveEverywhere, saveLocal, unfinishedLocal, type Manifest } from "./storage/manifest.js";
import { buildMinutesMessage } from "./pipeline/publish.js";
import { closeAtHeartbeat, runPipeline, type PipelineResult } from "./pipeline/run.js";
import { logger } from "./util/log.js";

const log = logger("judge-cli");

const usage: () => never = () => {
  log.error("usage: node --import tsx src/judge-cli.ts process <meetingId>");
  log.error("       node --import tsx src/judge-cli.ts recover [meetingId]");
  log.error("       node --import tsx src/judge-cli.ts verify-pin <pin> <salt> <hash>");
  log.error("       node --import tsx src/judge-cli.ts sign-access <meetingId> <secret> <ttlMs>");
  log.error("       node --import tsx src/judge-cli.ts verify-access <meetingId> <value> <secret>");
  log.error("       node --import tsx src/judge-cli.ts bangkok <ms> | duration <seconds>");
  process.exit(2);
};

const meetingId = (raw: string | undefined): string => {
  if (!raw || !SESSION_ID_RE.test(raw)) usage();
  return raw;
};

const judgePin = (): string => {
  const pin = process.env.JUDGE_PIN ?? "";
  if (!/^\d{6}$/.test(pin)) {
    log.error("JUDGE_PIN must be a 6-digit PIN");
    process.exit(2);
  }
  return pin;
};

const writePublish = (m: Manifest, pin: string, result: PipelineResult): void => {
  const message = buildMinutesMessage(m, {
    pin,
    shortSummary: result.shortSummary,
    fullSummary: result.fullSummary,
    transcript: result.transcript,
    note: result.notes.join(" / ") || undefined,
  });
  writeFileSync(join(config().DATA_DIR, "judge-publish.json"), JSON.stringify(message, null, 2));
  log.info(`${m.id}: judge-publish.json written`);
};

const runMeeting = async (m: Manifest, pin: string): Promise<void> => {
  const result = await runPipeline(m, pin);
  m.status = "done";
  await saveEverywhere(m);
  writePublish(m, pin, result);
};

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "process": {
    const m = loadLocal(meetingId(args[0]));
    if (!m) {
      log.error(`no local meeting ${args[0]} under ${config().DATA_DIR}`);
      process.exit(1);
    }
    await runMeeting(m, judgePin());
    break;
  }
  case "recover": {
    const pin = judgePin();
    const meetings = args[0] ? [loadLocal(meetingId(args[0]))].filter((m): m is Manifest => !!m) : unfinishedLocal();
    if (meetings.length === 0) {
      log.error(`no unfinished local meetings under ${config().DATA_DIR}`);
      process.exit(1);
    }
    for (const m of meetings) {
      if (m.status === "recording") {
        closeAtHeartbeat(m);
        saveLocal(m);
        log.warn(`recovering ${m.id}: closed at last heartbeat`);
      }
      await runMeeting(m, pin);
    }
    break;
  }
  case "verify-pin": {
    const [pin, salt, hash] = args;
    if (!pin || !salt || !hash) usage();
    const ok = verifyPin(pin, salt, hash);
    console.log(ok ? "ok" : "fail");
    process.exitCode = ok ? 0 : 1;
    break;
  }
  case "sign-access": {
    const id = meetingId(args[0]);
    const [secret, ttl] = [args[1], args[2]];
    if (!secret || !ttl || !Number.isFinite(Number(ttl))) usage();
    console.log(signAccess(id, secret, Number(ttl)));
    break;
  }
  case "verify-access": {
    const id = meetingId(args[0]);
    const [value, secret] = [args[1], args[2]];
    if (!value || !secret) usage();
    const ok = verifyAccess(id, value, secret);
    console.log(ok ? "ok" : "fail");
    process.exitCode = ok ? 0 : 1;
    break;
  }
  case "bangkok": {
    if (!args[0] || !Number.isFinite(Number(args[0]))) usage();
    console.log(bangkokDateTime(Number(args[0])));
    break;
  }
  case "duration": {
    if (!args[0] || !Number.isFinite(Number(args[0]))) usage();
    console.log(durationTh(Number(args[0])));
    break;
  }
  default:
    usage();
}
