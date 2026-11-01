import { config } from "../config.js";
import type { RecordingJob, RecordingStatus } from "./protocol.js";

/** HTTPS client for the meet-recorder Worker (meet/worker). */
export const meetRecorderConfigured = () => !!config().MEET_RECORDER_URL;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const c = config();
  if (!c.MEET_RECORDER_URL || !c.MEET_RECORDER_TOKEN) throw new Error("Google Meet recording is not configured");
  return fetch(`${c.MEET_RECORDER_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.MEET_RECORDER_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
}

async function check(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export const recorder = {
  async start(id: string, job: RecordingJob): Promise<void> {
    await check(await call("POST", `/recordings/${id}`, job), "starting the Google Meet recorder");
  },
  async status(id: string): Promise<RecordingStatus | undefined> {
    const res = await call("GET", `/recordings/${id}`);
    if (res.status === 404) return undefined;
    await check(res, "reading the Google Meet recorder status");
    return (await res.json()) as RecordingStatus;
  },
  async stop(id: string): Promise<void> {
    const res = await call("POST", `/recordings/${id}/stop`);
    if (res.status !== 404) await check(res, "stopping the Google Meet recorder");
  },
};
