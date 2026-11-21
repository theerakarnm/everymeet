# Engine and Service Split: Open-Source Engine with a Versioned HTTP API - Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-11-21-engine-service-split.md` - the runner that ticks these checkboxes and honours the track layout below.
>
> **For the executing agent:** Implement this plan task by task in one worktree (single sequential track, see Execution).
> Steps use checkbox (`- [ ]`) syntax for tracking; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.
> Code in Steps is a reference implementation written without a compiler.
> When `tsc` or a test rejects it, the tool wins: correct it minimally and record a `> Deviation:` note under the step.
> **Order:** Tasks 1-20 need nothing from the user and can run now, while the older plan's Task 0 (the user's calendar probe) is pending.
> Run Tasks 1-4 before the older plan's Tasks 12-13 (they rewrite what those tasks consume, see `## Ordering against the older plan`).
> Task 21 waits for the older plan's Tasks 12 and 13; Task 22 waits for the user's history decision and runs last of all.

**Goal:** Make this public repo a self-hostable AGPL-3.0 meeting-minutes ENGINE (Discord `/record`, Google Meet by `/meet` page, calendar, and a versioned HTTP API with signed webhooks), and move every subscription-service concern (open signup, user database, admin page, per-person caps) out of it.
**Architecture:** One Node process as today.
The Hono server keeps the PIN playback pages (`/m/:id`) and the `/meet` page (magic-link login for an `ALLOWED_EMAILS` allowlist), and gains `/api/v1` (Bearer API keys from config, per-key rate limits) that starts, reads, stops, and lists Meet recordings for an opaque `ownerId`, and issues playback PINs.
Recordings started over the API report through a durable outbox of Standard Webhooks signed events (`recording.notice_failed`, `recording.ended`, `recording.failed`, `minutes.ready`), and either also get today's Resend emails (`delivery.mode: "email"`) or none (`"webhook"`, the hosted service sends its own).
**Tech Stack:** Node 22 + TypeScript 7 + Hono 4.13 + zod 4.6 + node:test (unchanged); `@aws-sdk/client-s3` `ListObjectsV2Command` (already a dependency) for the owner index; no new runtime dependency.
**Spec:** none - planned from the parent's task brief of 2026-11-21 (user decisions 1-8, quoted in `## Decisions`), on top of `docs/plans/2026-11-01-meet-calendar-web-email.md` (executed: Tasks 1-11b and 14 and the review fixes; not yet: Task 0, 12, 13, 15).
**Base commit:** 883fa96 (branch `feat/meet-recording`, 53 commits ahead of `origin/main`, merge-base 478be16, never pushed).
**Confidence:** 7/10 - see `## Confidence derivation`; the open unknowns are the user's answers on the license variant, copyright line, and history option, and UX commits landing on `src/web/templates.ts` and `src/web/meet-routes.ts` after 883fa96.
**NOT building:**
- The hosted subscription service (signup, billing, plans and quotas, tenants, admin UI, branded pages and emails): a separate private repo, not planned here.
- Any user database in the engine: no `users.json`, no accounts, no admin page, no per-person caps; the engine knows an API client name and an opaque `ownerId` only.
- An API for Discord recordings: Discord `/record` stays exactly as it is and is not reachable over `/api/v1`.
- Deleting recordings over the API (Open question 4).
- Per-client webhook secrets: one shared `WEBHOOK_SECRET` (user decision 3).
- `recording.started` or progress webhooks: the service polls `GET /api/v1/recordings/{id}` for live state.
- Any change to the recorder Worker or container under `meet/` apart from the `license` field in `meet/package.json` (no image redeploy is needed for this plan).
- A per-file SPDX or copyright header in source files (Decision 14).
- A CLA bot or DCO-checking CI (no CI exists; Decision 15 says how DCO is checked).
- Executing any git history rewrite or force-push (Task 22 is gated on the user's choice and run by the user or on their explicit go).
- Publishing Docker images.

## Decisions

The user decisions of 2026-11-21 are quoted in short; each plan decision states the chosen option and why.

User decisions (final):
- U1: the repo is open source under AGPL-3.0 and holds only the engine, so anyone can fork and self-host.
- U2: a separate private repo is the hosted subscription service; it calls the engine over HTTP; multi-tenant model B: one engine serves many customers and knows only an opaque owner id and metadata.
- U3: a versioned HTTP API with Bearer API keys from config (constant-time compare): start (Meet URL, optional recipients, delivery mode, opaque ownerId and metadata, optional webhook URL), status, stop, list by owner; signed webhooks (HMAC-SHA256, shared secret, timestamp, retry with backoff, idempotency id) when a recording ends or fails and when minutes are ready; delivery modes email (today) or webhook-only; an OpenAPI-style markdown doc in `docs/`.
- U4: open signup, `users.json`, `/meet/admin`, per-person caps and the 50/day signup cap are service concerns and leave the engine; engine login is `ALLOWED_EMAILS` (addresses and `@domains`) with magic links at `/meet`; global limits and the calendar trigger (organizer on the allowlist) stay.
- U5: the Discord bot stays in the engine.
- U6: single process; API routes under `/api/v1` in the existing Hono server, separate from the PIN pages and `/meet`; per-key rate limits.
- U7: open-source readiness (license, contributing, security, DCO stance, AGPL network note, dependency license audit, removal of the author's infrastructure, a git history decision).
- U8: say which tasks start now, which depend on the user, and which wait for the older plan's Tasks 12, 13, 15.

Plan decisions:

1. **What stays from the 2026-11-20 login code.**
   Kept unchanged: `src/web/login-links.ts` (single-use 15-minute tokens), `src/web/rate-limit.ts`, `src/web/client-ip.ts`, `signUser`/`verifyUser` in `src/util/pin.ts` (the `mu` cookie), `hono/csrf` on `/meet/*`, the confirm-button page (mail scanners), logout, the per-IP (5) and per-email (3) link limits per 15 minutes, and `MEET_LOGIN_MAIL_DAILY_CAP` (a self-hoster on Resend's free plan still wants a ceiling on login mail; with `@domain` entries anyone can type made-up addresses on an allowed domain).
   Removed: `src/users/` (store and test), the signup caps (`MAX_SIGNUP_EMAILS_PER_DAY`, `signupsPerIp`), the admin routes and page, the "account disabled" page, `SEED_ADMIN_EMAIL`, `MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER`, and the refusal reasons `user_busy` and `daily_limit`.
   Restored from commit bb746d1: `Allowlist`, `parseAllowlist`, `invalidAllowlistEntries`, `isAllowed` in `src/util/email.ts` and the `ALLOWED_EMAILS` config entry (written out in Task 2, not `git show`n, because that commit's neighbours carry real addresses).
2. **`/meet` login checks the allowlist on every request** (`user(c)` = valid cookie AND `isAllowed`), so removing an address from `ALLOWED_EMAILS` and restarting signs it out.
   `POST /meet/login` gives the same page and status for allowed and not-allowed addresses and only mails allowed ones (no enumeration of the allowlist).
3. **Which surfaces are on.**
   `/meet` is mounted when `MEET_RECORDER_URL` is set AND `ALLOWED_EMAILS` has an entry (`meetPageEnabled()`); `/api/v1` is mounted when `API_KEYS` has an entry.
   `MEET_RECORDER_URL` needs at least one of them; `RESEND_API_KEY` and `EMAIL_FROM` are required only when the `/meet` page or the calendar is on, so the hosted service can run an engine with API and webhooks only; Discord becomes optional too (`DISCORD_TOKEN` and `DISCORD_CLIENT_ID` set together, Task 6), and at least one of Discord and Google Meet must be on.
   An API start with `delivery.mode: "email"` on an engine without Resend gets `422 email_not_configured`.
   Failure emails show the "start again on the web page" button only when `meetPageEnabled()`, so no email links to a 404.
4. **API keys: `API_KEYS=<name>:<key>,<name>:<key>`.**
   The name (`^[a-z0-9-]{1,32}$`) is the client identity and the tenant boundary: a client sees and controls only recordings it started.
   A name may appear twice with two keys, which is how a key is rotated without downtime.
   Keys are at least 32 characters of `[A-Za-z0-9_-]` (generate with `openssl rand -base64 36 | tr '+/' '-_' | tr -d '='`).
   The check hashes the presented token and every configured key with SHA-256 and compares with `timingSafeEqual`, visiting every key (no early exit), so neither length nor position leaks.
5. **Rate limit per client name, not per key:** `API_RATE_LIMIT_PER_MIN` (default 120) requests per minute in a fixed window (the existing `RateLimit`), 429 with `Retry-After: 60` over it; unauthenticated requests are limited per IP (30 per minute) so key guessing is slow.
6. **Webhooks follow the Standard Webhooks specification** (https://www.standardwebhooks.com, the scheme Svix and others use) instead of an invented header set, so the service can verify with an off-the-shelf library.
   Headers `webhook-id` (stable across retries: the idempotency id), `webhook-timestamp` (Unix seconds of this attempt), `webhook-signature: v1,<base64 HMAC-SHA256 over "<id>.<timestamp>.<body>">`.
   `WEBHOOK_SECRET` is `whsec_<base64>` and the HMAC key is the base64-decoded part (generate with `echo "whsec_$(openssl rand -base64 32)"`).
   Body: `{ "type": "<event>", "timestamp": "<ISO time of the event>", "data": <Recording> }`, where `Recording` is the same object `GET /api/v1/recordings/{id}` returns (one serializer, `recordingView`).
7. **What a webhook carries, and what it does not.**
   Carried: recording id, client name, `ownerId`, `metadata`, state, `endCode` (machine-readable) and `endReason` (Thai text), Meet code and title, delivery mode, timestamps, `durationSeconds`, `playbackUrl` (the `/m/<id>` page, useless without a PIN), `error` for failures, and `summaryShort` on `minutes.ready` (the service needs it for its email, and every minutes email carries it today).
   Never carried: the PIN, the transcript, the full summary, audio URLs, recipient addresses, the bot account session.
   The PIN is fetched separately with `POST /api/v1/recordings/{id}/pin`, which makes a new PIN, stores only its scrypt hash, and returns it once; a PIN and the playback URL together are full access, so they never travel in the same retried, logged webhook body, and no plaintext PIN is ever written to the outbox on disk.
   Issuing a PIN voids the previous one (also an emailed one in email mode); this is documented in `docs/api.md`.
8. **Webhook URL per recording (U3 asks for an optional one), but only to allowed origins.**
   Review round 1 proposed dropping the per-request URL as the only SSRF surface; it stays because the user's brief lists it, and the origin allowlist plus `https` plus no redirects is what keeps it from being a request forwarder (a service with one receiver simply never sends it).
   The start request may name `webhookUrl`; it must be `https:` (or `http:` on `localhost`/`127.0.0.1` for development) and its origin must be in `WEBHOOK_ALLOWED_ORIGINS` or equal the origin of `WEBHOOK_URL`, so an API key cannot turn the engine into a request forwarder to internal hosts.
   Without `webhookUrl`, `WEBHOOK_URL` is used; with neither, no webhooks are sent; `delivery.mode: "webhook"` without any webhook URL is `400 webhook_url_required`.
   The resolved URL is stored in the manifest, so restarts and retries use it.
9. **Delivery is a durable outbox:** each event is one JSON file `DATA_DIR/webhooks/pending/<webhook-id>.json` written atomically (temp file plus rename, as `saveLocal`) before anything is attempted; a 15 s tick delivers due entries one at a time with a 10 s timeout.
   A 2xx answer deletes the file; anything else (including network errors) reschedules it after 30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h (about 22 h in all, 8 attempts); after the last failure the file moves to `DATA_DIR/webhooks/failed/` and an error is logged (an operator can move it back to `pending/` to retry).
   Events may arrive out of order and more than once: receivers dedupe by `webhook-id` and trust `data.state`.
10. **Delivery modes.**
    `email`: the engine sends today's emails (minutes to `starter` plus `recipients`, failure and consent notices to `starter`) and also webhooks when a URL resolved.
    `webhook`: the engine sends no email at all; the consent fallback becomes the `recording.notice_failed` event, and the API contract makes telling the participants the service's duty (`docs/api.md`, Task 15; AGENTS.md consent rule, Task 10).
    Web and calendar starts are unchanged (email, no webhooks).
11. **Owner listing is an R2 index**, not a local store: at start the API writes an empty object `api/<client>/<ownerId>/<13-digit inverted startedAt>-<id>` (newest first in R2's lexicographic listing), and `GET /api/v1/recordings?ownerId=` lists that prefix (at most 50 per page, R2 continuation token as `cursor`) and loads each manifest (8 at a time).
    This adds no second writer and no new storage (AGENTS.md "users.json is written only by the bot" lesson), survives restarts, and costs one PUT per start.
    `ownerId` is `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (no `.` or `..` segment) so it is safe in a key; `metadata` is at most 20 string pairs (keys up to 40, values up to 500 characters) and is stored in R2 with the manifest, so the docs say "no personal data in metadata".
12. **Machine-readable end code:** `MeetManifest` gains `endCode?: EndReason | "recorder_lost"`, set when the recording finishes (`"stopped"` when someone pressed stop, the recorder's reason otherwise, `"recorder_lost"` when the recorder lost it); `endReason` stays the Thai text the emails use.
13. **`MeetInfo` widening.** `trigger` gains `"api"`, `startedBy` becomes optional (absent only for API recordings in webhook mode), and `api?: { client, ownerId, metadata, delivery, webhookUrl? }` is added; no compatibility shim, because no API manifests exist yet and old manifests still parse (the new fields are optional).
14. **License: AGPL-3.0-only, one `LICENSE` file, no per-file headers.**
    `-only` keeps the license under the copyright holders' control instead of the FSF's future versions (Open question 1 offers `-or-later`).
    Per-file SPDX headers are optional under the AGPL, add churn to every file, and help mainly when files are copied out of the repo; the `license` field in both `package.json` files plus `LICENSE` and the README "License" section are the declaration.
15. **Contributions: DCO sign-off (`git commit -s`), no CLA.**
    The commercial value lives in the private service, which talks to the engine only over HTTP and copies no engine code, so it is a separate work and the author needs no relicensing rights over contributed engine code.
    The hosted engine runs this public code, so the AGPL's obligation to offer source (section 13) costs the author nothing.
    A CLA adds friction and signals "this may become closed", which deters exactly the self-hosters U1 wants.
    The trade-off, stated in CONTRIBUTING.md: without a CLA the author can never relicense contributed code (no proprietary or dual-licensed engine later); Open question 2.
    No CI exists, so the maintainer checks for `Signed-off-by:` when merging (`git log --format=%B <range> | grep -c Signed-off-by`).
16. **AGPL section 13 for network users.**
    Every engine web page (playback, PIN, `/meet`) gets a footer link "ซอร์สโค้ด" to `SOURCE_CODE_URL` (default: this repo's public URL); someone running a modified engine must point it at their modified source.
    The Worker and container under `meet/` are part of the same AGPL program; people in a Meet call interact with the bot, not with a web interface, so the engine pages' link and the README note cover the offer; the README "License" section says so.
    The private service stays outside the AGPL only while it talks to the engine over HTTP, does not import engine modules (not even `src/meet/protocol.ts` or `src/storage/keys.ts`), and writes its own client from `docs/api.md`; README and `docs/api.md` say this.
17. **Dependency licenses: no incompatible package** (audit 2026-11-21, lockfile v3 `license` fields).
    Root: 77 prod packages (MIT 40, Apache-2.0 36, 0BSD 1) and 50 dev (MIT 29, Apache-2.0 21).
    `meet/`: prod `playwright` and `playwright-core` 1.64.1 (Apache-2.0); dev tree of wrangler has LGPL-3.0-or-later `@img/sharp-*` builds (dev only, not shipped).
    Shipped binaries, not npm packages: Debian `ffmpeg` in the root image (GPL build, run as a separate process, which the AGPL allows) and Chromium in `mcr.microsoft.com/playwright:v1.64.1-noble` (BSD-3 plus third-party notices); neither is redistributed by this repo since no images are published.
    `spike/meet-bot/package.json` declares `ISC`, which contradicts the repo license; Task 18 removes `spike/` from the tree.
    Task 19 adds `npm run licenses`, a dependency-free check of all lockfiles, so an upgrade cannot quietly bring in an incompatible license.
18. **Author infrastructure in tracked files.**
    HEAD 883fa96 is clean (placeholders only; `meet/wrangler.deploy.jsonc` exists on disk but is ignored by `meet/.gitignore`).
    Still to remove: `spike/` (exploration code, ISC license field, real-looking deploy layout), `bun.lock` (AGENTS.md: npm only), and, at the merge into `main`, `meet/wrangler.deploy.jsonc`, which `origin/main` still tracks from 1b6f34a (that commit is not in this branch).
    `.gitignore` gets `.env.*` with `!.env.example`, so `.env.local` and friends cannot be committed.
19. **Git history: recommendation in `## Git history decision`;** nothing is rewritten by Tasks 1-21.

## Ordering against the older plan

- Start now, no user input: Tasks 1-20 (Tasks 16 and 20 ask Open questions 1-3, and their defaults ship without an answer).
  They touch `src/config.ts`, `src/test/setup.ts`, `src/index.ts`, `.env.example`, `package.json` like the older plan's Tasks 12-13, so everything runs in one sequential track on `feat/meet-recording`.
- Run Tasks 1-4 BEFORE the older plan's Tasks 12-13: those tasks consume `users().active(...)`, the `user_busy` retry, and `RefusalReason` with per-person reasons, which Tasks 1 and 3 delete; Task 4 rewrites the affected steps of Tasks 12-13 in the older plan to use `isAllowed(organizer, config().ALLOWED_EMAILS)`.
  If Tasks 12-13 were already executed when this plan starts, Task 3 also edits `src/calendar/poller.ts` and `src/calendar/poller.test.ts` (see its Gotcha).
- Depends on the user (answers before the task, defaults ship otherwise): Task 16 (license variant and copyright line, Open questions 1 and 3), Task 20 (DCO vs CLA, Open question 2; enabling GitHub private vulnerability reporting is a 👤 step), Task 22 (history option, Open question 5).
- Waits for the older plan: Task 21 (the README self-hosting section describes the calendar trigger as built) waits for Tasks 12-13 or for their STOP decision; the real-room part of `## End-to-end verification` waits for Task 15 (the image with the 15-minute waiting rule) and Task 0 (Resend key).
- Last of all: Task 22 (history), after every other commit of both plans, so history is rewritten at most once, and before `feat/meet-recording` is pushed for the first time.

## Global Constraints

- Runtime Node >= 22.12.0 with npm and `package-lock.json`; never Bun APIs or `bun.lock` (AGENTS.md "Hard constraint"); no new runtime dependency in this plan.
- Every relative import ends in `.js`; double quotes, semicolons, 2-space indent, trailing commas; match the surrounding code (no formatter or linter exists).
- All environment access goes through `src/config.ts`; every new variable is added to the zod schema, `.env.example`, and the env block of `src/test/setup.ts` in the same task; every removed variable leaves all three in the same task.
- Log through `logger(scope)`, never bare `console.log`.
- Never log or put in an error message or a webhook: API keys, `WEBHOOK_SECRET`, PINs, `RESEND_API_KEY`, `CALENDAR_ICAL_URL`, login-link tokens, `MEET_RECORDER_TOKEN`, `SESSION_SECRET`, cookie values, the bot-account session file.
  Email addresses and API client names may be logged.
- Thai for every user-facing string on web pages and in emails, Bangkok time via `src/util/time.ts`; the API speaks English JSON with ISO 8601 UTC timestamps (machine interface, not user-facing).
- Every response, `/api/v1` included, keeps the security headers and `Cache-Control: no-store` of the `app.use("*")` middleware in `src/web/server.ts`.
- API errors are always `{ "error": { "code": "<snake_case>", "message": "<English sentence>" } }` with the HTTP status listed in `docs/api.md`.
- Tenant isolation: every `/api/v1` handler reads recordings only through `findRecording(client, id)` or the client's own owner prefix `keys.ownerPrefix(client, ownerId)`; a recording of another client, a Discord recording, or a web/calendar recording answers 404, never 403.
- Global Meet limits stay: one recording per Meet code and at most `MAX_MEET_RECORDINGS = 2` at once (`activeMeets` in `src/meet/session.ts`), for web, calendar, and API starts alike.
- Discord `/record`: unchanged (one recording per guild, announcements in the command channel and the voice chat).
- Consent / PDPA: the Meet chat notice is the only notice; when it fails, email mode emails the starter and webhook mode sends `recording.notice_failed`; keep both.
- R2 keys are built only in `src/storage/keys.ts`, which stays import-free (the Worker bundles it).
- Tests: `node:test` + `node:assert/strict`, next to the code as `*.test.ts`; no network: R2 through `mockR2()`, email through `mockEmail()`, webhooks through `mockWebhooks()` (Task 8), the recorder through `fakeMeetRecorder()`, OpenRouter through `mockOpenRouter()`.
- Quality gate per task: root `npm run typecheck` and `npm test`; `meet/` typecheck and tests only in Task 11 (`src/storage/keys.ts` changes) and Task 16 (`meet/package.json`).
- Commits: Conventional Commits, one per task, explicit `git add <paths>` (never `git add -A`: `.env`, `secrets/`, `meet/auth/`, and untracked files must stay out), no agent co-author line, never edit CHANGELOG files.
- Markdown written by this plan puts each full sentence on its own line and never uses the em dash.
- The repo is public: code, tests, fixtures, `.env.example`, and docs use placeholders only (`example.com`, `planthia.test`, `<account-id>`, `abc-defg-hij`); real addresses, domains, ids, tokens, and home paths live only in `.env` and `secrets/`.
- Do not read `.env*` (except `.env.example`), `secrets/`, `meet/auth/`, or `spike/meet-bot/auth/`.

## Patterns to Mirror

### Config: zod schema, blanks mean unset, cross-field rules in `superRefine`
<!-- SOURCE: src/config.ts:8-9,52-55,76-91 -->
```ts
/** Empty values in .env mean "not set". */
const blank = (v: unknown) => (v === "" ? undefined : v);
...
  MEET_RECORDER_URL: z.preprocess(blank, z.url().optional()),
...
}).superRefine((c, ctx) => {
  const need = (ok: unknown, path: string, message: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
  };
  need(!c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, "MEET_RECORDER_TOKEN", "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together");
```

### Atomic local JSON write
<!-- SOURCE: src/storage/manifest.ts:84-90 -->
```ts
export function saveLocal(m: Manifest): void {
  const dir = meetingDir(m.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "manifest.json.tmp");
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, join(dir, "manifest.json")); // atomic replace
}
```

### The only I/O module for an external service, replaced in tests with `mock.module`
<!-- SOURCE: src/email/send.ts:25-42 and src/test/setup.ts:73-82 -->
```ts
export async function sendEmail(e: Email): Promise<void> {
  const c = config();
  if (!c.RESEND_API_KEY || !c.EMAIL_FROM) throw new Error("email is not configured (RESEND_API_KEY, EMAIL_FROM)");
  const res = await fetch("https://api.resend.com/emails", {
...
export function mockEmail(opts: { fail?: (to: string) => boolean } = {}): void {
  mock.module(new URL("../email/send.js", import.meta.url).href, {
    namedExports: {
      sendEmail: async (e: Email) => {
        if (opts.fail?.(e.to)) throw new Error(`email to ${e.to} failed: HTTP 400 validation_error: Invalid \`to\` field.`);
        sentEmails.push(e);
      },
    },
  });
}
```

### Rate limit and client IP
<!-- SOURCE: src/web/rate-limit.ts:2-19, src/web/meet-routes.ts:25-26,75 -->
```ts
const linksPerIp = new RateLimit(5, 15 * 60_000);
...
    if (!linksPerIp.take(clientIp(c)) || !linksPerEmail.take(email)) {
```

### Constant-time compare
<!-- SOURCE: src/util/pin.ts:34-42 -->
```ts
  const expected = createHmac("sha256", secret).update(`${sessionId}.${exp}`).digest();
  const given = Buffer.from(mac, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
```

### Error handling: log and keep going when the failure is not fatal
<!-- SOURCE: src/meet/session.ts:258-266 -->
```ts
  private async email(mail: Mail): Promise<void> {
    const to = this.manifest.meet.startedBy;
    try {
      await sendEmail({ to, ...mail });
    } catch (err) {
      log.error(`could not email ${to} about Google Meet recording ${this.id}`, err);
    }
  }
```

### Tests: mock modules, then import the code under test; route tests use `app.request()`
<!-- SOURCE: src/web/meet-routes.test.ts:1-13 -->
```ts
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeMeetRecorder, mockEmail, mockR2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
const worker = fakeMeetRecorder();
process.env.TRUST_PROXY = "true"; // as behind Nginx; the tests send X-Forwarded-For
const { createApp } = await import("./server.js");
const { MeetSession, activeMeets } = await import("../meet/session.js");
...
const app = createApp({ startMeet: (meet) => MeetSession.start(meet, () => {}) });
```
Tests that need an env value different from `src/test/setup.ts` set `process.env.X` before the first `config()` call, in their own file, because `config()` caches (precedent: `src/web/meet-login-mail-cap.test.ts:8`).
Each `*.test.ts` file runs in its own process under `node --test`, so this does not leak into other files.

### API JSON errors
No existing pattern in this repo - establishing new convention: `src/api/routes.ts` answers every error through one helper `fail(c, status, code, message)` producing `{ error: { code, message } }`; codes are snake_case (`already_recording`, `webhook_url_required`, `email_not_configured`).

## Preflight

### DURABLE - true until the repo itself changes

- npm, no workspaces; `meet/` is a separate npm package - Evidence: root `package.json` has no `workspaces`; `meet/package.json` has its own scripts - Consequence: Tasks 11 and 16 also run `cd meet && npm run typecheck && npm test`.
- Root tests are `node --import tsx --experimental-test-module-mocks --test 'src/**/*.test.ts'` and `tsconfig.test.json` covers all of `src` - Evidence: `package.json` `scripts.test` - Consequence: new `src/api/*.test.ts` files run automatically; `scripts/check-licenses.mjs` (Task 19) is outside `src/` and is not typechecked or tested by `npm test`.
- `mock.module` replaces a module only for imports after it; a mocked module must export every name its importers use, so adding `listKeys` to `src/storage/r2.ts` means adding it to `mockR2()` in the same task (Task 11) - Evidence: `src/test/setup.ts:46-64`.
- `fakeMeetRecorder()` and `mockOpenRouter()` both replace `globalThis.fetch`, so webhook delivery must not use `fetch` directly in tested paths; it goes through `src/api/webhook-send.ts`, replaced by `mockWebhooks()` - Evidence: `src/test/setup.ts:93-101,120-148`.
- The R2 client has no list function today and `@aws-sdk/client-s3` exports `ListObjectsV2Command` - Evidence: `src/storage/r2.ts:4` imports only `GetObjectCommand, PutObjectCommand, S3Client`.
- The allowlist helpers exist in history only - Evidence: `git show bb746d1:src/util/email.ts` prints `parseAllowlist`, `invalidAllowlistEntries`, `isAllowed`; the reference code in Task 2 is copied from it.
- `users()` / `src/users/store.js` is imported by exactly `src/index.ts`, `src/meet/session.ts`, `src/web/meet-routes.ts`, `src/web/templates.ts` (type `User`), and the tests `src/meet/session.test.ts`, `src/web/meet-routes.test.ts`, `src/web/meet-login-mail-cap.test.ts`, `src/web/meet-signup-cap.test.ts`, `src/users/store.test.ts` - Evidence: `grep -rln "users/store" src` - Consequence: Tasks 1 and 3 edit exactly these.
- `MeetInfo` is constructed by hand in `src/web/meet-routes.ts` (start), `src/meet/session.test.ts` (`harness`), `src/pipeline/run.test.ts` (`meetRecording`), and read in `src/meet/session.ts`, `src/pipeline/run.ts`, `src/web/meet-routes.ts`, `src/web/templates.ts` (`MeetRecordingView`), `src/storage/manifest.ts` - Evidence: `grep -rn "startedBy\|trigger" src --include=*.ts` - Consequence: Task 9 lists them.
- treehouse is not needed: single sequential track.
- `git filter-repo` is not installed - Evidence: `git filter-repo --version` prints `git: 'filter-repo' is not a git command` - Consequence: Task 22 installs it (`brew install git-filter-repo`) only if the user picks a rewrite option.

### PERISHABLE - recapture before task 1

- Baseline gate is green - Check: `npm run typecheck; npm test 2>&1 | grep -E '^# (tests|pass|fail)'; (cd meet && npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)')` - Value at planning (2026-11-21, 883fa96): both typechecks exit 0; root `# tests 92`, `# pass 92`, `# fail 0`; meet `# tests 20`, `# pass 20`, `# fail 0` - Needed by: every Verify that states a count.
  Counts in later Verify lines are "baseline plus the tests that task adds or removes"; if the baseline differs (the UX commits the user is landing add or remove tests), shift every count by the same difference.
- HEAD moved since planning (UX commits on `src/web/templates.ts`, `src/web/meet-routes.ts`) - Check: `git log --oneline 883fa96..HEAD -- src/web src/meet` - Needed by: Tasks 1, 3, 9, 17, whose anchors are symbol names; re-grep each anchor before editing.
- Old plan state - Check: `ls src/calendar 2>/dev/null; grep -c '^- \[x\]' docs/plans/2026-11-01-meet-calendar-web-email.md` - Value at planning: no `src/calendar/` (Tasks 12-13 not executed) - Needed by: Task 3 (Gotcha) and Task 4.
- Dependencies installed - Check: `test -d node_modules && test -d meet/node_modules && echo deps-ok` - Value at planning: `deps-ok`.
- Node and ffmpeg - Check: `node --version; which ffmpeg >/dev/null && echo ffmpeg-ok` - Value at planning: `v22.19.0`, `ffmpeg-ok` - Needed by: root `npm test` (pipeline tests run real ffmpeg).
- Branch and staging - Check: `git status --short --branch | head -3` - Needed by: every commit (explicit `git add` paths).
- Live prerequisites (only for the real-room part of `## End-to-end verification`): the deployed recorder Worker, a Resend key, an API key and webhook secret in `.env` - Check: `for k in MEET_RECORDER_URL MEET_RECORDER_TOKEN RESEND_API_KEY EMAIL_FROM ALLOWED_EMAILS API_KEYS WEBHOOK_SECRET; do grep -q "^$k=." .env && echo "$k set" || echo "$k MISSING"; done` (prints names only) - Value at planning: not checked (reading `.env` was not allowed).

## Execution

**Tracks:** one sequential track, Tasks 1-22 in order, in the current checkout on `feat/meet-recording`.
Most tasks touch `src/config.ts`, `src/test/setup.ts`, `src/index.ts`, or `src/meet/session.ts`, so parallel tracks would collide.
Tasks 16, 18, 19, and 20 (license, cleanup, license check, contributing docs) touch only root files and docs and may be done earlier, between any two tasks, without changing anything else.
**Merge order:** not applicable (one branch); the user decides when to merge `feat/meet-recording` (see Task 22 for the merge into `main`).
**Shared files:** `src/config.ts`, `.env.example`, and the env block of `src/test/setup.ts`: Tasks 1, 2, 3, 6, 17 in order; `mockR2()` in `src/test/setup.ts`: Task 11; `mockWebhooks()`: Task 8; `src/index.ts`: Tasks 3, 6, 10; `src/web/server.ts`: Tasks 6, 12, 13; `package.json`: Tasks 16, 19; `README.md`: Tasks 4, 15, 16, 21; `AGENTS.md`: Tasks 4, 10, 20, 21; the older plan's file: Task 4.

## Git history decision

Facts (audit 2026-11-21, values described by shape only):
- Already public on `origin/main` (9 commits): the Cloudflare account id in `.env.example` (5dd2f1f, still at the tip of `origin/main` and in `origin/rust-migration`), the same id inside a registry image reference in `meet/wrangler.deploy.jsonc` (1b6f34a, still tracked at the tip of `origin/main`), and a `/Users/<user>/...` path plus the real Meet room code in both 2026-10-28 plan docs (64bec47).
- Also public on `origin/rust-migration`: a real-looking Discord id in `rust/spikes/README.md` (2dc9e00).
- Not pushed, only on `feat/meet-recording` (53 commits): the bot account's personal gmail address and the real sending domain with two addresses on it (25c8c22, bb746d1, 5ee1929); later commits removed them from the tree, but history keeps them.
- All 79 commits carry the author's personal gmail as author and committer (already public).
- An account id is an identifier, not a credential (API tokens are what grant access), but it narrows targeting; a Meet room code lets anyone knock on that room; a home path reveals a username.

Options:
1. **Leave history as it is.**
   No effort, no broken SHAs.
   Pushing `feat/meet-recording` publishes the bot address and the sending domain forever; the already-public values stay.
2. **Rewrite only the unpushed commits, then push.**
   `git filter-repo --refs 478be16..feat/meet-recording --replace-text <file>` (or the same with `feat/meet-track-b`/`-c` deleted first) rewrites the 53 local commits; `origin/main` is untouched, nobody else is affected, no force-push.
   The bot address and the domain never become public; the account id, the home path, and the Meet code on `origin/main` stay public.
   Plan docs that cite SHAs of the rewritten commits (for example "Base commit: 883fa96" here and "478fc65" in the older plan) no longer resolve; Task 21 updates them in the same pass.
3. **Rewrite everything and force-push `origin`.**
   `git filter-repo --replace-text <file> --path meet/wrangler.deploy.jsonc --invert-paths` over all branches, then `git push --force --all`; optionally `--mailmap` to a GitHub `noreply` author address.
   Cleans every branch, but rewrites every public SHA: existing clones and forks keep the old objects, GitHub may keep old commits reachable by SHA and in cached views until GitHub Support purges them, and anyone who cloned must re-clone.
   It cannot take back what was already fetched.

Recommendation: **Option 2 always, before the first push of `feat/meet-recording`; Option 3 in addition only if the repo has no forks and the user accepts re-cloning** (check `gh repo view --json forkCount,stargazerCount`).
Option 2 is cheap and removes the only items that are not yet public.
For the already-public items, rewriting helps only if nobody has a copy, and the account id cannot be rotated: if forks exist, accept them, stop using that Meet room code, and keep `.env.example` and `meet/wrangler.deploy.jsonc` placeholder-only from now on.
Either way, do it exactly once, as the last step (Task 22), so the rewrite is not repeated after later commits.
The commit author address is the user's call (Open question 5).

---

### Phase 1: the engine scope (service concerns leave)

#### Task 1: Drop the per-person recording limits

The global limits (one per Meet code, at most 2) stay; `MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER`, and the refusal reasons `user_busy` and `daily_limit` go.
The user store keeps `recordStart`/`startsToday` until Task 3 deletes the whole store (unused for one commit).

**Files:**
- Modify: `src/meet/session.ts` (anchors: `export type RefusalReason`, `const REFUSALS`, in `static async start`: `const running =`, `users().startsToday`, `users().recordStart`, `import { users }`)
- Modify: `src/meet/session.test.ts` (anchors: test `one person runs one recording at a time and starts at most 5 in 24 hours`, `const { users } = await import`, comment `Different starters, so the per-person limit`)
- Modify: `src/web/meet-routes.ts` (anchor: `case "user_busy":`, `const limits = config();` in `app.post("/start"`)
- Modify: `src/web/meet-routes.test.ts` (anchors: test `a person who used up the daily limit is told so`, `const mine = await post` in test `bad input, a recorder error, and the limits are explained`)
- Modify: `src/email/messages.ts` (anchor: `export function calendarRefusedMail`)
- Modify: `src/email/messages.test.ts` (anchor: `const daily = calendarRefusedMail`)
- Modify: `src/config.ts` (anchors: `MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER`), `src/test/setup.ts` (same two keys), `.env.example` (anchor: `# Per person, web and calendar together`)

**Interfaces:**
- Produces: `export type RefusalReason = "already_recording" | "busy";` (consumed by `calendarRefusedMail` and, later, the older plan's Task 13 and this plan's Task 11).

**Gotcha:** this is one task although it touches 9 files: removing two members of `RefusalReason` breaks `calendarRefusedMail`'s record and both `switch` statements in the same compile, so splitting it gives a red commit.

**Steps:**
- [ ] Step 1: In `src/meet/session.ts`: delete `import { users } from "../users/store.js";`; replace the type and the record with
      ```ts
      export type RefusalReason = "already_recording" | "busy";

      const REFUSALS: Record<RefusalReason, string> = {
        already_recording: "this Google Meet call is already being recorded",
        busy: `at most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once`,
      };
      ```
      and in `static async start` delete the lines `const running = ...`, `if (running >= c.MEET_MAX_ACTIVE_PER_USER) ...`, `if (users().startsToday(...)) ...`, the comment `// Counted before the recorder is asked...`, and `users().recordStart(meet.startedBy, now);`, so the checks read:
      ```ts
          // Checked and registered in one synchronous block, so two starts at the same moment cannot both pass.
          if (activeMeets.has(meet.code)) throw new MeetRefused("already_recording");
          if (activeMeets.size >= MAX_MEET_RECORDINGS) throw new MeetRefused("busy");
      ```
- [ ] Step 2: In `src/meet/session.test.ts` delete the whole test `one person runs one recording at a time and starts at most 5 in 24 hours; refused starts reach no recorder`, the line `const { users } = await import("../users/store.js");`, and the comment line `// Different starters, so the per-person limit of Task 7b is not what refuses here.`
- [ ] Step 3: In `src/web/meet-routes.ts` `app.post("/start")`, delete `const limits = config();` and the `case "user_busy":` and `case "daily_limit":` arms (4 lines with their `return again(...)`).
- [ ] Step 4: In `src/web/meet-routes.test.ts` delete the test `a person who used up the daily limit is told so and nothing is started`; in the test `bad input, a recorder error, and the limits are explained on the page` replace the lines from `const mine = await post(` through `assert.match(await third.text(), /2 ห้องแล้ว/);` with
      ```ts
        assert.equal((await post("/meet/start", { url: "https://meet.google.com/pqr-stuv-wxy", emails: "" }, { cookie })).status, 303, "one person may run both slots");
        const lee = await signIn("lee@planthia.test");
        const third = await post("/meet/start", { url: "https://meet.google.com/xyz-abcd-efg", emails: "" }, { cookie: lee });
        assert.equal(third.status, 503);
        assert.match(await third.text(), /2 ห้องแล้ว/);
      ```
- [ ] Step 5: In `src/email/messages.ts` replace the end of `calendarRefusedMail` (from `const c = config();` to the closing brace) with
      ```ts
        const why = o.reason === "busy" ? "ตอนนี้บันทึก Google Meet อยู่ 2 ห้องแล้ว ซึ่งเป็นจำนวนสูงสุด" : "เปิดเครื่องบันทึกไม่สำเร็จ";
        return mail(`ไม่ได้บันทึก Google Meet - ${o.title}`, [
          `${head} เพราะ${why} เริ่มบันทึกเองได้ที่หน้าเว็บ`,
          { url: `${base()}/meet`, label: "เริ่มบันทึกเอง" },
        ]);
      }
      ```
      In `src/email/messages.test.ts` delete the 4 lines from `const daily = calendarRefusedMail` through the `user_busy` assertion.
- [ ] Step 6: Delete `MEET_MAX_ACTIVE_PER_USER` and `MEET_MAX_DAILY_PER_USER` (with their doc comments) from `src/config.ts`, the same two lines from the env block of `src/test/setup.ts`, and from `.env.example` the comment `# Per person, web and calendar together: ...` plus its two lines.
- [ ] Step 7: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 90`, `# pass 90`, `# fail 0` (92 minus the two deleted tests); `grep -rn "user_busy\|daily_limit\|MEET_MAX_ACTIVE\|MEET_MAX_DAILY" src .env.example` prints nothing.
- [ ] Step 8: Commit - `git add src/meet/session.ts src/meet/session.test.ts src/web/meet-routes.ts src/web/meet-routes.test.ts src/email/messages.ts src/email/messages.test.ts src/config.ts src/test/setup.ts .env.example && git commit -m "refactor(meet): drop the per-person recording limits"`

#### Task 2: Restore the `ALLOWED_EMAILS` allowlist helpers and setting

Adds the allowlist next to the user store; nothing reads it until Task 3.

**Files:**
- Modify: `src/util/email.ts` (append after `parseEmailList`)
- Modify: `src/util/email.test.ts` (append one test)
- Modify: `src/config.ts` (anchor: `SEED_ADMIN_EMAIL:`; add the import of `parseAllowlist, invalidAllowlistEntries`)
- Modify: `src/test/setup.ts` (env block), `.env.example` (anchor: `# Required when Google Meet recording is on. Anyone can sign up`)

**Interfaces:**
- Produces: `interface Allowlist { emails: string[]; domains: string[] }`; `parseAllowlist(text: string | undefined): Allowlist`; `invalidAllowlistEntries(a: Allowlist): string[]`; `isAllowed(email: string, a: Allowlist): boolean`; `config().ALLOWED_EMAILS: Allowlist`.

**Steps:**
- [ ] Step 1: Append to `src/util/email.ts` (the code of bb746d1, plus `DOMAIN_RE` under `ADDRESS_RE`):
      ```ts
      const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
      ```
      ```ts
      /** Who may use the /meet page and whose calendar events are recorded: exact addresses, and whole domains written as "@example.com". */
      export interface Allowlist {
        emails: string[];
        domains: string[];
      }

      export function parseAllowlist(text: string | undefined): Allowlist {
        const a: Allowlist = { emails: [], domains: [] };
        for (const part of (text ?? "").split(/[\s,;]+/).filter(Boolean)) {
          const p = part.toLowerCase();
          if (p.startsWith("@")) a.domains.push(p.slice(1));
          else a.emails.push(p);
        }
        return a;
      }

      /** Entries that are neither an address nor an "@domain"; config refuses to start with any. */
      export function invalidAllowlistEntries(a: Allowlist): string[] {
        return [...a.emails.filter((e) => !normalizeEmail(e)), ...a.domains.filter((d) => !DOMAIN_RE.test(d)).map((d) => `@${d}`)];
      }

      /** Exact address match, or the address's domain is listed (subdomains are not). */
      export function isAllowed(email: string, a: Allowlist): boolean {
        const e = email.toLowerCase();
        return a.emails.includes(e) || a.domains.includes(e.slice(e.lastIndexOf("@") + 1));
      }
      ```
- [ ] Step 2: Append to `src/util/email.test.ts` (and add `invalidAllowlistEntries, isAllowed, parseAllowlist` to its import):
      ```ts
      test("the allowlist matches exact addresses and whole domains, not subdomains", () => {
        const a = parseAllowlist("Alice@Example.com, @planthia.test");
        assert.deepEqual(a, { emails: ["alice@example.com"], domains: ["planthia.test"] });
        assert.equal(isAllowed("ALICE@example.com", a), true);
        assert.equal(isAllowed("bob@example.com", a), false);
        assert.equal(isAllowed("carol@planthia.test", a), true);
        assert.equal(isAllowed("dave@eu.planthia.test", a), false);
        assert.equal(isAllowed("mallory@planthia.test.evil.test", a), false);
        assert.deepEqual(parseAllowlist(undefined), { emails: [], domains: [] });
        assert.deepEqual(invalidAllowlistEntries(parseAllowlist("ok@example.com, nope, @bad_domain")), ["nope", "@bad_domain"]);
      });
      ```
- [ ] Step 3: In `src/config.ts` add `import { invalidAllowlistEntries, parseAllowlist } from "./util/email.js";`, and above `SEED_ADMIN_EMAIL` add
      ```ts
        /** Who may sign in on /meet and whose calendar events are recorded: addresses and whole domains as "@example.com", comma separated. */
        ALLOWED_EMAILS: z.preprocess(blank, z.string().optional()).transform(parseAllowlist),
      ```
      and at the end of `superRefine`:
      ```ts
        for (const bad of invalidAllowlistEntries(c.ALLOWED_EMAILS)) {
          need(false, "ALLOWED_EMAILS", `"${bad}" is neither an email address nor an @domain`);
        }
      ```
      `src/util/email.ts` imports nothing, so there is no import cycle.
- [ ] Step 4: Add `ALLOWED_EMAILS: "@example.com, @planthia.test",` to the env block of `src/test/setup.ts` (every address the web tests sign in with after Task 3 is on one of these domains).
      In `.env.example`, above the `SEED_ADMIN_EMAIL` comment, add
      ```
      # Who may sign in on <PUBLIC_BASE_URL>/meet and whose calendar invitations are recorded:
      # addresses and whole domains, comma separated, e.g. alice@example.com, @example.org
      ALLOWED_EMAILS=
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 91`, `# pass 91`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/util/email.ts src/util/email.test.ts src/config.ts src/test/setup.ts .env.example && git commit -m "feat(config): add the ALLOWED_EMAILS allowlist"`

#### Task 3: Sign in by the allowlist; remove open signup, the user store, and the admin page

**Files:**
- Delete: `src/users/store.ts`, `src/users/store.test.ts`, `src/web/meet-signup-cap.test.ts`
- Modify: `src/web/meet-routes.ts` (anchors: `import { users }`, `MAX_SIGNUP_EMAILS_PER_DAY`, `signupsPerIp`, `function user(c: Context)`, `const recorderPage`, `app.post("/login"`, `app.post("/auth"`, `const admin = (c: Context)`, `app.get("/admin"`, `app.post("/admin/status"`)
- Modify: `src/web/meet-routes.test.ts` (tests listed in Step 3)
- Modify: `src/web/meet-login-mail-cap.test.ts`
- Modify: `src/web/templates.ts` (anchors: `import type { User }`, `import { bangkokDateTime }`, `button.enable{`, `meetLogin:`, `meetAccountDisabled:`, `isAdmin?: boolean;`, `o.isAdmin ?`, `meetAdmin:`)
- Modify: `src/web/templates.test.ts` (anchors: `การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้`, `page.meetAccountDisabled()`, test `the admin page lists accounts`)
- Modify: `src/email/messages.ts` (anchor: `export function loginMail`)
- Modify: `src/index.ts` (anchors: `import { users }`, `const people = users();`)
- Modify: `src/config.ts` (anchors: `SEED_ADMIN_EMAIL`, `need(c.SEED_ADMIN_EMAIL`), `src/test/setup.ts` (`SEED_ADMIN_EMAIL`), `.env.example` (the `SEED_ADMIN_EMAIL` block and the `MEET_LOGIN_MAIL_DAILY_CAP` comment)

**Interfaces:**
- Consumes: `isAllowed`, `config().ALLOWED_EMAILS` (Task 2).
- Produces: `/meet` routes `GET /`, `POST /login`, `GET /auth`, `POST /auth`, `POST /logout`, `POST /start`, `POST /stop` only; `page.meetRecorder(o: { email: string; recordings: MeetRecordingView[]; error?: string; values?: { url: string; emails: string } })`.

**Gotcha:** if the older plan's Tasks 12-13 already ran (`src/calendar/poller.ts` exists), also replace `users().active(o.organizer)` there with `isAllowed(o.organizer, config().ALLOWED_EMAILS)`, drop its `user_busy` branch, and in `src/calendar/poller.test.ts` delete the `users().signIn`/`setStatus` lines of `beforeEach` (the fixture organizers alice and carol are on `@planthia.test`, which the test env allows; check that mallory's domain is not allowed); list those files in the commit.
`tsc` does not report unused imports here (no `noUnusedLocals`), so remove `bangkokDateTime` from `templates.ts` by hand once `meetAdmin` is gone, and check `grep -n bangkokDateTime src/web/templates.ts` prints nothing.

**Steps:**
- [ ] Step 1: `git rm src/users/store.ts src/users/store.test.ts src/web/meet-signup-cap.test.ts`.
- [ ] Step 2: In `src/web/meet-routes.ts`:
      - imports: drop `users`; import `isAllowed, normalizeEmail, parseEmailList` from `../util/email.js`.
      - delete `MAX_SIGNUP_EMAILS_PER_DAY` (with its comment), `signupEmails`, `signupsPerIp` (with its comment); keep `DAY_MS`, `linksPerIp`, `linksPerEmail`.
      - replace `user`:
        ```ts
        /** The signed-in person, while their cookie is valid and their address is on ALLOWED_EMAILS (checked on every request). */
        function user(c: Context): string | undefined {
          const email = verifyUser(getCookie(c, USER_COOKIE), config().SESSION_SECRET);
          return email && isAllowed(email, config().ALLOWED_EMAILS) ? email : undefined;
        }
        ```
      - `recorderPage`: `page.meetRecorder({ email, recordings: visibleTo(email).map(view), ...extra })`.
      - `app.post("/login")`: replace the block from `const account = users().get(email);` up to the `sendEmail` branch with
        ```ts
            if (!isAllowed(email, config().ALLOWED_EMAILS)) {
              log.warn(`login link not sent to ${email}: not on ALLOWED_EMAILS`);
            } else if (!loginEmails.take("all")) {
              log.error(`login link not sent to ${email}: ${config().MEET_LOGIN_MAIL_DAILY_CAP} login emails were sent in the last 24 hours (MEET_LOGIN_MAIL_DAILY_CAP)`);
            } else {
              // Not awaited: an allowed address must not answer slower than one that is not.
              sendEmail({ to: email, ...loginMail(`${base()}/meet/auth?t=${createLoginLink(email)}`) }).then(
                () => log.info(`login link sent to ${email}`),
                (err) => log.error(`could not send a login link to ${email}`, err),
              );
            }
            // The same answer for every address, so the page does not tell who is on the allowlist.
            return c.html(page.meetLoginSent());
        ```
      - `app.post("/auth")`: after `if (!email) return c.html(page.meetLinkInvalid(), 400);` replace everything up to `setCookie(` with
        ```ts
            // ALLOWED_EMAILS may have changed (restart) since the link was sent.
            if (!isAllowed(email, config().ALLOWED_EMAILS)) return c.html(page.meetLinkInvalid(), 400);
        ```
        and the log line with `log.info(`${email} signed in to the Google Meet page`);`.
      - delete the `admin` helper and the `app.get("/admin")` and `app.post("/admin/status")` routes; update the doc comment of `meetRoutes` to "magic-link login for ALLOWED_EMAILS, then start, follow, and stop recordings".
- [ ] Step 3: In `src/web/meet-routes.test.ts`:
      - drop `const { users } = await import("../users/store.js");` and add `const { config } = await import("../config.js");`.
      - test 1: rename to `an allowed address gets a single-use link by email, the link only asks to confirm, and confirming signs in`, and delete the `users()` lines (`asking for a link creates no account`, `opening the link creates no account`, and the four lines from `const alice = users().get` to `assert.ok(alice.lastLoginAt);`).
      - test 2: replace with
        ```ts
        test("allowed and other addresses get the same answer, only allowed ones get a link, and a form from another site is refused", async () => {
          await signIn("old@planthia.test");
          sentEmails.length = 0;
          const answers = [];
          for (const email of ["stranger@nowhere.test", "old@planthia.test"]) {
            const res = await post("/meet/login", { email });
            answers.push([res.status, await res.text()]);
          }
          assert.deepEqual(answers[1], answers[0]);
          assert.deepEqual(sentEmails.map((e) => e.to), ["old@planthia.test"]);
          const crossSite = await app.request("/meet/login", {
            method: "POST",
            body: new URLSearchParams({ email: "old@planthia.test" }),
            headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": newIp(), origin: "https://evil.test" },
          });
          assert.equal(crossSite.status, 403, "a form posted from another site is refused");
          assert.equal(sentEmails.length, 1);
        });
        ```
      - test 3: rename to `link requests are limited per email and per IP, whether or not the address is allowed`, and delete its lines from `const home = newIp();` to the end of the test body.
      - replace the test `disabling an account signs it out at once, ...` with
        ```ts
        test("an address taken off the allowlist is signed out at once, and a link sent before that no longer signs it in", async () => {
          const allow = config().ALLOWED_EMAILS.emails;
          allow.push("nora@nowhere.test"); // as if ALLOWED_EMAILS listed her before a restart
          const nora = await signIn("nora@nowhere.test");
          await post("/meet/login", { email: "nora@nowhere.test" });
          const token = tokenIn(sentEmails.at(-1)!.text)!;
          allow.splice(allow.indexOf("nora@nowhere.test"), 1);
          assert.match(await (await get("/meet", nora)).text(), /name="email"/, "the cookie no longer works");
          assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie: nora })).status, 303);
          assert.equal(activeMeets.size, 0);
          const late = await post("/meet/auth", { t: token });
          assert.equal(late.status, 400);
          assert.equal(late.headers.get("set-cookie"), null);
        });
        ```
      - delete the two admin tests (`an admin lists accounts ...` and `the admin pages answer 404 ...`).
      - the `signIn` helper comment: "Requests a link, takes it from the fake inbox, confirms it, and returns the cookie header value."
- [ ] Step 4: In `src/web/meet-login-mail-cap.test.ts` drop the `users` import and the two `users().signIn(...)` lines, and rename the test to `after MEET_LOGIN_MAIL_DAILY_CAP login emails in 24 hours, nobody gets a link and the answer stays the same` (all its addresses are on `@example.com`, which the test env allows).
- [ ] Step 5: In `src/web/templates.ts`: delete `import type { User }`, `import { bangkokDateTime }` (only `meetAdmin` used it), the `button.enable{...}` CSS line, `meetAccountDisabled`, `meetAdmin`, the `isAdmin?: boolean;` field, and the `${o.isAdmin ? ... : ""}` part of the links line (leaving `<a class="refresh" href="/meet">รีเฟรชสถานะ</a> · <form class="inline" ...`).
      In `meetLogin` replace the `<p class="meta">` text with `ใส่อีเมลของคุณ แล้วบอทจะส่งลิงก์เข้าสู่ระบบไปให้ ถ้าอีเมลนี้ได้รับอนุญาตให้ใช้งาน ลิงก์ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว`.
- [ ] Step 6: In `src/web/templates.test.ts`: replace the `การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้` assertion with `assert.doesNotMatch(page.meetLogin({}), /สร้างบัญชี/, "there are no accounts to create");`, delete the `page.meetAccountDisabled()` line, and delete the test `the admin page lists accounts with their state, ...`.
- [ ] Step 7: In `src/email/messages.ts` `loginMail`, the first paragraph becomes `กดปุ่มด้านล่างเพื่อเข้าสู่ระบบหน้าบันทึก Google Meet ลิงก์นี้ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว`.
- [ ] Step 8: In `src/index.ts` delete `import { users } from "./users/store.js";` and the three lines from the comment `// Also fails fast: a damaged users.json ...` through `if (c.SEED_ADMIN_EMAIL) people.seedAdmin(...)`.
- [ ] Step 9: In `src/config.ts` delete `SEED_ADMIN_EMAIL` (with its comment) and replace `need(c.SEED_ADMIN_EMAIL, ...)` with
      ```ts
          need(c.ALLOWED_EMAILS.emails.length + c.ALLOWED_EMAILS.domains.length > 0, "ALLOWED_EMAILS", "set who may sign in on the Google Meet page: ALLOWED_EMAILS");
      ```
      Delete `SEED_ADMIN_EMAIL` from `src/test/setup.ts`.
      In `.env.example` delete the two comment lines `# Required when Google Meet recording is on. Anyone can sign up ...` plus `SEED_ADMIN_EMAIL=`, and change the cap comment to `# Login emails in 24 hours, all addresses together; over it nobody gets a link`.
- [ ] Step 10: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'; grep -rn "users/store\|SEED_ADMIN\|isAdmin\|meetAdmin\|signupsPerIp\|MAX_SIGNUP" src .env.example` - Expected: typecheck exits 0; `# tests 80`, `# pass 80`, `# fail 0` (91 minus store 7, signup cap 1, admin routes 2, admin template 1); the grep prints nothing.
- [ ] Step 11: Commit - `git add -u src .env.example && git commit -m "refactor(web): sign in by ALLOWED_EMAILS and drop accounts, signup, and admin"` (`-u` stages only tracked files, including the deletions; check `git status --short` shows no untracked file staged).

#### Task 4: Document the engine scope and rebase the older plan's calendar tasks

**Files:**
- Modify: `README.md` (section `## Google Meet recording`, lines that mention signup, `SEED_ADMIN_EMAIL`, `/meet/admin`, per-person limits; anchors: `SEED_ADMIN_EMAIL`, `MEET_MAX_ACTIVE_PER_USER`, `MEET_LOGIN_MAIL_DAILY_CAP`)
- Modify: `AGENTS.md` (Project overview Meet paragraph "anyone who signs up"; Architecture map rows `src/web/`, `src/users/`; Security bullets on open signup, login links, `SEED_ADMIN_EMAIL`; Gotchas bullets on `users.json` and per-person limits)
- Modify: `docs/plans/2026-11-01-meet-calendar-web-email.md` (Task 13 Step 2 and Step 4 reference code; a status line at the top)
- Add: `docs/plans/2026-11-21-engine-service-split.md` (this plan, with its ticked boxes so far; later tasks' ticks and Deviation notes go into their own commits)

**Steps:**
- [ ] Step 1: README: describe `/meet` as "magic-link login for the addresses and domains in `ALLOWED_EMAILS`; there are no accounts and no signup", keep the login-mail cap sentence without "new and existing addresses", and delete the sentences on the seeded admin, the admin page, and the per-person limits; keep the 2-recording and one-per-Meet-code limits.
      Add one sentence: "Accounts, billing, and per-customer limits belong to the hosted service that uses the engine's API (`docs/api.md`), not to the engine."
- [ ] Step 2: AGENTS.md:
      - overview: "anyone on `ALLOWED_EMAILS` starts one on the `/meet` web page (magic-link login, no accounts)".
      - map: remove the `src/users/` row; `src/web/` row: "Hono playback server, PIN flow, signed cookies, `/meet` magic-link login for `ALLOWED_EMAILS` and the recorder page (meet-routes.ts), Thai HTML templates".
      - security: replace the open-signup cost bullet with "Only `ALLOWED_EMAILS` can use `/meet` and only allowed organizers trigger calendar recordings; keep `MAX_MEET_RECORDINGS` (2) and the one-per-Meet-code rule for every trigger."; in the login-links bullet replace "answers the same for new, existing, and disabled addresses" with "answers the same for allowed and other addresses" and delete "links to new addresses are capped at 50 per day in total"; replace the `SEED_ADMIN_EMAIL` bullet with "Every real address lives only in `.env`; the repo is public, so code, tests, and docs use placeholders."
      - gotchas: delete the `users.json` bullet and the per-person limits bullet.
      - add to Project overview one sentence: "The repo is the open-source engine only; accounts, billing, quotas, and customer-facing pages belong to a separate hosted service that calls the engine's HTTP API."
- [ ] Step 3: In the older plan, add under the `**Status ...**` blockquote line: `> **Rebased 2026-11-21 by docs/plans/2026-11-21-engine-service-split.md:** the user store, signup, admin page, and per-person limits are gone (Tasks 1-3 there); calendar organizers are trusted when \`isAllowed(organizer, config().ALLOWED_EMAILS)\`, and the only refusal reasons are \`already_recording\` and \`busy\`.`
      In its Task 13 reference code: in Step 2 replace `import { users } from "../users/store.js";` with `import { isAllowed } from "../util/email.js";`, replace `if (!o.organizer || !users().active(o.organizer)) {` with `if (!o.organizer || !isAllowed(o.organizer, c.ALLOWED_EMAILS)) {` and its log text `is not an active user` with `is not on ALLOWED_EMAILS`, change `(err.reason === "already_recording" || err.reason === "user_busy")` to `err.reason === "already_recording"`, and change the comment `// busy, daily_limit, or a recorder error` to `// busy or a recorder error`; in Step 4 delete the `users().signIn`/`users().setStatus` loop in `beforeEach` and its comment (alice and carol are on `@planthia.test`, which the test env allows; mallory must be on a domain that is not allowed, for example `@nowhere.test`; adjust the fixture if it is not), and drop `const { users } = await import(...)`.
      Also in its Task 13: the comment `// Only registered, active users may have the bot record their events (Decisions 6 and 22).` becomes `// Only organizers on ALLOWED_EMAILS have the bot record their events.`; the doc comment of `startOccurrence` drops "or its organizer's own recording (MEET_MAX_ACTIVE_PER_USER) has not ended yet"; delete the test `an organizer whose earlier recording still runs is told once, ...` (it scripts `new MeetRefused("user_busy")`); and replace the test `a disabled organizer's events are skipped quietly, ...` with
      ```ts
      test("an organizer not on ALLOWED_EMAILS is skipped quietly, and the occurrence is not started later", async () => {
        const allow = config().ALLOWED_EMAILS;
        allow.domains.splice(allow.domains.indexOf("planthia.test"), 1);
        allow.emails.push("alice@planthia.test"); // carol is no longer allowed, alice still is
        try {
          await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
          assert.deepEqual(started.map((s) => s.startedBy), ["alice@planthia.test"]);
          assert.equal(sentEmails.length, 0, "no email to an organizer who is not allowed");
        } finally {
          allow.domains.push("planthia.test");
          allow.emails.splice(allow.emails.indexOf("alice@planthia.test"), 1);
        }
        await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
        assert.equal(started.length, 1, "each occurrence is acted on once, also when it was skipped");
      });
      ```
      (its test file imports `config` with `const { config } = await import("../config.js");`), and rename the test `from one minute before the start, occurrences of active users with a Meet link start once; ...` to start with `from one minute before the start, occurrences of allowed organizers with a Meet link start once;`.
      In its Task 12 Step 5 replace the stated count with "the root count before Task 12 plus 4".
      Its Step 5 Expected becomes "typecheck exit 0; the root count before Task 13 plus 8, `# fail 0`" (8 new tests, not 9), and its End-to-end prerequisite counts are recomputed the same way from this plan's 106.
      Its Consumes line drops `users()` (Task 4c) and gains `isAllowed` (this plan's Task 2); its End-to-end Scenario B strangers step reads "whose address is not on `ALLOWED_EMAILS`", and Scenario C (per-person limits) is deleted.
- [ ] Step 4: Verify - Run: `grep -n "SEED_ADMIN\|/meet/admin\|MEET_MAX_ACTIVE\|MEET_MAX_DAILY\|users.json\|signs up\|sign up" README.md AGENTS.md; sed -n '/^### Task 12:/,/^### Task 14:/p' docs/plans/2026-11-01-meet-calendar-web-email.md | grep -c "users()\|user_busy\|users/store\|active user"` - Expected: the first grep prints nothing; the second prints `0` (Tasks 12-13 no longer use the store; earlier tasks are history and stay).
- [ ] Step 5: Commit - `git add README.md AGENTS.md docs/plans/2026-11-01-meet-calendar-web-email.md docs/plans/2026-11-21-engine-service-split.md && git commit -m "docs: describe the engine scope and rebase the calendar tasks"`

---

### Phase 2: the HTTP API and signed webhooks

#### Task 5: API key and webhook URL helpers

Pure modules; nothing uses them until Task 6.

**Files:**
- Create: `src/api/clients.ts`, `src/api/clients.test.ts`
- Create: `src/api/webhook-url.ts`, `src/api/webhook-url.test.ts`

**Interfaces:**
- Produces: `interface ApiKey { name: string; key: string }`; `parseApiKeys(text: string | undefined): { keys: ApiKey[]; invalid: number[] }`; `findClient(token: string | undefined, keys: ApiKey[]): string | undefined`; `webhookProtocolOk(u: URL): boolean`; `parseOrigins(text: string | undefined): { origins: string[]; invalid: string[] }`; `resolveWebhookUrl(requested: string | undefined, c: { WEBHOOK_URL?: string; WEBHOOK_ALLOWED_ORIGINS: { origins: string[] } }): { url: string | undefined } | { error: "webhook_url_not_allowed" }`.

**Steps:**
- [ ] Step 1: Create `src/api/clients.ts`:
      ```ts
      import { createHash, timingSafeEqual } from "node:crypto";

      /** One entry of API_KEYS. The name is the client: the tenant boundary of the API. */
      export interface ApiKey {
        name: string;
        key: string;
      }

      const NAME_RE = /^[a-z0-9-]{1,32}$/;
      const KEY_RE = /^[A-Za-z0-9_-]{32,}$/;

      /**
       * "name:key,name:key". A name may appear twice (key rotation); a key may not. Bad entries are reported by
       * their 1-based position only, so a config error never prints a key.
       */
      export function parseApiKeys(text: string | undefined): { keys: ApiKey[]; invalid: number[] } {
        const keys: ApiKey[] = [];
        const invalid: number[] = [];
        const parts = (text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
        parts.forEach((part, i) => {
          const at = part.indexOf(":");
          const name = part.slice(0, at);
          const key = part.slice(at + 1);
          if (at > 0 && NAME_RE.test(name) && KEY_RE.test(key) && !keys.some((k) => k.key === key)) keys.push({ name, key });
          else invalid.push(i + 1);
        });
        return { keys, invalid };
      }

      const digest = (s: string) => createHash("sha256").update(s).digest();

      /** The client of a valid key. Every key is compared on equal-length digests, so timing tells neither which key nor its length. */
      export function findClient(token: string | undefined, keys: ApiKey[]): string | undefined {
        if (!token) return undefined;
        const given = digest(token);
        let found: string | undefined;
        for (const k of keys) if (timingSafeEqual(given, digest(k.key)) && found === undefined) found = k.name;
        return found;
      }
      ```
- [ ] Step 2: Create `src/api/clients.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { findClient, parseApiKeys } from "./clients.js";

      const K1 = "a".repeat(32);
      const K2 = "b".repeat(40);
      const K3 = "c".repeat(32);

      test("API keys parse as name:key pairs, a name may hold two keys, and bad entries are reported by position only", () => {
        const p = parseApiKeys(`service:${K1}, service:${K2},ops:${K3}, Bad Name:${K1}x, short:abc, dup:${K1}`);
        assert.deepEqual(p.keys, [
          { name: "service", key: K1 },
          { name: "service", key: K2 },
          { name: "ops", key: K3 },
        ]);
        assert.deepEqual(p.invalid, [4, 5, 6]);
        assert.deepEqual(parseApiKeys(undefined), { keys: [], invalid: [] });
      });

      test("a token finds its client; unknown, empty, shortened, and extended tokens find none", () => {
        const { keys } = parseApiKeys(`service:${K1},service:${K2},ops:${K3}`);
        assert.equal(findClient(K2, keys), "service");
        assert.equal(findClient(K3, keys), "ops");
        for (const t of [undefined, "", K1.slice(0, 31), `${K1}x`]) assert.equal(findClient(t, keys), undefined, String(t));
      });
      ```
- [ ] Step 3: Create `src/api/webhook-url.ts`:
      ```ts
      const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

      /** https anywhere; plain http only on this machine, for development. */
      export function webhookProtocolOk(u: URL): boolean {
        return u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname));
      }

      /** Comma-separated URLs reduced to their origins; entries that are not URLs are reported. */
      export function parseOrigins(text: string | undefined): { origins: string[]; invalid: string[] } {
        const origins: string[] = [];
        const invalid: string[] = [];
        for (const part of (text ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
          try {
            origins.push(new URL(part).origin);
          } catch {
            invalid.push(part);
          }
        }
        return { origins, invalid };
      }

      /**
       * Where one recording's webhooks go: the requested URL when its origin is allowed (WEBHOOK_ALLOWED_ORIGINS or the
       * origin of WEBHOOK_URL), else WEBHOOK_URL. An API key must not be able to make the engine post to any host it likes.
       */
      export function resolveWebhookUrl(
        requested: string | undefined,
        c: { WEBHOOK_URL?: string; WEBHOOK_ALLOWED_ORIGINS: { origins: string[] } },
      ): { url: string | undefined } | { error: "webhook_url_not_allowed" } {
        if (requested === undefined) return { url: c.WEBHOOK_URL };
        let u: URL;
        try {
          u = new URL(requested);
        } catch {
          return { error: "webhook_url_not_allowed" };
        }
        const allowed = new Set(c.WEBHOOK_ALLOWED_ORIGINS.origins);
        if (c.WEBHOOK_URL) allowed.add(new URL(c.WEBHOOK_URL).origin);
        return webhookProtocolOk(u) && allowed.has(u.origin) ? { url: u.href } : { error: "webhook_url_not_allowed" };
      }
      ```
- [ ] Step 4: Create `src/api/webhook-url.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { parseOrigins, resolveWebhookUrl } from "./webhook-url.js";

      test("allowed origins parse to their origin form, and entries that are not URLs are reported", () => {
        assert.deepEqual(parseOrigins("https://a.example.com/x, http://localhost:9999, nope"), {
          origins: ["https://a.example.com", "http://localhost:9999"],
          invalid: ["nope"],
        });
      });

      test("a requested webhook URL must be https, or http on localhost, on an allowed origin; without one the default is used", () => {
        const c = { WEBHOOK_URL: "https://service.example.com/hooks", WEBHOOK_ALLOWED_ORIGINS: parseOrigins("https://other.example.com, http://127.0.0.1:9999") };
        assert.deepEqual(resolveWebhookUrl(undefined, c), { url: "https://service.example.com/hooks" });
        assert.deepEqual(resolveWebhookUrl("https://service.example.com/t/1", c), { url: "https://service.example.com/t/1" });
        assert.deepEqual(resolveWebhookUrl("https://other.example.com/h", c), { url: "https://other.example.com/h" });
        assert.deepEqual(resolveWebhookUrl("http://127.0.0.1:9999/h", c), { url: "http://127.0.0.1:9999/h" });
        for (const bad of ["https://evil.test/h", "http://other.example.com/h", "ftp://other.example.com/", "not a url"]) {
          assert.deepEqual(resolveWebhookUrl(bad, c), { error: "webhook_url_not_allowed" }, bad);
        }
        assert.deepEqual(resolveWebhookUrl(undefined, { WEBHOOK_ALLOWED_ORIGINS: parseOrigins(undefined) }), { url: undefined });
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 84`, `# pass 84`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/api/clients.ts src/api/clients.test.ts src/api/webhook-url.ts src/api/webhook-url.test.ts && git commit -m "feat(api): add API key and webhook URL helpers"`

#### Task 6: API and webhook settings; each surface on only when configured

**Files:**
- Modify: `src/config.ts` (anchors: `const schema = z.object({`, `}).superRefine(`, `export function config()`; add `parseConfig`, `meetPageEnabled`, `apiEnabled`)
- Create: `src/config.test.ts`
- Modify: `src/test/setup.ts` (env block), `.env.example` (new block after the Email block)
- Modify: `src/web/server.ts` (anchors: `import { meetRecorderConfigured }`, `if (meetRecorderConfigured()) app.route("/meet"`), `src/meet/recorder-client.ts` (anchor: `export const meetRecorderConfigured`)
- Modify: `src/email/messages.ts` (anchor: `export function notRecordedMail`, its `return mail(` line)
- Modify: `src/index.ts` (anchor: `await client.login(c.DISCORD_TOKEN);`), `src/register-commands.ts` (anchor: `const rest = new REST().setToken(c.DISCORD_TOKEN);`)

**Interfaces:**
- Consumes: `parseApiKeys`, `parseOrigins`, `webhookProtocolOk` (Task 5).
- Produces: `config().DISCORD_TOKEN?: string` and `config().DISCORD_CLIENT_ID?: string` (now optional, set together); `config().API_KEYS: { keys: ApiKey[]; invalid: number[] }`, `config().API_RATE_LIMIT_PER_MIN: number`, `config().WEBHOOK_SECRET?: string`, `config().WEBHOOK_URL?: string`, `config().WEBHOOK_ALLOWED_ORIGINS: { origins: string[]; invalid: string[] }`; `parseConfig(env: NodeJS.ProcessEnv): Config`; `meetPageEnabled(c?: Config): boolean`; `apiEnabled(c?: Config): boolean`.

**Gotcha:** `Config` is `z.infer<typeof schema>`, so its shape widens (and `DISCORD_TOKEN`/`DISCORD_CLIENT_ID` become `string | undefined`, whose only readers are `src/index.ts` and `src/register-commands.ts`; `diag-commands.mts` is outside `tsconfig` and is a debug script that needs Discord set anyway); nothing in `src` builds a `Config` by hand (`grep -rn ": Config" src` shows only `config.ts`), so there are no other consumers to fix.
After Step 4 nothing uses `meetRecorderConfigured`: delete it from `src/meet/recorder-client.ts` (`grep -rn meetRecorderConfigured src` must print nothing).

**Steps:**
- [ ] Step 0: Make Discord optional, so a Meet-only or API-only engine (the hosted one included) needs no Discord app (review round 1).
      In `src/config.ts`: `DISCORD_TOKEN: z.preprocess(blank, z.string().min(1).optional()),` and the same for `DISCORD_CLIENT_ID`, with the comment `/** Discord /record. Off when unset; set both together. */`; in `superRefine` (Step 1 below) add as its first rules
      ```ts
        need(!c.DISCORD_TOKEN === !c.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID", "set DISCORD_TOKEN and DISCORD_CLIENT_ID together");
        need(c.DISCORD_TOKEN || c.MEET_RECORDER_URL, "DISCORD_TOKEN", "nothing to run: set DISCORD_TOKEN (Discord /record) or MEET_RECORDER_URL (Google Meet)");
      ```
      In `src/index.ts` replace `await client.login(c.DISCORD_TOKEN);` with
      ```ts
      if (c.DISCORD_TOKEN) await client.login(c.DISCORD_TOKEN);
      else log.info("Discord is off (DISCORD_TOKEN is not set)");
      ```
      (the client object stays: `processMeeting` takes it but uses it only for Discord manifests, and `ClientReady` never fires without a login, so Discord recovery does not run).
      In `src/register-commands.ts`, right after `const c = config();`: `if (!c.DISCORD_TOKEN || !c.DISCORD_CLIENT_ID) throw new Error("set DISCORD_TOKEN and DISCORD_CLIENT_ID to register slash commands");`.
      `.env.example`: the Discord block heading becomes `# --- Discord (optional; /record is off when DISCORD_TOKEN is unset) ---`.
- [ ] Step 1: In `src/config.ts` import `parseApiKeys` from `./api/clients.js` and `parseOrigins, webhookProtocolOk` from `./api/webhook-url.js` (both import nothing from the app), and add after `EMAIL_FROM`:
      ```ts
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
      ```
      Replace the body of `superRefine` after the `need` helper with:
      ```ts
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
      ```
      Replace `config()` with a pure parser plus the cache, and add the two surface helpers:
      ```ts
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
      ```
- [ ] Step 2: Create `src/config.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { apiEnabled, meetPageEnabled, parseConfig } from "./config.js";

      const base = {
        R2_ACCOUNT_ID: "x", R2_ACCESS_KEY_ID: "x", R2_SECRET_ACCESS_KEY: "x", R2_BUCKET: "x",
        OPENROUTER_API_KEY: "x", PUBLIC_BASE_URL: "https://meet.example.com", SESSION_SECRET: "s".repeat(40),
      };
      const recorder = { MEET_RECORDER_URL: "https://meet-recorder.example.com", MEET_RECORDER_TOKEN: "m".repeat(40) };
      const KEY = "k".repeat(40);
      const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
      const errorOf = (env: Record<string, string>) => {
        try {
          parseConfig(env);
          return "";
        } catch (err) {
          return (err as Error).message;
        }
      };

      test("an engine with only the API needs no Discord app, no email sender, and no allowlist; the /meet page needs both", () => {
        const apiOnly = parseConfig({ ...base, ...recorder, API_KEYS: `service:${KEY}` });
        assert.equal(meetPageEnabled(apiOnly), false);
        assert.equal(apiEnabled(apiOnly), true);
        assert.match(errorOf({ ...base, ...recorder }), /ALLOWED_EMAILS \(the \/meet page\) or API_KEYS/);
        assert.match(errorOf({ ...base, ...recorder, ALLOWED_EMAILS: "@example.com" }), /RESEND_API_KEY/);
        assert.match(errorOf({ ...base, API_KEYS: `service:${KEY}` }), /API_KEYS: the API starts Google Meet recordings/);
        assert.match(errorOf(base), /nothing to run/);
        assert.equal(errorOf({ ...base, DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "x" }), "", "a Discord-only engine is fine");
        assert.match(errorOf({ ...base, DISCORD_TOKEN: "x" }), /set DISCORD_TOKEN and DISCORD_CLIENT_ID together/);
      });

      test("bad API keys and webhook settings are refused, and the message never contains a key", () => {
        const msg = errorOf({ ...base, ...recorder, API_KEYS: `service:${KEY},oops:tooshort` });
        assert.match(msg, /API_KEYS: entry 2 is not <name>:<key>/);
        assert.ok(!msg.includes("tooshort") && !msg.includes(KEY));
        const withApi = { ...base, ...recorder, API_KEYS: `service:${KEY}` };
        assert.match(errorOf({ ...withApi, WEBHOOK_URL: "https://service.example.com/h" }), /WEBHOOK_SECRET: webhooks are signed/);
        assert.match(errorOf({ ...withApi, WEBHOOK_URL: "http://service.example.com/h", WEBHOOK_SECRET: SECRET }), /WEBHOOK_URL: must be https/);
        const typo = errorOf({ ...withApi, WEBHOOK_URL: "not a url/secret-token", WEBHOOK_SECRET: SECRET });
        assert.match(typo, /Invalid environment configuration[\s\S]*WEBHOOK_URL/, "a listed problem, not a crash");
        assert.ok(!typo.includes("secret-token"), "the value is never echoed");
        assert.equal(errorOf({ ...withApi, WEBHOOK_URL: "http://localhost:9999/h", WEBHOOK_SECRET: SECRET }), "");
      });
      ```
- [ ] Step 3: Add to the env block of `src/test/setup.ts`:
      ```ts
        API_KEYS: `service:${"k".repeat(40)},ops:${"o".repeat(40)}`,
        // The example secret of the Standard Webhooks specification: a public test value.
        WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        WEBHOOK_URL: "https://service.example.com/hooks/everymeet",
        WEBHOOK_ALLOWED_ORIGINS: "https://other.example.com",
      ```
      Add to `.env.example` after the Email block:
      ```
      # --- HTTP API (optional; /api/v1 is off when API_KEYS is unset; see docs/api.md) ---
      # name:key pairs, comma separated; key: openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
      # List one name twice with two keys to rotate a key without downtime.
      API_KEYS=
      API_RATE_LIMIT_PER_MIN=120
      # Signs webhooks (Standard Webhooks): echo "whsec_$(openssl rand -base64 32)"
      WEBHOOK_SECRET=
      # Default webhook URL for API recordings, https (http only on localhost)
      WEBHOOK_URL=
      # More origins a start request may name in webhookUrl, comma separated
      WEBHOOK_ALLOWED_ORIGINS=
      ```
      Also change the comment above `ALLOWED_EMAILS` to start with `# Optional: who may sign in on <PUBLIC_BASE_URL>/meet ...`, and the Email block heading to `# --- Email (Resend; required for the /meet page and the calendar) ---`.
- [ ] Step 4: In `src/web/server.ts` replace the `meetRecorderConfigured` import with `meetPageEnabled` added to the `../config.js` import, and the mount line with `if (meetPageEnabled()) app.route("/meet", meetRoutes(deps));`.
- [ ] Step 5: In `src/email/messages.ts` `notRecordedMail`, show the button only when the page exists (import `meetPageEnabled` from `../config.js`):
      ```ts
        return mail(`บันทึก Google Meet ไม่สำเร็จ - ${o.title}`, [why, ...(meetPageEnabled() ? [{ url: `${base()}/meet`, label: "เริ่มบันทึกใหม่" }] : [])]);
      ```
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 86`, `# pass 86`, `# fail 0`.
- [ ] Step 7: Commit - `git add src/config.ts src/config.test.ts src/test/setup.ts .env.example src/web/server.ts src/email/messages.ts src/index.ts src/register-commands.ts src/meet/recorder-client.ts && git commit -m "feat(config): add API and webhook settings and make Discord optional"`

#### Task 7: Standard Webhooks signatures

**Files:**
- Create: `src/api/signature.ts`, `src/api/signature.test.ts`

**Interfaces:**
- Produces: `signWebhook(secret: string, id: string, timestampSec: number, body: string): string`; `webhookHeaders(secret: string, id: string, body: string, nowSec: number): Record<string, string>`; `verifyWebhook(secret: string, h: { id: string; timestamp: string; signature: string }, body: string, nowSec: number): boolean`; `TOLERANCE_SEC = 300`.

**Steps:**
- [ ] Step 1: Create `src/api/signature.ts`:
      ```ts
      import { createHmac, timingSafeEqual } from "node:crypto";

      /** Receivers refuse a webhook whose timestamp is further than this from their clock (replay protection). */
      export const TOLERANCE_SEC = 300;

      const keyOf = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ""), "base64");

      /** The Standard Webhooks "v1," signature of one delivery attempt: HMAC-SHA256 over "<id>.<timestamp>.<body>", base64. */
      export function signWebhook(secret: string, id: string, timestampSec: number, body: string): string {
        return `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestampSec}.${body}`).digest("base64")}`;
      }

      /** Headers of one attempt; the id stays the same on every retry, the timestamp is the attempt's. */
      export function webhookHeaders(secret: string, id: string, body: string, nowSec: number): Record<string, string> {
        return { "webhook-id": id, "webhook-timestamp": String(nowSec), "webhook-signature": signWebhook(secret, id, nowSec, body) };
      }

      /** What a receiver does (used by tests and shown in docs/api.md): any listed v1 signature matches, and the time is close. */
      export function verifyWebhook(secret: string, h: { id: string; timestamp: string; signature: string }, body: string, nowSec: number): boolean {
        const ts = Number(h.timestamp);
        if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return false;
        const expected = Buffer.from(signWebhook(secret, h.id, ts, body));
        return h.signature.split(" ").some((s) => {
          const given = Buffer.from(s);
          return given.length === expected.length && timingSafeEqual(given, expected);
        });
      }
      ```
- [ ] Step 2: Create `src/api/signature.test.ts` (the vector is the example of the Standard Webhooks specification; it was recomputed with an independent HMAC implementation while planning):
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { signWebhook, verifyWebhook, webhookHeaders } from "./signature.js";

      const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
      const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
      const TS = 1614265330;
      const BODY = '{"test": 2432232314}';

      test("signatures match the Standard Webhooks example", () => {
        assert.equal(signWebhook(SECRET, ID, TS, BODY), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
        assert.deepEqual(webhookHeaders(SECRET, ID, BODY, TS), {
          "webhook-id": ID,
          "webhook-timestamp": String(TS),
          "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        });
      });

      test("a receiver accepts the signed body, also among several signatures, and refuses changes and old timestamps", () => {
        const h = { id: ID, timestamp: String(TS), signature: `v1,bm9wZQ== ${signWebhook(SECRET, ID, TS, BODY)}` };
        assert.equal(verifyWebhook(SECRET, h, BODY, TS + 10), true);
        assert.equal(verifyWebhook(SECRET, h, BODY.replace("2", "3"), TS), false, "changed body");
        assert.equal(verifyWebhook(SECRET, { ...h, id: "msg_other" }, BODY, TS), false, "changed id");
        assert.equal(verifyWebhook(SECRET, h, BODY, TS + 301), false, "too old");
        assert.equal(verifyWebhook("whsec_" + Buffer.from("x".repeat(24)).toString("base64"), h, BODY, TS), false, "other secret");
      });
      ```
- [ ] Step 3: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 88`, `# pass 88`, `# fail 0`.
- [ ] Step 4: Commit - `git add src/api/signature.ts src/api/signature.test.ts && git commit -m "feat(api): sign webhooks the Standard Webhooks way"`

#### Task 8: Durable webhook outbox with retries

**Files:**
- Create: `src/api/webhook-send.ts` (the only webhook HTTP I/O)
- Create: `src/api/outbox.ts`, `src/api/outbox.test.ts`
- Modify: `src/test/setup.ts` (add `SentWebhook`, `sentWebhooks`, `mockWebhooks` after `mockEmail`)

**Interfaces:**
- Consumes: `webhookHeaders` (Task 7), `config().WEBHOOK_SECRET`, `config().DATA_DIR`.
- Produces: `postWebhook(url: string, headers: Record<string, string>, body: string): Promise<number>`; `interface OutboxEntry { id: string; url: string; type: string; body: string; attempts: number; nextAt: number; createdAt: number }`; `enqueueWebhook(url: string, type: string, data: unknown, now?: number): OutboxEntry`; `pendingWebhooks(): OutboxEntry[]`; `deliverDue(clock?: () => number): Promise<void>`; `startOutbox(): void`; `RETRY_DELAYS_MS: number[]`; test helpers `mockWebhooks(opts?: { status?: (w: SentWebhook) => number }): void`, `sentWebhooks: SentWebhook[]`, `interface SentWebhook { url: string; headers: Record<string, string>; body: string }`.

**Gotcha:** never log a full webhook URL (its path may carry a token of the receiver); log `new URL(url).origin`.
`redirect: "manual"` makes a 3xx answer a failed attempt instead of following it to another host.

**Steps:**
- [ ] Step 1: Create `src/api/webhook-send.ts`:
      ```ts
      /** Posts one webhook attempt and returns the HTTP status; throws on a network error or after 10 s. Redirects are not followed. */
      export async function postWebhook(url: string, headers: Record<string, string>, body: string): Promise<number> {
        const res = await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", "User-Agent": "everymeet-engine/1.0" },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        await res.body?.cancel();
        return res.status;
      }
      ```
- [ ] Step 2: Create `src/api/outbox.ts`:
      ```ts
      import { randomBytes } from "node:crypto";
      import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { config } from "../config.js";
      import { logger } from "../util/log.js";
      import { webhookHeaders } from "./signature.js";
      import { postWebhook } from "./webhook-send.js";

      const log = logger("webhooks");
      /** Wait after failed attempt 1, 2, ...; the attempt after the last wait is the last one (8 in about 22 hours). */
      export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
      const TICK_MS = 15_000;

      /** One event waiting for delivery; its body is fixed when queued, so every retry sends the same bytes. */
      export interface OutboxEntry {
        /** Standard Webhooks message id ("webhook-id"), the receiver's idempotency key. */
        id: string;
        url: string;
        type: string;
        body: string;
        attempts: number;
        nextAt: number;
        createdAt: number;
      }

      const dir = (sub: "pending" | "failed") => join(config().DATA_DIR, "webhooks", sub);
      const origin = (url: string) => new URL(url).origin;

      function write(e: OutboxEntry): void {
        mkdirSync(dir("pending"), { recursive: true });
        const tmp = join(dir("pending"), `${e.id}.json.tmp`);
        writeFileSync(tmp, JSON.stringify(e));
        renameSync(tmp, join(dir("pending"), `${e.id}.json`)); // atomic replace
      }

      /** Queues one event. It is on disk before anything is sent, so a crash or restart does not lose it. */
      export function enqueueWebhook(url: string, type: string, data: unknown, now = Date.now()): OutboxEntry {
        const e: OutboxEntry = {
          id: `msg_${randomBytes(16).toString("base64url")}`,
          url,
          type,
          body: JSON.stringify({ type, timestamp: new Date(now).toISOString(), data }),
          attempts: 0,
          nextAt: now,
          createdAt: now,
        };
        write(e);
        return e;
      }

      /** Events not delivered yet, oldest first. */
      export function pendingWebhooks(): OutboxEntry[] {
        if (!existsSync(dir("pending"))) return [];
        const out: OutboxEntry[] = [];
        for (const f of readdirSync(dir("pending")).filter((f) => f.endsWith(".json"))) {
          try {
            out.push(JSON.parse(readFileSync(join(dir("pending"), f), "utf8")) as OutboxEntry);
          } catch (err) {
            // One damaged file must not stop every other delivery.
            mkdirSync(dir("failed"), { recursive: true });
            renameSync(join(dir("pending"), f), join(dir("failed"), f));
            log.error(`webhook file ${f} is not valid JSON; moved to webhooks/failed/`, err);
          }
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
      }

      let delivering = false;

      /**
       * Sends every due event, oldest first, one at a time; skipped while the previous run still goes.
       * Takes a clock, not a time: a long backlog must sign each attempt with its own time (receivers allow 5 minutes).
       */
      export async function deliverDue(clock: () => number = Date.now): Promise<void> {
        if (delivering) return;
        delivering = true;
        try {
          for (const e of pendingWebhooks()) {
            const now = clock();
            if (e.nextAt <= now) await attempt(e, now);
          }
        } finally {
          delivering = false;
        }
      }

      async function attempt(e: OutboxEntry, now: number): Promise<void> {
        let status: number | undefined;
        let why: string;
        try {
          status = await postWebhook(e.url, webhookHeaders(config().WEBHOOK_SECRET!, e.id, e.body, Math.floor(now / 1000)), e.body);
          why = `HTTP ${status}`;
        } catch (err) {
          why = (err as Error).message;
        }
        if (status !== undefined && status >= 200 && status < 300) {
          rmSync(join(dir("pending"), `${e.id}.json`), { force: true });
          log.info(`webhook ${e.type} ${e.id} delivered to ${origin(e.url)}`);
          return;
        }
        e.attempts++;
        const wait = RETRY_DELAYS_MS[e.attempts - 1];
        if (wait === undefined) {
          mkdirSync(dir("failed"), { recursive: true });
          renameSync(join(dir("pending"), `${e.id}.json`), join(dir("failed"), `${e.id}.json`));
          log.error(`webhook ${e.type} ${e.id} to ${origin(e.url)} given up after ${e.attempts} attempts (${why}); kept in webhooks/failed/`);
          return;
        }
        e.nextAt = now + wait;
        write(e);
        log.warn(`webhook ${e.type} ${e.id} to ${origin(e.url)} failed (${why}), attempt ${e.attempts}, next in ${wait / 1000} s`);
      }

      /** Delivers queued events every 15 s, starting with what a previous run left. */
      export function startOutbox(): void {
        const run = () => void deliverDue().catch((err) => log.error("webhook delivery failed", err));
        run();
        setInterval(run, TICK_MS).unref();
      }
      ```
- [ ] Step 3: Add to `src/test/setup.ts` after `mockEmail`:
      ```ts
      export interface SentWebhook {
        url: string;
        headers: Record<string, string>;
        body: string;
      }

      /** Webhook attempts that reached the fake sender, oldest first. */
      export const sentWebhooks: SentWebhook[] = [];

      /**
       * Replaces the webhook sender. Call before importing code that delivers webhooks.
       * `status` answers each attempt (default 200); throwing from it fakes a network error.
       */
      export function mockWebhooks(opts: { status?: (w: SentWebhook) => number } = {}): void {
        mock.module(new URL("../api/webhook-send.js", import.meta.url).href, {
          namedExports: {
            postWebhook: async (url: string, headers: Record<string, string>, body: string) => {
              const w = { url, headers, body };
              sentWebhooks.push(w);
              return opts.status?.(w) ?? 200;
            },
          },
        });
      }
      ```
- [ ] Step 4: Create `src/api/outbox.test.ts`:
      ```ts
      import { beforeEach, test } from "node:test";
      import assert from "node:assert/strict";
      import { existsSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { dataDir, mockWebhooks, sentWebhooks } from "../test/setup.js";

      let answer: () => number = () => 200;
      mockWebhooks({ status: () => answer() });
      const { deliverDue, enqueueWebhook, pendingWebhooks, RETRY_DELAYS_MS } = await import("./outbox.js");
      const { verifyWebhook } = await import("./signature.js");

      const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // WEBHOOK_SECRET of src/test/setup.ts
      const URL_ = "https://service.example.com/hooks/everymeet";
      const T0 = Date.UTC(2026, 10, 21, 3, 0, 0);

      beforeEach(() => {
        sentWebhooks.length = 0;
        answer = () => 200;
        rmSync(join(dataDir, "webhooks"), { recursive: true, force: true });
      });

      test("an event is on disk before it is sent, is signed with a stable id, and is removed once delivered", async () => {
        const e = enqueueWebhook(URL_, "minutes.ready", { id: "r1" }, T0);
        assert.match(e.id, /^msg_[\w-]{22}$/);
        assert.deepEqual(pendingWebhooks().map((p) => p.id), [e.id]);
        await deliverDue(() => T0);
        assert.equal(sentWebhooks.length, 1);
        const w = sentWebhooks[0]!;
        assert.equal(w.url, URL_);
        assert.equal(w.headers["webhook-id"], e.id);
        assert.equal(w.headers["webhook-timestamp"], String(T0 / 1000));
        const h = { id: e.id, timestamp: w.headers["webhook-timestamp"]!, signature: w.headers["webhook-signature"]! };
        assert.ok(verifyWebhook(SECRET, h, w.body, T0 / 1000));
        assert.deepEqual(JSON.parse(w.body), { type: "minutes.ready", timestamp: new Date(T0).toISOString(), data: { id: "r1" } });
        assert.deepEqual(pendingWebhooks(), []);
      });

      test("a refused delivery is retried with backoff, keeps its id and body, and moves to failed/ after the eighth attempt", async () => {
        answer = () => 500;
        const e = enqueueWebhook(URL_, "recording.failed", { id: "r2" }, T0);
        let now = T0;
        await deliverDue(() => now);
        assert.equal(pendingWebhooks()[0]!.nextAt, T0 + 30_000);
        await deliverDue(() => now + 29_000);
        assert.equal(sentWebhooks.length, 1, "not due yet");
        for (const wait of RETRY_DELAYS_MS) {
          now += wait;
          await deliverDue(() => now);
        }
        assert.equal(sentWebhooks.length, 8);
        assert.ok(sentWebhooks.every((w) => w.headers["webhook-id"] === e.id && w.body === sentWebhooks[0]!.body));
        assert.notEqual(sentWebhooks[7]!.headers["webhook-timestamp"], sentWebhooks[0]!.headers["webhook-timestamp"], "each attempt is signed at its own time");
        assert.deepEqual(pendingWebhooks(), []);
        assert.ok(existsSync(join(dataDir, "webhooks", "failed", `${e.id}.json`)));
      });

      test("a network error is a failed attempt, and the next success delivers the event", async () => {
        answer = () => {
          throw new TypeError("fetch failed");
        };
        enqueueWebhook(URL_, "recording.ended", { id: "r3" }, T0);
        await deliverDue(() => T0);
        assert.equal(pendingWebhooks()[0]!.attempts, 1);
        answer = () => 204;
        await deliverDue(() => T0 + 30_000);
        assert.deepEqual(pendingWebhooks(), []);
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 91`, `# pass 91`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/api/webhook-send.ts src/api/outbox.ts src/api/outbox.test.ts src/test/setup.ts && git commit -m "feat(api): add a durable webhook outbox with retries"`

#### Task 9: API owner, delivery mode, and end code on Meet manifests

Widens `MeetInfo` and adds `endCode`; email is skipped for webhook-mode recordings; no webhook is sent yet.

**Files:**
- Modify: `src/storage/manifest.ts` (anchors: `export interface MeetInfo`, `export interface MeetManifest`)
- Modify: `src/meet/session.ts` (anchors: `meet: { ...meet, recipients:` in `start`, the `log.info(`recording Google Meet` line, `m.endReason = this.stopReason ??` in `doFinish`, `private async email(`)
- Modify: `src/pipeline/run.ts` (anchors: `await emailMinutes(m,`, `if (m.meet) {` in the `catch`, `startedBy: m.meet.startedBy,` in `emailMinutes`)
- Modify: `src/email/messages.ts` (anchor: `export function notRecordedMail`)
- Modify: `src/web/meet-routes.ts` (anchor: `startedBy: s.manifest.meet.startedBy,` in `view`)
- Modify: `src/web/templates.ts` (anchors: `trigger: "calendar" | "web";` in `MeetRecordingView`, `r.trigger === "calendar" ? "จากปฏิทิน" : "จากหน้าเว็บ"`)
- Test: `src/meet/session.test.ts`, `src/pipeline/run.test.ts`

**Interfaces:**
- Produces (frozen for Tasks 10-14):
  ```ts
  export interface ApiOwner {
    /** API client name from API_KEYS: the tenant boundary. */
    client: string;
    ownerId: string;
    metadata: Record<string, string>;
    /** "email": the engine emails as for web starts; "webhook": no email at all. */
    delivery: "email" | "webhook";
    /** Where this recording's webhooks go; none when unset. */
    webhookUrl?: string;
  }
  export interface MeetInfo {
    url: string;
    code: string;
    title: string;
    trigger: "calendar" | "web" | "api";
    /** Calendar organizer, web starter, or the API's delivery.starter; failure emails go here. Absent only for API recordings in webhook mode. */
    startedBy?: string;
    /** Who gets the minutes by email: lowercase, unique, includes startedBy when set, never the bot account. */
    recipients: string[];
    api?: ApiOwner;
  }
  export interface MeetManifest extends ManifestBase {
    meet: MeetInfo;
    /** Why it ended, for machines (the API); endReason is the Thai text for people. */
    endCode?: EndReason | "recorder_lost";
  }
  /** Who gets failure and consent emails: the starter, unless the recording reports by webhook only. */
  export const emailStarter: (m: MeetManifest) => string | undefined;
  ```
- Consumers of the widened type (all edited here): `src/meet/session.ts`, `src/pipeline/run.ts`, `src/web/meet-routes.ts`, `src/web/templates.ts`; hand-built fixtures in `src/meet/session.test.ts` (`harness`) and `src/pipeline/run.test.ts` (`meetRecording`) keep compiling because the new fields are optional.

**Steps:**
- [ ] Step 1: In `src/storage/manifest.ts` add `import type { EndReason } from "../meet/protocol.js";` (protocol.ts imports nothing), replace `MeetInfo` and `MeetManifest` with the declarations above, add `ApiOwner`, and add
      ```ts
      export const emailStarter = (m: MeetManifest): string | undefined => (m.meet.api?.delivery === "webhook" ? undefined : m.meet.startedBy);
      ```
- [ ] Step 2: In `src/meet/session.ts`:
      - `start`: `meet: { ...meet, recipients: [...new Set([meet.startedBy, ...meet.recipients].filter((e): e is string => !!e))] },`
      - its log line: `` log.info(`recording Google Meet ${meet.code} as ${manifest.id} (${meet.trigger}, started by ${meet.startedBy ?? `API client ${meet.api?.client}`})`); ``
      - `doFinish`, right after `m.endReason = ...`: `m.endCode = this.stopReason ? "stopped" : (end?.reason ?? "recorder_lost");`, and pass `api: !!m.meet.api` to `notRecordedMail` (its API starter usually cannot sign in on `/meet`, so the "start again" button is left out).
      - `src/email/messages.ts` `notRecordedMail`: the parameter becomes `o: { title: string; code: string; end?: RecordingEnd; api?: boolean }` and the button condition `meetPageEnabled() && !o.api` (list `src/email/messages.ts` in this task's commit).
      - `email`:
        ```ts
          /** Emails the person who started the recording (never in webhook mode); a failed email is logged, never fatal. */
          private async email(mail: Mail): Promise<void> {
            const to = emailStarter(this.manifest);
            if (!to) return;
            try {
              await sendEmail({ to, ...mail });
            } catch (err) {
              log.error(`could not email ${to} about Google Meet recording ${this.id}`, err);
            }
          }
        ```
        (import `emailStarter` from `../storage/manifest.js`).
- [ ] Step 3: In `src/pipeline/run.ts`:
      - replace the `if (m.meet) { await emailMinutes(...) }` arm with
        ```ts
            if (m.meet) {
              const starter = emailStarter(m);
              // Webhook mode: the caller sends its own emails (minutes.ready, Task 10). Nobody spoke: only the starter is told.
              if (starter) await emailMinutes(m, t.lines.length > 0 ? m.meet.recipients : [starter], { pin, shortSummary: short, note });
            } else {
        ```
      - in the `catch`, replace the Meet arm's `sendEmail({ to: m.meet.startedBy, ...` with
        ```ts
            if (m.meet) {
              const starter = emailStarter(m);
              if (starter) {
                await sendEmail({ to: starter, ...processingFailedMail({ id: m.id, title: m.meet.title, startedAt: m.startedAt, error: m.error }) })
                  .catch((e) => log.error(`could not email the failure of ${m.id}`, e));
              }
            } else {
        ```
      - in `emailMinutes`: `startedBy: m.meet.startedBy ?? "-",`.
- [ ] Step 4: `src/web/meet-routes.ts` `view`: `startedBy: s.manifest.meet.startedBy ?? "-",`.
      `src/web/templates.ts`: `trigger: "calendar" | "web" | "api";` and the label `${r.trigger === "calendar" ? "จากปฏิทิน" : r.trigger === "api" ? "จาก API" : "จากหน้าเว็บ"}`.
- [ ] Step 5: Append to `src/meet/session.test.ts`:
      ```ts
      const API_WEBHOOK = { client: "service", ownerId: "team-1", metadata: { plan: "pro" }, delivery: "webhook" as const, webhookUrl: "https://service.example.com/hooks/everymeet" };

      test("an API recording in webhook mode emails nobody when it fails, and keeps a machine-readable end code", async () => {
        const s = await MeetSession.start({ ...MEET, title: "API call", trigger: "api", recipients: [], api: API_WEBHOOK }, () => {});
        assert.deepEqual(s.manifest.meet.recipients, []);
        remote(s.id).status = { state: "ended", segments: [], end: { reason: "not_admitted", leftCleanly: true } };
        await advance(15_000);
        assert.equal(stored(s.id).status, "failed");
        assert.equal(stored(s.id).endCode, "not_admitted");
        assert.deepEqual(sentEmails, []);
      });
      ```
      Append to `src/pipeline/run.test.ts`:
      ```ts
      const apiMeet = (delivery: "email" | "webhook", o: { silent?: boolean } = {}) => {
        const m = meetRecording(o);
        const api = { client: "service", ownerId: "team-1", metadata: { plan: "pro" }, delivery, webhookUrl: "https://service.example.com/hooks/everymeet" };
        return delivery === "webhook"
          ? { ...m, meet: { ...m.meet, trigger: "api" as const, startedBy: undefined, recipients: [], api } }
          : { ...m, meet: { ...m.meet, trigger: "api" as const, api } };
      };

      test("a Google Meet API recording in webhook mode is processed and done without any email", async () => {
        const m = apiMeet("webhook");
        sentEmails.length = 0;
        mockOpenRouter((call) =>
          call.path === "/audio/transcriptions"
            ? Response.json({ text: "", segments: [{ start: 0.3, end: 3, text: "สวัสดีครับ" }] })
            : chatReply(call.body.max_tokens <= 2_000 ? SHORT : FULL),
        );
        await processMeeting(discord([]).client, m as any);
        assert.deepEqual(sentEmails, []);
        assert.equal(manifestIn(m.id).status, "done");
      });
      ```
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 93`, `# pass 93`, `# fail 0`.
- [ ] Step 7: Commit - `git add src/storage/manifest.ts src/meet/session.ts src/email/messages.ts src/pipeline/run.ts src/web/meet-routes.ts src/web/templates.ts src/meet/session.test.ts src/pipeline/run.test.ts && git commit -m "refactor(meet): add API owner, delivery mode, and end code to Meet recordings"`

#### Task 10: Webhook events from Meet recordings and processing

**Files:**
- Create: `src/api/events.ts`
- Modify: `src/meet/session.ts` (anchors: `if (!status.consentPosted) await this.email(` in `recordingStarted`; in `doFinish`: `await this.email(notRecordedMail(`, `this.onFinished(m);`)
- Modify: `src/pipeline/run.ts` (anchors: `m.status = "done";`, the `catch` Meet arm)
- Modify: `src/index.ts` (anchor: `startWebServer({ startMeet });`)
- Modify: `AGENTS.md` (anchor: the security bullet `A Google Meet recording needs only the notice in the Meet chat`)
- Test: `src/meet/session.test.ts`, `src/pipeline/run.test.ts`

**Interfaces:**
- Consumes: `enqueueWebhook`, `pendingWebhooks`, `startOutbox` (Task 8); `MeetManifest`, `ApiOwner` (Task 9).
- Produces (frozen for Tasks 12-15):
  ```ts
  export type WebhookType = "recording.notice_failed" | "recording.ended" | "recording.failed" | "minutes.ready";
  export type ApiState = "starting" | "joining" | "waiting" | "recording" | "processing" | "done" | "failed";
  export interface RecordingView {
    id: string;
    client: string;
    ownerId: string;
    metadata: Record<string, string>;
    state: ApiState;
    stopping: boolean;
    meetCode: string;
    title: string;
    delivery: "email" | "webhook";
    /** ISO time: when the start was asked, then (once audio capture began) when capture started. */
    startedAt: string;
    endedAt?: string;
    endCode?: string;
    endReason?: string;
    durationSeconds?: number;
    playbackUrl?: string;
    summaryShort?: string;
    error?: string;
  }
  export function recordingView(m: MeetManifest, live?: { state: RecordingState; stopping: boolean }, summaryShort?: string): RecordingView;
  export function emitWebhook(m: MeetManifest, type: WebhookType, summaryShort?: string): void;
  ```

**Steps:**
- [ ] Step 1: Create `src/api/events.ts`:
      ```ts
      import { config } from "../config.js";
      import { MEET_PARTICIPANT_ID, type RecordingState } from "../meet/protocol.js";
      import type { MeetManifest } from "../storage/manifest.js";
      import { logger } from "../util/log.js";
      import { enqueueWebhook } from "./outbox.js";

      const log = logger("webhooks");

      export type WebhookType = "recording.notice_failed" | "recording.ended" | "recording.failed" | "minutes.ready";
      export type ApiState = "starting" | "joining" | "waiting" | "recording" | "processing" | "done" | "failed";

      // (RecordingView as in Interfaces above)

      const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

      function stateOf(m: MeetManifest, live?: { state: RecordingState }): ApiState {
        if (m.status !== "recording") return m.status;
        if (live) return live.state === "ended" ? "processing" : live.state;
        return m.participants[MEET_PARTICIPANT_ID] ? "recording" : "starting";
      }

      /**
       * The one shape of a recording for API answers and webhook bodies. Never the PIN, the transcript, the full
       * summary, audio links, or recipient addresses (Decision 7).
       */
      export function recordingView(m: MeetManifest, live?: { state: RecordingState; stopping: boolean }, summaryShort?: string): RecordingView {
        const api = m.meet.api!;
        const captured = !!m.participants[MEET_PARTICIPANT_ID];
        return {
          id: m.id,
          client: api.client,
          ownerId: api.ownerId,
          metadata: api.metadata,
          state: stateOf(m, live),
          stopping: live?.stopping ?? false,
          meetCode: m.meet.code,
          title: m.meet.title,
          delivery: api.delivery,
          startedAt: iso(m.startedAt)!,
          endedAt: iso(m.endedAt),
          endCode: m.endCode,
          endReason: m.endReason,
          durationSeconds: captured && m.endedAt !== undefined ? Math.round((m.endedAt - m.startedAt) / 1000) : undefined,
          playbackUrl: m.status === "done" ? `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${m.id}` : undefined,
          summaryShort,
          error: m.status === "failed" ? m.error : undefined,
        };
      }

      /** Queues a webhook for an API recording that has a webhook URL; other recordings are ignored. Never throws. */
      export function emitWebhook(m: MeetManifest, type: WebhookType, summaryShort?: string): void {
        const url = m.meet.api?.webhookUrl;
        if (!url) return;
        try {
          enqueueWebhook(url, type, recordingView(m, undefined, summaryShort));
        } catch (err) {
          log.error(`could not queue webhook ${type} for ${m.id}`, err);
        }
      }
      ```
      `JSON.stringify` drops `undefined` fields, so absent values are absent keys in the JSON.
- [ ] Step 2: `src/meet/session.ts` (import `emitWebhook` from `../api/events.js`):
      - `recordingStarted`:
        ```ts
            // The Meet chat notice is the only consent notice; if it failed, the starter (or, in webhook mode, the caller) must tell people.
            if (!status.consentPosted) {
              await this.email(consentMissingMail({ title: this.manifest.meet.title, code: this.code }));
              emitWebhook(this.manifest, "recording.notice_failed");
            }
        ```
      - `doFinish` failed branch: after `await this.email(notRecordedMail(...));` add `emitWebhook(m, "recording.failed");`.
      - `doFinish` success: right before `this.onFinished(m);` add `emitWebhook(m, "recording.ended");`.
- [ ] Step 3: `src/pipeline/run.ts` (import `emitWebhook`):
      - after `m.status = "done";` and its `await saveEverywhere(m);` add `if (m.meet) emitWebhook(m, "minutes.ready", short);` (`short` is declared before, in the same `try`).
      - in the `catch` Meet arm, after the email block, add `emitWebhook(m, "recording.failed");`.
- [ ] Step 4: `src/index.ts`: import `startOutbox` from `./api/outbox.js` and call `startOutbox();` right before `startWebServer({ startMeet });` (after `recoverUnfinished(client, "meet")`, so re-attached recordings and left-over events are both handled at boot).
- [ ] Step 5: Tests.
      In `src/meet/session.test.ts` import `pendingWebhooks` (`const { pendingWebhooks } = await import("../api/outbox.js");`) and add a helper and a test:
      ```ts
      const hooksFor = (id: string) => pendingWebhooks().map((e) => JSON.parse(e.body)).filter((b) => b.data.id === id);

      test("an API recording reports a failed chat notice and its end by webhook, and emails nobody in webhook mode", async () => {
        const s = await MeetSession.start({ ...MEET, title: "API call", trigger: "api", recipients: [], api: API_WEBHOOK }, () => {});
        remote(s.id).status = { state: "recording", captureStartedAt: NOW + MIN, consentPosted: false, segments: [] };
        await advance(15_000);
        remote(s.id).status = {
          state: "ended",
          captureStartedAt: NOW + MIN,
          consentPosted: false,
          segments: [{ index: 0, samples: SAMPLE_RATE * 60 }],
          end: { reason: "alone", leftCleanly: true },
        };
        await advance(15_000);
        const hooks = hooksFor(s.id);
        assert.deepEqual(hooks.map((h) => h.type), ["recording.notice_failed", "recording.ended"]);
        const ended = hooks[1].data;
        assert.equal(ended.client, "service");
        assert.equal(ended.ownerId, "team-1");
        assert.deepEqual(ended.metadata, { plan: "pro" });
        assert.equal(ended.state, "processing");
        assert.equal(ended.endCode, "alone");
        assert.equal(ended.durationSeconds, 60);
        assert.equal(ended.meetCode, MEET.code);
        for (const h of hooks) {
          assert.equal("pin" in h.data, false);
          assert.equal("recipients" in h.data, false);
        }
        assert.deepEqual(sentEmails, []);
      });
      ```
      In `src/pipeline/run.test.ts` import `pendingWebhooks` and `verifyPin` is already imported; extend the Task 9 test with
      ```ts
        const ready = pendingWebhooks().map((e) => JSON.parse(e.body)).find((b) => b.data.id === m.id && b.type === "minutes.ready")!;
        assert.equal(ready.data.state, "done");
        assert.equal(ready.data.summaryShort, SHORT);
        assert.equal(ready.data.playbackUrl, `https://meet.example.com/m/${m.id}`);
        assert.equal("pin" in ready.data, false);
      ```
      (rename it to `a Google Meet API recording in webhook mode emails nobody and queues minutes.ready with the short summary but no PIN`), and add
      ```ts
      test("a Google Meet API recording whose processing fails queues recording.failed and, in email mode, emails the starter", async () => {
        const m = apiMeet("email");
        sentEmails.length = 0;
        mockOpenRouter((call) =>
          call.path === "/audio/transcriptions"
            ? Response.json({ text: "", segments: [{ start: 0.3, end: 3, text: "สวัสดีครับ" }] })
            : new Response("bad request", { status: 400 }), // 4xx is not retried (src/pipeline/openrouter.ts withRetry), so both summary models fail at once
        );
        await processMeeting(discord([]).client, m as any);
        assert.equal(manifestIn(m.id).status, "failed");
        const failed = pendingWebhooks().map((e) => JSON.parse(e.body)).find((b) => b.data.id === m.id)!;
        assert.equal(failed.type, "recording.failed");
        assert.equal(failed.data.state, "failed");
        assert.ok(failed.data.error);
        assert.deepEqual(sentEmails.map((e) => e.to), ["alice@planthia.test"]);
        assert.match(sentEmails[0]!.subject, /ประมวลผลบันทึกการประชุมไม่สำเร็จ/);
      });
      ```
- [ ] Step 5b: AGENTS.md, in the consent bullet `A Google Meet recording needs only the notice in the Meet chat ...`, append: `For an API recording in webhook mode the fallback is the \`recording.notice_failed\` webhook, and the API caller must tell the participants; keep it too.` (the binding rule must change in the same commit as the behaviour).
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 95`, `# pass 95`, `# fail 0`.
- [ ] Step 7: Commit - `git add src/api/events.ts src/meet/session.ts src/pipeline/run.ts src/index.ts AGENTS.md src/meet/session.test.ts src/pipeline/run.test.ts && git commit -m "feat(api): send webhooks when API recordings end, fail, and have minutes"`

#### Task 11: Owner index keys and R2 listing

**Files:**
- Modify: `src/storage/keys.ts` (append two builders to `keys`)
- Create: `src/storage/keys.test.ts`
- Modify: `src/storage/r2.ts` (import `ListObjectsV2Command`; add `listKeys`)
- Modify: `src/test/setup.ts` (`mockR2()` gains `listKeys`)

**Interfaces:**
- Produces: `keys.ownerIndex(client: string, ownerId: string, startedAt: number, id: string): string`; `keys.ownerPrefix(client: string, ownerId: string): string`; `listKeys(prefix: string, limit: number, cursor?: string): Promise<{ keys: string[]; cursor?: string }>`.

**Gotcha:** `keys.ts` is bundled by the Worker, so it stays import-free and the `meet/` typecheck and tests run too.
Meeting ids are base64url and may contain `-`; the id is everything after the first 14 characters of the last key segment (13 digits and `-`), never "after the last `-`".

**Steps:**
- [ ] Step 1: Append to `keys` in `src/storage/keys.ts`:
      ```ts
        /** Empty marker that lists an API recording under its owner; the inverted start time sorts newest first. */
        ownerIndex: (client: string, ownerId: string, startedAt: number, id: string) =>
          `api/${client}/${ownerId}/${String(9_999_999_999_999 - startedAt).padStart(13, "0")}-${id}`,
        ownerPrefix: (client: string, ownerId: string) => `api/${client}/${ownerId}/`,
      ```
- [ ] Step 2: Create `src/storage/keys.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { keys } from "./keys.js";

      test("owner index keys sort newest first under the owner's prefix and end in the meeting id", () => {
        const older = keys.ownerIndex("service", "team-1", Date.UTC(2026, 10, 1), "AAAAAAAAAAAAAA-_");
        const newer = keys.ownerIndex("service", "team-1", Date.UTC(2026, 10, 2), "BBBBBBBBBBBBBBBB");
        assert.deepEqual([older, newer].sort(), [newer, older]);
        assert.ok(newer.startsWith(keys.ownerPrefix("service", "team-1")));
        const last = older.slice(older.lastIndexOf("/") + 1);
        assert.equal(last.slice(14), "AAAAAAAAAAAAAA-_");
      });
      ```
- [ ] Step 3: In `src/storage/r2.ts` import `ListObjectsV2Command` with the other commands and add:
      ```ts
      /** One page of keys under `prefix` in key order; pass the returned cursor to continue. */
      export async function listKeys(prefix: string, limit: number, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
        const res = await s3().send(
          new ListObjectsV2Command({ Bucket: config().R2_BUCKET, Prefix: prefix, MaxKeys: limit, ContinuationToken: cursor }),
        );
        return {
          keys: (res.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k),
          cursor: res.IsTruncated ? res.NextContinuationToken : undefined,
        };
      }
      ```
- [ ] Step 4: In `mockR2()` in `src/test/setup.ts` add to `namedExports`:
      ```ts
            listKeys: async (prefix: string, limit: number, cursor?: string) => {
              const all = [...r2.keys()].filter((k) => k.startsWith(prefix)).sort();
              const from = cursor ? Number(cursor) : 0;
              const next = from + limit;
              return { keys: all.slice(from, next), cursor: next < all.length ? String(next) : undefined };
            },
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'; cd meet && npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: both typechecks exit 0; root `# tests 96`, `# pass 96`, `# fail 0`; meet `# tests 20`, `# pass 20`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/storage/keys.ts src/storage/keys.test.ts src/storage/r2.ts src/test/setup.ts && git commit -m "feat(storage): add the owner index and R2 key listing"`

#### Task 12: `/api/v1` recordings: start, get, stop, list

**Files:**
- Create: `src/api/routes.ts`
- Create: `src/api/routes.test.ts`, `src/api/rate-limit.test.ts`
- Modify: `src/web/server.ts` (anchors: imports; `if (meetPageEnabled()) app.route("/meet"`)

**Interfaces:**
- Consumes: `findClient` (Task 5), `resolveWebhookUrl` (Task 5), `recordingView`, `RecordingView` (Task 10), `keys.ownerIndex`, `keys.ownerPrefix`, `listKeys` (Task 11), `StartMeet`, `MeetRefused`, `activeMeets`, `MAX_MEET_RECORDINGS` (`src/meet/session.ts`), `apiEnabled` (Task 6).
- Produces: `apiRoutes(deps: { startMeet: StartMeet }): Hono<ApiEnv>` where `type ApiEnv = { Variables: { client: string } }`; `findRecording(client: string, id: string): Promise<{ m: MeetManifest; live?: MeetSession } | undefined>` (exported for Task 13); `fail(c: Context, status: ContentfulStatusCode, code: string, message: string): Response`; routes `POST /api/v1/recordings`, `GET /api/v1/recordings/:id`, `POST /api/v1/recordings/:id/stop`, `GET /api/v1/recordings?ownerId=&limit=&cursor=`.

**Gotcha:** Hono's sub-app `notFound` is not used when the app is mounted with `app.route`, so `routes.ts` ends with an `app.all("*")` JSON 404.
The `hono/body-limit` middleware exists in Hono 4.13 (`node_modules/hono/dist/types/middleware/body-limit/index.d.ts`); check its option names there before use.
`ContentfulStatusCode` is exported by `hono/utils/http-status`; if the import path differs, use the narrower union `400 | 401 | 404 | 409 | 413 | 422 | 429 | 503`.

**Steps:**
- [ ] Step 1: Create `src/api/routes.ts`:
      ```ts
      import { Hono, type Context } from "hono";
      import { bodyLimit } from "hono/body-limit";
      import type { ContentfulStatusCode } from "hono/utils/http-status";
      import { z } from "zod";
      import { config } from "../config.js";
      import { parseMeetUrl } from "../meet/meet-url.js";
      import { activeMeets, MAX_MEET_RECORDINGS, MeetRefused, type MeetSession, type StartMeet } from "../meet/session.js";
      import { keys } from "../storage/keys.js";
      import { loadLocal, loadRemote, type MeetManifest } from "../storage/manifest.js";
      import { getText, listKeys, putText } from "../storage/r2.js";
      import { pLimit } from "../util/limit.js";
      import { logger } from "../util/log.js";
      import { SESSION_ID_RE } from "../util/pin.js";
      import { clientIp } from "../web/client-ip.js";
      import { RateLimit } from "../web/rate-limit.js";
      import { findClient } from "./clients.js";
      import { recordingView } from "./events.js";
      import { resolveWebhookUrl } from "./webhook-url.js";

      const log = logger("api");
      const PAGE = 50;
      const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

      export type ApiEnv = { Variables: { client: string } };

      const startBody = z.strictObject({
        meetUrl: z.string().max(300),
        title: z.string().trim().min(1).max(200).optional(),
        ownerId: z.string().regex(OWNER_RE),
        metadata: z
          .record(z.string().max(40), z.string().max(500))
          .refine((m) => Object.keys(m).length <= 20, "at most 20 entries")
          .default({}),
        delivery: z.discriminatedUnion("mode", [
          z.strictObject({ mode: z.literal("email"), starter: z.email(), recipients: z.array(z.email()).max(50).default([]) }),
          z.strictObject({ mode: z.literal("webhook") }),
        ]),
        webhookUrl: z.string().max(2000).optional(),
      });

      export const fail = (c: Context, status: ContentfulStatusCode, code: string, message: string) => c.json({ error: { code, message } }, status);

      /** The caller's own Meet recording: the live session first, else the local, else the R2 manifest. Other clients' and Discord recordings are not found. */
      export async function findRecording(client: string, id: string): Promise<{ m: MeetManifest; live?: MeetSession } | undefined> {
        if (!SESSION_ID_RE.test(id)) return undefined;
        const live = [...activeMeets.values()].find((s) => s.id === id);
        const m = live?.manifest ?? loadLocal(id) ?? (await loadRemote(id));
        if (!m?.meet || m.meet.api?.client !== client) return undefined;
        return { m, live };
      }

      /** /api/v1: Bearer API keys, per-client rate limits, JSON in and out (docs/api.md). */
      export function apiRoutes(deps: { startMeet: StartMeet }): Hono<ApiEnv> {
        const app = new Hono<ApiEnv>();
        const perClient = new RateLimit(config().API_RATE_LIMIT_PER_MIN, 60_000);
        const badKeysPerIp = new RateLimit(30, 60_000);

        app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => fail(c, 413, "body_too_large", "The request body is larger than 16 KB.") }));
        app.use("*", async (c, next) => {
          const auth = c.req.header("authorization");
          const client = auth?.startsWith("Bearer ") ? findClient(auth.slice(7), config().API_KEYS.keys) : undefined;
          if (!client) {
            if (!badKeysPerIp.take(clientIp(c))) {
              c.header("Retry-After", "60");
              return fail(c, 429, "rate_limited", "Too many requests without a valid API key.");
            }
            c.header("WWW-Authenticate", 'Bearer realm="everymeet"');
            return fail(c, 401, "unauthorized", "A valid API key is required.");
          }
          if (!perClient.take(client)) {
            c.header("Retry-After", "60");
            return fail(c, 429, "rate_limited", `More than ${config().API_RATE_LIMIT_PER_MIN} requests in a minute.`);
          }
          c.set("client", client);
          await next();
        });

        app.post("/recordings", async (c) => {
          const client = c.get("client");
          const parsed = startBody.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success) {
            return fail(c, 400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
          }
          const b = parsed.data;
          const meet = parseMeetUrl(b.meetUrl);
          if (!meet) return fail(c, 400, "invalid_meet_url", "meetUrl is not a Google Meet link like https://meet.google.com/abc-defg-hij.");
          const cfg = config();
          if (b.delivery.mode === "email" && !(cfg.RESEND_API_KEY && cfg.EMAIL_FROM)) {
            return fail(c, 422, "email_not_configured", "This engine has no email sender; use delivery mode webhook.");
          }
          const hook = resolveWebhookUrl(b.webhookUrl, cfg);
          if ("error" in hook) {
            return fail(c, 400, hook.error, "webhookUrl must be https (http only on localhost) on WEBHOOK_URL's origin or one in WEBHOOK_ALLOWED_ORIGINS.");
          }
          if (b.delivery.mode === "webhook" && !hook.url) {
            return fail(c, 400, "webhook_url_required", "Delivery mode webhook needs webhookUrl or a configured WEBHOOK_URL.");
          }
          const email = b.delivery.mode === "email" ? b.delivery : undefined;
          let s: MeetSession;
          try {
            s = await deps.startMeet({
              ...meet,
              title: b.title ?? `Google Meet ${meet.code}`,
              trigger: "api",
              startedBy: email?.starter.toLowerCase(),
              recipients: email?.recipients.map((r) => r.toLowerCase()) ?? [],
              api: { client, ownerId: b.ownerId, metadata: b.metadata, delivery: b.delivery.mode, webhookUrl: hook.url },
            });
          } catch (err) {
            if (err instanceof MeetRefused && err.reason === "already_recording") {
              // Only the client that runs it learns its id.
              const running = activeMeets.get(meet.code);
              const own = running?.manifest.meet.api?.client === client ? running.id : undefined;
              return c.json({ error: { code: "already_recording", message: "This Google Meet call is already being recorded.", ...(own ? { recordingId: own } : {}) } }, 409);
            }
            if (err instanceof MeetRefused) {
              c.header("Retry-After", "60");
              return fail(c, 503, "busy", `At most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once.`);
            }
            log.error(`API client ${client} could not start a recording`, err);
            return fail(c, 503, "recorder_unavailable", "The recorder could not be started; try again.");
          }
          try {
            await putText(keys.ownerIndex(client, b.ownerId, s.manifest.startedAt, s.id), "", "text/plain");
          } catch (err) {
            // Not fatal: the recording runs and is reachable by id; only the owner list misses it.
            log.warn(`recording ${s.id} is not in the owner list of ${client}/${b.ownerId}`, err);
          }
          log.info(`API client ${client} started ${s.id} for owner ${b.ownerId}`);
          c.header("Location", `/api/v1/recordings/${s.id}`);
          return c.json(recordingView(s.manifest, s), 201);
        });

        app.get("/recordings/:id", async (c) => {
          const r = await findRecording(c.get("client"), c.req.param("id"));
          if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
          const summary = r.m.status === "done" ? await getText(keys.summaryShort(r.m.id)) : undefined;
          return c.json(recordingView(r.m, r.live, summary));
        });

        app.post("/recordings/:id/stop", async (c) => {
          const r = await findRecording(c.get("client"), c.req.param("id"));
          if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
          if (!r.live) return fail(c, 409, "not_recording", "The recording has already ended.");
          try {
            await r.live.end("หยุดผ่าน API");
          } catch (err) {
            log.warn(`API client ${c.get("client")} could not stop ${r.m.id}`, err);
            return fail(c, 503, "recorder_unavailable", "The recorder could not be reached; it stops by itself when the call empties or reaches its time limit.");
          }
          return c.json(recordingView(r.m, r.live), 202);
        });

        app.get("/recordings", async (c) => {
          const client = c.get("client");
          const ownerId = c.req.query("ownerId") ?? "";
          if (!OWNER_RE.test(ownerId)) return fail(c, 400, "invalid_request", "ownerId is required: 1-128 of A-Z a-z 0-9 . _ -, starting with a letter or digit.");
          const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? PAGE) || PAGE, PAGE));
          const page = await listKeys(keys.ownerPrefix(client, ownerId), limit, c.req.query("cursor"));
          const ids = page.keys.map((k) => k.slice(k.lastIndexOf("/") + 1).slice(14));
          const load = pLimit(8);
          const found = await Promise.all(ids.map((id) => load(() => findRecording(client, id))));
          const items = found.filter((r) => r !== undefined).map((r) => recordingView(r.m, r.live));
          return c.json({ items, ...(page.cursor ? { nextCursor: page.cursor } : {}) });
        });

        app.all("*", (c) => fail(c, 404, "not_found", "No such endpoint."));
        // A mounted sub-app's onError handles its own routes, so API failures keep the JSON error shape.
        app.onError((err, c) => {
          log.error("API request failed", err);
          return fail(c, 500, "internal_error", "Something went wrong; try again.");
        });
        return app;
      }
      ```
- [ ] Step 2: In `src/web/server.ts` import `apiEnabled` from `../config.js` and `apiRoutes` from `../api/routes.js`, and after the `/meet` mount add:
      ```ts
        // The HTTP API (docs/api.md); also under the security headers above.
        if (apiEnabled()) app.route("/api/v1", apiRoutes(deps));
      ```
- [ ] Step 3: Create `src/api/routes.test.ts`:
      ```ts
      import { afterEach, test } from "node:test";
      import assert from "node:assert/strict";
      import { fakeMeetRecorder, mockEmail, mockR2, r2 } from "../test/setup.js";

      mockR2();
      mockEmail();
      const worker = fakeMeetRecorder();
      process.env.TRUST_PROXY = "true";
      const { createApp } = await import("../web/server.js");
      const { MeetSession, activeMeets } = await import("../meet/session.js");
      const { keys } = await import("../storage/keys.js");
      const { newSessionId } = await import("../util/pin.js");

      const app = createApp({ startMeet: (meet) => MeetSession.start(meet, () => {}) });
      const SERVICE = `Bearer ${"k".repeat(40)}`;
      const OPS = `Bearer ${"o".repeat(40)}`;
      const JKU = "https://meet.google.com/abc-defg-hij";
      const api = (path: string, o: { body?: unknown; method?: string; auth?: string; ip?: string } = {}) =>
        app.request(`/api/v1${path}`, {
          method: o.method ?? (o.body === undefined ? "GET" : "POST"),
          headers: { authorization: o.auth ?? SERVICE, "content-type": "application/json", "x-forwarded-for": o.ip ?? "10.9.0.1" },
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        });
      const start = (over: Record<string, unknown> = {}, auth = SERVICE) =>
        api("/recordings", { auth, body: { meetUrl: JKU, ownerId: "team-1", metadata: { plan: "pro" }, delivery: { mode: "webhook" }, ...over } });

      afterEach(async () => {
        for (const s of activeMeets.values()) await s.shutdown();
        activeMeets.clear();
      });

      test("without a valid API key the API answers 401 in JSON, and many bad keys from one IP get 429", async () => {
        const res = await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
        assert.equal(res.status, 401);
        assert.deepEqual((await res.json()).error.code, "unauthorized");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal((await api("/recordings?ownerId=team-1", { auth: "", ip: "10.9.1.1" })).status, 401);
        for (let i = 0; i < 28; i++) await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
        const limited = await api("/recordings?ownerId=team-1", { auth: "Bearer nope", ip: "10.9.1.1" });
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get("retry-after"), "60");
      });

      test("a client starts a recording, reads it, and stops it; another client can neither see nor stop it", async () => {
        const res = await start();
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(res.headers.get("location"), `/api/v1/recordings/${body.id}`);
        assert.equal(body.state, "starting");
        assert.equal(body.ownerId, "team-1");
        assert.deepEqual(body.metadata, { plan: "pro" });
        assert.equal(body.delivery, "webhook");
        const s = activeMeets.get("abc-defg-hij")!;
        assert.deepEqual(s.manifest.meet.api, { client: "service", ownerId: "team-1", metadata: { plan: "pro" }, delivery: "webhook", webhookUrl: "https://service.example.com/hooks/everymeet" });
        assert.equal(s.manifest.meet.trigger, "api");
        assert.ok(worker.recordings.has(body.id));
        assert.ok([...r2.keys()].some((k) => k.startsWith(keys.ownerPrefix("service", "team-1")) && k.endsWith(body.id)));
        assert.equal((await api(`/recordings/${body.id}`)).status, 200);
        assert.equal((await api(`/recordings/${body.id}`, { auth: OPS })).status, 404);
        assert.equal((await api(`/recordings/${body.id}/stop`, { method: "POST", auth: OPS })).status, 404);
        const stopped = await api(`/recordings/${body.id}/stop`, { method: "POST" });
        assert.equal(stopped.status, 202);
        assert.equal((await stopped.json()).stopping, true);
        assert.equal(worker.recordings.get(body.id)!.stopped, true);
      });

      test("bad input is refused with a code: the body, the Meet link, and the webhook URL", async () => {
        const codeOf = async (res: Response) => [res.status, (await res.json()).error.code];
        assert.deepEqual(await codeOf(await start({ ownerId: "has space" })), [400, "invalid_request"]);
        assert.deepEqual(await codeOf(await start({ ownerId: ".." })), [400, "invalid_request"]);
        assert.deepEqual(await codeOf(await start({ extra: 1 })), [400, "invalid_request"]);
        assert.deepEqual(await codeOf(await start({ meetUrl: "https://zoom.us/j/1" })), [400, "invalid_meet_url"]);
        assert.deepEqual(await codeOf(await start({ webhookUrl: "https://evil.test/h" })), [400, "webhook_url_not_allowed"]);
        assert.deepEqual(await codeOf(await start({ webhookUrl: "http://other.example.com/h" })), [400, "webhook_url_not_allowed"]);
        const raw = await app.request("/api/v1/recordings", { method: "POST", headers: { authorization: SERVICE, "content-type": "application/json" }, body: "{not json" });
        assert.deepEqual(await codeOf(raw), [400, "invalid_request"]);
        assert.equal(activeMeets.size, 0, "nothing was started");
        const ok = await start({ webhookUrl: "https://other.example.com/h" });
        assert.equal(ok.status, 201);
        assert.equal(activeMeets.get("abc-defg-hij")!.manifest.meet.api!.webhookUrl, "https://other.example.com/h");
      });

      test("email delivery passes the starter and recipients through, and the global limits answer 409 and 503", async () => {
        const res = await start({ delivery: { mode: "email", starter: "Ann@Example.com", recipients: ["bob@example.com"] } });
        assert.equal(res.status, 201);
        const id = (await res.json()).id;
        const meet = activeMeets.get("abc-defg-hij")!.manifest.meet;
        assert.equal(meet.startedBy, "ann@example.com");
        assert.deepEqual(meet.recipients, ["ann@example.com", "bob@example.com"]);
        const again = await (await start()).json();
        assert.deepEqual(again.error, { code: "already_recording", message: "This Google Meet call is already being recorded.", recordingId: id });
        assert.equal((await (await start({}, OPS)).json()).error.recordingId, undefined, "another client does not learn the id");
        assert.equal((await start({ meetUrl: "https://meet.google.com/pqr-stuv-wxy" })).status, 201);
        const busy = await start({ meetUrl: "https://meet.google.com/xyz-abcd-efg" });
        assert.equal(busy.status, 503);
        assert.equal(busy.headers.get("retry-after"), "60");
      });

      test("an owner's recordings are listed newest first, page by page, only for the client that started them", async () => {
        const T = Date.UTC(2026, 10, 20, 3);
        const seed = (startedAt: number, client = "service") => {
          const id = newSessionId();
          const m = {
            id, startedAt, endedAt: startedAt + 60_000, heartbeatAt: startedAt + 60_000, status: "done", endCode: "alone",
            participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [0], uploaded: [0] } },
            pin: { salt: "s", hash: "h" },
            meet: { url: JKU, code: "abc-defg-hij", title: "Weekly", trigger: "api", recipients: [], api: { client, ownerId: "team-2", metadata: {}, delivery: "webhook" } },
          };
          r2.set(keys.manifest(id), Buffer.from(JSON.stringify(m)));
          r2.set(keys.ownerIndex(client, "team-2", startedAt, id), Buffer.alloc(0));
          return id;
        };
        const older = seed(T);
        const newer = seed(T + 60 * 60_000);
        seed(T, "ops");
        r2.set(keys.summaryShort(newer), Buffer.from("สรุปสั้น"));
        const first = await (await api("/recordings?ownerId=team-2&limit=1")).json();
        assert.deepEqual(first.items.map((i: { id: string }) => i.id), [newer]);
        assert.ok(first.nextCursor);
        const second = await (await api(`/recordings?ownerId=team-2&limit=1&cursor=${first.nextCursor}`)).json();
        assert.deepEqual(second.items.map((i: { id: string }) => i.id), [older]);
        assert.equal(second.nextCursor, undefined);
        const one = await (await api(`/recordings/${newer}`)).json();
        assert.equal(one.state, "done");
        assert.equal(one.durationSeconds, 60);
        assert.equal(one.summaryShort, "สรุปสั้น");
        assert.equal(one.playbackUrl, `https://meet.example.com/m/${newer}`);
        assert.equal((await api("/recordings?ownerId=")).status, 400);
      });
      ```
- [ ] Step 4: Create `src/api/rate-limit.test.ts` (its own file, so its low limit does not touch other tests):
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { mockEmail, mockR2 } from "../test/setup.js";

      mockR2();
      mockEmail();
      process.env.API_RATE_LIMIT_PER_MIN = "3";
      const { createApp } = await import("../web/server.js");
      const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
      const list = (key: string) => app.request("/api/v1/recordings?ownerId=team-1", { headers: { authorization: `Bearer ${key}` } });

      test("each API client has its own requests-per-minute limit", async () => {
        for (let i = 0; i < 3; i++) assert.equal((await list("k".repeat(40))).status, 200);
        const limited = await list("k".repeat(40));
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).error.code, "rate_limited");
        assert.equal((await list("o".repeat(40))).status, 200, "the other client is not limited");
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 102`, `# pass 102`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/api/routes.ts src/api/routes.test.ts src/api/rate-limit.test.ts src/web/server.ts && git commit -m "feat(api): start, read, stop, and list Meet recordings over /api/v1"`

#### Task 13: Issue a playback PIN over the API

**Files:**
- Create: `src/web/manifest-cache.ts` (moved out of `src/web/server.ts`)
- Modify: `src/web/server.ts` (anchor: `// ---- small caches`, `const manifestCache`, `async function getManifest`)
- Modify: `src/storage/manifest.ts` (anchor: `export async function saveEverywhere`)
- Modify: `src/api/routes.ts` (add the route before `app.all("*")`)
- Create: `src/api/pin.test.ts`

**Interfaces:**
- Consumes: `findRecording`, `fail` (Task 12); `generatePin`, `hashPin` (`src/util/pin.ts`).
- Produces: `getManifest(id: string): Promise<Manifest | undefined>`, `forgetManifest(id: string): void` in `src/web/manifest-cache.ts`; `saveRemote(m: Manifest): Promise<void>` in `src/storage/manifest.ts`; route `POST /api/v1/recordings/:id/pin` answering `200 { pin: string, playbackUrl: string }`.

**Gotcha:** the playback server caches finished manifests for 60 s; without `forgetManifest` a new PIN would be refused for up to a minute.

**Steps:**
- [ ] Step 1: Create `src/web/manifest-cache.ts` with the cache code from `server.ts` moved verbatim (`manifestCache` and `getManifest`, importing `loadRemote, type Manifest` from `../storage/manifest.js`) plus
      ```ts
      /** Drops a cached manifest after it changed (a new PIN). */
      export function forgetManifest(id: string): void {
        manifestCache.delete(id);
      }
      ```
      In `server.ts` delete the moved block and import `getManifest` from `./manifest-cache.js` (drop `loadRemote` from its manifest import if nothing else uses it).
- [ ] Step 2: In `src/storage/manifest.ts`:
      ```ts
      export async function saveRemote(m: Manifest): Promise<void> {
        await putText(keys.manifest(m.id), JSON.stringify(m), "application/json");
      }

      export async function saveEverywhere(m: Manifest): Promise<void> {
        saveLocal(m);
        await saveRemote(m);
      }
      ```
- [ ] Step 3: In `src/api/routes.ts` (imports: `generatePin, hashPin` with `SESSION_ID_RE` from `../util/pin.js`, `saveLocal, saveRemote` from `../storage/manifest.js`, `forgetManifest` from `../web/manifest-cache.js`), add:
      ```ts
        /** A new PIN for the playback page, returned once; only its hash is stored, and the previous PIN stops working. */
        app.post("/recordings/:id/pin", async (c) => {
          const client = c.get("client");
          const r = await findRecording(client, c.req.param("id"));
          if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
          if (r.m.status !== "done") return fail(c, 409, "not_ready", "The minutes are not ready yet; wait for minutes.ready.");
          const pin = generatePin();
          r.m.pin = hashPin(pin);
          await saveRemote(r.m);
          if (loadLocal(r.m.id)) saveLocal(r.m); // only when CLEANUP_LOCAL=false kept the folder
          forgetManifest(r.m.id);
          log.info(`API client ${client} issued a new PIN for ${r.m.id}`);
          return c.json({ pin, playbackUrl: `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${r.m.id}` });
        });
      ```
- [ ] Step 4: Create `src/api/pin.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { mockEmail, mockR2, r2 } from "../test/setup.js";

      mockR2();
      mockEmail();
      process.env.TRUST_PROXY = "true";
      const { createApp } = await import("../web/server.js");
      const { keys } = await import("../storage/keys.js");
      const { hashPin, newSessionId } = await import("../util/pin.js");

      const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
      const issue = (id: string, key = "k".repeat(40)) =>
        app.request(`/api/v1/recordings/${id}/pin`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
      const enter = (id: string, pin: string) =>
        app.request(`/m/${id}`, {
          method: "POST",
          body: new URLSearchParams({ pin }),
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.8.0.1", origin: "https://meet.example.com" },
        });
      const seed = (status: "done" | "processing", oldPin = "111111") => {
        const id = newSessionId();
        const m = {
          id, startedAt: 0, endedAt: 60_000, heartbeatAt: 60_000, status, pin: hashPin(oldPin), outputs: {},
          participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [0], uploaded: [0] } },
          meet: { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij", title: "Weekly", trigger: "api", recipients: [], api: { client: "service", ownerId: "team-1", metadata: {}, delivery: "webhook" } },
        };
        r2.set(keys.manifest(id), Buffer.from(JSON.stringify(m)));
        return id;
      };

      test("a new PIN opens the playback page at once and the previous one stops working", async () => {
        const id = seed("done");
        assert.equal((await app.request(`/m/${id}`)).status, 200, "the page is cached with the old PIN");
        const res = await issue(id);
        assert.equal(res.status, 200);
        const { pin, playbackUrl } = await res.json();
        assert.match(pin, /^\d{6}$/);
        assert.equal(playbackUrl, `https://meet.example.com/m/${id}`);
        assert.ok(!r2.get(keys.manifest(id))!.toString().includes(`"${pin}"`), "only the hash is stored");
        const opened = await enter(id, pin);
        assert.equal(opened.status, 303);
        assert.match(opened.headers.get("set-cookie") ?? "", new RegExp(`^ma_${id}=`));
        if (pin !== "111111") assert.equal((await enter(id, "111111")).status, 401);
      });

      test("PINs are issued only for the caller's own recordings with finished minutes", async () => {
        assert.equal((await issue(seed("done"), "o".repeat(40))).status, 404);
        const busy = await issue(seed("processing"));
        assert.equal(busy.status, 409);
        assert.equal((await busy.json()).error.code, "not_ready");
      });
      ```
      `POST /m/:id` has no CSRF check today (the PIN form); the `origin` header only mirrors a browser.
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 104`, `# pass 104`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/web/manifest-cache.ts src/web/server.ts src/storage/manifest.ts src/api/routes.ts src/api/pin.test.ts && git commit -m "feat(api): issue playback PINs over the API"`

#### Task 14: End-to-end API flow with fakes

One test walks the whole engine path with fakes only: API start, the scripted recorder, the real pipeline (ffmpeg), the outbox, signature checks, the PIN, and the playback page.

**Files:**
- Create: `src/api/flow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 8-13; `processMeeting` (`src/pipeline/run.ts`), `fakeMeetRecorder`, `mockOpenRouter`, `mockWebhooks`, `mockR2`, `mockEmail`, `flush` (`src/test/setup.ts`).

**Gotcha:** `fakeMeetRecorder()` and `mockOpenRouter()` both replace `globalThis.fetch`; capture each replacement and install one dispatcher by host.
Use `mock.timers.enable({ apis: ["setInterval", "Date"] })` like `src/meet/session.test.ts`, and drive polls with `mock.timers.tick` plus `flush`; ffmpeg child processes do not depend on the mocked timers.
The segment FLAC is made with real ffmpeg the same way as `meetRecording()` in `src/pipeline/run.test.ts`.

**Steps:**
- [ ] Step 1: Create `src/api/flow.test.ts`:
      ```ts
      import { mock, test } from "node:test";
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { chatReply, dataDir, fakeMeetRecorder, flush, mockEmail, mockOpenRouter, mockR2, mockWebhooks, r2, sentEmails, sentWebhooks } from "../test/setup.js";

      mockR2();
      mockEmail();
      mockWebhooks();
      const worker = fakeMeetRecorder();
      const recorderFetch = globalThis.fetch;
      mockOpenRouter((call) =>
        call.path === "/audio/transcriptions"
          ? Response.json({ text: "", segments: [{ start: 0.3, end: 3, text: "สวัสดีครับ เริ่มประชุม" }] })
          : chatReply(call.body.max_tokens <= 2_000 ? "**ภาพรวม:** ทดสอบ" : "# สรุปการประชุม\nทดสอบ"),
      );
      const openRouterFetch = globalThis.fetch;
      globalThis.fetch = ((url: string, init?: RequestInit) =>
        (new URL(url).host === "meet-recorder.example.com" ? recorderFetch : openRouterFetch)(url, init)) as typeof fetch;
      process.env.TRUST_PROXY = "true";
      const { createApp } = await import("../web/server.js");
      const { MeetSession } = await import("../meet/session.js");
      const { processMeeting } = await import("../pipeline/run.js");
      const { deliverDue } = await import("./outbox.js");
      const { verifyWebhook } = await import("./signature.js");
      const { keys } = await import("../storage/keys.js");
      const { SAMPLE_RATE } = await import("../config.js");

      const NOW = Date.UTC(2026, 10, 21, 3, 0, 0);
      const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
      let processing: Promise<void> | undefined;
      const app = createApp({ startMeet: (meet) => MeetSession.start(meet, (m) => { processing = processMeeting({} as any, m); }) });
      const auth = { authorization: `Bearer ${"k".repeat(40)}`, "content-type": "application/json" };

      test("API start to playback: webhooks are signed, the PIN comes from the API, nobody is emailed", async () => {
        mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
        try {
          const started = await app.request("/api/v1/recordings", {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ meetUrl: "https://meet.google.com/abc-defg-hij", ownerId: "team-1", delivery: { mode: "webhook" } }),
          });
          assert.equal(started.status, 201);
          const { id } = await started.json();

          // The recorder stores one 20 s segment of a tone and reports the end (as meet/worker does).
          const raw = join(dataDir, `${id}.raw`);
          const flac = join(dataDir, `${id}.flac`);
          const pcm = Buffer.alloc(SAMPLE_RATE * 20 * 2);
          for (let i = 0; i < SAMPLE_RATE * 3; i++) {
            pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), (SAMPLE_RATE + i) * 2); // 3 s tone at 1 s
          }
          writeFileSync(raw, pcm);
          execFileSync("ffmpeg", ["-v", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", raw, "-c:a", "flac", flac]);
          r2.set(keys.segment(id, "meet", 0), readFileSync(flac));
          worker.recordings.get(id)!.status = {
            state: "ended", captureStartedAt: NOW + 60_000, consentPosted: true,
            segments: [{ index: 0, samples: SAMPLE_RATE * 20 }], end: { reason: "alone", leftCleanly: true },
          };
          mock.timers.tick(5_000);
          await flush(20);
          assert.ok(processing, "the end reached processing");
          await processing;

          await deliverDue();
          const bodies = sentWebhooks.map((w) => JSON.parse(w.body));
          // Both were queued at the same frozen instant, so their order is not defined (receivers never rely on it).
          assert.deepEqual(bodies.map((b) => b.type).sort(), ["minutes.ready", "recording.ended"]);
          for (const w of sentWebhooks) {
            const h = { id: w.headers["webhook-id"]!, timestamp: w.headers["webhook-timestamp"]!, signature: w.headers["webhook-signature"]! };
            assert.ok(verifyWebhook(SECRET, h, w.body, Math.floor(Date.now() / 1000)));
            assert.equal(w.url, "https://service.example.com/hooks/everymeet");
          }
          assert.equal(bodies.find((b) => b.type === "minutes.ready").data.summaryShort, "**ภาพรวม:** ทดสอบ");

          const { pin, playbackUrl } = await (await app.request(`/api/v1/recordings/${id}/pin`, { method: "POST", headers: auth })).json();
          const entered = await app.request(new URL(playbackUrl).pathname, {
            method: "POST",
            body: new URLSearchParams({ pin }),
            headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.7.0.1" },
          });
          assert.equal(entered.status, 303);
          const cookie = entered.headers.get("set-cookie")!.split(";")[0]!;
          const player = await app.request(`/m/${id}`, { headers: { cookie } });
          assert.equal(player.status, 200);
          assert.match(await player.text(), /<audio controls/);
          assert.deepEqual(sentEmails, []);
        } finally {
          mock.timers.reset();
        }
      });
      ```
- [ ] Step 2: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 105`, `# pass 105`, `# fail 0`; and `node --import tsx --experimental-test-module-mocks --test src/api/flow.test.ts` passes on its own.
- [ ] Step 3: Commit - `git add src/api/flow.test.ts && git commit -m "test(api): walk an API recording from start to playback"`

#### Task 15: API reference and the README API section

**Files:**
- Create: `docs/api.md`
- Modify: `README.md` (new section `## HTTP API` after `## Google Meet recording`)

**Steps:**
- [ ] Step 1: Write `docs/api.md` (one sentence per line, no em dash) with exactly these sections and facts, all taken from Tasks 5-13:
      - `# everymeet engine HTTP API (v1)` and an intro: base path `/api/v1` on `PUBLIC_BASE_URL`; JSON in and out; English; times are ISO 8601 UTC; the API exists only when `API_KEYS` is set; it serves Google Meet recordings only (Discord `/record` has no API).
      - `## Authentication`: `Authorization: Bearer <key>`; `API_KEYS` format and the rotation rule (same name twice); the name is the client and the tenant boundary (a client sees only its own recordings, others answer 404); 401 `unauthorized` with `WWW-Authenticate`; 30 failed attempts per IP per minute, then 429.
      - `## Rate limits`: `API_RATE_LIMIT_PER_MIN` (default 120) per client per minute, fixed window, 429 `rate_limited` with `Retry-After: 60`; request bodies over 16 KB get 413 `body_too_large`.
      - `## Errors`: the `{ "error": { "code", "message" } }` shape and a table of every code with its status: `invalid_request` 400, `invalid_meet_url` 400, `webhook_url_not_allowed` 400, `webhook_url_required` 400, `unauthorized` 401, `not_found` 404, `already_recording` 409 (with `recordingId` only for the client that runs it), `not_recording` 409, `not_ready` 409, `body_too_large` 413, `email_not_configured` 422, `rate_limited` 429, `busy` 503 (`Retry-After: 60`), `recorder_unavailable` 503, `internal_error` 500; the 409 `already_recording` tells any client that the Meet code is being recorded by someone (inherent in the one-per-code rule).
      - `## The Recording object`: every field of `RecordingView` (Task 10) with type and meaning; the `state` values and their order (`starting`, `joining`, `waiting`, `recording`, `processing`, `done`, `failed`) and `stopping`; `endCode` values (the `EndReason` list in `src/meet/protocol.ts` plus `recorder_lost`); `endReason` is free Thai text for people and, for an email-mode recording stopped on the `/meet` page, names the address that pressed stop; what is never included (PIN, transcript, full summary, audio links, recipients).
      - `## POST /recordings`: request fields (`meetUrl`, `title`, `ownerId` pattern, `metadata` limits and "no personal data", `delivery` with both modes, `webhookUrl` rules), a full request and `201` response example using `https://meet.google.com/abc-defg-hij`, `team-1`, `starter: "ann@example.com"`; the global limits (one per Meet code, at most 2 at once, also counting web and calendar recordings); the `Location` header.
      - `## GET /recordings/{id}`: includes `summaryShort` once `done`.
      - `## POST /recordings/{id}/stop`: 202 with `stopping: true`; processing starts when the recorder reports the end (up to about a minute).
      - `## GET /recordings?ownerId=&limit=&cursor=`: newest first, `limit` 1-50 (default 50), `nextCursor`; a recording whose index write failed is reachable by id but missing here.
      - `## POST /recordings/{id}/pin`: `200 { pin, playbackUrl }`; only for `done`; every call makes a new PIN and voids the previous one (including the emailed PIN in email mode); store it or call once per delivery.
      - `## Webhooks`: the four types and when each fires (`recording.notice_failed` when the Meet chat notice could not be posted: the caller MUST tell the participants that the call is recorded; `recording.ended` when capture ended and processing starts; `recording.failed` for nothing recorded or failed processing, with `error`; `minutes.ready` with `summaryShort`); body `{ type, timestamp, data: Recording }`; headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; the signing recipe and a 15-line Node verification example equal to `verifyWebhook` in `src/api/signature.ts` (a copy, not an import); 5-minute tolerance; answer 2xx within 10 s; retries after 30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h, then the event moves to `DATA_DIR/webhooks/failed/` on the engine; at-least-once and unordered: dedupe deliveries by `webhook-id`, trust `data.state`; processing retried after an engine restart can send `minutes.ready` again with a new `webhook-id`, so dedupe side effects (customer emails) on `data.id` plus `type`; redirects are not followed; delivery within about 15 s of the event.
      - `## Delivery modes`: `email` (engine emails the starter and recipients as for the web page, and also sends webhooks when a URL resolved) and `webhook` (no email at all); web and calendar recordings never send webhooks.
      - `## Using the API from another program`: talk HTTP only; do not import engine modules or copy engine code into a closed program, so the AGPL does not extend to it (README "License").
- [ ] Step 2: README `## HTTP API`: three sentences (what it is, that it is off without `API_KEYS`, link to `docs/api.md`) and the settings `API_KEYS`, `API_RATE_LIMIT_PER_MIN`, `WEBHOOK_SECRET`, `WEBHOOK_URL`, `WEBHOOK_ALLOWED_ORIGINS` with one line each, as in `.env.example`.
- [ ] Step 3: Verify - Run: `grep -c "$(printf '\342\200\224')" docs/api.md README.md; for c in internal_error invalid_request invalid_meet_url webhook_url_not_allowed webhook_url_required unauthorized not_found already_recording not_recording not_ready body_too_large email_not_configured rate_limited busy recorder_unavailable; do grep -q "$c" docs/api.md || echo "missing $c"; done; grep -o '"[a-z_]*"' src/api/routes.ts | sort -u` - Expected: `0` em dashes for both files; no `missing` line; every error code string in `routes.ts` appears in the doc's table.
- [ ] Step 4: Commit - `git add docs/api.md README.md && git commit -m "docs(api): document the v1 HTTP API and webhooks"`

---

### Phase 3: open-source readiness

#### Task 16: AGPL-3.0 license

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (`"license"`, `"description"`), `meet/package.json` (`"license"`)
- Modify: `README.md` (new last section `## License`; first paragraph)

**Gotcha:** the license variant and the copyright line are the user's (Open questions 1 and 3); the defaults below ship if they did not answer.
Fetching the license text is the only network call in this plan; if it is not allowed, STOP and ask the user to put the file in place.

**Steps:**
- [ ] Step 1: `curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE` - Expected: `head -3 LICENSE` shows `GNU AFFERO GENERAL PUBLIC LICENSE` and `Version 3, 19 November 2007`; `grep -c "END OF TERMS AND CONDITIONS" LICENSE` prints `1`; the file is unmodified (no copyright line is added inside it).
- [ ] Step 2: `package.json`: add `"license": "AGPL-3.0-only",` after `"private": true,` and change `"description"` to `"Self-hostable meeting minutes engine: records Discord voice channels and Google Meet calls, transcribes them, and writes Thai minutes"`; `meet/package.json`: add `"license": "AGPL-3.0-only"`.
      Keep `"private": true` (nothing is published to npm).
- [ ] Step 3: README: the first paragraph says the repo is the open-source engine (AGPL-3.0) that anyone can self-host, and a hosted service may use it through the API.
      `## License`, one sentence per line:
      - `Copyright (C) 2026 The everymeet authors.`
      - This program is free software under the GNU Affero General Public License, version 3 only (`LICENSE`).
      - If you run a modified version for others over a network, section 13 asks you to offer them your modified source; set `SOURCE_CODE_URL` to it (every page links it).
      - The recorder Worker and container in `meet/` are part of the same program and the same license.
      - Discord users reach the source through the playback page that every minutes post links, whose footer links `SOURCE_CODE_URL`.
      - The Docker images include ffmpeg (Debian, GPL) and Chromium (in the Playwright base image) as separate programs under their own licenses.
      - Programs that only call the HTTP API (`docs/api.md`) are separate works; do not import engine modules into them.
      - Contributions are accepted under the same license with a DCO sign-off (CONTRIBUTING.md).
- [ ] Step 4: Verify - Run: `node -p "require('./package.json').license + ' ' + require('./meet/package.json').license"; head -2 LICENSE; npm run typecheck && (cd meet && npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)')` - Expected: `AGPL-3.0-only AGPL-3.0-only`; the license header; typechecks exit 0; meet `# pass 20`, `# fail 0`.
- [ ] Step 5: Commit - `git add LICENSE package.json meet/package.json README.md && git commit -m "chore: license the engine under AGPL-3.0"`

#### Task 17: Link the source code on every page (AGPL section 13)

**Files:**
- Modify: `src/config.ts` (add `SOURCE_CODE_URL`; the test env uses the default), `.env.example`
- Modify: `src/web/templates.ts` (anchors: `function shell(`, `const STYLE`)
- Modify: `src/web/templates.test.ts` (one test, and `import "../test/setup.js";` as its first import, because `shell()` now calls `config()` and this file had no test env)

**Interfaces:**
- Produces: `config().SOURCE_CODE_URL: string`.

**Steps:**
- [ ] Step 1: `src/config.ts`, after `PUBLIC_BASE_URL`:
      ```ts
        /** Where people who use this engine's pages get its source (AGPL section 13); point it at your fork if you change the code. */
        SOURCE_CODE_URL: z.preprocess(blank, z.url().default("https://github.com/<owner>/everymeet")),
      ```
      Replace `<owner>` with the owner of this repo's public GitHub remote (`git remote get-url origin`, without `.git`); it is the project's public home, not private infrastructure.
      `.env.example`, in the Playback page block: `# Source of the code this server runs (AGPL section 13); change it if you run modified code` and `SOURCE_CODE_URL=`.
      `blank` makes the empty value in `.env.example` mean the default.
- [ ] Step 2: `src/web/templates.ts`: import `config` from `../config.js`; add to `STYLE` `footer{text-align:center;margin-top:16px;font-size:12px;color:var(--muted)}footer a{color:var(--muted)}`; and in `shell` replace `<main>${body}</main>` with `<main>${body}<footer><a href="${esc(config().SOURCE_CODE_URL)}">ซอร์สโค้ด</a> · AGPL-3.0</footer></main>`.
- [ ] Step 3: Add `import "../test/setup.js";` above the other imports of `src/web/templates.test.ts` (without it `config()` throws on an empty env and all its tests fail), then add:
      ```ts
      test("every page links the source code under its license", () => {
        for (const html of [page.notFound(), page.pin({ id: "AbCdEfGhIjKlMnOp", title: "t" }), page.meetLogin({})]) {
          assert.match(html, /<footer><a href="https:\/\/github\.com\/[^"]+\/everymeet">ซอร์สโค้ด<\/a> · AGPL-3\.0<\/footer>/);
        }
      });
      ```
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` - Expected: typecheck exits 0; `# tests 106`, `# pass 106`, `# fail 0`.
- [ ] 👤 Step 5: Verify - Human: open any playback page and `/meet` in light and dark mode - Expected: the small centered "ซอร์สโค้ด · AGPL-3.0" line sits under the card, muted, not crowding it - Proxy: Step 3's test asserts the markup on three pages.
- [ ] Step 6: Commit - `git add src/config.ts .env.example src/web/templates.ts src/web/templates.test.ts && git commit -m "feat(web): link the source code on every page"`

#### Task 18: Remove exploration code and the Bun lockfile from the tree

**Files:**
- Untrack: `spike/` (all tracked files; the local copy stays), Delete: `bun.lock`
- Modify: `.gitignore`

**Gotcha:** older plan docs mention `spike/meet-bot/...` paths as history; leave them.
Ask the user first if they want `spike/` kept in the repo (Open question 7); the default is to untrack it.

**Steps:**
- [ ] Step 1: `git rm -r --cached spike && git rm bun.lock`.
- [ ] Step 2: Append to `.gitignore`:
      ```
      # Local env files of any name; only the example is tracked
      .env.*
      !.env.example
      # Exploration code, kept locally only
      spike/
      ```
- [ ] Step 3: Verify - Run: `git ls-files spike bun.lock | wc -l; git check-ignore -q .env.local && echo env-ignored; git ls-files .env.example; npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'` - Expected: `0`; `env-ignored`; `.env.example`; `# pass 106`, `# fail 0` (`tsconfig.test.json` covers `src` only).
- [ ] Step 4: Commit - `git add .gitignore && git commit -m "chore: drop the spike code and the bun lockfile from the repo"` (the `git rm` changes are already staged).

#### Task 19: Dependency license check

**Files:**
- Create: `scripts/check-licenses.mjs`
- Modify: `package.json` (`scripts.licenses`)

**Steps:**
- [ ] Step 1: Create `scripts/check-licenses.mjs`:
      ```js
      // Fails when a package in a lockfile has a license that is not known to be AGPL-3.0 compatible. Run: npm run licenses
      import { readFileSync } from "node:fs";

      const ALLOWED = new Set([
        "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "MPL-2.0",
        "LGPL-3.0-only", "LGPL-3.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
      ]);
      const ok = (expr) => {
        const e = expr.replace(/[()]/g, "").trim();
        if (e.includes(" OR ")) return e.split(" OR ").some(ok);
        if (e.includes(" AND ")) return e.split(" AND ").every(ok);
        return ALLOWED.has(e);
      };

      const files = process.argv.length > 2 ? process.argv.slice(2) : ["package-lock.json", "meet/package-lock.json"];
      let bad = 0;
      for (const file of files) {
        const { packages } = JSON.parse(readFileSync(file, "utf8"));
        for (const [path, p] of Object.entries(packages)) {
          if (path === "") continue; // the project itself
          if (p.license && ok(String(p.license))) continue;
          console.log(`${file}: ${path.replace(/^.*node_modules\//, "")}@${p.version}: ${p.license ?? "no license field"}`);
          bad++;
        }
      }
      console.log(bad ? `${bad} packages need a license review` : "all dependency licenses are AGPL-3.0 compatible");
      process.exit(bad ? 1 : 0);
      ```
- [ ] Step 2: `package.json` scripts: `"licenses": "node scripts/check-licenses.mjs"`.
- [ ] Step 3: Verify - Run: `npm run licenses; echo '{"packages":{"":{},"node_modules/x":{"version":"1.0.0","license":"SSPL-1.0"}}}' > /tmp/everymeet-bad-lock.json; node scripts/check-licenses.mjs /tmp/everymeet-bad-lock.json; echo "exit $?"` - Expected: `all dependency licenses are AGPL-3.0 compatible` (exit 0); then `/tmp/everymeet-bad-lock.json: x@1.0.0: SSPL-1.0`, `1 packages need a license review`, `exit 1` (the negative control proves the check fires).
- [ ] Step 4: Commit - `git add scripts/check-licenses.mjs package.json && git commit -m "chore: check dependency licenses with npm run licenses"`

#### Task 20: CONTRIBUTING.md and SECURITY.md

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`
- Modify: `AGENTS.md` (`## Build and test commands`: add `npm run licenses`; `## Commits and pull requests`: add "Commits from outside contributors carry a DCO sign-off (`git commit -s`); maintainers check it before merging.")

**Steps:**
- [ ] Step 1: `CONTRIBUTING.md` (one sentence per line), sections:
      - `# Contributing`: thanks; the repo is the engine only (no accounts, billing, or customer pages; those requests are out of scope).
      - `## Before you start`: Node >= 22.12 and npm (not Bun), ffmpeg on PATH; `npm install`, `npm run typecheck`, `npm test`, and in `meet/` the same two when `meet/`, `src/meet/protocol.ts`, or `src/storage/keys.ts` change; `npm run licenses` when dependencies change.
      - `## Style`: point to AGENTS.md (code style, tests with fakes only, Thai user-facing text, placeholders only: `example.com`, never real addresses, ids, or Meet codes).
      - `## Commits`: Conventional Commits, one subsystem per commit.
      - `## Developer Certificate of Origin`: every commit carries `Signed-off-by: Name <email>` (`git commit -s`), which certifies the DCO 1.1 (link https://developercertificate.org); contributions are licensed under AGPL-3.0-only like the rest; there is no CLA, so contributors keep their copyright and the project can never be relicensed without every contributor's consent; maintainers check sign-offs before merging.
- [ ] Step 2: `SECURITY.md`: `# Security policy`; report vulnerabilities privately through GitHub's "Report a vulnerability" button on the repository's Security tab (private vulnerability reporting), not in public issues; what to include (version or commit, steps, impact); a reply within 7 days is a goal, not a promise; the supported version is the latest `main`; in scope: the engine in this repo (web pages, API, webhooks, recorder Worker and container); out of scope: the hosted service, which has its own channel.
- [ ] 👤 Step 3: Verify - Human: in the GitHub repository settings > Code security, turn on "Private vulnerability reporting" - Expected: the Security tab shows "Report a vulnerability" - Proxy: `grep -c "Report a vulnerability" SECURITY.md` prints `1` (the doc points at the button).
- [ ] Step 4: Verify - Run: `grep -c "$(printf '\342\200\224')" CONTRIBUTING.md SECURITY.md AGENTS.md; grep -c "git commit -s" CONTRIBUTING.md` - Expected: `0` for each file; `1` or more.
- [ ] Step 5: Commit - `git add CONTRIBUTING.md SECURITY.md AGENTS.md && git commit -s -m "docs: add contributing and security policies"`

#### Task 21: README self-hosting section and AGENTS.md map (after the older plan's Tasks 12-13)

**Files:**
- Modify: `README.md` (new `## Self-hosting` after `## How it works`; reorganize `## Setup` under it)
- Modify: `AGENTS.md` (`## Architecture map`, `## Project overview`, `## Security considerations`)

**Steps:**
- [ ] Step 1: README `## Self-hosting`: what you need for each surface (Discord bot: Discord app, R2, OpenRouter; `/meet` page: plus the `meet/` recorder on Cloudflare, `ALLOWED_EMAILS`, Resend; calendar: plus the bot Google account's iCal address and `MEET_BOT_EMAIL`, organizers on `ALLOWED_EMAILS`; API: plus `API_KEYS` and, for webhooks, `WEBHOOK_SECRET`/`WEBHOOK_URL`); a minimal `.env` per surface (names only, values as placeholders); the cost bound (at most 2 Meet recordings at once, about $0.08 per recording hour for the container plus transcription and summary); the PDPA/consent duty of whoever runs it; the upgrade note "builds before 2026-11-21 used `users.json` and `SEED_ADMIN_EMAIL`; set `ALLOWED_EMAILS` instead and delete `DATA_DIR/users.json`".
      If the older plan's Task 0 gate said STOP for the calendar, describe the calendar as not available and leave out its settings.
- [ ] Step 2: AGENTS.md map: add rows `src/api/` ("HTTP API under /api/v1: API keys (clients.ts), routes, Standard Webhooks signatures, durable webhook outbox (outbox.ts, the only webhook I/O is webhook-send.ts), event and Recording view (events.ts)") and `docs/api.md` ("the API contract; keep it in step with src/api/"); `src/test/setup.ts` row gains `mockWebhooks()`/`sentWebhooks`; Project overview gains one sentence on the API and webhooks.
      Security considerations gain two bullets: "API keys (`API_KEYS`) and `WEBHOOK_SECRET` are secrets: never log them; API keys are compared in constant time and a client sees only its own recordings."; "Webhooks never carry the PIN, the transcript, the full summary, audio links, or recipients; PINs come only from `POST /api/v1/recordings/{id}/pin`, stored as a hash."
- [ ] Step 3: Verify - Run: `grep -c "$(printf '\342\200\224')" README.md AGENTS.md; grep -n "src/api/" AGENTS.md | head -3; grep -n "^## " README.md` - Expected: `0` and `0`; the new row is listed; `## Self-hosting`, `## HTTP API`, and `## License` are among the headings.
- [ ] Step 4: Commit - `git add README.md AGENTS.md && git commit -m "docs: add self-hosting guide and the API to the map"`

#### Task 22: Clean the unpushed history and merge into main (gated on the user's choice)

Runs after every other commit of this plan and of the older plan, and only after the user picked an option in `## Git history decision` (Open question 5).
No agent runs Steps 3-6 without the user's explicit go in this session.

**Files:**
- Scratch, never committed: `/tmp/everymeet-replace.txt` (the real values, written by the user or with them, deleted after the run)

**Rollback:** the rewrite happens in a separate clone (`../everymeet-rewrite`), so the working repo and its branches stay as they were until Step 5; after a force-push (Option 3) there is no way back for others' clones.

**Steps:**
- [ ] 👤 Step 1: Verify - Human: tell the agent which option (1, 2, or 3), whether to map the author address (`--mailmap`), and check `gh repo view --json forkCount,stargazerCount` for Option 3 - Expected: a written choice in this task as a `> Decision:` line - Proxy: none (a decision, not a product check).
- [ ] 👤 Step 2: Verify - Human: write `/tmp/everymeet-replace.txt` with one `literal:<real value>==><placeholder>` line per value (the bot account address ==> `bot@example.com`, the sending domain ==> `mail.example.com`, each address on it ==> `minutes@mail.example.com`, the real Meet code ==> `abc-defg-hij`) - Expected: the file exists and is never added to git - Proxy: `test -s /tmp/everymeet-replace.txt && git status --short | grep -c everymeet-replace` prints `0`.
- [ ] Step 3 (Option 2): `brew install git-filter-repo`; `git clone --no-local . ../everymeet-rewrite && cd ../everymeet-rewrite` (the clone has `feat/meet-recording` as its only local branch; its `origin/*` refs are the working repo's branches and are not rewritten); `git filter-repo --refs 478be16..feat/meet-recording --replace-text /tmp/everymeet-replace.txt --replace-message /tmp/everymeet-replace.txt` (`--replace-message` also cleans commit messages; check `git filter-repo --help` that `--refs` takes a range; if it refuses ranges, STOP and ask: rewriting the whole branch would change the shared commits with `origin/main`).
- [ ] Step 4: Verify - Run (in `../everymeet-rewrite`): `git merge-base origin/main feat/meet-recording; git log -p 478be16..feat/meet-recording | grep -c -F -f <(sed -E 's/^literal:(.*)==>.*/\1/' /tmp/everymeet-replace.txt); npm ci && npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'` - Expected: `478be16...` (the shared base is unchanged); `0` matches; the gate is green.
- [ ] Step 5: Replace the branch in the working repo: `git fetch ../everymeet-rewrite feat/meet-recording:feat/meet-recording-clean`, compare `git diff feat/meet-recording feat/meet-recording-clean --stat` (expected: only the replaced values in old plan docs, if any), then `git branch -m feat/meet-recording feat/meet-recording-before-rewrite && git branch -m feat/meet-recording-clean feat/meet-recording`.
      Before the first push delete every local branch that still holds the old commits: `git branch -D feat/meet-track-b feat/meet-track-c` (both are contained in the old `feat/meet-recording`), and `feat/meet-recording-before-rewrite` once the push is done; push only this branch (`git push -u origin feat/meet-recording`), never `--all`.
      SHAs quoted in plan docs (for example the **Base commit** lines) now point at the old history; add one line under this plan's title: `> History rewritten on <date>: SHAs above refer to the history before the rewrite.`
- [ ] Step 6 (Option 3, only on top of Option 2 and only with no forks): in a fresh mirror clone, `git filter-repo --replace-text /tmp/everymeet-replace.txt --path meet/wrangler.deploy.jsonc --invert-paths` (plus the account id and the home path in the replace file), then `git push --force --all && git push --force --tags`; ask GitHub Support to purge cached views of the old commits; tell anyone with a clone to re-clone.
- [ ] Step 7: Merge into `main` (with Option 1 or 2): on `main`, `git merge feat/meet-recording`, then `git rm --cached meet/wrangler.deploy.jsonc` (tracked on `main` since 1b6f34a; `meet/.gitignore` already ignores it) and replace the account id in `.env.example` if the merge kept `main`'s version; commit `chore: untrack the personal deploy config`.
- [ ] Step 8: Verify - Run: `git ls-files meet/wrangler.deploy.jsonc | wc -l; git grep -nE '[0-9a-f]{32}' -- .env.example meet/ | wc -l; rm /tmp/everymeet-replace.txt` - Expected: `0`, `0`, and the replacement file is gone.

## Failure handling summary

- **A UX commit moved an anchor** (templates, meet-routes) - Detect: the anchor grep finds nothing or two places. Respond: re-read the current file, apply the same intent, record a `> Deviation:`; if the change of intent is unclear (for example the recorder page was restructured), STOP and ask.
- **The older plan's Tasks 12-13 already ran** - Detect: `src/calendar/poller.ts` exists. Respond: Task 3's Gotcha (edit the poller and its test in Task 3), and Task 4 Step 3 records that the older plan's text was rebased after the fact.
- **Boot refuses the config after upgrading** - Detect: `ALLOWED_EMAILS: set who may sign in` or `Google Meet recording needs ALLOWED_EMAILS ... or API_KEYS`. Respond: set `ALLOWED_EMAILS` (and `API_KEYS` for the API) in `.env`; an old `SEED_ADMIN_EMAIL` line is ignored (zod drops unknown keys), `DATA_DIR/users.json` is no longer read.
- **The webhook receiver is down** - Detect: `webhook ... failed (HTTP 5xx|fetch failed), attempt N` warnings, files piling up in `DATA_DIR/webhooks/pending/`. Respond: nothing to do in the engine for about 22 hours; after that, events are in `webhooks/failed/` (logged as errors); once the receiver is back, move them into `pending/` and they are delivered within 15 s.
- **The receiver refuses signatures** - Detect: steady 401/403 from the receiver. Respond: compare `WEBHOOK_SECRET` on both sides (the receiver needs the full `whsec_...` value) and the clock (5-minute tolerance); do not loosen the engine's signing.
- **R2 list fails** (`GET /recordings?ownerId=` answers 500 `internal_error`) - Detect: `request failed` with an S3 `ListObjectsV2` error in the log. Respond: check the R2 token has list permission on the bucket (Object Read covers `ListObjectsV2`); recordings stay reachable by id.
- **`git filter-repo --refs` refuses a range** - Detect: an error in Task 22 Step 3. Respond: STOP and ask; never rewrite the commits shared with `origin/main` without the user choosing Option 3.
- **A second process on the same Discord token during E2E** - Detect: every slash command answered twice or "already acknowledged". Respond: stop and ask which process to stop; never stop the production bot without asking.

## End-to-end verification

Run after Tasks 1-21 (Task 22 is history only).
Part A needs no secrets; Part B uses the user's `.env`, the deployed recorder Worker, and a real Meet room written here as `<TEST_ROOM>` (the user's test room code; never commit it).

Part A - with fakes (agent):
- [ ] Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)' && (cd meet && npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)') && npm run licenses` - Expected: both typechecks exit 0; root `# tests 106`, `# pass 106`, `# fail 0` (plus the older plan's calendar tests if Tasks 12-13 ran); meet `# pass 20`, `# fail 0`; `all dependency licenses are AGPL-3.0 compatible`.
- [ ] Run: `node --import tsx --experimental-test-module-mocks --test src/api/flow.test.ts` - Expected: 1 pass (API start, recorder end, pipeline, signed `recording.ended` and `minutes.ready`, PIN over the API, playback page, no email).
- [ ] Run: `git grep -nE "users/store|SEED_ADMIN|meetAdmin|user_busy|daily_limit" -- src .env.example README.md AGENTS.md | wc -l; git ls-files spike bun.lock | wc -l; git grep -c "$(printf '\342\200\224')" -- '*.md' | grep -v ':0$' | grep -v '^docs/plans/2026-1[01]-' | wc -l` - Expected: `0`, `0`, `0`.

Part B - real engine (user's `.env`): the user runs these commands in their own shell, because the agent must not read `.env`; the agent runs them only if the user allows reading `.env` in that session, and reports from the output the user pastes (it prints names, states, and ids only):
- [ ] Manual: `for k in MEET_RECORDER_URL MEET_RECORDER_TOKEN RESEND_API_KEY EMAIL_FROM ALLOWED_EMAILS API_KEYS WEBHOOK_SECRET WEBHOOK_URL; do grep -q "^$k=." .env && echo "$k set" || echo "$k MISSING"; done` - Expected: every key `set`, and `WEBHOOK_URL` is `http://127.0.0.1:9999/hook` for this run (the 👤 user sets it; prints names only).
- [ ] Manual: start a local receiver that prints each event's type, `data.state`, and whether the signature verifies (never the body), with the same check as `verifyWebhook`:
      ```bash
      node --env-file=.env --import tsx -e '
      import("./src/api/signature.ts").then(({ verifyWebhook }) => require("node:http").createServer((req, res) => {
        let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
          const h = { id: req.headers["webhook-id"], timestamp: req.headers["webhook-timestamp"], signature: req.headers["webhook-signature"] };
          const ok = verifyWebhook(process.env.WEBHOOK_SECRET, h, body, Math.floor(Date.now() / 1000));
          const b = JSON.parse(body); console.log(new Date().toISOString(), b.type, b.data.state, ok ? "signature ok" : "SIGNATURE BAD");
          res.writeHead(ok ? 204 : 401).end();
        });
      }).listen(9999, "127.0.0.1"));'
      ```
      Then `npm run dev` - Expected: the bot logs `playback page listening on :8787` and `logged in as`.
- [ ] Manual: `curl -s -X POST localhost:8787/api/v1/recordings -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"meetUrl":"https://meet.google.com/<TEST_ROOM>","ownerId":"e2e-1","delivery":{"mode":"webhook"}}'` with `KEY` read from `.env` into the shell without printing it - Expected: HTTP 201 JSON with `state: "starting"`; `curl .../recordings/<id>` moves to `joining`/`waiting`.
- [ ] 👤 Human: join `<TEST_ROOM>`, admit the bot, check the Thai/English recording notice in the Meet chat, speak Thai for about 2 minutes - Expected: the bot is in the call and the notice is visible - Proxy: `GET /api/v1/recordings/<id>` shows `state: "recording"`; `src/meet/session.test.ts` covers the notice-failed event.
- [ ] Manual: `curl -s -X POST localhost:8787/api/v1/recordings/<id>/stop -H "Authorization: Bearer $KEY"` - Expected: 202 with `stopping: true`; within about 2 minutes the receiver prints `recording.ended processing signature ok`, and within about 5 minutes `minutes.ready done signature ok`; no email arrives anywhere (webhook mode).
- [ ] Manual: `curl -s -X POST localhost:8787/api/v1/recordings/<id>/pin -H "Authorization: Bearer $KEY"` - Expected: `{ pin, playbackUrl }`; `curl -s "localhost:8787/api/v1/recordings?ownerId=e2e-1" -H "Authorization: Bearer $KEY"` lists the id first.
- [ ] 👤 Human: open `playbackUrl` (on `PUBLIC_BASE_URL`), enter the PIN - Expected: the player plays the audio; the page footer shows "ซอร์สโค้ด · AGPL-3.0" - Proxy: `src/api/flow.test.ts` and `src/api/pin.test.ts`.
- [ ] 👤 Human: repeat the start with `"delivery":{"mode":"email","starter":"<your address>"}` and let it end by leaving the call - Expected: the Thai minutes email arrives with a PIN that opens the page, and the receiver also gets both events - Proxy: `src/pipeline/run.test.ts` email tests.
- [ ] 👤 Human: on `<PUBLIC_BASE_URL>/meet` sign in with an address on `ALLOWED_EMAILS`, then ask a link for an address that is not on it - Expected: the first gets the login email and the recorder page (with no admin link); the second sees the same "ตรวจอีเมลของคุณ" page and gets no email - Proxy: `src/web/meet-routes.test.ts` allowlist tests; Manual: the log shows `login link not sent to ...: not on ALLOWED_EMAILS`.
- [ ] 👤 Human: in Discord, `/record` in a voice channel for one minute, then `/end` - Expected: minutes in `#meeting-of-minutes` as before - Proxy: `src/bot.test.ts` and `src/pipeline/run.test.ts` Discord tests.
- [ ] Manual: for each id started above, `GET /api/v1/recordings/<id>` shows `done` or `failed`, and `ls $DATA_DIR/webhooks/pending | wc -l` prints `0` - Expected: no recording or event left behind.

## Open questions for the user

The defaults ship unless the user says otherwise.

1. **License variant:** `AGPL-3.0-only` (default; keeps future license versions under the copyright holders' control) or `AGPL-3.0-or-later` (lets the FSF's future versions apply, a common choice that eases combining with "-or-later" code).
2. **DCO or CLA:** DCO by default (Decision 15); choose a CLA only if you may want to relicense the engine (for example a proprietary or dual-licensed edition) later, which DCO rules out once others contribute.
3. **Copyright line:** `Copyright (C) 2026 The everymeet authors` (default) or your legal name or company.
4. **Deleting recordings over the API:** customers of the hosted service may ask for erasure (PDPA); a `DELETE /api/v1/recordings/{id}` that removes the R2 objects and the owner index is not in this plan; say if it should be the next plan.
5. **History:** Option 1, 2 (recommended, always), or 3 (only with no forks) in `## Git history decision`, and whether the commit author address should be mapped to a GitHub `noreply` address during a rewrite; also whether `origin/rust-migration` (with a real-looking Discord id) should be deleted from the remote.
6. **Webhooks for web and calendar recordings:** off by default (only API recordings have an owner to report to); self-hosters might want them for chat integrations.
7. **`spike/`:** untracked by default (kept on your disk); say if it should stay in the repo.
8. **Defaults:** the rate limit counts per client name, not per key (two keys of one name during rotation share it; U6 said "per-key"), `API_RATE_LIMIT_PER_MIN` 120, 30 failed key attempts per IP per minute, 50 recipients per API email-mode start, 16 KB request bodies, the retry schedule of about 22 hours.
9. **Security contact:** GitHub private vulnerability reporting (default) or an email address (it would be a real address in a public file).

## Review record

Round 1 (independent scrutinize review, Opus 5.5 medium): 0 blockers, 6 majors, 9 nits.
Fixed: the Task 10 `pin` assertion (`stopping` contains `pin`), the templates test env for Task 17, the full rebase of the older plan's Task 13 tests and counts (Task 4), a JSON `onError` for `/api/v1` (`internal_error`), Discord made optional (Task 6), and nits 1 and 3-9 (filter-repo `--replace-message` and branch handling, `ownerId` without `.` segments, `endReason` documented as free text, one bad outbox file no longer blocks the rest, `meetRecorderConfigured` deleted, a real invalid-JSON test, the consent rule moved to Task 10, the 409 leak documented, Part B run by the user).
Round 2 (fresh reviewer, same model): 0 blockers, 1 major, 8 nits; the round-1 fixes were confirmed.
Fixed: `WEBHOOK_URL` is checked at field level with `URL.canParse` (a typo no longer crashes boot or echoes the value), the leftover "active users" test title and Task 12 count in the older plan, a 400 instead of a retried 500 in the Task 10 failure test, a per-attempt clock in `deliverDue`, no `/meet` button in API starter emails, `minutes.ready` repeats documented, the DCO rule worded for outside contributors, this plan committed in Task 4, and the Discord source-offer sentence.
Not taken: dropping the per-request `webhookUrl` (round 1 major 1), because the user's brief lists an optional webhook URL in the start request; Decision 8 records why the origin allowlist keeps it safe.
Nit 2 (per-client vs per-key rate limit) became part of Open question 8.

## Confidence derivation

Start at 10 and subtract per the writing-plans rubric, counted in this file:
- Consumes entries without a full signature: 0 (single track; every consumed name is produced with its signature in an earlier task's Interfaces).
- Patterns-to-Mirror SOURCEs not verified against the real file: 0 (all read at 883fa96).
- Verify - Human with no paired proxy: 0 (Task 22 Step 1 is a decision, not a product check).
- NOT-building entries that cut a requirement on an unproven claim: 0 ("no `meet/` change" rests on Tasks 1-21's Files blocks touching only `meet/package.json`).
- Tasks touching a shared or inferred type without consumers listed: 0 (`MeetInfo`/`MeetManifest` in Task 9, `Config` in Tasks 2, 3, 6, 17, `RefusalReason` in Task 1, `mockR2` exports in Task 11).
- Preflight checks written but never run: 0 (the baseline, deps, node, ffmpeg, and old-plan checks were run at 883fa96; the live `.env` check is deferred to Part B because reading `.env` was not allowed, as in the older plan).
- Parallel tracks below the cost floor: 0 (one track).
- Judgement: -1 because UX commits are landing on `src/web/templates.ts` and `src/web/meet-routes.ts` after 883fa96 and may move anchors; -1 because the larger reference modules (`routes.ts`, `outbox.ts`, the flow test) were written without a compiler; -1 because `git filter-repo --refs <range>` was not tried (not installed while planning).
Result: 7/10.
