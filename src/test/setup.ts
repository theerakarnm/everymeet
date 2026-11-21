/**
 * Shared test setup: environment, an in-memory R2, and a scripted OpenRouter.
 * Nothing in the tests talks to Discord, Cloudflare or OpenRouter.
 */
import { mock } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Email } from "../email/send.js";
import type { RecordingJob, RecordingStatus } from "../meet/protocol.js";

export const dataDir = mkdtempSync(join(tmpdir(), "meeting-bot-test-"));

/** Stand-in for the bot account session file; tests check it never leaks into R2. */
export const FAKE_MEET_AUTH = '{"cookies":[{"name":"SID","value":"fake-session-cookie"}],"origins":[]}';
writeFileSync(join(dataDir, "meet-auth.json"), FAKE_MEET_AUTH);

Object.assign(process.env, {
  DISCORD_TOKEN: "x",
  DISCORD_CLIENT_ID: "x",
  R2_ACCOUNT_ID: "x",
  R2_ACCESS_KEY_ID: "x",
  R2_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  OPENROUTER_API_KEY: "x",
  PUBLIC_BASE_URL: "https://meet.example.com",
  SESSION_SECRET: "s".repeat(40),
  DATA_DIR: dataDir,
  MEET_RECORDER_URL: "https://meet-recorder.example.com",
  MEET_RECORDER_TOKEN: "m".repeat(40),
  MEET_AUTH_STATE_FILE: join(dataDir, "meet-auth.json"),
  ALLOWED_EMAILS: "@example.com, @planthia.test",
  MEET_BOT_EMAIL: "bot@example.com",
  CALENDAR_ICAL_URL: "https://calendar.example.com/calendar/ical/bot/private-secret/basic.ics",
  RESEND_API_KEY: `re_${"e".repeat(40)}`,
  EMAIL_FROM: "minutes@example.com",
  API_KEYS: `service:${"k".repeat(40)},ops:${"o".repeat(40)}`,
  // The example secret of the Standard Webhooks specification: a public test value.
  WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  WEBHOOK_URL: "https://service.example.com/hooks/everymeet",
  WEBHOOK_ALLOWED_ORIGINS: "https://other.example.com",
});

/** Objects "uploaded" to R2, by key. */
export const r2 = new Map<string, Buffer>();
export const r2Text = (key: string) => r2.get(key)?.toString("utf8");

/** Replaces the R2 client with an in-memory bucket. Call before importing code that uses it. */
export function mockR2(opts: { failPuts?: () => boolean } = {}): void {
  const put = (key: string, body: Buffer) => {
    if (opts.failPuts?.()) throw new Error("R2 unavailable");
    r2.set(key, body);
  };
  mock.module(new URL("../storage/r2.js", import.meta.url).href, {
    namedExports: {
      putFile: async (key: string, path: string) => put(key, readFileSync(path)),
      putText: async (key: string, body: string) => put(key, Buffer.from(body, "utf8")),
      getText: async (key: string) => r2Text(key),
      downloadTo: async (key: string, path: string) => {
        const body = r2.get(key);
        if (!body) throw new Error(`NoSuchKey ${key}`);
        writeFileSync(path, body);
      },
      presign: async (key: string) => `https://r2.example.com/${key}?X-Amz-Signature=test`,
    },
  });
}

/** Emails "sent" through the fake sender, oldest first. */
export const sentEmails: Email[] = [];

/**
 * Replaces the Resend email sender. Call before importing code that sends email.
 * `fail` makes sends to matching addresses throw like a refused send.
 */
export function mockEmail(opts: { fail?: (to: string) => boolean } = {}): void {
  mock.module(new URL("../email/send.js", import.meta.url).href, {
    namedExports: {
      sendEmail: async (e: Email) => {
        if (opts.fail?.(e.to)) throw new Error(`email to ${e.to} failed: HTTP 400 validation_error: Invalid \`to\` field.`);
        sentEmails.push(e);
      },
    },
  });
}

export interface SentWebhook {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Webhook attempts that reached the fake sender, oldest first. */
export const sentWebhooks: SentWebhook[] = [];

/**
 * Replaces the webhook sender. Call before importing code that delivers webhooks.
 * `status` answers each attempt (default 200); throwing from it fakes a network error.
 */
export function mockWebhooks(opts: { status?: (w: SentWebhook) => number } = {}): void {
  mock.module(new URL("../api/webhook-send.js", import.meta.url).href, {
    namedExports: {
      postWebhook: async (url: string, headers: Record<string, string>, body: string) => {
        const w = { url, headers, body };
        sentWebhooks.push(w);
        return opts.status?.(w) ?? 200;
      },
    },
  });
}

export interface OpenRouterCall {
  path: string;
  body: any;
}

/**
 * Replaces fetch with a scripted OpenRouter. The handler returns a Response for each call;
 * returns the list of calls so tests can check which models were used.
 */
export function mockOpenRouter(handler: (call: OpenRouterCall) => Response | Promise<Response>): OpenRouterCall[] {
  const calls: OpenRouterCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { path: new URL(url).pathname.replace("/api/v1", ""), body: JSON.parse(String(init.body)) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

export const chatReply = (text: string) => Response.json({ choices: [{ message: { content: text } }] });

/** Lets queued promise callbacks and I/O run (timers stay frozen under mock.timers). */
export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

export interface FakeRecording {
  job: RecordingJob;
  status: RecordingStatus;
  stopped: boolean;
}

/**
 * Replaces fetch with a scripted meet-recorder Worker (meet/worker). Tests move a recording along by
 * editing `recordings.get(id).status`; `down` makes every call fail like a network error.
 */
export function fakeMeetRecorder() {
  const fake = {
    recordings: new Map<string, FakeRecording>(),
    authorizations: [] as string[],
    /** "<METHOD> <path>" of every call that reached the fake. */
    requests: [] as string[],
    down: false,
    failStart: false,
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (fake.down) throw new TypeError("fetch failed");
    fake.authorizations.push(new Headers(init.headers).get("authorization") ?? "");
    fake.requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    const [, , id, action] = new URL(url).pathname.split("/");
    const rec = fake.recordings.get(id!);
    if (init.method === "POST" && action === undefined) {
      if (fake.failStart) return new Response("no container instance available", { status: 500 });
      fake.recordings.set(id!, { job: JSON.parse(String(init.body)), status: { state: "starting", segments: [] }, stopped: false });
      return new Response(null, { status: 202 });
    }
    if (!rec) return new Response("not found", { status: 404 });
    if (init.method === "POST" && action === "stop") {
      rec.stopped = true;
      return new Response(null, { status: 202 });
    }
    return Response.json(rec.status);
  }) as typeof fetch;
  return fake;
}
