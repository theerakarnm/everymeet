import { config } from "../config.js";
import { sleep } from "../util/time.js";
import { logger } from "../util/log.js";

const log = logger("openrouter");
const BASE = "https://openrouter.ai/api/v1";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

const retryable = (err: unknown) =>
  !(err instanceof HttpError) || err.status === 408 || err.status === 429 || err.status >= 500;

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!retryable(err) || i === attempts - 1) break;
      const wait = [2_000, 6_000, 15_000][i] ?? 15_000;
      log.warn(`${label} failed (attempt ${i + 1}), retrying in ${wait / 1000}s: ${(err as Error).message}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function post(path: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config().OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Meeting Minutes Bot",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text);
}

export interface SttSegment {
  start: number;
  end: number;
  text: string;
}

export interface SttResult {
  model: string;
  text: string;
  /** Seconds relative to the start of the uploaded audio; missing when the model has no timestamps. */
  segments?: SttSegment[];
}

async function sttOnce(model: string, wavBase64: string): Promise<SttResult> {
  const request = (verbose: boolean) =>
    withRetry(`stt ${model}`, () =>
      post(
        "/audio/transcriptions",
        {
          model,
          input_audio: { data: wavBase64, format: "wav" },
          ...(verbose ? { response_format: "verbose_json", timestamp_granularities: ["segment"] } : {}),
        },
        180_000,
      ),
    );
  let json: any;
  try {
    json = await request(true);
  } catch (err) {
    // Some models reject verbose_json; plain text still works, only timestamps are coarser.
    if (err instanceof HttpError && err.status === 400) json = await request(false);
    else throw err;
  }
  const segments = Array.isArray(json.segments)
    ? (json.segments as any[])
        .filter((s) => typeof s?.start === "number" && typeof s?.text === "string")
        .map((s) => ({ start: s.start, end: s.end ?? s.start, text: s.text }))
    : undefined;
  return { model, text: String(json.text ?? ""), segments: segments?.length ? segments : undefined };
}

/** Transcribe a WAV clip with the primary model, falling back to the second one. */
export async function transcribe(wav: Buffer): Promise<SttResult> {
  const c = config();
  const data = wav.toString("base64");
  const errors: string[] = [];
  for (const model of [c.TRANSCRIBE_MODEL_PRIMARY, c.TRANSCRIBE_MODEL_FALLBACK]) {
    try {
      return await sttOnce(model, data);
    } catch (err) {
      errors.push(`${model}: ${(err as Error).message}`);
      log.warn(`transcription with ${model} failed`, err);
    }
  }
  throw new Error(`All transcription models failed. ${errors.join(" | ")}`);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Chat completion with the primary summary model, falling back to the second one. */
export async function chat(messages: ChatMessage[], maxTokens: number): Promise<{ model: string; text: string }> {
  const c = config();
  const errors: string[] = [];
  for (const model of [c.SUMMARY_MODEL_PRIMARY, c.SUMMARY_MODEL_FALLBACK]) {
    try {
      const json = await withRetry(`chat ${model}`, () =>
        post("/chat/completions", { model, messages, max_tokens: maxTokens }, 600_000),
      );
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("empty response");
      return { model, text: text.trim() };
    } catch (err) {
      errors.push(`${model}: ${(err as Error).message}`);
      log.warn(`summary with ${model} failed`, err);
    }
  }
  throw new Error(`All summary models failed. ${errors.join(" | ")}`);
}
