import { createHmac, timingSafeEqual } from "node:crypto";

/** Receivers refuse a webhook whose timestamp is further than this from their clock (replay protection). */
export const TOLERANCE_SEC = 300;

const keyOf = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ""), "base64");

/** The Standard Webhooks "v1," signature of one delivery attempt: HMAC-SHA256 over "<id>.<timestamp>.<body>", base64. */
export function signWebhook(secret: string, id: string, timestampSec: number, body: string): string {
  return `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestampSec}.${body}`).digest("base64")}`;
}

/** Headers of one attempt; the id stays the same on every retry, the timestamp is the attempt's. */
export function webhookHeaders(secret: string, id: string, body: string, nowSec: number): Record<string, string> {
  return { "webhook-id": id, "webhook-timestamp": String(nowSec), "webhook-signature": signWebhook(secret, id, nowSec, body) };
}

/** What a receiver does (used by tests and shown in docs/api.md): any listed v1 signature matches, and the time is close. */
export function verifyWebhook(secret: string, h: { id: string; timestamp: string; signature: string }, body: string, nowSec: number): boolean {
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return false;
  const expected = Buffer.from(signWebhook(secret, h.id, ts, body));
  return h.signature.split(" ").some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
