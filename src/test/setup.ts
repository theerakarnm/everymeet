/**
 * Shared test setup: environment, an in-memory R2, and a scripted OpenRouter.
 * Nothing in the tests talks to Discord, Cloudflare or OpenRouter.
 */
import { mock } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dataDir = mkdtempSync(join(tmpdir(), "meeting-bot-test-"));

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
});

const realR2 = await import("../storage/r2.js");

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
      keys: realR2.keys,
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
