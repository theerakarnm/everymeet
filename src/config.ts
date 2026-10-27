import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  /** Optional: register commands to one guild instantly instead of globally. */
  DISCORD_GUILD_ID: z.string().optional(),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  /** Optional S3 endpoint override (tests, local fakes). Default is the R2 account endpoint. */
  R2_ENDPOINT: z.url().optional(),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  TRANSCRIBE_MODEL_PRIMARY: z.string().default("microsoft/mai-transcribe-2"),
  TRANSCRIBE_MODEL_FALLBACK: z.string().default("google/gemini-3.5-transcribe"),
  SUMMARY_MODEL_PRIMARY: z.string().default("anthropic/claude-sonnet-5.5"),
  SUMMARY_MODEL_FALLBACK: z.string().default("openai/gpt-6.1-sol-pro"),
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  /** Public HTTPS origin of the playback page, e.g. https://meet.example.com */
  PUBLIC_BASE_URL: z.url(),
  WEB_PORT: z.coerce.number().int().default(8787),
  /** Long random string used to sign playback cookies. */
  SESSION_SECRET: z.string().min(32),
  /** Set true when running behind Nginx so the client IP is read from X-Forwarded-For. */
  TRUST_PROXY: bool,

  DATA_DIR: z.string().default("./data"),
  MINUTES_CHANNEL_NAME: z.string().default("meeting-of-minutes"),
  FALLBACK_CHANNEL_NAME: z.string().default("general"),
  /** Minutes of recording before the "continue?" prompt. */
  CONTINUE_PROMPT_AFTER_MIN: z.coerce.number().positive().default(120),
  /** Minutes to wait for a click before ending automatically. */
  CONTINUE_PROMPT_TIMEOUT_MIN: z.coerce.number().positive().default(5),
  /** Minutes the voice channel may stay empty before ending automatically. */
  EMPTY_CHANNEL_TIMEOUT_MIN: z.coerce.number().positive().default(3),
  /** Delete the local working folder after a meeting is posted. */
  CLEANUP_LOCAL: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Audio format used everywhere: 24 kHz mono signed 16-bit little endian. */
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SAMPLE = 2;
/** Recording is cut into 5-minute segments that are uploaded to R2 while the meeting runs. */
export const SEGMENT_SECONDS = 300;
export const SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS;
