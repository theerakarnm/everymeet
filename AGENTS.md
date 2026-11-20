# AGENTS.md

Guidance for AI agents working in this repository.

## Project overview

Meeting Minutes Bot is a Discord bot that records a voice channel with one audio track per speaker, uploads the audio to Cloudflare R2, transcribes it through OpenRouter, writes Thai meeting minutes, and posts them to a `#meeting-of-minutes` channel.
It also serves a PIN-protected playback page (Hono) where participants listen to the mixed and per-speaker audio and read the transcript and full summary.

Recording flow: `/record` joins the voice channel and writes one 24 kHz mono PCM track per speaker.
Every 5 minutes a finished segment is uploaded to R2 as FLAC, so a crash loses at most 5 minutes.
`/end` (or an auto-end rule: 2 h "Continue recording?" prompt, or empty channel for 3 min) stops recording, skips silence, packs each speaker's speech into transcription requests of up to ~2 minutes, interleaves the transcripts by time, generates full and short Thai summaries, and posts the result with a 6-digit PIN.
If the bot dies mid-meeting, `recoverUnfinished()` closes the meeting at the last heartbeat on restart and processes what it has.

Google Meet calls are recorded without Discord: anyone who signs up starts one on the `/meet` web page (magic-link login, open signup).
A calendar trigger (invite the bot Google account to an event, found by reading its secret iCal feed) is planned but not built yet; its settings `CALENDAR_ICAL_URL` and `MEET_BOT_EMAIL` already exist.
The recorder runs on Cloudflare Containers (`meet/`), uploads 5-minute FLAC segments to R2 through its Durable Object, and the bot polls it and feeds the same pipeline with one mixed pseudo-participant `meet`; the minutes and failure notices go out by email (Resend REST API, one email per recipient).
Meet recording is optional and stays off unless `MEET_RECORDER_URL` and `MEET_RECORDER_TOKEN` are both set.

## Hard constraint: Node 22, not Bun

- The runtime is Node >= 22.12.0 because `@discordjs/voice` needs it for audio receive and Discord's DAVE voice encryption.
- npm and `package-lock.json` are the source of truth (the Dockerfile runs `npm ci`); do not use `bun.lock`.
- Do not rewrite imports or scripts to Bun APIs.

## Build and test commands

```bash
npm install          # install dependencies
npm run dev          # tsx watch with .env, no build step needed
npm run build        # tsc -> dist/
npm start            # node dist/index.js (production)
npm run typecheck    # tsc over src including tests, no emit
npm test             # all suites with node:test, requires ffmpeg on PATH
npm run register     # register slash commands (needs .env, reads dist/, so build first)
cd meet && npm ci && npm run typecheck && npm test   # the meet-recorder package (Worker + container)
cd meet && npm run meet:login   # one-time bot Google account sign-in (podman)
```

- Run `npm run typecheck` and `npm test` (root) and, when `meet/` or `src/meet/protocol.ts` / `src/storage/keys.ts` changed, the same two in `meet/`.
- There is no linter or CI configured, so these two commands are the quality gate.
- `npm test` needs ffmpeg installed locally; the full suite currently passes in about 3 seconds.

## Architecture map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point: Discord client, web server, signal handling, recovery on boot |
| `src/config.ts` | Zod env schema (fails fast at boot) plus shared constants (24 kHz sample rate, 5-min segments) |
| `src/recorder/` | Voice session lifecycle, per-speaker PCM track writer, 5-min FLAC segment uploader |
| `src/pipeline/` | Meeting processing: `plan.ts` (pure planning math), `assemble`, `transcribe`, `summarize`, `publish`, `run` (orchestrator), `openrouter` (API client) |
| `src/storage/` | `manifest.json` state model and the R2 client |
| `src/storage/keys.ts` | R2 key builders, import-free so the Worker can bundle them |
| `src/meet/` | Google Meet side of the bot: MeetSession (poll, email notices, manifest, activeMeets and per-person limits), recorder client, VAD, link parsing, shared protocol.ts |
| `src/web/` | Hono playback server, PIN flow, signed cookies, /meet magic-link login with open signup, recorder page, and admin page (meet-routes.ts), Thai HTML templates |
| `src/email/` | Resend client (send.ts, the only email I/O) and Thai email builders (messages.ts) |
| `src/users/` | User store: `DATA_DIR/users.json`, atomic writes, the bot is its only writer (store.ts) |
| `src/util/` | ffmpeg wrappers, concurrency limiter, logger, PIN/crypto helpers, time formatting, wav |
| `src/test/setup.ts` | Shared test setup: fake env, in-memory R2, scripted OpenRouter fetch, fake email sender (mockEmail, sentEmails), fake meet recorder |
| `diag-commands.mts` | Debug script to inspect slash command registration against the Discord API |
| `meet/` | Separate npm package: Cloudflare Worker + Durable Object (worker/) and the Playwright container runner (bot/) |

