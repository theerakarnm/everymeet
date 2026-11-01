import {
  MEET_PARTICIPANT_ID,
  type EventReply,
  type RecordingJob,
  type RecordingStatus,
  type RunnerEvent,
} from "../../src/meet/protocol.js";
import { keys } from "../../src/storage/keys.js";

/** The Durable Object methods the HTTP layer calls; a plain interface so tests can fake it. */
export interface RecorderApi {
  start(id: string, job: RecordingJob): Promise<"started" | "exists">;
  status(): Promise<RecordingStatus | undefined>;
  stop(): Promise<boolean>;
  event(e: RunnerEvent): Promise<EventReply>;
  segmentStored(index: number, samples: number): Promise<void>;
}

/** Writes one object to the R2 bucket. */
export type Store = (key: string, body: ArrayBuffer, contentType: string) => Promise<void>;

/** Cost cap on the Worker side, whatever the bot asks for. */
export const MAX_RECORDING_MS = 6 * 60 * 60_000;
const MAX_ADMIT_MS = 15 * 60_000;

/** Recording ids become Durable Object names and R2 key parts. */
const ID_RE = /^[\w-]{1,64}$/;
const MAX_EVENT_BYTES = 16 * 1024;
/** A 5-minute 24 kHz mono segment is at most 14.4 MB even uncompressed. */
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_DEBUG_BYTES = 4 * 1024 * 1024;

const text = (body: string, status: number) => new Response(body, { status });

/** Constant-time string comparison that also runs under Node (crypto.subtle.timingSafeEqual is Workers-only). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** The bot (VPS) side: start, poll, and stop recordings. */
export async function handleApi(
  request: Request,
  token: string | undefined,
  recorder: (id: string) => RecorderApi,
): Promise<Response> {
  if (!token || !sameSecret(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
    return text("unauthorized", 401);
  }
  const [, root, id, action, extra] = new URL(request.url).pathname.split("/");
  if (root !== "recordings" || !id || !ID_RE.test(id) || extra !== undefined) return text("not found", 404);
  const r = recorder(id);
  if (request.method === "POST" && action === undefined) {
    const job = (await request.json()) as RecordingJob;
    if (typeof job?.meetUrl !== "string" || !job.meetUrl.startsWith("https://meet.google.com/")) {
      return text("meetUrl must be a https://meet.google.com/ link", 400);
    }
    if (!(job.maxDurationMs > 0 && job.maxDurationMs <= MAX_RECORDING_MS && job.admitTimeoutMs > 0 && job.admitTimeoutMs <= MAX_ADMIT_MS)) {
      return text("maxDurationMs must be at most 6 h and admitTimeoutMs at most 15 min", 400);
    }
    return (await r.start(id, job)) === "started" ? new Response(null, { status: 202 }) : text("exists", 409);
  }
  if (request.method === "GET" && action === undefined) {
    const status = await r.status();
    return status ? Response.json(status) : text("not found", 404);
  }
  if (request.method === "POST" && action === "stop") {
    return (await r.stop()) ? new Response(null, { status: 202 }) : text("not found", 404);
  }
  return text("not found", 404);
}

/** Reads a body after checking its declared size, so an oversized upload is refused before it is buffered. */
async function boundedBody(request: Request, max: number): Promise<ArrayBuffer | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  const body = await request.arrayBuffer();
  return body.byteLength > max ? undefined : body;
}

/**
 * The container side: requests the runner sends to http://meet-recorder.internal, which
 * interceptOutboundHttp routes here. Only that one container can reach this, so there is no token.
 */
export async function handleCallback(request: Request, id: string, r: RecorderApi, store: Store): Promise<Response> {
  const [, root, name, extra] = new URL(request.url).pathname.split("/");
  if (extra !== undefined) return text("not found", 404);
  if (request.method === "POST" && root === "event" && name === undefined) {
    const body = await request.text();
    if (body.length > MAX_EVENT_BYTES) return text("too large", 413);
    return Response.json(await r.event(JSON.parse(body) as RunnerEvent));
  }
  if (request.method === "PUT" && root === "segments" && /^\d{1,5}$/.test(name ?? "")) {
    const samples = Number(request.headers.get("x-samples"));
    if (!Number.isInteger(samples) || samples <= 0) return text("x-samples header required", 400);
    const body = await boundedBody(request, MAX_SEGMENT_BYTES);
    if (!body) return text("too large", 413);
    await store(keys.segment(id, MEET_PARTICIPANT_ID, Number(name)), body, "audio/flac");
    await r.segmentStored(Number(name), samples);
    return new Response(null, { status: 204 });
  }
  if (request.method === "PUT" && root === "debug" && /^[\w.-]{1,64}$/.test(name ?? "")) {
    const body = await boundedBody(request, MAX_DEBUG_BYTES);
    if (!body) return text("too large", 413);
    await store(keys.debug(id, name!), body, "image/png");
    return new Response(null, { status: 204 });
  }
  return text("not found", 404);
}
