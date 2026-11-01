import { readFileSync } from "node:fs";
import { CALLBACK_HOST, type EventReply, type RunnerEvent } from "../../src/meet/protocol.js";
import { sleep } from "./human.js";

/** Plain http: interceptOutboundHttp hands these requests to this recording's Durable Object. */
const ORIGIN = `http://${CALLBACK_HOST}`;

async function send(path: string, init: RequestInit, attempts: number): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${ORIGIN}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} for ${path}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err;
    }
    if (i < attempts - 1) await sleep(1_000 * 2 ** i);
  }
  throw last;
}

export async function sendEvent(e: RunnerEvent): Promise<EventReply> {
  const res = await send(
    "/event",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) },
    e.type === "ended" ? 5 : 2,
  );
  return (await res.json()) as EventReply;
}

export async function uploadSegment(index: number, samples: number, flacPath: string): Promise<void> {
  await send(
    `/segments/${index}`,
    { method: "PUT", headers: { "content-type": "audio/flac", "x-samples": String(samples) }, body: readFileSync(flacPath) },
    5,
  );
}

export async function uploadDebug(name: string, png: Buffer): Promise<void> {
  await send(`/debug/${name}`, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(png) }, 1);
}