## Code style guidelines

- TypeScript strict mode, target ES2023, ESM with NodeNext module resolution.
- Every relative import ends in `.js` (it points at the compiled output); never drop the extension.
- Double quotes, semicolons, 2-space indent, trailing commas.
- No formatter or linter is configured, so match the surrounding code exactly.
- Prefer small hand-rolled utilities over new dependencies (`util/limit.ts` is a tiny p-limit, `util/log.ts` a tiny logger); adding a runtime dependency needs a good reason.
- All environment access goes through `src/config.ts`; add new variables to the zod schema and to `.env.example` in the same change.
- Log through the `logger(scope)` helper, not bare `console.log`.
- Keep pure logic (timeline math, chunk packing, formatting) in I/O-free modules like `pipeline/plan.ts` so it stays unit-testable.
- User-facing strings on the playback page are Thai; keep that consistent and do not switch times to UTC (`util/time.ts` formats Bangkok time on purpose).

## Testing instructions

- Tests use the built-in `node:test` runner with `node:assert/strict`; test files sit next to the code as `*.test.ts`.
- Nothing in the tests talks to real Discord, Cloudflare, or OpenRouter.
- `src/test/setup.ts` provides fake env, an in-memory R2 bucket (`mockR2()`, `r2`, `r2Text`), a scripted OpenRouter (`mockOpenRouter()`, `chatReply`), a fake email sender (`mockEmail()`, `sentEmails`), and a scripted meet-recorder Worker (`fakeMeetRecorder()`).
- Mocking uses `mock.module` from `node:test`, which requires the `--experimental-test-module-mocks` flag already present in the `test` script.
- Call `mockR2()` before dynamically importing (`await import(...)`) any module under test that binds R2 functions at load time; see `pipeline/run.test.ts` for the pattern.
- Call `mockEmail()` before dynamically importing any module that sends email; no test may send real email.
- `pipeline/run.test.ts` is the end-to-end suite: generated tone audio through real ffmpeg, everything else faked.
- New pure helpers get plain unit tests in the `pipeline.test.ts` style; do not mock what can be real.

## Security considerations

