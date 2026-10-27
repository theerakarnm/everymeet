# AGENTS.md

Guidance for AI agents working in this repository.

## Project overview

Meeting Minutes Bot is a Discord bot that records a voice channel with one audio track per speaker, uploads the audio to Cloudflare R2, transcribes it through OpenRouter, writes Thai meeting minutes, and posts them to a `#meeting-of-minutes` channel.
It also serves a PIN-protected playback page (Hono) where participants listen to the mixed and per-speaker audio and read the transcript and full summary.

Recording flow: `/record` joins the voice channel and writes one 24 kHz mono PCM track per speaker.
Every 5 minutes a finished segment is uploaded to R2 as FLAC, so a crash loses at most 5 minutes.
`/end` (or an auto-end rule: 2 h "Continue recording?" prompt, or empty channel for 3 min) stops recording, skips silence, packs each speaker's speech into transcription requests of up to ~2 minutes, interleaves the transcripts by time, generates full and short Thai summaries, and posts the result with a 6-digit PIN.
If the bot dies mid-meeting, `recoverUnfinished()` closes the meeting at the last heartbeat on restart and processes what it has.

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
```

- Run `npm run typecheck` and `npm test` before considering work done.
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
| `src/web/` | Hono playback server, PIN flow, signed cookies, Thai HTML templates |
| `src/util/` | ffmpeg wrappers, concurrency limiter, logger, PIN/crypto helpers, time formatting, wav |
| `src/test/setup.ts` | Shared test setup: fake env, in-memory R2, scripted OpenRouter fetch |
| `diag-commands.mts` | Debug script to inspect slash command registration against the Discord API |

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
- `src/test/setup.ts` provides fake env, an in-memory R2 bucket (`mockR2()`, `r2`, `r2Text`), and a scripted OpenRouter (`mockOpenRouter()`, `chatReply`).
- Mocking uses `mock.module` from `node:test`, which requires the `--experimental-test-module-mocks` flag already present in the `test` script.
- Call `mockR2()` before dynamically importing (`await import(...)`) any module under test that binds R2 functions at load time; see `pipeline/run.test.ts` for the pattern.
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
- The bot announces that it is recording in the command channel and voice channel chat (consent / PDPA); keep that behavior in any change.
- Recommend an R2 lifecycle rule deleting `meetings/*/segments/` after ~30 days; segments are only crash backups.

## Deployment steps

- Production runs via `docker compose up -d --build` (node:22-slim + ffmpeg, non-root user, healthcheck on `/healthz`).
- After changing slash command definitions, run once: `docker compose exec meeting-bot node dist/register-commands.js`.
- The `meeting-data` volume keeps in-progress recordings across restarts; `stop_grace_period: 60s` gives shutdown time to flush the last segment.
- Debug registration with `npx tsx diag-commands.mts`.

## Gotchas

- Discord does not officially document receiving audio; `@discordjs/voice` supports it, but a Discord change could break it, so pin dependency versions and test voice receive after upgrades.
- One recording per server at a time is enforced; do not remove that invariant without redesigning storage keys.
- The OpenRouter price unit for MAI-Transcribe 2 is unclear; if billing turns out to be per request, raise `maxChunk` in `pipeline/plan.ts` to reduce the call count.
- Local temp audio can reach ~170 MB per speaker-hour; `CLEANUP_LOCAL=true` removes it after posting.
- Every fallback model pair (transcribe, summary) should keep working; do not remove the fallback path.

## Commits and pull requests

- There is no established convention yet (the repo has a single init commit); use short imperative subjects, for example `fix recorder drop on late speaker join`.
- Keep commits scoped to one subsystem (recorder, pipeline, web, storage) where practical.
