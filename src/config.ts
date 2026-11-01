import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Empty values in .env mean "not set". */
const blank = (v: unknown) => (v === "" ? undefined : v);

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  /** Optional: register commands to one guild instantly instead of globally. */
  DISCORD_GUILD_ID: z.string().optional(),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),

  OPENROUTER_API_KEY: z.string().min(1),
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

  /** Origin of the meet-recorder Worker (meet/). /record-meet is off when unset. */
  MEET_RECORDER_URL: z.preprocess(blank, z.url().optional()),
  /** Same value as the Worker secret RECORDER_TOKEN. */
  MEET_RECORDER_TOKEN: z.preprocess(blank, z.string().min(32).optional()),
  /** Playwright storageState of the bot's Google account (npm run meet:login in meet/). Unset = join as a guest. */
  MEET_AUTH_STATE_FILE: z.preprocess(blank, z.string().optional()),
  /** A Google Meet recording ends after this many minutes; the Worker refuses more than 6 h. */
  MEET_MAX_DURATION_MIN: z.coerce.number().positive().max(360).default(240),
}).refine((c) => !c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, {
  message: "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together",
  path: ["MEET_RECORDER_TOKEN"],
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
