import { z } from "zod";
import { parseApiKeys } from "./api/clients.js";
import { parseOrigins, webhookProtocolOk } from "./api/webhook-url.js";
import { invalidAllowlistEntries, parseAllowlist } from "./util/email.js";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Empty values in .env mean "not set". */
const blank = (v: unknown) => (v === "" ? undefined : v);

const schema = z.object({
  /** Discord /record. Off when unset; set both together. */
  DISCORD_TOKEN: z.preprocess(blank, z.string().min(1).optional()),
  DISCORD_CLIENT_ID: z.preprocess(blank, z.string().min(1).optional()),
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

  /** Origin of the meet-recorder Worker (meet/). Google Meet recording is off when unset. */
  MEET_RECORDER_URL: z.preprocess(blank, z.url().optional()),
  /** Same value as the Worker secret RECORDER_TOKEN. */
  MEET_RECORDER_TOKEN: z.preprocess(blank, z.string().min(32).optional()),
  /** Playwright storageState of the bot's Google account (npm run meet:login in meet/). Unset = join as a guest. */
  MEET_AUTH_STATE_FILE: z.preprocess(blank, z.string().optional()),
  /** A Google Meet recording ends after this many minutes; the Worker refuses more than 6 h. */
  MEET_MAX_DURATION_MIN: z.coerce.number().positive().max(360).default(240),
  /** Who may sign in on /meet and whose calendar events are recorded: addresses and whole domains as "@example.com", comma separated. */
  ALLOWED_EMAILS: z.preprocess(blank, z.string().optional()).transform(parseAllowlist),
  /** Login emails in 24 hours, all addresses together, so the Resend quota is left for the minutes. */
  MEET_LOGIN_MAIL_DAILY_CAP: z.coerce.number().int().min(1).default(300),
  /** The bot Google account people invite; it never gets the minutes. Needed for calendar starts. */
  MEET_BOT_EMAIL: z.preprocess(blank, z.email().optional()).transform((v) => v?.toLowerCase()),
  /** The bot account's "Secret address in iCal format". A secret: never log it. Calendar starts are off when unset. */
  CALENDAR_ICAL_URL: z.preprocess(blank, z.url().optional()),
  /** Resend API key with "Sending access" for the sender's domain. A secret: never log it. */
  RESEND_API_KEY: z.preprocess(blank, z.string().startsWith("re_").optional()),
  /** Sender on a domain verified in Resend, e.g. minutes@mail.example.com. */
  EMAIL_FROM: z.preprocess(blank, z.email().optional()),
  /** API clients as name:key pairs, comma separated; a name may appear twice to rotate its key. /api/v1 is off when unset. Secrets: never log them. */
  API_KEYS: z.preprocess(blank, z.string().optional()).transform(parseApiKeys),
  /** Requests per minute for each API client. */
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  /** Standard Webhooks signing secret: "whsec_" and base64 (echo "whsec_$(openssl rand -base64 32)"). A secret: never log it. */
  WEBHOOK_SECRET: z.preprocess(blank, z.string().regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/).optional()),
  /** Where webhooks of API recordings go unless a start request names another allowed URL. */
  WEBHOOK_URL: z.preprocess(
    blank,
    z
      .url()
      // canParse first: zod runs this check even after z.url() failed, and new URL() would throw with the value in its message.
      .refine((u) => URL.canParse(u) && webhookProtocolOk(new URL(u)), "must be https (plain http only on localhost)")
      .optional(),
  ),
  /** More origins a start request may send its webhooks to, comma separated. */
  WEBHOOK_ALLOWED_ORIGINS: z.preprocess(blank, z.string().optional()).transform(parseOrigins),
}).superRefine((c, ctx) => {
  const need = (ok: unknown, path: string, message: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
  };
  need(!c.DISCORD_TOKEN === !c.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID", "set DISCORD_TOKEN and DISCORD_CLIENT_ID together");
  need(c.DISCORD_TOKEN || c.MEET_RECORDER_URL, "DISCORD_TOKEN", "nothing to run: set DISCORD_TOKEN (Discord /record) or MEET_RECORDER_URL (Google Meet)");
  const meetPage = c.ALLOWED_EMAILS.emails.length + c.ALLOWED_EMAILS.domains.length > 0;
  const api = c.API_KEYS.keys.length > 0;
  need(!c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, "MEET_RECORDER_TOKEN", "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together");
  if (c.MEET_RECORDER_URL) {
    need(meetPage || api, "ALLOWED_EMAILS", "Google Meet recording needs ALLOWED_EMAILS (the /meet page) or API_KEYS (the API)");
    if (meetPage) {
      // The /meet page sends login links, and its recordings report by email only.
      need(c.RESEND_API_KEY, "RESEND_API_KEY", "the Google Meet page sends login links and minutes by email: set RESEND_API_KEY");
      need(c.EMAIL_FROM, "EMAIL_FROM", "the Google Meet page sends login links and minutes by email: set EMAIL_FROM");
    }
  }
  if (api) need(c.MEET_RECORDER_URL, "API_KEYS", "the API starts Google Meet recordings: set MEET_RECORDER_URL and MEET_RECORDER_TOKEN");
  for (const i of c.API_KEYS.invalid) {
    need(false, "API_KEYS", `entry ${i} is not <name>:<key> (name: a-z, 0-9, -, up to 32; key: at least 32 of A-Z a-z 0-9 _ -, used once)`);
  }
  if (c.WEBHOOK_URL || c.WEBHOOK_ALLOWED_ORIGINS.origins.length > 0) need(c.WEBHOOK_SECRET, "WEBHOOK_SECRET", "webhooks are signed: set WEBHOOK_SECRET");
  for (const bad of c.WEBHOOK_ALLOWED_ORIGINS.invalid) need(false, "WEBHOOK_ALLOWED_ORIGINS", `"${bad}" is not a URL`);
  if (c.CALENDAR_ICAL_URL) {
    need(c.MEET_RECORDER_URL, "CALENDAR_ICAL_URL", "calendar starts need MEET_RECORDER_URL and MEET_RECORDER_TOKEN");
    need(c.MEET_BOT_EMAIL, "MEET_BOT_EMAIL", "calendar starts need MEET_BOT_EMAIL");
    need(meetPage, "ALLOWED_EMAILS", "calendar starts record only organizers on ALLOWED_EMAILS: set ALLOWED_EMAILS");
  }
  for (const bad of invalidAllowlistEntries(c.ALLOWED_EMAILS)) {
    need(false, "ALLOWED_EMAILS", `"${bad}" is neither an email address nor an @domain`);
  }
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

/** Parses an environment; throws with every problem listed (never a secret value). */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function config(): Config {
  return (cached ??= parseConfig(process.env));
}

/** The /meet page runs when Google Meet recording is configured and someone may sign in. */
export const meetPageEnabled = (c: Config = config()): boolean =>
  !!c.MEET_RECORDER_URL && c.ALLOWED_EMAILS.emails.length + c.ALLOWED_EMAILS.domains.length > 0;

/** /api/v1 runs when at least one API key is configured. */
export const apiEnabled = (c: Config = config()): boolean => c.API_KEYS.keys.length > 0;

/** Audio format used everywhere: 24 kHz mono signed 16-bit little endian. */
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SAMPLE = 2;
/** Recording is cut into 5-minute segments that are uploaded to R2 while the meeting runs. */
export const SEGMENT_SECONDS = 300;
export const SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS;

/** How long a Google Meet bot waits to be let in, and then for the first person to join (the recorder Worker allows at most 15 min). */
export const MEET_ADMIT_TIMEOUT_MS = 15 * 60_000;
