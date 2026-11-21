import { config } from "../config.js";

/** One email to one recipient. */
export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const FROM_NAME = "บอทบันทึกการประชุม";

/** Resend's error body. */
interface ResendError {
  statusCode?: number;
  name?: string;
  message?: string;
}

/**
 * Sends one email through the Resend REST API. Callers send one email per recipient, so recipients
 * never see each other's addresses and one bad address does not block the rest.
 * Throws when Resend refuses it; the error never contains the API key.
 */
export async function sendEmail(e: Email): Promise<void> {
  const c = config();
  if (!c.RESEND_API_KEY || !c.EMAIL_FROM) throw new Error("email is not configured (RESEND_API_KEY, EMAIL_FROM)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "everymeet-bot/1.0",
    },
    body: JSON.stringify({ from: `${FROM_NAME} <${c.EMAIL_FROM}>`, to: e.to, subject: e.subject, text: e.text, html: e.html }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => undefined)) as ResendError | undefined;
  const why = [body?.name, body?.message].filter(Boolean).join(": ");
  throw new Error(`email to ${e.to} failed: HTTP ${res.status}${why ? ` ${why}` : ""}`);
}