- The R2 bucket stays private; playback streams only through short-lived presigned URLs.
- PINs are never stored in plaintext: the manifest holds a scrypt hash plus salt, and comparison uses `timingSafeEqual` (`util/pin.ts`).
- 5 wrong PIN tries per IP per meeting locks that meeting for 15 minutes.
- Playback access is an HMAC-SHA256 signed cookie, 12 h TTL, bound to one meeting id.
- `SESSION_SECRET` must be a long random string (`openssl rand -base64 48`); minimum 32 chars is enforced by the config schema.
- Keep the security headers and `Cache-Control: no-store` applied to every page response in `web/server.ts`.
- The container publishes the web port on `127.0.0.1` only; Nginx terminates HTTPS, and `TRUST_PROXY=true` is set only behind that trusted proxy.
- Meeting ids are 12 random bytes (base64url); validate them against `SESSION_ID_RE` before use.
- Never commit `.env`, never log tokens or secrets.
- Consent / PDPA: a Discord `/record` recording is announced in the command channel and the voice channel chat; keep that behavior in any change.
- Recommend an R2 lifecycle rule deleting `meetings/*/segments/` and `meetings/*/debug/` after ~30 days; segments are only crash backups, and Meet failure screenshots in `debug/` can show people.
- The bot-account session file (`MEET_AUTH_STATE_FILE`) is a full Google login credential: never commit it, never log it, never write it to R2, Durable Object storage, or the manifest.
- A Google Meet recording needs only the notice in the Meet chat (Thai/English), not a Discord announcement; if the notice fails, the starter is emailed to tell the participants. Keep both.
- Signup is open: anyone who confirms a login link gets an account in `DATA_DIR/users.json`, and only active accounts can use `/meet`; the account is re-checked on every request.
- Open signup means anyone can make the bot join a Meet call at about $0.08 per recording hour: keep `MAX_MEET_RECORDINGS` (2), the per-person limits (`MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER`), the signup and login-email limits, and the admin page's disable button.
- Login links are 32 random bytes, single use, 15 minutes, kept in memory, and using one voids the other links of that address; `/meet/login` answers the same for new, existing, and disabled addresses (no user enumeration) and is rate limited per IP and per email, and links to new addresses are capped per day in total (existing accounts are never capped).
- `SEED_ADMIN_EMAIL` and every other real address live only in `.env`; the repo is public, so code, tests, and docs use placeholders.
- The `/meet` cookie is HMAC-signed over `user:<email>` with `SESSION_SECRET`, `HttpOnly`, `SameSite=Lax`, 12 h; `hono/csrf` on `/meet/*` (logout included) refuses form posts from other sites. Keep both.
- `CALENDAR_ICAL_URL` and `RESEND_API_KEY` are secrets: never log them or put them in error messages.
- Resend keeps the sent emails, including the minutes PIN and the login links: limit who has access to the Resend team, and keep open and click tracking off for the sending domain (click tracking would rewrite the login and playback links through Resend).

## Deployment steps

- Production runs via `docker compose up -d --build` (node:22-slim + ffmpeg, non-root user, healthcheck on `/healthz`).
- After changing slash command definitions, run once: `docker compose exec meeting-bot node dist/register-commands.js`.
- The `meeting-data` volume keeps in-progress recordings across restarts; `stop_grace_period: 60s` gives shutdown time to flush the last segment.
- Debug registration with `npx tsx diag-commands.mts`.
- The Meet recorder (`meet/`) deploys separately to Cloudflare from podman; see `## Google Meet recording` in README.md.
- The bot Google account session is mounted read-only from `./secrets` to `/run/secrets/meet` (`MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json`).
- After deploying the build without `/record-meet`, run the register command once so Discord drops that removed command.

## Gotchas

- Discord does not officially document receiving audio; `@discordjs/voice` supports it, but a Discord change could break it, so pin dependency versions and test voice receive after upgrades.
- The OpenRouter price unit for MAI-Transcribe 2 is unclear; if billing turns out to be per request, raise `maxChunk` in `pipeline/plan.ts` to reduce the call count.
- Local temp audio can reach ~170 MB per speaker-hour; `CLEANUP_LOCAL=true` removes it after posting.
- Every fallback model pair (transcribe, summary) should keep working; do not remove the fallback path.
- Meet DOM texts and selectors live only in `meet/bot/meet-page.ts`; when joins or end detection break after a Meet UI change, start from `failure.png` in R2 and the `wrangler tail` events.
- `src/meet/protocol.ts` and `src/storage/keys.ts` are bundled into the Worker and the container: keep them free of imports.
- A stop on the web page returns at once, but the minutes arrive only after the recorder reports the end (up to about a minute later).
- Discord: one recording per server at a time; do not remove that invariant without redesigning storage keys.
- Google Meet: one recording per Meet code, at most 2 Meet recordings in total (`MAX_MEET_RECORDINGS`, the Worker's `max_instances`), plus the per-person limits below; a start right after a recording ended can still fail for up to 30 s while the old container shuts down.
- A recording covers whatever happens in its Meet room until it ends.
- `users.json` is written only by the running bot (`src/users/store.ts`); do not add a second writer (a CLI, a cron job) without moving the store to something with real locking.
- Each person may run `MEET_MAX_ACTIVE_PER_USER` recordings and start `MEET_MAX_DAILY_PER_USER` per 24 hours; the 24-hour start times live in `users.json`, so a restart does not reset them.

## Commits and pull requests

- There is no established convention yet (the repo has a single init commit); use short imperative subjects, for example `fix recorder drop on late speaker join`.
- Keep commits scoped to one subsystem (recorder, pipeline, web, storage) where practical.
