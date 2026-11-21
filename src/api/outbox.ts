import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../util/log.js";
import { webhookHeaders } from "./signature.js";
import { postWebhook } from "./webhook-send.js";

const log = logger("webhooks");
/** Wait after failed attempt 1, 2, ...; the attempt after the last wait is the last one (8 in about 22 hours). */
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
const TICK_MS = 15_000;

/** One event waiting for delivery; its body is fixed when queued, so every retry sends the same bytes. */
export interface OutboxEntry {
  /** Standard Webhooks message id ("webhook-id"), the receiver's idempotency key. */
  id: string;
  url: string;
  type: string;
  body: string;
  attempts: number;
  nextAt: number;
  createdAt: number;
}

const dir = (sub: "pending" | "failed") => join(config().DATA_DIR, "webhooks", sub);
const origin = (url: string) => new URL(url).origin;

function write(e: OutboxEntry): void {
  mkdirSync(dir("pending"), { recursive: true });
  const tmp = join(dir("pending"), `${e.id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(e));
  renameSync(tmp, join(dir("pending"), `${e.id}.json`)); // atomic replace
}

/** Queues one event. It is on disk before anything is sent, so a crash or restart does not lose it. */
export function enqueueWebhook(url: string, type: string, data: unknown, now = Date.now()): OutboxEntry {
  const e: OutboxEntry = {
    id: `msg_${randomBytes(16).toString("base64url")}`,
    url,
    type,
    body: JSON.stringify({ type, timestamp: new Date(now).toISOString(), data }),
    attempts: 0,
    nextAt: now,
    createdAt: now,
  };
  write(e);
  return e;
}

/** Events not delivered yet, oldest first. */
export function pendingWebhooks(): OutboxEntry[] {
  if (!existsSync(dir("pending"))) return [];
  const out: OutboxEntry[] = [];
  for (const f of readdirSync(dir("pending")).filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(dir("pending"), f), "utf8")) as OutboxEntry);
    } catch (err) {
      // One damaged file must not stop every other delivery.
      mkdirSync(dir("failed"), { recursive: true });
      renameSync(join(dir("pending"), f), join(dir("failed"), f));
      log.error(`webhook file ${f} is not valid JSON; moved to webhooks/failed/`, err);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

let delivering = false;

/**
 * Sends every due event, oldest first, one at a time; skipped while the previous run still goes.
 * Takes a clock, not a time: a long backlog must sign each attempt with its own time (receivers allow 5 minutes).
 */
export async function deliverDue(clock: () => number = Date.now): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    for (const e of pendingWebhooks()) {
      const now = clock();
      if (e.nextAt <= now) await attempt(e, now);
    }
  } finally {
    delivering = false;
  }
}

async function attempt(e: OutboxEntry, now: number): Promise<void> {
  let status: number | undefined;
  let why: string;
  try {
    status = await postWebhook(e.url, webhookHeaders(config().WEBHOOK_SECRET!, e.id, e.body, Math.floor(now / 1000)), e.body);
    why = `HTTP ${status}`;
  } catch (err) {
    why = (err as Error).message;
  }
  if (status !== undefined && status >= 200 && status < 300) {
    rmSync(join(dir("pending"), `${e.id}.json`), { force: true });
    log.info(`webhook ${e.type} ${e.id} delivered to ${origin(e.url)}`);
    return;
  }
  e.attempts++;
  const wait = RETRY_DELAYS_MS[e.attempts - 1];
  if (wait === undefined) {
    mkdirSync(dir("failed"), { recursive: true });
    renameSync(join(dir("pending"), `${e.id}.json`), join(dir("failed"), `${e.id}.json`));
    log.error(`webhook ${e.type} ${e.id} to ${origin(e.url)} given up after ${e.attempts} attempts (${why}); kept in webhooks/failed/`);
    return;
  }
  e.nextAt = now + wait;
  write(e);
  log.warn(`webhook ${e.type} ${e.id} to ${origin(e.url)} failed (${why}), attempt ${e.attempts}, next in ${wait / 1000} s`);
}

/** Delivers queued events every 15 s, starting with what a previous run left. */
export function startOutbox(): void {
  const run = () => void deliverDue().catch((err) => log.error("webhook delivery failed", err));
  run();
  setInterval(run, TICK_MS).unref();
}
