# Google Meet Recording Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-10-28-google-meet-recording.md` - the runner that ticks these checkboxes and honours the track/merge layout below.
>
> **For the executing agent:** Implement this plan track-by-track.
> Parallel tracks each get their own `treehouse get --lease` worktree (see Execution).
> Steps use checkbox (`- [ ]`) syntax for tracking; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.
> Code in Steps is a reference implementation written without a compiler.
> When `tsc` or a test rejects it, the tool wins: correct it minimally and record a `> Deviation:` note under the step.

**Goal:** A Discord slash command `/record-meet url:<Meet link>` sends a bot into a Google Meet call, records the call audio, and when the meeting ends posts the same Thai minutes, PIN playback page, and `#meeting-of-minutes` message as a Discord recording.
**Architecture:** A new deployable `meet/` holds a Cloudflare Worker, one Durable Object (`MeetRecorder`) per recording, and a Playwright + Xvfb + PulseAudio container image; the container uploads exact 5-minute FLAC segments and status events to its own Durable Object through `interceptOutboundHttp`; the Worker's callback entrypoint writes the segments to R2 with its binding and the Durable Object keeps the recording state.
The VPS bot creates the Manifest, starts the recording over HTTPS with a Bearer token, polls the recording status every 15 s, and when the recording ends it fills the Manifest (one mixed pseudo-participant `meet`) and hands it to the existing pipeline, which finds speech with a small energy VAD and then runs unchanged transcription, summaries, PIN, and posting.
Only pure contract files (`src/meet/protocol.ts`, `src/storage/keys.ts`) are shared; the container receives sample rate and segment length in its job, so `src/config.ts` stays the single source of truth.
**Tech Stack:** Node 22 + TypeScript 7 + discord.js + node:test (VPS bot, unchanged runtime); Cloudflare Workers + Durable Objects + Containers (`ctx.container` API, wrangler 4.154); Playwright 1.64.1 headful Chromium, Xvfb, PulseAudio, ffmpeg, xdotool in `mcr.microsoft.com/playwright:v1.64.1-noble`; esbuild for the container bundle.
**Spec:** `docs/plans/2026-10-28-google-meet-recording-spec.md` (the task brief of 2026-10-29 with the spike findings and the user decisions relayed that day).
**Base commit:** 52866bd
**Confidence:** 9/10 - see the derivation at the end of this file; the two real unknowns (uploads through `interceptOutboundHttp` in production, and Meet DOM strings for the People count, tiles, and chat) are only provable on Cloudflare and in a real call, so Task 0 (before Track C), Task 19, and the End-to-end section gate them.
**NOT building:**
- Per-speaker audio and speaker names for Meet (phase 2, outlined in `## Phase 2 outline`, separate plan).
- The 2-hour "Continue recording?" button for Meet recordings; Meet uses a hard limit `MEET_MAX_DURATION_MIN` (default 240) plus the alone rule instead (see Decision 6).
- CPU tuning (disabling incoming video, `--in-process-gpu`) and investigating why the spike's exec stdout stream never closed; the design does not read exec stdout at all.
- Refreshing the bot-account session automatically or falling back to guest mode when it expires; an expired session ends the run with a Discord notice.
- Any change to `spike/meet-bot/` (it stays as the historical reference).
- Zoom / Teams / other meeting platforms.
- A local (non-Cloudflare) way to run the recorder container against a real Meet call; the spike already covers that.

## Decisions

Each decision states the chosen option and why, briefly.

1. **Repo layout: one new npm package `meet/`** with its own `package.json`, `package-lock.json`, `wrangler.jsonc`, two tsconfigs, `worker/` (Worker + Durable Object), `bot/` (container runner), `Dockerfile`, `entrypoint.sh`, and its own `npm run typecheck` / `npm test`.
   The root package is untouched except for new code under `src/meet/`, so the VPS image, `npm ci`, and the root test glob `src/**/*.test.ts` never see `meet/`.
   Shared code is only what crosses the boundary and is pure: `src/meet/protocol.ts` (types + 2 constants, no imports) and `src/storage/keys.ts` (R2 key builders, split out of `r2.ts`).
   `meet/` imports them by relative path (`../../src/...`); wrangler's esbuild bundles them into the Worker, and the container bundle is built on the host with esbuild before `podman build`, so the image build context is `meet/` alone and only `meet/.dockerignore` applies (wrangler pipes the Dockerfile on stdin).
   They must live under `src/` because the root `tsconfig.json` has `rootDir: "src"`.
   Sample rate and segment length travel in the job payload from `src/config.ts`, so no constant is duplicated.
2. **Audio to R2: container -> Durable Object callback -> R2 binding** (user decision).
   The container sends `PUT http://meet-recorder.internal/segments/<index>` with one FLAC segment (at most ~14.4 MB for 5 minutes of 24 kHz mono) and an `x-samples` header; `interceptOutboundHttp` routes it to the `RecorderCallback` entrypoint with the recording id in `props`, which writes it with `env.BUCKET.put` and then tells the Durable Object the segment exists (so the large body never crosses the Durable Object RPC boundary).
   No R2 S3 keys enter the container.
   Callbacks carry no token: only this container's requests for `meet-recorder.internal` reach the entrypoint, the host is not publicly routable, and the Meet page cannot forge one (plain http from an https page is blocked as mixed content).
3. **End signal to the VPS: the VPS polls** `GET /recordings/<id>` on the Worker every 15 s (the same tick the Discord recorder uses).
   The Durable Object is the source of truth for the recording state, so a VPS restart loses nothing: on boot `recoverUnfinished` re-attaches to Meet recordings instead of closing them.
   No new inbound endpoint or HMAC check on the VPS; the only credential is one Bearer token from VPS to Worker over HTTPS.
   `/end` in Discord calls `POST /recordings/<id>/stop`; the Durable Object sets `stopRequested`, and the container sees it in the reply to its next event (heartbeat every 5 s), leaves the call, flushes the last segment, and reports `ended`.
4. **Speaker attribution: phase 1 = one mixed track** as the pseudo-participant `meet` with display name `เสียงรวมจาก Google Meet` (user decision).
   Transcript lines for Meet recordings carry no speaker name and are never joined, the summary prompt is told that speakers are unknown, and the playback page shows no per-speaker section.
5. **Bot-account session** (user decision): `MEET_AUTH_STATE_FILE` on the VPS (mounted read-only from `./secrets/` in docker compose) is read fresh on every `/record-meet`, sent in the start request body over HTTPS, forwarded by the Durable Object to the runner's stdin, and never stored in Durable Object storage, R2, or logs.
   Unset means guest mode.
   It is created once with `npm run meet:login` in `meet/` (local podman + noVNC on `127.0.0.1:6080`, as in the spike).
   An expired session (redirect to `accounts.google.com`, or the guest name field shown while signed in) ends the run as `auth_expired` with a Discord notice telling an admin to run `meet:login` again.
6. **Meet end rules** (container `bot/rules.ts`, pure):
   - `/end` in Discord -> `stopped`.
   - Meet end screen "You've been removed from the meeting" -> `removed`.
   - Meet end screens for a finished call, or the call UI (Leave button, tiles) gone for 30 s -> `meeting_ended`.
   - The People button counts exactly 1 (only the bot) for `EMPTY_CHANNEL_TIMEOUT_MIN` (existing setting, default 3) -> `alone`; when the count cannot be read, this rule never fires.
   - Recording for `MEET_MAX_DURATION_MIN` (new, default 240) -> `max_duration`.
   - Not admitted within 5 minutes -> `not_admitted`; host denial or Meet refusing the join -> `denied`.
   - Backstops in the Durable Object: no event for 3 minutes -> `container_lost`; hard deadline (admit + max duration + 10 min) -> `max_duration`; runner exit without `ended` -> `crashed`.
   Leaving is part of every normal end: the runner clicks "Leave call" with humanized input and verifies it left ("You left the meeting" or the call UI gone), and reports `leftCleanly`.
   The 2-hour continue prompt is not ported: the hard limit is the cost guardrail and the alone rule ends abandoned calls.
7. **Testing:** pure units with node:test in both packages (end rules, segment splitting, VAD, Meet URL parsing, Worker core state machine with fake ports, Worker HTTP auth and routing); the VPS `MeetSession` and `/record-meet` are driven through a scripted fake Worker (`fakeMeetRecorder()` in `src/test/setup.ts`); `src/pipeline/run.test.ts` gains a Meet end-to-end test with real ffmpeg and a FLAC segment that exists only in the in-memory R2.
   Nothing in either test suite talks to Discord, Google, Cloudflare, or OpenRouter.
   The real Meet call is verified once in `## End-to-end verification` against the test room `https://meet.google.com/jku-cpry-bcg`.
8. **Deployment:** `wrangler deploy` from `meet/` with podman, using the registry-tag procedure proven by the spike (Task 19): build the amd64 image with podman, `wrangler containers push`, then deploy a gitignored `wrangler.deploy.jsonc` whose `image` is the pushed registry tag.
   Guardrails: `instance_type: standard-2`, `max_instances: 2`, `setInactivityTimeout` and a Durable Object alarm at the hard deadline, the container is destroyed when the runner exits or reports `ended`, and Durable Object storage is deleted 7 days after the end.
   Measured cost from the spike: about $0.076 per recording hour on standard-2.

## Architecture

```
Discord /record-meet ──► VPS bot (MeetSession)
   │  manifest.json (status recording, meet{url,code}) ─► R2
   │  POST /recordings/<id>  {job + authState}  (Bearer MEET_RECORDER_TOKEN, HTTPS)
   ▼
Worker everymeet-meet-recorder ──► Durable Object MeetRecorder (name = manifest id)
   │  container.start(sleep infinity) · interceptOutboundHttp(meet-recorder.internal) · exec entrypoint.sh, job on stdin
   ▼
Container: Xvfb + PulseAudio sink "meet" + Chromium (Playwright, humanized xdotool input)
   join ─► consent message in Meet chat ─► ffmpeg -f pulse meet.monitor ─► exact 5-min s16le segments ─► FLAC
   POST /event (joining, waiting, recording, heartbeat every 5 s, ended)   PUT /segments/<n>   PUT /debug/failure.png
   ▼ (intercepted)                                    ▼
Durable Object state (storage)                      R2 meetings/<id>/segments/meet/NNNN.flac
   ▲
VPS polls GET /recordings/<id> every 15 s; on "ended": manifest participants.meet = segments, status processing
   ▼
processMeeting: markMeetSpeech (VAD) ─► buildRawTracks ─► mp3 ─► transcribe ─► Thai summaries ─► PIN ─► #meeting-of-minutes
```

The `PUT /segments` request is stored by the `RecorderCallback` entrypoint (R2 binding), which then records the segment in the Durable Object.

R2 layout gains:
```
meetings/<id>/segments/meet/NNNN.flac   5-min Meet segments (written by the Worker)
meetings/<id>/debug/failure.png         screenshot when a Meet join fails
```


## Global Constraints

- Root runtime is Node >= 22.12.0 with npm and `package-lock.json`; never use Bun APIs or `bun.lock` (AGENTS.md "Hard constraint").
- `meet/` is its own npm package with its own `package-lock.json`; the root `package.json` and lockfile do not change in this plan.
- Every relative import in TypeScript ends in `.js` (root and `meet/`), including imports of `../../src/...` from `meet/`.
- Double quotes, semicolons, 2-space indent, trailing commas; match surrounding code (no formatter or linter exists).
- All environment access in the VPS bot goes through `src/config.ts`; every new variable is added to the zod schema and to `.env.example` in the same task.
- Log through `logger(scope)` in the VPS bot, never bare `console.log`; the Worker logs with `console.log(JSON.stringify(...))` (Workers Logs), and the container runner does not log to stdout at all because the Durable Object runs it with `stdout: "ignore"`.
- User-facing strings on the playback page, the minutes, the transcript, and the Meet chat consent text are Thai; Discord command replies stay English like the existing `/record` replies (`src/interactions.ts`).
- Times stay Bangkok time through `src/util/time.ts`; never format in UTC.
- One recording per guild across Discord and Meet sources: `activeSessions` (moved to `src/recorder/active.ts`) is the only registry and both sources check it.
- Consent / PDPA: the bot announces a Meet recording in the Discord command channel and posts the Thai/English notice in the Meet chat right after it is admitted; if the chat notice fails, the Discord announcement says so.
- The bot-account session (`authState`) is never written to Durable Object storage, R2, logs, error messages, or the Manifest; it exists only in the VPS file, the HTTPS request body, the Durable Object's memory during `start`, and the runner's stdin.
- The R2 bucket stays private; the Worker writes only `meetings/<id>/segments/meet/*.flac` and `meetings/<id>/debug/*.png` through its binding, and caps any recording at 6 hours whatever the bot asks.
- The Worker API requires `Authorization: Bearer <RECORDER_TOKEN>` on every request, compared in constant time; the VPS sends `MEET_RECORDER_TOKEN` (same value, at least 32 chars, `openssl rand -base64 48`).
- Never commit `.env`, `secrets/`, `meet/auth/`, or `meet/wrangler.deploy.jsonc`; never log tokens or the session.
- Both transcription models and both summary models must keep working with their fallbacks; the Meet path goes through the unchanged `transcribe()` and `chat()` in `src/pipeline/openrouter.ts`.
- Tests use `node:test` + `node:assert/strict`, sit next to the code as `*.test.ts`, and never talk to real Discord, Google, Cloudflare, or OpenRouter.
- Quality gate per package: root `npm run typecheck` and `npm test`; `meet/` `npm run typecheck` and `npm test`.
- Commits: short imperative subject scoped to one subsystem, no agent co-author line, never edit CHANGELOG files.
- Markdown docs written by this plan put each full sentence on its own line and never use the em dash.

## Patterns to Mirror

### Config: zod schema in `src/config.ts`, read through `config()`
<!-- SOURCE: src/config.ts:1-12 -->
```ts
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
```

### Error handling: log and keep going when the failure is not fatal
<!-- SOURCE: src/recorder/segment-uploader.ts:33-43 -->
```ts
    try {
      await ffmpeg([...rawInput(rawPath), "-c:a", "flac", flac]);
      await putFile(keys.segment(this.manifest.id, userId, index), flac, "audio/flac");
      participant.uploaded.push(index);
      await saveEverywhere(this.manifest);
    } catch (err) {
      // Not fatal: the local copy is still used at the end of the meeting.
      log.warn(`upload failed for ${this.manifest.id} user ${userId} segment ${index}`, err);
    } finally {
      if (existsSync(flac)) unlinkSync(flac);
    }
```

### Sequential background work: a promise chain
<!-- SOURCE: src/recorder/segment-uploader.ts:14-26 -->
```ts
export class SegmentUploader {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly manifest: Manifest) {}

  enqueue(userId: string, index: number, rawPath: string): void {
    this.chain = this.chain.then(() => this.upload(userId, index, rawPath));
  }
```

### Tests: mock R2 before dynamically importing the module under test
<!-- SOURCE: src/pipeline/run.test.ts:5-19 -->
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, Collection } from "discord.js";
import { chatReply, dataDir, flush, mockOpenRouter, mockR2, r2, r2Text, type OpenRouterCall } from "../test/setup.js";

mockR2();
const { processMeeting, recoverUnfinished } = await import("./run.js");
const { saveLocal, meetingDir } = await import("../storage/manifest.js");
const { keys } = await import("../storage/r2.js");
```

### Session registry and tick (the Meet session mirrors the 15 s tick)
<!-- SOURCE: src/recorder/session.ts:30-36 -->
```ts
export const CONTINUE_BUTTON_PREFIX = "meeting-continue:";
/** Wait this long past a segment boundary before closing it, so late packets still land. */
const SEGMENT_GRACE_SAMPLES = SAMPLE_RATE * 15;
const TICK_MS = 15_000;

/** One active recording per guild (a bot can only be in one voice channel per guild). */
export const activeSessions = new Map<string, MeetingSession>();
```

### Durable Object owning a container (spike, verified on Cloudflare 2026-10-28)
<!-- SOURCE: spike/meet-bot/cf/src/worker.ts:8-24 -->
```ts
// Exec does not inherit the image ENV, so the variables the Playwright image relies on are set here.
const BASE_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  HOME: "/root",
};
const LIFETIME_MS = 20 * 60 * 1000;

/** One Durable Object per spike run; it owns one container kept alive with `sleep` so files can be read after the run. */
export class MeetSpike extends DurableObject<Env> {
  private async container(): Promise<Container> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container configured");
    if (!c.running) {
      c.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
```
The stdin payload, `stdout: "ignore"`, `interceptOutboundHttp`, and `exitCode.then(stop)` follow Cellar (`/Users/jametirakarn/Desktop/Theerakarnm/Cellar/src/worker/container/job-runner.ts:25-51`, read-only reference, deployed 2026-10-26):
```ts
    container.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
    await container.setInactivityTimeout(Math.max(request.deadlineMs - Date.now(), 0) + GRACE_MS);
    await this.ctx.storage.setAlarm(request.deadlineMs + GRACE_MS);
    await container.interceptOutboundHttp(CALLBACK_HOST, this.ctx.exports.CallbackEntrypoint({}));
    const proc = await container.exec(RUNNER_COMMAND, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const writer = proc.stdin?.getWriter();
    await writer.write(new TextEncoder().encode(request.payloadJson));
    await writer.close();
    this.ctx.waitUntil(proc.exitCode.then(() => this.stop()));
```

### Worker tests
No existing pattern in this repo - establishing new convention: Worker logic lives in plain modules (`meet/worker/core.ts` with injected ports, `meet/worker/http.ts` with a structural `RecorderApi`) tested with node:test through `tsx`; only `meet/worker/index.ts` and `meet/worker/recorder.ts` import `cloudflare:workers`, and they stay thin adapters (Cellar does the same: its Durable Object class has no tests and its logic is in plain modules).

### Meet selectors
No existing pattern in this repo - establishing new convention: all Meet DOM strings live in `meet/bot/meet-page.ts`, adapted from Vexa (Apache-2.0, `/tmp/meetbots/vexa/core/meetings/modules/join/src/googlemeet/selectors.ts:21-130,246-269,417-452`) and pinned to the en-US UI (`--lang=en-US`, context `locale: "en-US"`, `?hl=en` on the URL).
Attendee (Elastic License 2.0) was read for ideas only; no code from it is used.


## Preflight

### DURABLE - true until the repo itself changes

- npm is the package manager and the root has no workspaces - Evidence: `package.json` has no `workspaces`, the Dockerfile runs `npm ci` - Consequence: `meet/` is installed separately with `cd meet && npm ci` in every worktree that runs Track C or D.
- The root test glob does not descend into `meet/` - Evidence: `package.json` `"test": "node --import tsx --experimental-test-module-mocks --test 'src/**/*.test.ts'"` and `tsconfig.json` `"include": ["src"]`, `"rootDir": "src"` - Consequence: shared files must live under `src/`; `meet/` has its own test and typecheck scripts.
- Wrangler builds container images with the Dockerfile on stdin, so only `<image_build_context>/.dockerignore` applies - Evidence: global memory "wrangler container builds pipe the Dockerfile on stdin" (Cellar, wrangler 4.152) - Consequence: `meet/.dockerignore` is an allowlist; the deploy in Task 19 builds with podman directly anyway.
- This Mac has podman, no docker CLI - Evidence: `which docker` exits 1; `podman --version` prints `podman version 5.8.0` - Consequence: every image command in this plan uses `podman`; `WRANGLER_DOCKER_BIN=podman` is set only for `wrangler containers push`.
- Podman on macOS shares `/Users` into the VM but not `/tmp` - Evidence: spike notes (global memory `everymeet_google_meet_guest_bot_spike_findings_2026_10_28`) - Consequence: `meet:login` mounts `meet/auth` (under `/Users`).
- Container types available in `@cloudflare/workers-types` 5.20261028.1: `Container.start(options)`, `setInactivityTimeout(ms)`, `interceptOutboundHttp(addr, Fetcher)`, `exec(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore", env, cwd })` returning `ExecProcess` with `stdin: WritableStream | null` and `exitCode: Promise<number>`, `destroy(reason)`; `ctx.exports.<Entrypoint>({ props })` returns a `Fetcher` - Evidence: `spike/meet-bot/cf/node_modules/@cloudflare/workers-types/index.d.ts:3959-4042,4134-4141`.
- treehouse is installed - Evidence: `treehouse --version` printed `v3.1.2`.

### PERISHABLE - recapture before task 1

- Baseline gate is green - Check: `npm run typecheck; npm test 2>&1 | tail -8` - Value at planning (2026-10-29, 52866bd): typecheck exit 0; `# tests 31`, `# pass 31`, `# fail 0` - Needed by: every root Verify that says "0 fail".
- ffmpeg and ffprobe on PATH - Check: `ffmpeg -version | head -1 && ffprobe -version | head -1` - Value at planning: `/opt/homebrew/bin/ffmpeg` present - Needed by: root `npm test`, Task 6, Task 8.
- Root dependencies installed in THIS checkout - Check: `test -d node_modules && npm run typecheck` exits 0 - Needed by: every root task (a leased worktree starts without `node_modules`; run `npm ci` first).
- Node version - Check: `node --version` - Value at planning: `v22.19.0` - Needed by: both packages (`>=22.12.0`).
- Podman machine running - Check: `podman info >/dev/null && echo up` - Value at planning: `podman machine list` showed `podman-machine-default ... Currently running` - Needed by: Task 17 (image build) and Task 19.
  If podman commands fail with "connection refused" although the machine says Running, restart it from a persistent shell (global memory "Cellar deploy on podman", step 1).
- npm registry reachable - Check: `npm ping 2>&1 | tail -1` - Value at planning: `npm notice PONG` - Needed by: Task 10 (`npm install`) and every `npm ci` in a fresh worktree.
- Playwright base image present locally - Check: `podman image exists mcr.microsoft.com/playwright:v1.64.1-noble && echo BASE_PRESENT` - Value at planning: `BASE_PRESENT` - Needed by: Task 17 and Task 19 (otherwise the first build pulls about 2 GB).
- Spike image already in the Cloudflare registry - Check: `podman images --format '{{.Repository}}:{{.Tag}}' | grep meetspike` - Value at planning: two tags of `registry.cloudflare.com/<account-id>/everymeet-meet-spike-meetspike` - Needed by: Task 0 (the transport probe reuses that image instead of building one).
- Uncommitted spike edits - Check: `git status --short spike/` - Value at planning: 5 modified files and `metrics.mjs` untracked under `spike/meet-bot/` - Needed by: nothing in this plan; leave them alone and never stage them in this plan's commits (`git add` explicit paths only).

Deploy-time prerequisites (Cloudflare login, the bot-account session file, a Discord test server) are checked as the first step of Task 19 and in `## End-to-end verification`, because they need artifacts this plan creates and live authenticated calls that were not allowed during planning.

## Execution

**Tracks:**
- Task 0 (no worktree, a scratch directory outside the repo) - the transport probe; run it first.
  If it fails, STOP before Track C and ask the user (Tracks A and B do not depend on it).
- Track A (`plan:google-meet-recording:track-a`) - Tasks 1-3.
  Foundation, no dependencies.
  Merges first.
- Track B (`plan:google-meet-recording:track-b`) - Tasks 4-9, VPS bot side under `src/`.
  Depends on Track A merged.
  Runs in parallel with Track C.
- Track C (`plan:google-meet-recording:track-c`) - Tasks 10-17, the new `meet/` package.
  Depends on Track A merged.
  Runs in parallel with Track B.
- Track D (no worktree, the main checkout after B and C merge) - Tasks 18-19, docs, deploy, smoke.

**Merge order:** Task 0 passes first; then A, then B and C in any order, then D on the merged result, then `## End-to-end verification`.
**Shared files:** `.env.example`, `.gitignore`, `.dockerignore`, `src/config.ts`, `src/storage/manifest.ts`, `src/meet/protocol.ts`, `src/storage/keys.ts` - owned by Track A (Tasks 1-3); Tracks B and C only read the last two.
`src/test/setup.ts` - Task 1 (mock drops `keys`), Task 3 (env), then Task 8 (fake recorder); Track C never touches it.
`README.md`, `AGENTS.md`, `docker-compose.yml` - Task 18 only.
Root `package.json` and `package-lock.json` - no task changes them.
`meet/package.json` and `meet/package-lock.json` - Task 10 creates them and no later task edits them.
**Process-global singletons:** Track B uses ffmpeg and temp dirs only; Track C uses podman only in Task 17; no ports, servers, or external APIs are shared, so B and C can run at the same time.
**Worktree setup per track:** `WORKTREE=$(treehouse get --lease --lease-holder "plan:google-meet-recording:track-b"); cd "$WORKTREE"; git switch -c feat/meet-track-b; npm ci` (Track C additionally runs `cd meet && npm ci` from Task 11 on).
**Teardown:** `treehouse return "$WORKTREE"` after the track's branch is merged.



---

### Task 0 - transport probe (before Track C; throwaway, nothing committed)

#### Task 0: Prove that a container can upload 12 MB to R2 through `interceptOutboundHttp`

**Files:**
- Create (outside the repo, deleted at the end): `/Users/jametirakarn/everymeet-intercept-probe/wrangler.jsonc`, `/Users/jametirakarn/everymeet-intercept-probe/probe.ts`

Uploads and events through `interceptOutboundHttp` are the only load-bearing assumption no one has run in production (Cellar never verified that path; the spike used exec stdout and a public Bearer route).
This probe checks it with the spike image before Track C builds on it, including whether Node `fetch` in the container reaches `meet-recorder.internal` and whether a 12 MB body gets through (a 5-minute FLAC segment is 5-14 MB).

**Interfaces:**
- Consumes: the spike image already pushed to the Cloudflare registry (Preflight).
- Produces: a yes/no for Decision 2; nothing in the repo.

**Rollback:** `cd /Users/jametirakarn/everymeet-intercept-probe && npx wrangler delete && npx wrangler containers list` then `npx wrangler containers delete <ID>` for `everymeet-intercept-probe`; `npx wrangler r2 object delete meeting-recordings/probe/intercept-test.bin --remote`; `rm -rf /Users/jametirakarn/everymeet-intercept-probe`.

**Steps:**
- [ ] Step 1: `mkdir -p /Users/jametirakarn/everymeet-intercept-probe && cd $_ && npm init -y >/dev/null && npm install wrangler@^4.154.0 >/dev/null && npx wrangler whoami | grep -ci "logged in"` prints at least 1 (if not, STOP and ask the user to log in).
      Find the newest spike image with `podman images --format '{{.Repository}}:{{.Tag}}' | grep meetspike | head -1` and use it as `<SPIKE_IMAGE>`.
- [ ] Step 2: Create `wrangler.jsonc`:
      ```jsonc
      {
        "name": "everymeet-intercept-probe",
        "main": "probe.ts",
        "compatibility_date": "2026-10-01",
        "workers_dev": true,
        "containers": [{ "class_name": "Probe", "image": "<SPIKE_IMAGE>", "instance_type": "standard-1", "max_instances": 1 }],
        "durable_objects": { "bindings": [{ "name": "PROBE", "class_name": "Probe" }] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Probe"] }],
        "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "meeting-recordings" }]
      }
      ```
      and `probe.ts`:
      ```ts
      import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

      interface Env {
        PROBE: DurableObjectNamespace<Probe>;
        BUCKET: R2Bucket;
        PROBE_TOKEN: string;
      }

      /** What the real RecorderCallback will do: receive the container's request and write the body to R2. */
      export class Sink extends WorkerEntrypoint<Env> {
        override async fetch(request: Request): Promise<Response> {
          const body = await request.arrayBuffer();
          await this.env.BUCKET.put("probe/intercept-test.bin", body);
          return Response.json({ stored: body.byteLength, path: new URL(request.url).pathname });
        }
      }

      const PUT_12MB =
        "fetch('http://meet-recorder.internal/segments/0',{method:'PUT',headers:{'x-samples':'1'},body:Buffer.alloc(12*1024*1024,7)})" +
        ".then(async r=>console.log(r.status, await r.text())).catch(e=>console.log('ERR', e.cause?.code ?? e.message))";

      export class Probe extends DurableObject<Env> {
        async run(): Promise<string> {
          const c = this.ctx.container!;
          if (!c.running) c.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
          await c.interceptOutboundHttp("meet-recorder.internal", (this.ctx.exports as any).Sink({}));
          const proc = await c.exec(["node", "-e", PUT_12MB], {
            env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
            stdout: "pipe",
            stderr: "combined",
          });
          const out = new TextDecoder().decode((await proc.output()).stdout);
          await c.destroy("probe done");
          return out;
        }
      }

      export default {
        async fetch(request: Request, env: Env): Promise<Response> {
          if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("unauthorized", { status: 401 });
          return new Response(await env.PROBE.getByName("probe").run());
        },
      } satisfies ExportedHandler<Env>;
      ```
- [ ] Step 3: `npx wrangler deploy`, then `(umask 077 && openssl rand -hex 24 > token) && npx wrangler secret put PROBE_TOKEN < token`, note the printed workers.dev URL as `<PROBE_URL>`, and wait 60 s.
- [ ] Step 4: Verify - Manual: `curl -s -H "authorization: Bearer $(cat token)" <PROBE_URL>` (repeat after 30 s while it answers "no container instance available"), then `npx wrangler r2 object get meeting-recordings/probe/intercept-test.bin --remote --file /Users/jametirakarn/everymeet-intercept-probe/got.bin && wc -c < /Users/jametirakarn/everymeet-intercept-probe/got.bin` - Expected: the curl body is `200 {"stored":12582912,"path":"/segments/0"}` and `wc -c` prints `12582912`.
      If the output starts with `ERR` (for example `ENOTFOUND`) or any status other than 200, STOP: report the output to the user before Track C; the transport in Decision 2 has to be re-decided (see Failure handling).
- [ ] Step 5: Run the Rollback line.
  No commit.

---

### Track A - foundation (merges first)

#### Task 1: Move R2 key builders into a pure `src/storage/keys.ts`

**Files:**
- Create: `src/storage/keys.ts`
- Modify: `src/storage/r2.ts` (anchor: `export const keys = {`, ~L22-31)
- Modify (import line only): `src/storage/manifest.ts` (anchor: `import { getText, keys, putText } from "./r2.js";`, ~L4), `src/recorder/segment-uploader.ts` (anchor: `import { keys, putFile } from "../storage/r2.js";`, ~L4), `src/pipeline/assemble.ts` (anchor: `import { downloadTo, keys } from "../storage/r2.js";`, ~L6), `src/pipeline/run.ts` (anchor: `import { keys, putFile, putText } from "../storage/r2.js";`, ~L5), `src/web/server.ts` (anchor: `import { keys, presign } from "../storage/r2.js";`, ~L7)
- Modify (tests): `src/test/setup.ts` (anchor: `keys: realR2.keys,`, ~L39), `src/pipeline/run.test.ts` (anchor: `const { keys } = await import("../storage/r2.js");`, ~L16), `src/bot.test.ts` (anchor: `const { keys } = await import("./storage/r2.js");`, ~L60), `src/web/server.test.ts` (anchor: `const { keys } = await import("../storage/r2.js");`, ~L9)

This task touches 11 files because every importer of `keys` must move in the same commit or the build breaks; each edit except `keys.ts` is a one-line import change.

**Interfaces:**
- Consumes: nothing.
- Produces (frozen, consumed by Track C `meet/worker/core.ts`):
  ```ts
  // src/storage/keys.ts
  export const keys: {
    manifest(id: string): string;                              // meetings/<id>/manifest.json
    segment(id: string, userId: string, index: number): string; // meetings/<id>/segments/<userId>/NNNN.flac
    track(id: string, userId: string): string;
    mixed(id: string): string;
    transcript(id: string): string;
    summaryFull(id: string): string;
    summaryShort(id: string): string;
    debug(id: string, name: string): string;                    // meetings/<id>/debug/<name>
  };
  ```

**Gotcha:** `src/storage/keys.ts` must not import anything; the Worker bundles it and the Worker has no `node:` modules or AWS SDK.

**Steps:**
- [ ] Step 1: Create `src/storage/keys.ts`:
      ```ts
      /**
       * R2 object keys. Kept free of imports so the meet-recorder Worker (meet/worker) can bundle it too.
       */
      export const keys = {
        manifest: (id: string) => `meetings/${id}/manifest.json`,
        segment: (id: string, userId: string, index: number) =>
          `meetings/${id}/segments/${userId}/${String(index).padStart(4, "0")}.flac`,
        track: (id: string, userId: string) => `meetings/${id}/tracks/${userId}.ogg`,
        mixed: (id: string) => `meetings/${id}/meeting.mp3`,
        transcript: (id: string) => `meetings/${id}/transcript.txt`,
        summaryFull: (id: string) => `meetings/${id}/summary-full.md`,
        summaryShort: (id: string) => `meetings/${id}/summary-short.md`,
        /** Screenshot the Google Meet recorder saves when it cannot join. */
        debug: (id: string, name: string) => `meetings/${id}/debug/${name}`,
      };
      ```
- [ ] Step 2: In `src/storage/r2.ts` delete the whole `export const keys = { ... };` block (L22-31); nothing else in `r2.ts` uses it.
- [ ] Step 3: Change the five production imports:
      - `manifest.ts`: `import { getText, putText } from "./r2.js";` and `import { keys } from "./keys.js";`
      - `segment-uploader.ts`: `import { putFile } from "../storage/r2.js";` and `import { keys } from "../storage/keys.js";`
      - `assemble.ts`: `import { downloadTo } from "../storage/r2.js";` and `import { keys } from "../storage/keys.js";`
      - `run.ts`: `import { putFile, putText } from "../storage/r2.js";` and `import { keys } from "../storage/keys.js";`
      - `server.ts`: `import { presign } from "../storage/r2.js";` and `import { keys } from "../storage/keys.js";`
- [ ] Step 4: Tests: in `src/test/setup.ts` remove the line `keys: realR2.keys,` from the `mockR2` named exports (keep `const realR2 = await import("../storage/r2.js");` only if still used; it is not, so delete that line too).
      In `run.test.ts`, `bot.test.ts`, `server.test.ts` change the dynamic import to `const { keys } = await import("../storage/keys.js");` (`./storage/keys.js` in `bot.test.ts`).
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 31`, `# pass 31`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/storage src/recorder/segment-uploader.ts src/pipeline/assemble.ts src/pipeline/run.ts src/web/server.ts src/test/setup.ts src/pipeline/run.test.ts src/bot.test.ts src/web/server.test.ts && git commit -m "split R2 key builders into storage/keys.ts"`

#### Task 2: Meet contract types and the `meet` field on the Manifest

**Files:**
- Create: `src/meet/protocol.ts`
- Modify: `src/storage/manifest.ts` (anchor: `export interface Manifest {`, ~L22-48)

Current declaration being extended (`src/storage/manifest.ts:22-48`, copied):
```ts
export interface Manifest {
  id: string;
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  /** Text channel where /record was used (fallback output + continue prompts). */
  commandChannelId: string;
  startedBy: { id: string; name: string };
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  /** Last time the recorder was alive; used as the end time after a crash. */
  heartbeatAt: number;
  status: MeetingStatus;
  recovered?: boolean;
  participants: Record<string, Participant>;
  pin?: { salt: string; hash: string };
  outputs?: { mixed?: string; tracks?: Record<string, string>; transcript?: string; summaryFull?: string; summaryShort?: string; postedMessageUrl?: string };
  error?: string;
}
```
Consumers of `Manifest` (all keep compiling because the new field is optional): `src/recorder/session.ts` (builds it in the constructor), `src/storage/manifest.ts`, `src/recorder/segment-uploader.ts`, `src/pipeline/{run,assemble,transcribe,summarize,publish}.ts`, `src/web/server.ts`; hand-built fixtures `src/pipeline/run.test.ts` (`recordedMeeting`, cast `as any`), `src/pipeline.test.ts` (`const m: any`), `src/web/server.test.ts` (`storeMeeting`, plain object stored as JSON).
Old manifests in R2 have no `meet` field and stay valid: absent means a Discord recording.

**Interfaces:**
- Consumes: nothing.
- Produces (frozen; consumed by Track B and Track C):
  ```ts
  // src/meet/protocol.ts
  export const MEET_PARTICIPANT_ID = "meet";
  export const CALLBACK_HOST = "meet-recorder.internal";
  export type RecordingState = "starting" | "joining" | "waiting" | "recording" | "ended";
  export type EndReason =
    | "stopped" | "alone" | "removed" | "meeting_ended" | "max_duration"
    | "not_admitted" | "denied" | "auth_expired" | "join_failed" | "container_lost" | "crashed";
  export interface RecordingJob {
    meetUrl: string; authState?: string; sampleRate: number; segmentSamples: number;
    admitTimeoutMs: number; aloneTimeoutMs: number; maxDurationMs: number;
  }
  export interface SegmentInfo { index: number; samples: number }
  export interface RecordingEnd { reason: EndReason; detail?: string; leftCleanly: boolean }
  export interface RecordingStatus {
    state: RecordingState; captureStartedAt?: number; consentPosted?: boolean;
    segments: SegmentInfo[]; end?: RecordingEnd;
  }
  export type RunnerEvent =
    | { type: "joining" }
    | { type: "waiting" }
    | { type: "recording"; captureStartedAt: number; consentPosted: boolean }
    | { type: "heartbeat"; participants?: number }
    | ({ type: "ended" } & RecordingEnd);
  export interface EventReply { stop: boolean }
  // src/storage/manifest.ts
  interface Manifest { /* ...existing... */ meet?: { url: string; code: string } }
  ```

**Steps:**
- [ ] Step 1: Create `src/meet/protocol.ts`:
      ```ts
      /**
       * Contract between the bot (VPS), the meet-recorder Worker (meet/worker) and the recorder
       * container (meet/bot). Types and constants only: all three bundle this file, so it imports nothing.
       */

      /** Participant id of the single mixed Google Meet track, also its R2 segment folder. */
      export const MEET_PARTICIPANT_ID = "meet";

      /** Host the container calls; interceptOutboundHttp routes it to the recording's Durable Object. */
      export const CALLBACK_HOST = "meet-recorder.internal";

      export type RecordingState = "starting" | "joining" | "waiting" | "recording" | "ended";

      export type EndReason =
        | "stopped" // /end in Discord
        | "alone" // only the bot left in the call
        | "removed" // a host removed the bot
        | "meeting_ended" // the call ended or its UI disappeared
        | "max_duration"
        | "not_admitted" // nobody let the bot in before the admit timeout
        | "denied" // the host or Meet refused the join
        | "auth_expired" // the bot account session is no longer signed in
        | "join_failed" // the Meet page did not show a join button
        | "container_lost" // the recorder stopped reporting
        | "crashed"; // the recorder hit an unexpected error

      /** What the bot sends to start a recording; the Worker passes it to the container's stdin unchanged. */
      export interface RecordingJob {
        meetUrl: string;
        /** Playwright storageState JSON of the signed-in bot account; never stored on Cloudflare. */
        authState?: string;
        sampleRate: number;
        segmentSamples: number;
        admitTimeoutMs: number;
        aloneTimeoutMs: number;
        maxDurationMs: number;
      }

      export interface SegmentInfo {
        index: number;
        samples: number;
      }

      export interface RecordingEnd {
        reason: EndReason;
        detail?: string;
        /** The bot clicked "Leave call" and saw that it left (true when it was never in the call). */
        leftCleanly: boolean;
      }

      export interface RecordingStatus {
        state: RecordingState;
        /** Epoch ms when audio capture started; the meeting timeline starts here. */
        captureStartedAt?: number;
        consentPosted?: boolean;
        /** Segments stored in R2, sorted by index. */
        segments: SegmentInfo[];
        end?: RecordingEnd;
      }

      /** Reports the container sends to its Durable Object. */
      export type RunnerEvent =
        | { type: "joining" }
        | { type: "waiting" }
        | { type: "recording"; captureStartedAt: number; consentPosted: boolean }
        | { type: "heartbeat"; participants?: number }
        | ({ type: "ended" } & RecordingEnd);

      export interface EventReply {
        /** True once /end was used in Discord; the container leaves the call. */
        stop: boolean;
      }
      ```
- [ ] Step 2: In `src/storage/manifest.ts`, document the two reused fields and add `meet` after `commandChannelId`:
      ```ts
        /** Discord voice channel id; for a Google Meet recording, the Meet code. */
        voiceChannelId: string;
        /** Discord voice channel name; for a Google Meet recording, "Google Meet <code>". */
        voiceChannelName: string;
        /** Text channel where /record was used (fallback output + continue prompts). */
        commandChannelId: string;
        /** Set when the audio came from a Google Meet call (one mixed track) instead of a Discord voice channel. */
        meet?: { url: string; code: string };
      ```
- [ ] Step 3: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 31`, `# fail 0`.
- [ ] Step 4: Commit - `git add src/meet/protocol.ts src/storage/manifest.ts && git commit -m "add Google Meet recorder contract and manifest field"`

#### Task 3: Meet settings in the config schema, `.env.example`, test env, and ignore files

**Files:**
- Modify: `src/config.ts` (anchor: `CLEANUP_LOCAL: z`, ~L43-48, and `const schema = z.object({`, ~L8)
- Modify: `.env.example` (append after the `# --- Behaviour ---` block)
- Modify: `src/test/setup.ts` (anchor: `Object.assign(process.env, {`, ~L12-23)
- Modify: `.gitignore`, `.dockerignore` (append lines)

`Config` is inferred from the schema (`export type Config = z.infer<typeof schema>`); every consumer reads fields through `config()`, nobody constructs a `Config` by hand, so adding optional/defaulted fields breaks no consumer.

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Track B):
  ```ts
  config().MEET_RECORDER_URL: string | undefined     // Worker origin, e.g. https://everymeet-meet-recorder.<subdomain>.workers.dev
  config().MEET_RECORDER_TOKEN: string | undefined   // >= 32 chars; set exactly when MEET_RECORDER_URL is set
  config().MEET_AUTH_STATE_FILE: string | undefined  // unset = guest mode
  config().MEET_MAX_DURATION_MIN: number             // default 240
  // test env (src/test/setup.ts): MEET_RECORDER_URL "https://meet-recorder.example.com",
  // MEET_RECORDER_TOKEN "m".repeat(40), MEET_AUTH_STATE_FILE `${dataDir}/meet-auth.json`
  // whose content is the exported constant:
  export const FAKE_MEET_AUTH = '{"cookies":[{"name":"SID","value":"fake-session-cookie"}],"origins":[]}';
  ```

**Gotcha:** `.env.example` leaves values empty (`MEET_RECORDER_URL=`), and `z.url()` / `.min(32)` reject `""`, so the new optional fields go through a `blank` preprocess that turns `""` into `undefined`.

**Steps:**
- [ ] Step 1: In `src/config.ts` add, above `const schema`:
      ```ts
      /** Empty values in .env mean "not set". */
      const blank = (v: unknown) => (v === "" ? undefined : v);
      ```
      and inside the schema after `CLEANUP_LOCAL`:
      ```ts
        /** Origin of the meet-recorder Worker (meet/). /record-meet is off when unset. */
        MEET_RECORDER_URL: z.preprocess(blank, z.url().optional()),
        /** Same value as the Worker secret RECORDER_TOKEN. */
        MEET_RECORDER_TOKEN: z.preprocess(blank, z.string().min(32).optional()),
        /** Playwright storageState of the bot's Google account (npm run meet:login in meet/). Unset = join as a guest. */
        MEET_AUTH_STATE_FILE: z.preprocess(blank, z.string().optional()),
        /** A Google Meet recording ends after this many minutes. */
        MEET_MAX_DURATION_MIN: z.coerce.number().positive().max(360).default(240), // the Worker refuses more than 6 h
      ```
      and close the object with a refine:
      ```ts
      }).refine((c) => !c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, {
        message: "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together",
        path: ["MEET_RECORDER_TOKEN"],
      });
      ```
- [ ] Step 2: Append to `.env.example`:
      ```
      # --- Google Meet recording (optional; /record-meet is off when unset) ---
      # Worker origin printed by the deploy in meet/, e.g. https://everymeet-meet-recorder.<subdomain>.workers.dev
      MEET_RECORDER_URL=
      # Same value as the Worker secret RECORDER_TOKEN: openssl rand -base64 48
      MEET_RECORDER_TOKEN=
      # Bot Google account session from `npm run meet:login` in meet/; on the VPS: /run/secrets/meet/meet-auth.json
      # (docker compose mounts ./secrets there). Leave empty to join as a guest, which Meet refuses more often.
      MEET_AUTH_STATE_FILE=
      MEET_MAX_DURATION_MIN=240
      ```
- [ ] Step 3: In `src/test/setup.ts` import `writeFileSync` is already imported; add after `export const dataDir = ...`:
      ```ts
      /** Stand-in for the bot account session file; tests check it never leaks into R2. */
      export const FAKE_MEET_AUTH = '{"cookies":[{"name":"SID","value":"fake-session-cookie"}],"origins":[]}';
      writeFileSync(join(dataDir, "meet-auth.json"), FAKE_MEET_AUTH);
      ```
      and add to the `Object.assign(process.env, {...})` literal:
      ```ts
        MEET_RECORDER_URL: "https://meet-recorder.example.com",
        MEET_RECORDER_TOKEN: "m".repeat(40),
        MEET_AUTH_STATE_FILE: join(dataDir, "meet-auth.json"),
      ```
- [ ] Step 4: Append `secrets/` to `.gitignore`.
      Append to `.dockerignore` (the VPS image needs none of these, and `meet/node_modules` would otherwise be sent as build context):
      ```
      meet
      spike
      rust
      docs
      secrets
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && MEET_RECORDER_URL=https://x.example.com node --import tsx --input-type=module -e 'process.env.DISCORD_TOKEN="x";process.env.DISCORD_CLIENT_ID="x";process.env.R2_ACCOUNT_ID="x";process.env.R2_ACCESS_KEY_ID="x";process.env.R2_SECRET_ACCESS_KEY="x";process.env.R2_BUCKET="x";process.env.OPENROUTER_API_KEY="x";process.env.PUBLIC_BASE_URL="https://a.example.com";process.env.SESSION_SECRET="s".repeat(40);const { config } = await import("./src/config.ts");try{config();console.log("ACCEPTED")}catch(e){console.log(String(e.message).split("\n")[1])}'` - Expected: typecheck exit 0; `# pass 31`, `# fail 0`; last line `  MEET_RECORDER_TOKEN: set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together`.
- [ ] Step 6: Commit - `git add src/config.ts .env.example src/test/setup.ts .gitignore .dockerignore && git commit -m "add Google Meet recorder settings"`


---

### Track B - VPS bot side (`src/`)

Expected test counts below assume Track B runs on top of merged Track A (31 tests) and adds tests only in its own tasks.

#### Task 4: Pure speech detection and Meet link parsing

**Files:**
- Create: `src/meet/vad.ts`
- Create: `src/meet/meet-url.ts`
- Test: `src/meet/meet.test.ts`

**Interfaces:**
- Consumes: `SAMPLE_RATE` from `src/config.ts`; `Utterance` from `src/storage/manifest.ts`.
- Produces:
  ```ts
  // src/meet/vad.ts
  export interface VadOptions { frame: number; thresholdDb: number; bridge: number; pad: number }
  export const DEFAULT_VAD: VadOptions;
  export function detectUtterances(pcm: Buffer, offset: number, o?: VadOptions): Utterance[];
  // src/meet/meet-url.ts
  export function parseMeetUrl(input: string): { url: string; code: string } | undefined;
  ```

The -50 dBFS threshold comes from the spike's 15-minute Cloudflare recording (`spike/meet-bot/runs/long2/mixed.flac`, 20 ms frames): silence sits at -95 to -75 dBFS, speech averages about -21 dBFS, and 82% of frames are above -50 dBFS in that talk-heavy call.
`buildTurns` (`src/pipeline/plan.ts`) still merges gaps up to 2 s and drops turns under 0.4 s, so the VAD only needs to be coarse.

**Steps:**
- [ ] Step 1: Create `src/meet/vad.ts`:
      ```ts
      import { SAMPLE_RATE } from "../config.js";
      import type { Utterance } from "../storage/manifest.js";

      /**
       * Energy-based speech detection for mixed Google Meet audio. Pure, so it is unit testable.
       * Positions are samples on the meeting timeline.
       */
      export interface VadOptions {
        /** Samples per analysis frame. */
        frame: number;
        /** Frames at least this loud (RMS, dBFS) count as speech. */
        thresholdDb: number;
        /** Speech runs closer than this are one utterance. */
        bridge: number;
        /** Kept around each utterance so first and last syllables are not clipped. */
        pad: number;
      }

      export const DEFAULT_VAD: VadOptions = {
        frame: SAMPLE_RATE / 50,
        thresholdDb: -50,
        bridge: Math.round(0.3 * SAMPLE_RATE),
        pad: Math.round(0.2 * SAMPLE_RATE),
      };

      /** Speech in a mono s16le buffer that starts at `offset` on the meeting timeline. */
      export function detectUtterances(pcm: Buffer, offset: number, o: VadOptions = DEFAULT_VAD): Utterance[] {
        const total = Math.floor(pcm.length / 2);
        const threshold = 32768 * 10 ** (o.thresholdDb / 20);
        const runs: Utterance[] = [];
        for (let f = 0; f + o.frame <= total; f += o.frame) {
          let sum = 0;
          for (let i = f; i < f + o.frame; i++) {
            const v = pcm.readInt16LE(i * 2);
            sum += v * v;
          }
          if (Math.sqrt(sum / o.frame) < threshold) continue;
          const last = runs.at(-1);
          if (last && f - last.end <= o.bridge) last.end = f + o.frame;
          else runs.push({ start: f, end: f + o.frame });
        }
        return runs.map((r) => ({
          start: offset + Math.max(0, r.start - o.pad),
          end: offset + Math.min(total, r.end + o.pad),
        }));
      }
      ```
- [ ] Step 2: Create `src/meet/meet-url.ts`:
      ```ts
      const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

      /**
       * Accepts a Google Meet link or a bare meeting code and returns the canonical link.
       * Anything else is refused, so the recorder only ever opens meet.google.com.
       */
      export function parseMeetUrl(input: string): { url: string; code: string } | undefined {
        const text = input.trim().toLowerCase();
        let code = text;
        if (!CODE_RE.test(text)) {
          let url: URL;
          try {
            url = new URL(text.includes("://") ? text : `https://${text}`);
          } catch {
            return undefined;
          }
          if (url.hostname !== "meet.google.com") return undefined;
          code = url.pathname.replace(/^\/+|\/+$/g, "");
        }
        return CODE_RE.test(code) ? { url: `https://meet.google.com/${code}`, code } : undefined;
      }
      ```
- [ ] Step 3: Create `src/meet/meet.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { SAMPLE_RATE } from "../config.js";
      import { detectUtterances } from "./vad.js";
      import { parseMeetUrl } from "./meet-url.js";

      const sec = (s: number) => Math.round(s * SAMPLE_RATE);

      /** Mono s16le made of [seconds, amplitude] pieces of a 440 Hz sine; amplitude 0 is digital silence. */
      function audio(pieces: [number, number][]): Buffer {
        const b = Buffer.alloc(pieces.reduce((n, [s]) => n + sec(s), 0) * 2);
        let i = 0;
        for (const [s, amp] of pieces) {
          for (let k = 0; k < sec(s); k++, i++) {
            b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * k) / SAMPLE_RATE)), i * 2);
          }
        }
        return b;
      }

      test("speech detection keeps a short pause inside one utterance and ignores very quiet noise", () => {
        // speech 1-3 s, 0.2 s pause, speech 3.2-4.2 s, silence, -61 dBFS hum at 7.2-7.7 s
        const pcm = audio([[1, 0], [2, 8000], [0.2, 0], [1, 8000], [3, 0], [0.5, 40], [0.3, 0]]);
        assert.deepEqual(detectUtterances(pcm, 0), [{ start: sec(0.8), end: sec(4.4) }]);
      });

      test("a long pause starts a new utterance, and positions are shifted to the segment's place on the timeline", () => {
        const pcm = audio([[0.5, 0], [1, 8000], [2, 0], [1, 8000]]);
        const offset = 5 * 60 * SAMPLE_RATE;
        assert.deepEqual(detectUtterances(pcm, offset), [
          { start: offset + sec(0.3), end: offset + sec(1.7) },
          { start: offset + sec(3.3), end: offset + sec(4.5) }, // padding stops at the end of the segment
        ]);
      });

      test("Meet links and codes are normalized, and anything else is refused", () => {
        const ok = { url: "https://meet.google.com/jku-cpry-bcg", code: "jku-cpry-bcg" };
        for (const input of [
          "https://meet.google.com/jku-cpry-bcg",
          " meet.google.com/jku-cpry-bcg?authuser=1 ",
          "http://meet.google.com/JKU-CPRY-BCG/",
          "jku-cpry-bcg",
        ]) {
          assert.deepEqual(parseMeetUrl(input), ok, input);
        }
        for (const input of [
          "https://evil.example.com/jku-cpry-bcg",
          "https://meet.google.com.evil.example.com/jku-cpry-bcg",
          "https://meet.google.com/lookup/abcdefghij",
          "https://meet.google.com/",
          "jku-cpry",
        ]) {
          assert.equal(parseMeetUrl(input), undefined, input);
        }
      });
      ```
- [ ] Step 4: Verify - Run: `npm run typecheck && node --import tsx --test src/meet/meet.test.ts 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 3`, `# fail 0`.
- [ ] Step 5: Commit - `git add src/meet/vad.ts src/meet/meet-url.ts src/meet/meet.test.ts && git commit -m "add speech detection and Meet link parsing"`

#### Task 5: Honest labelling of a mixed Meet track in transcript and summary prompt

**Files:**
- Modify: `src/pipeline/transcribe.ts` (anchors: `const lines = mergeLines((await Promise.all(jobs)).flat());` in `transcribeMeeting`, ~L71; `const body = lines.map(` in `formatTranscript`, ~L92)
- Modify: `src/pipeline/summarize.ts` (anchor: `function meetingContext(m: Manifest): string {`, ~L15-20)
- Test: `src/pipeline.test.ts` (append one test)

**Interfaces:**
- Consumes: `Manifest.meet` (Task 2).
- Produces: for `m.meet` manifests, transcript body lines are `[HH:MM:SS] <text>` (no speaker), consecutive lines are never joined, and the summary prompts say the speakers are unknown.

**Steps:**
- [ ] Step 1: In `transcribeMeeting` replace the `mergeLines` line with:
      ```ts
        // One mixed Meet track holds several voices, so its lines are never joined into one speaker's paragraph.
        const lines = mergeLines((await Promise.all(jobs)).flat(), m.meet ? 0 : undefined);
      ```
      In `formatTranscript` replace the `body` line with:
      ```ts
        const body = lines.map((l) =>
          m.meet
            ? `[${hms(l.start / SAMPLE_RATE)}] ${l.text}`
            : `[${hms(l.start / SAMPLE_RATE)}] ${speakerName(m, l.userId)}: ${l.text}`,
        );
      ```
- [ ] Step 2: In `src/pipeline/summarize.ts` start `meetingContext` with a Meet branch (the rest of the function stays):
      ```ts
      function meetingContext(m: Manifest): string {
        if (m.meet) {
          return `ข้อมูลการประชุม: Google Meet (${m.meet.code}) บันทึกโดยบอทของเซิร์ฟเวอร์ Discord "${m.guildName}" เริ่ม ${bangkokDateTime(m.startedAt)}
      เสียงทั้งหมดถูกบันทึกเป็นแทร็กเดียว transcript จึงไม่ได้ระบุว่าใครพูด ห้ามเดาชื่อผู้พูด ให้ระบุชื่อเฉพาะเมื่อมีการเอ่ยชื่อในบทสนทนา`;
        }
      ```
- [ ] Step 3: Append to `src/pipeline.test.ts`:
      ```ts
      test("a Google Meet transcript names no speakers in its lines", () => {
        const m: any = {
          startedAt: 0,
          endedAt: 60_000,
          heartbeatAt: 0,
          guildName: "Planthia",
          voiceChannelName: "Google Meet jku-cpry-bcg",
          meet: { url: "https://meet.google.com/jku-cpry-bcg", code: "jku-cpry-bcg" },
          participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [], uploaded: [] } },
        };
        const t = formatTranscript(m, [
          { userId: "meet", start: sec(1), text: "สวัสดีครับ" },
          { userId: "meet", start: sec(3), text: "สวัสดีค่ะ" },
        ]);
        assert.match(t, /ผู้พูด: เสียงรวมจาก Google Meet/);
        assert.match(t, /\n\[00:00:01\] สวัสดีครับ\n\[00:00:03\] สวัสดีค่ะ\n/);
      });
      ```
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 35`, `# pass 35`, `# fail 0`.
- [ ] Step 5: Commit - `git add src/pipeline/transcribe.ts src/pipeline/summarize.ts src/pipeline.test.ts && git commit -m "label Google Meet transcripts as one mixed track"`

#### Task 6: Pipeline step for Meet recordings: speech detection from R2 segments, no per-speaker track

**Files:**
- Create: `src/meet/speech.ts`
- Modify: `src/pipeline/assemble.ts` (anchor: `async function ensureSegment(`, ~L16; export it)
- Modify: `src/pipeline/run.ts` (anchors: `// 1. Audio: per-speaker tracks + one mixed file, all to R2.` and `const tracks = await encodeTracks(raw);`, ~L28-30; `if (m.recovered) notes.push(`, ~L67)
- Test: `src/pipeline/run.test.ts` (append one test, extend the `node:fs` import with `readFileSync`)

**Interfaces:**
- Consumes: `detectUtterances` (Task 4), `MEET_PARTICIPANT_ID` (Task 2), `keys` (Task 1).
- Produces:
  ```ts
  // src/pipeline/assemble.ts
  export async function ensureSegment(m: Manifest, userId: string, index: number): Promise<string | undefined>;
  // src/meet/speech.ts
  export async function markMeetSpeech(m: Manifest): Promise<void>; // fills m.participants.meet.utterances from its segments
  ```

**Steps:**
- [ ] Step 1: In `src/pipeline/assemble.ts` change `async function ensureSegment(` to `export async function ensureSegment(`.
- [ ] Step 2: Create `src/meet/speech.ts`:
      ```ts
      import { readFileSync } from "node:fs";
      import { SEGMENT_SAMPLES } from "../config.js";
      import { ensureSegment } from "../pipeline/assemble.js";
      import type { Manifest } from "../storage/manifest.js";
      import { MEET_PARTICIPANT_ID } from "./protocol.js";
      import { detectUtterances } from "./vad.js";

      /**
       * A Google Meet recording arrives as continuous mixed audio without speech marks.
       * Finds the speech in every segment so transcription skips silence like it does for Discord.
       */
      export async function markMeetSpeech(m: Manifest): Promise<void> {
        const p = m.participants[MEET_PARTICIPANT_ID];
        if (!p) return;
        p.utterances = [];
        for (const index of [...p.segments].sort((a, b) => a - b)) {
          const raw = await ensureSegment(m, MEET_PARTICIPANT_ID, index);
          if (raw) p.utterances.push(...detectUtterances(readFileSync(raw), index * SEGMENT_SAMPLES));
        }
      }
      ```
- [ ] Step 3: In `src/pipeline/run.ts` add `import { markMeetSpeech } from "../meet/speech.js";` and change the start of step 1 to:
      ```ts
          // 0. A Google Meet recording is one mixed track without speech marks; find where people spoke.
          if (m.meet) await markMeetSpeech(m);

          // 1. Audio: per-speaker tracks + one mixed file, all to R2.
          const raw = await buildRawTracks(m);
          // A Meet recording has a single mixed track, which meeting.mp3 already is.
          const tracks = m.meet ? {} : await encodeTracks(raw);
      ```
      and the recovered note to:
      ```ts
          if (m.recovered) {
            notes.push(
              m.meet
                ? "บอท Google Meet หยุดทำงานระหว่างประชุม เสียงช่วงท้ายอาจขาดหายไปบางส่วน"
                : "บอทรีสตาร์ทระหว่างประชุม เสียงช่วงท้ายอาจขาดหายไปบางส่วน",
            );
          }
      ```
- [ ] Step 4: Append to `src/pipeline/run.test.ts` (change the fs import to `import { existsSync, readFileSync, writeFileSync } from "node:fs";`):
      ```ts
      test("a Google Meet recording stored only in R2 gets speech detection, unnamed unjoined lines and no per-speaker track", async () => {
        const id = newSessionId();
        const startedAt = Date.UTC(2026, 9, 12, 3, 0, 0);
        // 20 s of mixed Meet audio with speech at 1-4 s and 10-12 s; the segment exists only in R2 as FLAC.
        const pcm = Buffer.alloc(sec(20) * 2);
        tone(3, 440).copy(pcm, sec(1) * 2);
        tone(2, 660).copy(pcm, sec(10) * 2);
        const raw = join(dataDir, `${id}.raw`);
        const flac = join(dataDir, `${id}.flac`);
        writeFileSync(raw, pcm);
        execFileSync("ffmpeg", ["-v", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", raw, "-c:a", "flac", flac]);
        r2.set(keys.segment(id, "meet", 0), readFileSync(flac));
        const m = {
          id,
          guildId: "g1",
          guildName: "Planthia",
          voiceChannelId: "jku-cpry-bcg",
          voiceChannelName: "Google Meet jku-cpry-bcg",
          commandChannelId: "cmd",
          meet: { url: "https://meet.google.com/jku-cpry-bcg", code: "jku-cpry-bcg" },
          startedBy: { id: "alice", name: "Alice" },
          startedAt,
          endedAt: startedAt + 20_000,
          heartbeatAt: startedAt + 20_000,
          endReason: "everyone left the Google Meet call for 3 minutes",
          status: "processing" as const,
          participants: { meet: { displayName: "เสียงรวมจาก Google Meet", utterances: [], segments: [0], uploaded: [0] } },
        };
        const calls = mockOpenRouter((call) => {
          if (call.path === "/audio/transcriptions") {
            return Response.json({
              text: "",
              segments: [
                { start: 0.3, end: 3, text: "สวัสดีครับ เริ่มประชุม" },
                { start: 4.3, end: 6, text: "Bob ช่วย deploy วันศุกร์" },
              ],
            });
          }
          return chatReply(call.body.max_tokens <= 2_000 ? SHORT : FULL);
        });
        const { client, posts } = discord(["meeting-of-minutes"]);
        await processMeeting(client, m as any);

        // Speech 0.8-4.2 s and 9.8-12.2 s (0.2 s padding) packed into one request: 3.4 s + 0.6 s gap + 2.4 s.
        const stt = calls.filter((c) => c.path === "/audio/transcriptions");
        assert.equal(stt.length, 1);
        assert.ok(Math.abs(wavSeconds(stt[0]!) - 6.4) < 0.01, `${wavSeconds(stt[0]!)} s`);
        const body = r2Text(keys.transcript(id))!.split("-".repeat(60))[1]!.trim().split("\n");
        assert.deepEqual(body, ["[00:00:01] สวัสดีครับ เริ่มประชุม", "[00:00:10] Bob ช่วย deploy วันศุกร์"]);
        const fullPrompt = calls.find((c) => c.path === "/chat/completions")!.body.messages.map((x: any) => x.content).join("\n");
        assert.match(fullPrompt, /ไม่ได้ระบุว่าใครพูด/);

        assert.ok(r2.has(keys.mixed(id)));
        assert.ok(!r2.has(keys.track(id, "meet")), "no per-speaker file for a single mixed track");
        const saved = manifestIn(id);
        assert.equal(saved.status, "done");
        assert.deepEqual(saved.outputs.tracks, {});
        assert.deepEqual(saved.participants.meet.utterances, [
          { start: sec(0.8), end: sec(4.2) },
          { start: sec(9.8), end: sec(12.2) },
        ]);
        const post = readPost(posts[0]!.payload);
        assert.match(post.embed.title, /สรุปการประชุม - Google Meet jku-cpry-bcg/);
        assert.equal(post.embed.fields.find((f: any) => f.name === "ผู้พูด").value, "เสียงรวมจาก Google Meet");
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 36`, `# pass 36`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/meet/speech.ts src/pipeline/assemble.ts src/pipeline/run.ts src/pipeline/run.test.ts && git commit -m "process Google Meet recordings as one mixed track"`


#### Task 7: One registry for active recordings of any source

**Files:**
- Create: `src/recorder/active.ts`
- Modify: `src/recorder/session.ts` (anchors: `export const activeSessions = new Map<string, MeetingSession>();`, ~L35-36; `export class MeetingSession {`, ~L40)
- Modify: `src/interactions.ts` (anchors: `import { activeSessions, CONTINUE_BUTTON_PREFIX, MeetingSession } from "./recorder/session.js";`, ~L10; `const session = [...activeSessions.values()].find((s) => s.id === id);`, ~L89; `export function handleVoiceStateUpdate`, ~L105)
- Modify: `src/index.ts` (anchors: `import { activeSessions } from "./recorder/session.js";`, ~L3; `s.end("the bot is shutting down")`, ~L26)
- Modify (test import): `src/bot.test.ts` (anchor: `const { activeSessions } = await import("./recorder/session.js");`, ~L59)

**Interfaces:**
- Consumes: `Manifest`.
- Produces (consumed by Tasks 8-9):
  ```ts
  // src/recorder/active.ts
  export interface ActiveRecording {
    readonly manifest: Manifest;
    readonly id: string;
    end(reason: string): Promise<void>;
    shutdown(): Promise<void>;
  }
  export const activeSessions: Map<string, ActiveRecording>; // key: guild id
  // src/recorder/session.ts
  class MeetingSession implements ActiveRecording { shutdown(): Promise<void> } // = end("the bot is shutting down")
  ```

**Steps:**
- [ ] Step 1: Create `src/recorder/active.ts`:
      ```ts
      import type { Manifest } from "../storage/manifest.js";

      /** A recording in progress, from a Discord voice channel or a Google Meet call. */
      export interface ActiveRecording {
        readonly manifest: Manifest;
        readonly id: string;
        /**
         * Stop recording. A Discord recording is handed to processing before this resolves;
         * a Google Meet recording is handed over once its recorder reports the end.
         */
        end(reason: string): Promise<void>;
        /** The bot process is about to exit. */
        shutdown(): Promise<void>;
      }

      /** One active recording per guild, whatever its source (storage keys and the bot's voice slot assume it). */
      export const activeSessions = new Map<string, ActiveRecording>();
      ```
- [ ] Step 2: In `src/recorder/session.ts` delete the `activeSessions` declaration and its comment, add `import { activeSessions, type ActiveRecording } from "./active.js";`, change the class line to `export class MeetingSession implements ActiveRecording {`, and add next to `end()`:
      ```ts
        /** A Discord recording cannot outlive the process, so it ends now; recoverUnfinished() covers a hard kill. */
        shutdown(): Promise<void> {
          return this.end("the bot is shutting down");
        }
      ```
- [ ] Step 3: In `src/interactions.ts` import `activeSessions` from `"./recorder/active.js"` and `CONTINUE_BUTTON_PREFIX, MeetingSession` from `"./recorder/session.js"`.
      In the continue-button branch:
      ```ts
            const session = [...activeSessions.values()].find((s) => s.id === id);
            if (!(session instanceof MeetingSession)) {
              await interaction.update({ content: "This recording has already ended.", components: [] });
              return;
            }
      ```
      In `handleVoiceStateUpdate`:
      ```ts
        const session = activeSessions.get(newState.guild.id);
        if (!(session instanceof MeetingSession)) return;
      ```
- [ ] Step 4: In `src/index.ts` import `activeSessions` from `"./recorder/active.js"` and change the shutdown line:
      ```ts
        log.info(`${signal} received, stopping active recordings`);
        // Discord recordings end now; Google Meet recordings keep running on Cloudflare and are re-attached on boot.
        await Promise.allSettled([...activeSessions.values()].map((s) => s.shutdown()));
      ```
- [ ] Step 5: In `src/bot.test.ts` change the import to `const { activeSessions } = await import("./recorder/active.js");`.
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 36`, `# pass 36`, `# fail 0`.
- [ ] Step 7: Commit - `git add src/recorder/active.ts src/recorder/session.ts src/interactions.ts src/index.ts src/bot.test.ts && git commit -m "share the active recording registry across sources"`

#### Task 8: Recorder client and `MeetSession`

**Files:**
- Create: `src/meet/recorder-client.ts`
- Create: `src/meet/session.ts`
- Modify: `src/test/setup.ts` (append `fakeMeetRecorder()`; anchor: `export const chatReply =`, ~L71)
- Test: `src/meet/session.test.ts`

**Interfaces:**
- Consumes: Task 2 protocol types, Task 3 config fields and `FAKE_MEET_AUTH`, Task 7 `activeSessions` / `ActiveRecording`, `saveLocal`, `saveEverywhere`, `meetingDir` (`src/storage/manifest.ts`), `newSessionId` (`src/util/pin.ts`).
- Produces (consumed by Task 9):
  ```ts
  // src/meet/recorder-client.ts
  export const meetRecorderConfigured: () => boolean;
  export const recorder: {
    start(id: string, job: RecordingJob): Promise<void>;          // throws on non-2xx
    status(id: string): Promise<RecordingStatus | undefined>;    // undefined on 404
    stop(id: string): Promise<void>;                              // 404 is ignored
  };
  // src/meet/session.ts
  export const ADMIT_TIMEOUT_MS: number;      // 5 min
  export const GIVE_UP_GRACE_MS: number;      // 60 min past the recorder's hard deadline
  export const MEET_SPEAKER_NAME = "เสียงรวมจาก Google Meet";
  export class MeetSession implements ActiveRecording {
    static start(o: {
      client: Client; guildId: string; guildName: string; commandChannelId: string;
      startedBy: { id: string; name: string }; meet: { url: string; code: string };
      onFinished: (m: Manifest) => void;
    }): Promise<MeetSession>;
    static resume(client: Client, manifest: Manifest, onFinished: (m: Manifest) => void): MeetSession;
    readonly manifest: Manifest; get id(): string;
    end(reason: string): Promise<void>; shutdown(): Promise<void>;
  }
  // src/test/setup.ts
  export interface FakeRecording { job: RecordingJob; status: RecordingStatus; stopped: boolean }
  export function fakeMeetRecorder(): { recordings: Map<string, FakeRecording>; authorizations: string[]; requests: string[]; down: boolean; failStart: boolean };
  ```

**Gotcha:** `end()` must not wait for the recording to finish: `handleEnd` in `src/interactions.ts` awaits it, and in production the end arrives up to a minute later (the container leaves the call and uploads the last segment first).

**Steps:**
- [ ] Step 1: Create `src/meet/recorder-client.ts`:
      ```ts
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
      ```
- [ ] Step 2: Create `src/meet/session.ts`:
      ```ts
      import { readFileSync, rmSync } from "node:fs";
      import type { Client } from "discord.js";
      import { config, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
      import { activeSessions, type ActiveRecording } from "../recorder/active.js";
      import { meetingDir, saveEverywhere, saveLocal, type Manifest } from "../storage/manifest.js";
      import { logger } from "../util/log.js";
      import { newSessionId } from "../util/pin.js";
      import { MEET_PARTICIPANT_ID, type EndReason, type RecordingEnd, type RecordingStatus } from "./protocol.js";
      import { recorder } from "./recorder-client.js";

      const log = logger("meet");
      const TICK_MS = 15_000;
      /** How long the bot waits in the Meet lobby for someone to let it in. */
      export const ADMIT_TIMEOUT_MS = 5 * 60_000;
      /**
       * While the recorder is unreachable the bot keeps polling; it gives up only this long after the recorder's
       * own hard deadline (admit timeout + max duration + 10 min), when the recorder must have ended.
       */
      export const GIVE_UP_GRACE_MS = 60 * 60_000;
      export const MEET_SPEAKER_NAME = "เสียงรวมจาก Google Meet";

      type OnFinished = (manifest: Manifest) => void;

      /**
       * A Google Meet recording. The meet-recorder Worker's container (meet/) does the recording;
       * this side owns the manifest, polls the recorder, talks to Discord, and hands the result to processing.
       */
      export class MeetSession implements ActiveRecording {
        private tick?: NodeJS.Timeout;
        private polling = false;
        private readonly giveUpAt: number;
        private stopReason?: string;
        private finishing?: Promise<void>;

        private constructor(
          private readonly client: Client,
          readonly manifest: Manifest,
          private readonly onFinished: OnFinished,
        ) {
          this.giveUpAt = manifest.startedAt + ADMIT_TIMEOUT_MS + config().MEET_MAX_DURATION_MIN * 60_000 + GIVE_UP_GRACE_MS;
        }

        static async start(o: {
          client: Client;
          guildId: string;
          guildName: string;
          commandChannelId: string;
          startedBy: { id: string; name: string };
          meet: { url: string; code: string };
          onFinished: OnFinished;
        }): Promise<MeetSession> {
          const c = config();
          const now = Date.now();
          const manifest: Manifest = {
            id: newSessionId(),
            guildId: o.guildId,
            guildName: o.guildName,
            voiceChannelId: o.meet.code,
            voiceChannelName: `Google Meet ${o.meet.code}`,
            commandChannelId: o.commandChannelId,
            meet: o.meet,
            startedBy: o.startedBy,
            startedAt: now,
            heartbeatAt: now,
            status: "recording",
            participants: {},
          };
          const s = new MeetSession(o.client, manifest, o.onFinished);
          activeSessions.set(o.guildId, s);
          try {
            // Saved before the recorder starts, so recoverUnfinished() re-attaches if this process dies right after.
            saveLocal(manifest);
            await recorder.start(manifest.id, {
              meetUrl: o.meet.url,
              authState: c.MEET_AUTH_STATE_FILE ? readAuthState(c.MEET_AUTH_STATE_FILE) : undefined,
              sampleRate: SAMPLE_RATE,
              segmentSamples: SEGMENT_SAMPLES,
              admitTimeoutMs: ADMIT_TIMEOUT_MS,
              aloneTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
              maxDurationMs: c.MEET_MAX_DURATION_MIN * 60_000,
            });
          } catch (err) {
            // The request may have reached the Worker even though it failed here (a timeout): make sure no bot joins.
            recorder.stop(manifest.id).catch(() => {});
            activeSessions.delete(o.guildId);
            rmSync(meetingDir(manifest.id), { recursive: true, force: true });
            throw err;
          }
          await s.save();
          s.tick = setInterval(() => void s.poll(), TICK_MS);
          log.info(`recording Google Meet ${o.meet.code} as ${manifest.id} (${o.guildName})`);
          return s;
        }

        /** Re-attach to a recording that kept running on Cloudflare while this process restarted. */
        static resume(client: Client, manifest: Manifest, onFinished: OnFinished): MeetSession {
          const s = new MeetSession(client, manifest, onFinished);
          activeSessions.set(manifest.guildId, s);
          s.tick = setInterval(() => void s.poll(), TICK_MS);
          void s.poll();
          log.info(`re-attached to Google Meet recording ${manifest.id}`);
          return s;
        }

        get id(): string {
          return this.manifest.id;
        }

        private get code(): string {
          return this.manifest.meet!.code;
        }

        /** Asks the recorder to leave the call; processing starts when it reports the end. */
        async end(reason: string): Promise<void> {
          if (this.finishing) return;
          this.stopReason ??= reason;
          try {
            await recorder.stop(this.id);
          } catch (err) {
            log.warn(`could not ask the Google Meet recorder to stop ${this.id}`, err);
            await this.say(
              `I could not reach the Google Meet recorder to stop **${this.code}**. ` +
                "It stops by itself when the call is empty or reaches the time limit, and the minutes follow then.",
            );
          }
        }

        /** The recording goes on in the cloud; boot re-attaches to it. */
        async shutdown(): Promise<void> {
          clearInterval(this.tick);
        }

        private async poll(): Promise<void> {
          if (this.polling || this.finishing) return;
          this.polling = true;
          try {
            let status: RecordingStatus | undefined;
            try {
              status = await recorder.status(this.id);
            } catch (err) {
              log.warn(`could not reach the Google Meet recorder for ${this.id}`, err);
              // An outage is like a restart: the recording goes on in the cloud, so keep following it.
              if (Date.now() >= this.giveUpAt) await this.finish(undefined);
              return;
            }
            if (status?.state === "recording" && !this.manifest.participants[MEET_PARTICIPANT_ID]) {
              await this.recordingStarted(status);
            }
            if (!status || status.state === "ended") {
              await this.finish(status);
              return;
            }
            this.manifest.heartbeatAt = Date.now();
            try {
              saveLocal(this.manifest);
            } catch (err) {
              log.error("could not save manifest", err);
            }
          } finally {
            this.polling = false;
          }
        }

        private async recordingStarted(status: RecordingStatus): Promise<void> {
          this.manifest.startedAt = status.captureStartedAt!;
          this.manifest.participants[MEET_PARTICIPANT_ID] = {
            displayName: MEET_SPEAKER_NAME,
            utterances: [],
            segments: [],
            uploaded: [],
          };
          await this.save();
          await this.say(
            `🔴 I am recording the Google Meet call ${this.code}` +
              (status.consentPosted ? "" : ". I could not post the recording notice in the Meet chat, so please tell the participants."),
          );
        }

        private finish(status: RecordingStatus | undefined): Promise<void> {
          this.finishing ??= this.doFinish(status);
          return this.finishing;
        }

        private async doFinish(status: RecordingStatus | undefined): Promise<void> {
          clearInterval(this.tick);
          activeSessions.delete(this.manifest.guildId);
          const m = this.manifest;
          const end = status?.end;
          const segments = status?.segments ?? [];
          m.endReason = this.stopReason ?? describeEnd(end?.reason);

          if (!status || status.captureStartedAt === undefined || segments.length === 0) {
            m.status = "failed";
            m.endedAt = Date.now();
            m.error = `nothing was recorded (${end ? `${end.reason}${end.detail ? `: ${end.detail}` : ""}` : "the recorder lost this recording"})`;
            await this.save();
            await this.say(notRecordedMessage(this.code, end));
            log.warn(`Google Meet recording ${m.id} ended without audio: ${m.error}`);
            return;
          }

          const lastSample = Math.max(...segments.map((s) => s.index * SEGMENT_SAMPLES + s.samples));
          m.startedAt = status.captureStartedAt;
          m.endedAt = m.startedAt + Math.round((lastSample * 1000) / SAMPLE_RATE);
          m.heartbeatAt = m.endedAt;
          if (end?.reason === "container_lost" || end?.reason === "crashed") m.recovered = true;
          const p = (m.participants[MEET_PARTICIPANT_ID] ??= {
            displayName: MEET_SPEAKER_NAME,
            utterances: [],
            segments: [],
            uploaded: [],
          });
          p.segments = segments.map((s) => s.index).sort((a, b) => a - b);
          p.uploaded = [...p.segments]; // the Worker lists only segments it stored in R2
          m.status = "processing";
          await this.save();
          log.info(`Google Meet recording ${m.id} ended: ${m.endReason}`);
          this.onFinished(m);
        }

        private async save(): Promise<void> {
          try {
            await saveEverywhere(this.manifest);
          } catch (err) {
            log.error(`could not upload manifest ${this.id}, keeping the local copy`, err);
            saveLocal(this.manifest);
          }
        }

        private async say(text: string): Promise<void> {
          try {
            const channel = await this.client.channels.fetch(this.manifest.commandChannelId);
            if (channel?.isSendable()) await channel.send(text);
          } catch (err) {
            log.warn(`could not post in the command channel for ${this.id}`, err);
          }
        }
      }

      /**
       * Reads the bot account session and checks it is JSON before a container is paid for.
       * The error never quotes the file: JSON.parse messages can contain a piece of the session.
       */
      function readAuthState(path: string): string {
        let text: string;
        try {
          text = readFileSync(path, "utf8");
          JSON.parse(text);
        } catch {
          throw new Error("the bot account session file (MEET_AUTH_STATE_FILE) is missing or not valid JSON");
        }
        return text;
      }

      function describeEnd(reason: EndReason | undefined): string {
        switch (reason) {
          case "stopped":
            return "ended with /end";
          case "alone":
            return `everyone left the Google Meet call for ${config().EMPTY_CHANNEL_TIMEOUT_MIN} minutes`;
          case "removed":
            return "the bot was removed from the Google Meet call";
          case "meeting_ended":
            return "the Google Meet call ended";
          case "max_duration":
            return `the recording reached the ${config().MEET_MAX_DURATION_MIN}-minute limit`;
          case "not_admitted":
            return "nobody let the bot into the Google Meet call";
          case "denied":
            return "the bot was not allowed to join the Google Meet call";
          case "auth_expired":
            return "the bot's Google account session expired";
          case "join_failed":
            return "the Google Meet page offered no way to join";
          default:
            return "the Google Meet recorder stopped unexpectedly";
        }
      }

      function notRecordedMessage(code: string, end: RecordingEnd | undefined): string {
        if (end?.detail?.startsWith("container start failed")) {
          return `I could not start a recorder for Google Meet **${code}**. At most 2 Meet recordings run at once; please try again later.`;
        }
        const reason = end?.reason;
        switch (reason) {
          case "auth_expired":
            return (
              `I could not join Google Meet **${code}**: the bot's Google account session has expired. ` +
              "An admin needs to run `npm run meet:login` in meet/ and replace the session file on the server (MEET_AUTH_STATE_FILE)."
            );
          case "not_admitted":
            return `Nobody let the bot into Google Meet **${code}** within ${ADMIT_TIMEOUT_MS / 60_000} minutes, so nothing was recorded.`;
          case "denied":
            return `Google Meet **${code}** did not let the bot join (the host denied it or Meet refused it), so nothing was recorded.`;
          case "stopped":
            return `Recording of Google Meet **${code}** was stopped before the bot got in, so nothing was recorded.`;
          default:
            return `I could not record Google Meet **${code}** (${describeEnd(reason)}).`;
        }
      }
      ```
- [ ] Step 3: Append to `src/test/setup.ts` (add `import type { RecordingJob, RecordingStatus } from "../meet/protocol.js";` at the top):
      ```ts
      export interface FakeRecording {
        job: RecordingJob;
        status: RecordingStatus;
        stopped: boolean;
      }

      /**
       * Replaces fetch with a scripted meet-recorder Worker (meet/worker). Tests move a recording along by
       * editing `recordings.get(id).status`; `down` makes every call fail like a network error.
       */
      export function fakeMeetRecorder() {
        const fake = {
          recordings: new Map<string, FakeRecording>(),
          authorizations: [] as string[],
          /** "<METHOD> <path>" of every call that reached the fake. */
          requests: [] as string[],
          down: false,
          failStart: false,
        };
        globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
          if (fake.down) throw new TypeError("fetch failed");
          fake.authorizations.push(new Headers(init.headers).get("authorization") ?? "");
          fake.requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
          const [, , id, action] = new URL(url).pathname.split("/");
          const rec = fake.recordings.get(id!);
          if (init.method === "POST" && action === undefined) {
            if (fake.failStart) return new Response("no container instance available", { status: 500 });
            fake.recordings.set(id!, { job: JSON.parse(String(init.body)), status: { state: "starting", segments: [] }, stopped: false });
            return new Response(null, { status: 202 });
          }
          if (!rec) return new Response("not found", { status: 404 });
          if (init.method === "POST" && action === "stop") {
            rec.stopped = true;
            return new Response(null, { status: 202 });
          }
          return Response.json(rec.status);
        }) as typeof fetch;
        return fake;
      }
      ```
- [ ] Step 4: Create `src/meet/session.test.ts`:
      ```ts
      /**
       * The bot side of a Google Meet recording, driven through a scripted meet-recorder Worker
       * with the clock under test control. R2 is in memory; Discord is one fake text channel.
       */
      import { afterEach, beforeEach, mock, test } from "node:test";
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { dataDir, FAKE_MEET_AUTH, fakeMeetRecorder, flush, mockR2, r2 } from "../test/setup.js";

      mockR2();
      const worker = fakeMeetRecorder();
      const { MeetSession } = await import("./session.js");
      const { activeSessions } = await import("../recorder/active.js");
      const { keys } = await import("../storage/keys.js");
      const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("../config.js");

      const MIN = 60_000;
      const NOW = Date.UTC(2026, 9, 12, 3, 0, 0);
      const MEET = { url: "https://meet.google.com/jku-cpry-bcg", code: "jku-cpry-bcg" };
      let guildSeq = 0;

      function harness() {
        const said: string[] = [];
        const finished: any[] = [];
        const guildId = `meet-guild${++guildSeq}`;
        const client: any = {
          channels: { fetch: async () => ({ isSendable: () => true, send: async (t: string) => void said.push(t) }) },
        };
        const onFinished = (m: any) => void finished.push(structuredClone(m));
        const start = () =>
          MeetSession.start({
            client,
            guildId,
            guildName: "Planthia",
            commandChannelId: "cmd",
            startedBy: { id: "alice", name: "Alice" },
            meet: MEET,
            onFinished,
          });
        return { said, finished, guildId, client, onFinished, start };
      }
      const remote = (id: string) => worker.recordings.get(id)!;
      const stored = (id: string) => JSON.parse(r2.get(keys.manifest(id))!.toString());
      const advance = async (ms: number) => {
        mock.timers.tick(ms);
        await flush(20); // a poll goes through fetch, Response.json() and the R2 mock
      };

      beforeEach(() => {
        worker.down = false;
        worker.failStart = false;
        mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
      });
      afterEach(async () => {
        for (const s of activeSessions.values()) await s.shutdown();
        activeSessions.clear();
        mock.timers.reset();
      });

      test("starting sends the link, the session file and the timings to the recorder, and never stores the session", async () => {
        const h = harness();
        const s = await h.start();
        assert.deepEqual(remote(s.id).job, {
          meetUrl: MEET.url,
          authState: FAKE_MEET_AUTH,
          sampleRate: SAMPLE_RATE,
          segmentSamples: SEGMENT_SAMPLES,
          admitTimeoutMs: 5 * MIN,
          aloneTimeoutMs: 3 * MIN,
          maxDurationMs: 240 * MIN,
        });
        assert.equal(worker.authorizations.at(-1), `Bearer ${"m".repeat(40)}`);
        assert.equal(activeSessions.get(h.guildId), s);
        const raw = r2.get(keys.manifest(s.id))!.toString();
        assert.deepEqual(JSON.parse(raw).meet, MEET);
        assert.equal(JSON.parse(raw).voiceChannelName, "Google Meet jku-cpry-bcg");
        assert.ok(!raw.includes("fake-session-cookie"), "the bot account session never reaches R2");
      });

      test("the channel is told once recording starts, and when everyone left the meeting goes to processing", async () => {
        const h = harness();
        const s = await h.start();
        const rec = remote(s.id);
        rec.status = { state: "recording", captureStartedAt: NOW + 40_000, consentPosted: true, segments: [] };
        await advance(15_000);
        assert.deepEqual(h.said, ["🔴 I am recording the Google Meet call jku-cpry-bcg"]);
        await advance(15_000);
        assert.equal(h.said.length, 1, "announced once");

        rec.status = {
          ...rec.status,
          state: "ended",
          segments: [{ index: 0, samples: SEGMENT_SAMPLES }, { index: 1, samples: 10 * SAMPLE_RATE }],
          end: { reason: "alone", leftCleanly: true },
        };
        await advance(15_000);
        const m = h.finished.at(-1);
        assert.equal(m.status, "processing");
        assert.equal(m.startedAt, NOW + 40_000);
        assert.equal(m.endedAt, NOW + 40_000 + 310_000, "5 min + 10 s of audio");
        assert.equal(m.endReason, "everyone left the Google Meet call for 3 minutes");
        assert.deepEqual(m.participants.meet, {
          displayName: "เสียงรวมจาก Google Meet",
          utterances: [],
          segments: [0, 1],
          uploaded: [0, 1],
        });
        assert.equal(activeSessions.get(h.guildId), undefined);
        assert.equal(stored(s.id).status, "processing");
      });

      test("if the notice could not be posted in the Meet chat, the Discord announcement asks people to tell the participants", async () => {
        const h = harness();
        const s = await h.start();
        remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: false, segments: [] };
        await advance(15_000);
        assert.match(h.said[0]!, /could not post the recording notice in the Meet chat/);
      });

      test("/end asks the recorder to stop and keeps the Discord reason once the recorder reports the end", async () => {
        const h = harness();
        const s = await h.start();
        const rec = remote(s.id);
        rec.status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
        await advance(15_000);
        await s.end("ended by Dave with /end");
        assert.equal(rec.stopped, true);
        assert.equal(activeSessions.get(h.guildId), s, "still active until the recorder confirms");
        rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
        await advance(15_000);
        assert.equal(h.finished.at(-1).endReason, "ended by Dave with /end");
        assert.equal(h.finished.at(-1).endedAt, NOW + 60_000);
      });

      test("a call the bot never got into is marked failed with a reason-specific message and is not processed", async () => {
        for (const [reason, expected] of [
          ["denied", /did not let the bot join/],
          ["not_admitted", /Nobody let the bot into Google Meet \*\*jku-cpry-bcg\*\* within 5 minutes/],
          ["auth_expired", /session has expired.*npm run meet:login/],
          ["stopped", /stopped before the bot got in/],
          ["join_failed", /could not record Google Meet \*\*jku-cpry-bcg\*\* \(the Google Meet page offered no way to join\)/],
        ] as const) {
          const h = harness();
          const s = await h.start();
          remote(s.id).status = { state: "ended", segments: [], end: { reason, leftCleanly: true } };
          await advance(15_000);
          assert.match(h.said.at(-1)!, expected, reason);
          assert.equal(h.finished.length, 0, reason);
          assert.equal(stored(s.id).status, "failed", reason);
          assert.equal(activeSessions.get(h.guildId), undefined, reason);
        }
      });

      test("audio from a recorder that died mid-call is still processed and flagged as recovered", async () => {
        const h = harness();
        const s = await h.start();
        remote(s.id).status = {
          state: "ended",
          captureStartedAt: NOW,
          consentPosted: true,
          segments: [{ index: 0, samples: 90 * SAMPLE_RATE }],
          end: { reason: "container_lost", detail: "no report for 3 minutes", leftCleanly: false },
        };
        await advance(15_000);
        const m = h.finished.at(-1);
        assert.equal(m.recovered, true);
        assert.equal(m.endReason, "the Google Meet recorder stopped unexpectedly");
      });

      test("a network outage does not end the meeting: the bot keeps following the recorder and processes it when it is back", async () => {
        const h = harness();
        const s = await h.start();
        worker.down = true;
        await advance(30 * MIN);
        assert.equal(activeSessions.get(h.guildId), s, "still following");
        worker.down = false;
        remote(s.id).status = {
          state: "ended",
          captureStartedAt: NOW + 60_000,
          consentPosted: true,
          segments: [{ index: 0, samples: SEGMENT_SAMPLES }],
          end: { reason: "alone", leftCleanly: true },
        };
        await advance(15_000);
        assert.equal(h.finished.at(-1).id, s.id);
        assert.equal(h.finished.at(-1).status, "processing");
      });

      test("the bot gives up only after the recorder's own deadline has passed, and tells the channel", async () => {
        const h = harness();
        await h.start();
        worker.down = true;
        const giveUp = (5 + 240 + 60) * MIN; // admit timeout + MEET_MAX_DURATION_MIN + GIVE_UP_GRACE_MS
        await advance(giveUp - 15_000);
        assert.ok(activeSessions.get(h.guildId), "still following");
        await advance(15_000);
        assert.equal(activeSessions.get(h.guildId), undefined);
        assert.match(h.said.at(-1)!, /could not record Google Meet \*\*jku-cpry-bcg\*\* \(the Google Meet recorder stopped unexpectedly\)/);
      });

      test("after a bot restart a Meet recording is re-attached, not closed, and not announced again", async () => {
        const h = harness();
        const s = await h.start();
        remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
        await advance(15_000);
        await s.shutdown();
        activeSessions.clear();

        MeetSession.resume(h.client, structuredClone(s.manifest), h.onFinished);
        await flush();
        assert.ok(activeSessions.get(h.guildId), "re-registered");
        remote(s.id).status = { ...remote(s.id).status, state: "ended", segments: [{ index: 0, samples: SEGMENT_SAMPLES }], end: { reason: "meeting_ended", leftCleanly: true } };
        await advance(15_000);
        assert.equal(h.said.length, 1, "announced only before the restart");
        assert.equal(h.finished.at(-1).id, s.id);
        assert.equal(h.finished.at(-1).recovered, undefined);
      });

      test("if the recorder cannot start, a stop is still sent, the error reaches the caller, and nothing blocks the next try", async () => {
        const h = harness();
        worker.failStart = true;
        await assert.rejects(h.start(), /HTTP 500/);
        await flush(20);
        assert.match(worker.requests.at(-1)!, /^POST \/recordings\/[\w-]+\/stop$/, "a start that timed out on our side must not leave a bot joining");
        assert.equal(activeSessions.get(h.guildId), undefined);
        worker.failStart = false;
        assert.ok(await h.start());
      });

      test("a broken session file is reported without quoting it, before any recorder is started", async () => {
        const h = harness();
        const path = join(dataDir, "meet-auth.json");
        writeFileSync(path, '{"cookies":[{"value":"leaky-cookie"');
        try {
          const before = worker.requests.length;
          await assert.rejects(h.start(), (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes("leaky"));
          assert.ok(worker.requests.slice(before).every((r) => r.endsWith("/stop")), "no start request was sent");
        } finally {
          writeFileSync(path, FAKE_MEET_AUTH);
        }
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 47`, `# pass 47`, `# fail 0` (11 new tests in `src/meet/session.test.ts`).
- [ ] Step 6: Commit - `git add src/meet/recorder-client.ts src/meet/session.ts src/meet/session.test.ts src/test/setup.ts && git commit -m "add the bot side of Google Meet recordings"`


#### Task 9: `/record-meet` command, `/end` for Meet, and re-attach on boot

**Files:**
- Modify: `src/commands.ts` (anchor: `export const commands = [`, ~L3)
- Modify: `src/interactions.ts` (anchors: `async function handleEnd(`, ~L65; `if (interaction.commandName === "record") await handleRecord(client, interaction);`, ~L84)
- Modify: `src/pipeline/run.ts` (anchor: `for (const m of unfinishedLocal()) {` in `recoverUnfinished`, ~L106)
- Test: `src/bot.test.ts` (anchors: `const command = async (name: "record" | "end", member: any) => {`, ~L118; `afterEach(async () => {`, ~L206; append 3 tests)

**Interfaces:**
- Consumes: `MeetSession`, `meetRecorderConfigured`, `parseMeetUrl`, `fakeMeetRecorder`, `activeSessions`.
- Produces: slash command `record-meet` with required string option `url`; after deploying, `npm run register` must be run once.

**Steps:**
- [ ] Step 1: In `src/commands.ts` add to the array:
      ```ts
        new SlashCommandBuilder()
          .setName("record-meet")
          .setDescription("Send the bot into a Google Meet call and record it")
          .addStringOption((o) =>
            o.setName("url").setDescription("Google Meet link, e.g. https://meet.google.com/abc-defg-hij").setRequired(true),
          )
          .setContexts(InteractionContextType.Guild),
      ```
- [ ] Step 2: In `src/interactions.ts` add imports `import { MeetSession } from "./meet/session.js";`, `import { meetRecorderConfigured } from "./meet/recorder-client.js";`, `import { parseMeetUrl } from "./meet/meet-url.js";` and the handler:
      ```ts
      async function handleRecordMeet(client: Client, interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
        if (!meetRecorderConfigured()) {
          await interaction.reply({ content: "Google Meet recording is not set up on this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        const meet = parseMeetUrl(interaction.options.getString("url", true));
        if (!meet) {
          await interaction.reply({
            content: "That is not a Google Meet link. Use a link like https://meet.google.com/abc-defg-hij.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const existing = activeSessions.get(interaction.guildId);
        if (existing) {
          await interaction.reply({
            content: `I am already recording in **${existing.manifest.voiceChannelName}**. Use /end there first.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply();
        try {
          await MeetSession.start({
            client,
            guildId: interaction.guildId,
            guildName: interaction.guild.name,
            commandChannelId: interaction.channelId,
            startedBy: { id: interaction.member.id, name: interaction.member.displayName },
            meet,
            onFinished: (m) => void processMeeting(client, m),
          });
        } catch (err) {
          log.error("could not start a Google Meet recording", err);
          await interaction.editReply("I couldn't start the Google Meet recorder. Please try again, or ask an admin to check the bot log.");
          return;
        }
        await interaction.editReply(
          `Joining Google Meet **${meet.code}**. If the host has to admit the bot, please let it in. I will post here when recording starts.`,
        );
      }
      ```
      Route it in `handleInteraction` next to `record`:
      ```ts
            else if (interaction.commandName === "record-meet") await handleRecordMeet(client, interaction);
      ```
      `handleEnd` stays as it is: its reply already uses `session.manifest.voiceChannelName`, and `MeetSession.end()` returns once the stop request is sent.
- [ ] Step 3: In `recoverUnfinished` (`src/pipeline/run.ts`) add `import { MeetSession } from "../meet/session.js";` and make the loop start with:
      ```ts
        for (const m of unfinishedLocal()) {
          // A Google Meet recording runs on Cloudflare, so it survived the restart: keep following it.
          if (m.meet && m.status === "recording") {
            MeetSession.resume(client, m, (done) => void processMeeting(client, done));
            continue;
          }
      ```
- [ ] Step 4: In `src/bot.test.ts`:
      - import `fakeMeetRecorder` from `./test/setup.js` and, after `mockR2(...)`, add `const meetWorker = fakeMeetRecorder();`;
      - add `const { MeetSession } = await import("./meet/session.js");` after the other dynamic imports;
      - extend the command helper: `const command = async (name: "record" | "end" | "record-meet", member: any, options: Record<string, string> = {}) => {` and add `options: { getString: (n: string) => options[n] ?? null },` to the fake interaction `i`;
      - replace the `afterEach` body's first line with:
        ```ts
          await Promise.all([...activeSessions.values()].map((s) => s.end("test cleanup")));
          for (const s of activeSessions.values()) await s.shutdown(); // Meet sessions wait for their recorder
          activeSessions.clear();
        ```
      - append:
      ```ts
      // ---- Google Meet ---------------------------------------------------------------

      const MEET_LINK = "https://meet.google.com/jku-cpry-bcg";

      test("/record-meet refuses anything that is not a Google Meet link", async () => {
        const s = makeServer();
        const alice = s.person("alice", "Alice");
        const [reply] = await s.command("record-meet", alice, { url: "https://zoom.us/j/123" });
        assert.match(reply.content, /not a Google Meet link/);
        assert.ok(reply.flags, "only the caller sees it");
        assert.equal(s.session(), undefined);
      });

      test("/record-meet works from any channel, and a server records one meeting at a time across Discord and Meet", async () => {
        const s = makeServer();
        const alice = s.person("alice", "Alice");
        const replies = await s.command("record-meet", alice, { url: MEET_LINK });
        assert.match(replies.at(-1).content, /Joining Google Meet \*\*jku-cpry-bcg\*\*/);
        assert.ok(s.session() instanceof MeetSession);
        s.join(alice);
        const [again] = await s.command("record", alice);
        assert.match(again.content, /already recording in \*\*Google Meet jku-cpry-bcg\*\*/);
        const [twice] = await s.command("record-meet", alice, { url: "jku-cpry-bcg" });
        assert.match(twice.content, /already recording in \*\*Google Meet jku-cpry-bcg\*\*/);

        const other = makeServer();
        const bob = other.person("bob", "Bob");
        other.join(bob);
        await other.command("record", bob);
        const [blocked] = await other.command("record-meet", bob, { url: MEET_LINK });
        assert.match(blocked.content, /already recording in \*\*daily-standup\*\*/);
      });

      test("/end on a Meet recording tells the recorder to stop, and processing starts when the recorder reports the end", async () => {
        const s = makeServer();
        const alice = s.person("alice", "Alice");
        const dave = s.person("dave", "Dave");
        await s.command("record-meet", alice, { url: MEET_LINK });
        const id = s.session()!.id;
        const rec = meetWorker.recordings.get(id)!;
        rec.status = { state: "recording", captureStartedAt: Date.now(), consentPosted: true, segments: [] };
        await advance(15_000);
        assert.ok(s.sent.includes("🔴 I am recording the Google Meet call jku-cpry-bcg"));

        const [reply] = await s.command("end", dave);
        assert.match(reply.content, /Recording in \*\*Google Meet jku-cpry-bcg\*\* stopped/);
        assert.equal(rec.stopped, true);
        rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
        await advance(15_000);
        await flush(20);
        assert.equal(lastFinished().id, id);
        assert.equal(lastFinished().endReason, "ended by Dave with /end");
        assert.equal(s.session(), undefined);
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# tests 50`, `# pass 50`, `# fail 0`.
- [ ] Step 6: Commit - `git add src/commands.ts src/interactions.ts src/pipeline/run.ts src/bot.test.ts && git commit -m "add /record-meet and follow Meet recordings across restarts"`


---

### Track C - the `meet/` package (Worker, Durable Object, container)

All commands in this track run from `meet/` unless they say otherwise.

#### Task 10: Scaffold the `meet/` package

**Files:**
- Create: `meet/package.json`, `meet/package-lock.json` (generated by `npm install`), `meet/tsconfig.json`, `meet/tsconfig.node.json`, `meet/wrangler.jsonc`, `meet/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: scripts `typecheck`, `test`, `build:bot`, `image:local`, `meet:login`; tsconfig `tsconfig.json` = Worker code (`worker/`, tests excluded, workers-types); `tsconfig.node.json` = container code and every test (`bot/`, `worker/core.ts`, `worker/http.ts`, `worker/**/*.test.ts`, Node + DOM types).

**Gotcha:** the bucket name in `wrangler.jsonc` must equal `R2_BUCKET` on the VPS (`.env.example` default `meeting-recordings`); it is configured twice because the two deployables are configured separately.

**Steps:**
- [ ] Step 1: Create `meet/package.json`:
      ```json
      {
        "name": "meet-recorder",
        "private": true,
        "type": "module",
        "description": "Google Meet recorder for the meeting minutes bot: Cloudflare Worker, Durable Object and Playwright container",
        "engines": { "node": ">=22.12.0" },
        "scripts": {
          "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.node.json",
          "test": "node --import tsx --test 'worker/**/*.test.ts' 'bot/**/*.test.ts'",
          "build:bot": "esbuild bot/runner.ts bot/login.ts --bundle --platform=node --target=node22 --format=esm --external:playwright --outdir=dist --out-extension:.js=.mjs",
          "image:local": "npm run build:bot && podman build -t meet-recorder:local .",
          "meet:login": "npm run image:local && mkdir -p auth && podman run --rm -it -p 127.0.0.1:6080:6080 -v \"$PWD/auth:/out\" meet-recorder:local login"
        },
        "dependencies": {
          "playwright": "1.64.1"
        },
        "devDependencies": {
          "@cloudflare/workers-types": "^5.20261028.1",
          "@types/node": "^26.6.5",
          "esbuild": "^0.28.2",
          "tsx": "^4.23.15",
          "typescript": "^7.0.2",
          "wrangler": "^4.154.0"
        }
      }
      ```
      `playwright` is pinned exactly because it must match the browsers in `mcr.microsoft.com/playwright:v1.64.1-noble`.
- [ ] Step 2: Create `meet/tsconfig.json` (Worker):
      ```json
      {
        "compilerOptions": {
          "target": "ES2023",
          "lib": ["ES2023"],
          "module": "ES2022",
          "moduleResolution": "Bundler",
          "strict": true,
          "noEmit": true,
          "skipLibCheck": true,
          "types": ["@cloudflare/workers-types"]
        },
        "include": ["worker"],
        "exclude": ["worker/**/*.test.ts"]
      }
      ```
      and `meet/tsconfig.node.json` (container + tests):
      ```json
      {
        "compilerOptions": {
          "target": "ES2023",
          "lib": ["ES2023", "DOM"],
          "module": "ES2022",
          "moduleResolution": "Bundler",
          "strict": true,
          "noEmit": true,
          "skipLibCheck": true,
          "types": ["node"]
        },
        "include": ["bot", "worker/core.ts", "worker/http.ts", "worker/**/*.test.ts"]
      }
      ```
      (`DOM` is needed for `document` inside `page.evaluate` callbacks.)
- [ ] Step 3: Create `meet/wrangler.jsonc`:
      ```jsonc
      {
        "$schema": "node_modules/wrangler/config-schema.json",
        "name": "everymeet-meet-recorder",
        "main": "worker/index.ts",
        "compatibility_date": "2026-10-01",
        "workers_dev": true,
        "preview_urls": false,
        "observability": { "enabled": true },
        "containers": [
          {
            "class_name": "MeetRecorder",
            // Deploys from podman use a gitignored wrangler.deploy.jsonc whose image is the pushed registry tag (README).
            "image": "./Dockerfile",
            "instance_type": "standard-2",
            // Cost guardrail: at most two Meet recordings at the same time across all servers.
            "max_instances": 2
          }
        ],
        "durable_objects": { "bindings": [{ "name": "MEET_RECORDER", "class_name": "MeetRecorder" }] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MeetRecorder"] }],
        "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "meeting-recordings" }]
      }
      ```
- [ ] Step 4: Create `meet/.gitignore`:
      ```
      node_modules
      dist
      .wrangler
      auth/
      wrangler.deploy.jsonc
      ```
- [ ] Step 5: Verify - Run: `cd meet && npm install && npx wrangler --version && npx tsc --version && git status --short .` - Expected: install exits 0; wrangler prints `4.` followed by the minor version; tsc prints `Version 7.`; git status lists the six created files and no `node_modules`.
- [ ] Step 6: Commit - `git add meet/package.json meet/package-lock.json meet/tsconfig.json meet/tsconfig.node.json meet/wrangler.jsonc meet/.gitignore && git commit -m "scaffold the meet-recorder package"`

#### Task 11: Durable Object core: recording state machine with injected ports

**Files:**
- Create: `meet/worker/core.ts`
- Test: `meet/worker/core.test.ts`

**Interfaces:**
- Consumes: from Track A, exactly: `MEET_PARTICIPANT_ID: "meet"`, `EndReason`, `EventReply { stop: boolean }`, `RecordingJob`, `RecordingStatus`, `RunnerEvent` (`src/meet/protocol.ts`), and `keys.segment(id: string, userId: string, index: number): string`, `keys.debug(id: string, name: string): string` (`src/storage/keys.ts`).
- Produces (consumed by Tasks 12-13):
  ```ts
  export const WATCHDOG_MS = 180_000, DEADLINE_GRACE_MS = 600_000, DESTROY_AFTER_END_MS = 30_000, RETENTION_MS = 604_800_000;
  export interface RecordingRecord extends RecordingStatus { id: string; hardDeadline: number; lastEventAt: number; stopRequested: boolean; endedAt?: number }
  export interface RecorderPorts {
    load(): Promise<RecordingRecord | undefined>; save(r: RecordingRecord): Promise<void>; clear(): Promise<void>;
    setAlarm(at: number): Promise<void>;
    launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void>;
    background(task: Promise<void>): void;
    destroy(reason: string): Promise<void>;
    now(): number; log(entry: Record<string, unknown>): void;
  }
  export class RecorderCore {
    constructor(p: RecorderPorts);
    start(id: string, job: RecordingJob): Promise<"started" | "exists">;
    status(): Promise<RecordingStatus | undefined>;
    stop(): Promise<boolean>;
    event(e: RunnerEvent): Promise<EventReply>;
    segmentStored(index: number, samples: number): Promise<void>;
    runnerExited(code: number): Promise<void>;
    alarm(): Promise<void>;
  }
  ```

**Gotcha:** `start()` returns as soon as the record and the watchdog alarm are saved, and the container launch runs in the background (`ctx.waitUntil`): a cold start of the roughly 2 GB image, or the first minute after a deploy, can take longer than the bot's 20 s request timeout, and a timed-out start must not leave a recording nobody follows.
A failed launch ends the recording as `crashed`, which the bot's next poll reports.
Durable Object input gates make `load` -> modify -> `save` atomic only while no external I/O happens in between; every method below keeps external calls (container, alarms after save) out of that window, and R2 writes happen in the callback entrypoint, not here (Task 12).

**Steps:**
- [ ] Step 1: Create `meet/worker/core.ts`:
      ```ts
      import type { EndReason, EventReply, RecordingJob, RecordingStatus, RunnerEvent } from "../../src/meet/protocol.js";

      /** No report from the container for this long means it is gone. */
      export const WATCHDOG_MS = 3 * 60_000;
      /** Extra time past admit timeout + max duration before the hard deadline. */
      export const DEADLINE_GRACE_MS = 10 * 60_000;
      /** The container gets this long to exit by itself after reporting the end. */
      export const DESTROY_AFTER_END_MS = 30_000;
      /** State is kept this long after the end so a restarted bot can still read it. */
      export const RETENTION_MS = 7 * 24 * 60 * 60_000;

      /** What the Durable Object stores. Never holds the job's authState. */
      export interface RecordingRecord extends RecordingStatus {
        id: string;
        hardDeadline: number;
        lastEventAt: number;
        stopRequested: boolean;
        endedAt?: number;
      }

      /** Everything the core needs from Cloudflare, injected so it runs under node:test. */
      export interface RecorderPorts {
        load(): Promise<RecordingRecord | undefined>;
        save(r: RecordingRecord): Promise<void>;
        /** Deletes all stored state and the alarm. */
        clear(): Promise<void>;
        setAlarm(at: number): Promise<void>;
        /** Starts the container and the runner with `job` on its stdin. */
        launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void>;
        /** Keeps work running after the current call returns (ctx.waitUntil). */
        background(task: Promise<void>): void;
        /** Stops the container if it runs. */
        destroy(reason: string): Promise<void>;
        now(): number;
        log(entry: Record<string, unknown>): void;
      }

      /** One Google Meet recording: its state, its deadlines, and its container's lifecycle. */
      export class RecorderCore {
        constructor(private readonly p: RecorderPorts) {}

        async start(id: string, job: RecordingJob): Promise<"started" | "exists"> {
          if (await this.p.load()) return "exists";
          const now = this.p.now();
          const r: RecordingRecord = {
            id,
            state: "starting",
            segments: [],
            stopRequested: false,
            lastEventAt: now,
            hardDeadline: now + job.admitTimeoutMs + job.maxDurationMs + DEADLINE_GRACE_MS,
          };
          await this.p.save(r);
          await this.p.setAlarm(now + WATCHDOG_MS);
          this.p.log({ id, event: "start", meetUrl: job.meetUrl, signedIn: job.authState !== undefined });
          this.p.background(this.launch(id, job, r.hardDeadline));
          return "started";
        }

        private async launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void> {
          try {
            await this.p.launch(id, job, hardDeadline);
          } catch (err) {
            const r = await this.p.load();
            if (r && r.state !== "ended") await this.finish(r, "crashed", `container start failed: ${(err as Error).message}`);
            return;
          }
          // An image pull can take minutes; the watchdog counts from the moment the runner is running.
          const r = await this.p.load();
          if (r?.state === "starting") {
            r.lastEventAt = this.p.now();
            await this.p.save(r);
            await this.p.setAlarm(r.lastEventAt + WATCHDOG_MS);
          }
        }

        async status(): Promise<RecordingStatus | undefined> {
          const r = await this.p.load();
          if (!r) return undefined;
          const { state, captureStartedAt, consentPosted, segments, end } = r;
          return { state, captureStartedAt, consentPosted, segments, end };
        }

        async stop(): Promise<boolean> {
          const r = await this.p.load();
          if (!r) return false;
          if (r.state !== "ended" && !r.stopRequested) {
            r.stopRequested = true;
            await this.p.save(r);
            this.p.log({ id: r.id, event: "stop requested" });
          }
          return true;
        }

        async event(e: RunnerEvent): Promise<EventReply> {
          const r = await this.p.load();
          if (!r || r.state === "ended") return { stop: true };
          r.lastEventAt = this.p.now();
          this.p.log({ id: r.id, ...e });
          switch (e.type) {
            case "joining":
            case "waiting":
              r.state = e.type;
              break;
            case "recording":
              r.state = "recording";
              r.captureStartedAt = e.captureStartedAt;
              r.consentPosted = e.consentPosted;
              break;
            case "heartbeat":
              break;
            case "ended":
              await this.finish(r, e.reason, e.detail, e.leftCleanly);
              return { stop: true };
          }
          await this.p.save(r);
          return { stop: r.stopRequested };
        }

        /** The callback entrypoint stored a segment in R2; list it once, sorted (a retried upload replaces it). */
        async segmentStored(index: number, samples: number): Promise<void> {
          const r = await this.p.load();
          if (!r) throw new Error("unknown recording");
          r.segments = [...r.segments.filter((s) => s.index !== index), { index, samples }].sort((a, b) => a.index - b.index);
          r.lastEventAt = this.p.now();
          await this.p.save(r);
          this.p.log({ id: r.id, event: "segment", index, samples });
        }

        /** The runner process exited; normally right after it reported the end. */
        async runnerExited(code: number): Promise<void> {
          const r = await this.p.load();
          if (!r) return;
          if (r.state !== "ended") await this.finish(r, "crashed", `runner exited with code ${code}`);
          await this.destroy(r.id, "runner exited");
        }

        async alarm(): Promise<void> {
          const r = await this.p.load();
          if (!r) return;
          const now = this.p.now();
          if (r.state === "ended") {
            await this.destroy(r.id, "recording ended");
            if (now >= r.endedAt! + RETENTION_MS) await this.p.clear();
            else await this.p.setAlarm(r.endedAt! + RETENTION_MS);
            return;
          }
          if (now >= r.hardDeadline) {
            await this.finish(r, "max_duration", "hard deadline reached");
          } else if (now - r.lastEventAt >= WATCHDOG_MS) {
            await this.finish(r, "container_lost", `no report for ${WATCHDOG_MS / 60_000} minutes`);
          } else {
            await this.p.setAlarm(Math.min(r.lastEventAt + WATCHDOG_MS, r.hardDeadline));
            return;
          }
          await this.destroy(r.id, r.end!.reason);
        }

        private async finish(r: RecordingRecord, reason: EndReason, detail?: string, leftCleanly = false): Promise<void> {
          r.state = "ended";
          r.end = detail === undefined ? { reason, leftCleanly } : { reason, detail, leftCleanly };
          r.endedAt = this.p.now();
          await this.p.save(r);
          await this.p.setAlarm(r.endedAt + DESTROY_AFTER_END_MS);
          this.p.log({ id: r.id, event: "ended", reason, detail, leftCleanly });
        }

        private async destroy(id: string, reason: string): Promise<void> {
          this.p.log({ id, event: "destroy", reason });
          await this.p.destroy(reason);
        }
      }
      ```
- [ ] Step 2: Create `meet/worker/core.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import type { RecordingJob } from "../../src/meet/protocol.js";
      import { DESTROY_AFTER_END_MS, RecorderCore, RETENTION_MS, WATCHDOG_MS, type RecordingRecord } from "./core.js";

      const MIN = 60_000;
      const T0 = 1_000_000;
      const job: RecordingJob = {
        meetUrl: "https://meet.google.com/jku-cpry-bcg",
        authState: '{"cookies":[{"value":"secret-cookie"}]}',
        sampleRate: 24_000,
        segmentSamples: 7_200_000,
        admitTimeoutMs: 5 * MIN,
        aloneTimeoutMs: 3 * MIN,
        maxDurationMs: 240 * MIN,
      };

      function fakePorts() {
        const f = {
          now: T0,
          stored: undefined as RecordingRecord | undefined,
          alarm: undefined as number | undefined,
          launched: [] as { id: string; job: RecordingJob; hardDeadline: number }[],
          destroyed: [] as string[],
          logs: [] as Record<string, unknown>[],
          launchFails: false,
          pending: [] as Promise<void>[],
        };
        const core = new RecorderCore({
          load: async () => structuredClone(f.stored),
          save: async (r) => {
            f.stored = structuredClone(r);
          },
          clear: async () => {
            f.stored = undefined;
            f.alarm = undefined;
          },
          setAlarm: async (at) => {
            f.alarm = at;
          },
          launch: async (id, j, hardDeadline) => {
            if (f.launchFails) throw new Error("no container instance available");
            f.launched.push({ id, job: j, hardDeadline });
          },
          background: (task) => void f.pending.push(task),
          destroy: async (reason) => void f.destroyed.push(reason),
          now: () => f.now,
          log: (e) => void f.logs.push(e),
        });
        return { f, core };
      }

      test("start keeps the bot account session out of storage and logs, launches the container with it, and arms the watchdog", async () => {
        const { f, core } = fakePorts();
        assert.equal(await core.start("rec1", job), "started");
        await Promise.all(f.pending);
        assert.equal(f.launched[0]!.job.authState, job.authState);
        assert.equal(f.launched[0]!.hardDeadline, T0 + 5 * MIN + 240 * MIN + 10 * MIN);
        assert.ok(!JSON.stringify(f.stored).includes("secret-cookie"));
        assert.ok(!JSON.stringify(f.logs).includes("secret-cookie"));
        assert.equal(f.alarm, T0 + WATCHDOG_MS);
        assert.equal((await core.status())!.state, "starting");
        assert.equal(await core.start("rec1", job), "exists");
        assert.equal(f.launched.length, 1);
      });

      test("runner events move the state along, and /end reaches the runner in its next reply", async () => {
        const { core } = fakePorts();
        await core.start("rec1", job);
        assert.deepEqual(await core.event({ type: "joining" }), { stop: false });
        await core.event({ type: "waiting" });
        assert.equal((await core.status())!.state, "waiting");
        await core.event({ type: "recording", captureStartedAt: 1_234, consentPosted: true });
        const s = (await core.status())!;
        assert.equal(s.state, "recording");
        assert.equal(s.captureStartedAt, 1_234);
        assert.equal(s.consentPosted, true);
        assert.equal(await core.stop(), true);
        assert.deepEqual(await core.event({ type: "heartbeat", participants: 2 }), { stop: true });
      });

      test("a stop requested while the container is still starting reaches the runner at its first event", async () => {
        const { f, core } = fakePorts();
        await core.start("rec1", job);
        await Promise.all(f.pending);
        assert.equal(await core.stop(), true);
        assert.deepEqual(await core.event({ type: "joining" }), { stop: true });
        await core.event({ type: "ended", reason: "stopped", leftCleanly: true });
        assert.equal((await core.status())!.state, "ended");
      });

      test("stored segments are listed once and sorted, even when an upload is retried", async () => {
        const { core } = fakePorts();
        await core.start("rec1", job);
        await core.segmentStored(1, 240_000);
        await core.segmentStored(0, 7_200_000);
        await core.segmentStored(1, 240_000);
        assert.deepEqual((await core.status())!.segments, [
          { index: 0, samples: 7_200_000 },
          { index: 1, samples: 240_000 },
        ]);
      });

      test("after the runner reports the end, the container is destroyed and the state is deleted 7 days later", async () => {
        const { f, core } = fakePorts();
        await core.start("rec1", job);
        assert.deepEqual(await core.event({ type: "ended", reason: "alone", leftCleanly: true }), { stop: true });
        assert.deepEqual((await core.status())!.end, { reason: "alone", leftCleanly: true });
        assert.equal(f.alarm, T0 + DESTROY_AFTER_END_MS);
        f.now = f.alarm!;
        await core.alarm();
        assert.deepEqual(f.destroyed, ["recording ended"]);
        assert.equal(f.alarm, T0 + RETENTION_MS);
        f.now = f.alarm!;
        await core.alarm();
        assert.equal(await core.status(), undefined);
        assert.deepEqual(await core.event({ type: "heartbeat" }), { stop: true }, "a late runner is told to stop");
      });

      test("a container that stops reporting for 3 minutes is ended as container_lost; an earlier alarm only re-arms", async () => {
        const { f, core } = fakePorts();
        await core.start("rec1", job);
        await Promise.all(f.pending);
        f.now = T0 + 2 * MIN;
        await core.event({ type: "heartbeat" });
        f.now = T0 + WATCHDOG_MS;
        await core.alarm();
        assert.equal((await core.status())!.state, "starting");
        assert.equal(f.alarm, T0 + 2 * MIN + WATCHDOG_MS);
        f.now = f.alarm!;
        await core.alarm();
        assert.deepEqual((await core.status())!.end, { reason: "container_lost", detail: "no report for 3 minutes", leftCleanly: false });
        assert.deepEqual(f.destroyed, ["container_lost"]);
      });

      test("the hard deadline ends a recording even while the container keeps reporting", async () => {
        const { f, core } = fakePorts();
        await core.start("rec1", job);
        await Promise.all(f.pending);
        f.now = f.launched[0]!.hardDeadline;
        await core.event({ type: "heartbeat" });
        await core.alarm();
        assert.deepEqual((await core.status())!.end, { reason: "max_duration", detail: "hard deadline reached", leftCleanly: false });
        assert.deepEqual(f.destroyed, ["max_duration"]);
      });

      test("a runner that exits without reporting the end, or a container that cannot start, ends the recording as crashed", async () => {
        const a = fakePorts();
        await a.core.start("rec1", job);
        await a.core.runnerExited(137);
        assert.deepEqual((await a.core.status())!.end, { reason: "crashed", detail: "runner exited with code 137", leftCleanly: false });
        assert.deepEqual(a.f.destroyed, ["runner exited"]);

        const b = fakePorts();
        b.f.launchFails = true;
        assert.equal(await b.core.start("rec2", job), "started", "the bot's start request never waits for the container");
        await Promise.all(b.f.pending);
        assert.deepEqual((await b.core.status())!.end, {
          reason: "crashed",
          detail: "container start failed: no container instance available",
          leftCleanly: false,
        });
      });
      ```
- [ ] Step 3: Verify - Run: `cd meet && npm ci && npx tsc -p tsconfig.json && npx tsc -p tsconfig.node.json && node --import tsx --test worker/core.test.ts 2>&1 | tail -8` - Expected: both tsc runs exit 0; `# pass 8`, `# fail 0`.
- [ ] Step 4: Commit - `git add meet/worker/core.ts meet/worker/core.test.ts && git commit -m "add the meet recorder state machine"`


#### Task 12: Worker HTTP: Bearer-token API for the bot and the container callback routes

**Files:**
- Create: `meet/worker/http.ts`
- Test: `meet/worker/http.test.ts`

**Interfaces:**
- Consumes: protocol types and `MEET_PARTICIPANT_ID` (Track A), `keys.segment` / `keys.debug` (Track A), `RecorderCore` method shapes (Task 11).
- Produces (consumed by Task 13):
  ```ts
  export interface RecorderApi {
    start(id: string, job: RecordingJob): Promise<"started" | "exists">;
    status(): Promise<RecordingStatus | undefined>;
    stop(): Promise<boolean>;
    event(e: RunnerEvent): Promise<EventReply>;
    segmentStored(index: number, samples: number): Promise<void>;
  }
  export type Store = (key: string, body: ArrayBuffer, contentType: string) => Promise<void>;
  export const MAX_RECORDING_MS: number; // 6 h, the Worker-side cost cap
  export function sameSecret(a: string, b: string): boolean;
  export function handleApi(request: Request, token: string | undefined, recorder: (id: string) => RecorderApi): Promise<Response>;
  export function handleCallback(request: Request, id: string, recorder: RecorderApi, store: Store): Promise<Response>;
  ```
  API: `POST /recordings/:id` (job JSON) -> 202 | 409 exists | 400 bad job; `GET /recordings/:id` -> 200 `RecordingStatus` | 404; `POST /recordings/:id/stop` -> 202 | 404; anything without the exact `Authorization: Bearer <token>` -> 401.
  Callback: `POST /event` (JSON, at most 16 KiB) -> 200 `EventReply`; `PUT /segments/:index` with `x-samples` (at most 32 MiB) -> stored in R2 by the entrypoint itself, then `segmentStored` -> 204; `PUT /debug/:name` (at most 4 MiB) -> stored in R2 -> 204.

R2 writes happen in the callback entrypoint, which has the `BUCKET` binding, so a segment (up to 14.4 MB) never crosses the Durable Object RPC boundary; the Durable Object only records that it exists.
The callback routes carry no token on purpose: `interceptOutboundHttp` sends only this container's requests for `meet-recorder.internal` to the entrypoint, the host is not publicly routable, and the Meet page cannot forge a request to it (it is plain http from an https page, which Chromium blocks as mixed content).

**Steps:**
- [ ] Step 1: Create `meet/worker/http.ts`:
      ```ts
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
      ```
- [ ] Step 2: Create `meet/worker/http.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { handleApi, handleCallback, type RecorderApi } from "./http.js";

      const TOKEN = "t".repeat(40);
      const JOB = {
        meetUrl: "https://meet.google.com/jku-cpry-bcg",
        sampleRate: 24_000,
        segmentSamples: 7_200_000,
        admitTimeoutMs: 1,
        aloneTimeoutMs: 1,
        maxDurationMs: 1,
      };

      function fakeRecorder() {
        const calls: unknown[][] = [];
        let exists = false;
        const r: RecorderApi = {
          start: async (id, job) => {
            calls.push(["start", id, job]);
            if (exists) return "exists";
            exists = true;
            return "started";
          },
          status: async () => (exists ? { state: "recording", segments: [] } : undefined),
          stop: async () => exists,
          event: async (e) => {
            calls.push(["event", e]);
            return { stop: false };
          },
          segmentStored: async (index, samples) => void calls.push(["segmentStored", index, samples]),
        };
        const stored = new Map<string, { bytes: number; contentType: string }>();
        const store = async (key: string, body: ArrayBuffer, contentType: string) =>
          void stored.set(key, { bytes: body.byteLength, contentType });
        return { r, calls, stored, store };
      }

      const request = (path: string, init: RequestInit & { token?: string | null } = {}) => {
        const headers = new Headers(init.headers);
        if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
        return new Request(`https://recorder.example.com${path}`, { ...init, headers });
      };

      test("every API call needs the exact Bearer token", async () => {
        const { r } = fakeRecorder();
        const api = (req: Request) => handleApi(req, TOKEN, () => r);
        assert.equal((await api(request("/recordings/abc", { token: null }))).status, 401);
        assert.equal((await api(request("/recordings/abc", { token: "x".repeat(40) }))).status, 401);
        assert.equal((await handleApi(request("/recordings/abc"), undefined, () => r)).status, 401, "no secret configured");
        assert.equal((await api(request("/recordings/abc"))).status, 404, "right token, unknown recording");
      });

      test("the bot can start, read and stop a recording; bad ids, paths and links are refused", async () => {
        const { r, calls } = fakeRecorder();
        const api = (req: Request) => handleApi(req, TOKEN, () => r);
        const post = (path: string, body?: unknown) =>
          api(request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));
        assert.equal((await post("/recordings/abc", { ...JOB, meetUrl: "https://evil.example.com/x" })).status, 400);
        assert.equal((await post("/recordings/abc", { ...JOB, maxDurationMs: 7 * 60 * 60_000 })).status, 400, "Worker-side cost cap");
        assert.equal((await post("/recordings/abc", JOB)).status, 202);
        assert.deepEqual(calls.at(-1), ["start", "abc", JOB]);
        assert.equal((await post("/recordings/abc", JOB)).status, 409);
        const status = await api(request("/recordings/abc"));
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { state: "recording", segments: [] });
        assert.equal((await post("/recordings/abc/stop")).status, 202);
        assert.equal((await api(request("/recordings/a%2Fb"))).status, 404);
        assert.equal((await api(request("/recordings/abc/stop/now", { method: "POST" }))).status, 404);
        assert.equal((await api(request("/other/abc"))).status, 404);
      });

      test("container callbacks reach the recorder, and uploads land in R2 under the recording", async () => {
        const { r, calls, stored, store } = fakeRecorder();
        const cb = (path: string, init: RequestInit) =>
          handleCallback(new Request(`http://meet-recorder.internal${path}`, init), "rec1", r, store);
        const reply = await cb("/event", { method: "POST", body: JSON.stringify({ type: "heartbeat", participants: 2 }) });
        assert.deepEqual(await reply.json(), { stop: false });
        assert.deepEqual(calls.at(-1), ["event", { type: "heartbeat", participants: 2 }]);
        assert.equal((await cb("/segments/3", { method: "PUT", headers: { "x-samples": "240000" }, body: new Uint8Array(7) })).status, 204);
        assert.deepEqual(stored.get("meetings/rec1/segments/meet/0003.flac"), { bytes: 7, contentType: "audio/flac" });
        assert.deepEqual(calls.at(-1), ["segmentStored", 3, 240000]);
        assert.equal((await cb("/segments/3", { method: "PUT", body: new Uint8Array(7) })).status, 400, "x-samples is required");
        assert.equal(
          (await cb("/segments/4", { method: "PUT", headers: { "x-samples": "1" }, body: new Uint8Array(33 * 1024 * 1024) })).status,
          413,
          "larger than any 5-minute segment",
        );
        assert.equal((await cb("/debug/failure.png", { method: "PUT", body: new Uint8Array(2) })).status, 204);
        assert.deepEqual(stored.get("meetings/rec1/debug/failure.png"), { bytes: 2, contentType: "image/png" });
        assert.equal((await cb("/debug/..%2Fx", { method: "PUT", body: new Uint8Array(2) })).status, 404);
        assert.equal((await cb("/event", { method: "POST", body: "x".repeat(20_000) })).status, 413);
      });
      ```
- [ ] Step 3: Verify - Run: `cd meet && npx tsc -p tsconfig.json && npx tsc -p tsconfig.node.json && node --import tsx --test worker/http.test.ts 2>&1 | tail -8` - Expected: both tsc runs exit 0; `# pass 3`, `# fail 0`.
- [ ] Step 4: Commit - `git add meet/worker/http.ts meet/worker/http.test.ts && git commit -m "add the meet recorder HTTP routes"`

#### Task 13: Durable Object adapter and Worker entry

**Files:**
- Create: `meet/worker/env.ts`, `meet/worker/globals.d.ts`, `meet/worker/recorder.ts`, `meet/worker/index.ts`

These four files are the only ones that touch Cloudflare APIs; each is a thin adapter, so one task (one commit that builds).

**Interfaces:**
- Consumes: `RecorderCore`, `RecorderPorts` (Task 11); `handleApi`, `handleCallback`, `RecorderApi`, `Store` (Task 12); `CALLBACK_HOST` (Track A).
- Produces: Worker module with `default.fetch`, Durable Object class `MeetRecorder`, `WorkerEntrypoint` `RecorderCallback` (props `{ recordingId: string }`); container command `["/app/entrypoint.sh"]` run with the job on stdin (Task 17 provides the script).

**Gotcha:** `exec` does not inherit the image `ENV` (spike finding), so `RUNNER_ENV` sets `PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and `HOME`.
Never pipe the runner's stdout (`stdout: "ignore"`): Xvfb and PulseAudio inherit it and the stream never closes (spike finding).
If `tsc` rejects assigning a Durable Object stub to `RecorderApi` (RPC stubs wrap results in `Rpc.*` types), keep the cast `as unknown as RecorderApi` shown below.

**Steps:**
- [ ] Step 1: Create `meet/worker/env.ts`:
      ```ts
      import type { MeetRecorder } from "./recorder.js";

      export interface Env {
        MEET_RECORDER: DurableObjectNamespace<MeetRecorder>;
        BUCKET: R2Bucket;
        /** Shared with the bot as MEET_RECORDER_TOKEN; set with `wrangler secret put RECORDER_TOKEN`. */
        RECORDER_TOKEN?: string;
      }
      ```
      and `meet/worker/globals.d.ts` (types `this.ctx.exports`, as in Cellar `src/worker/globals.d.ts`):
      ```ts
      declare namespace Cloudflare {
        interface GlobalProps {
          mainModule: typeof import("./index.js");
        }
      }
      ```
- [ ] Step 2: Create `meet/worker/recorder.ts`:
      ```ts
      import { DurableObject } from "cloudflare:workers";
      import { CALLBACK_HOST, type EventReply, type RecordingJob, type RecordingStatus, type RunnerEvent } from "../../src/meet/protocol.js";
      import { RecorderCore, type RecordingRecord } from "./core.js";
      import type { Env } from "./env.js";
      import type { RecorderApi } from "./http.js";

      /** Exec does not inherit the image ENV, so the variables the Playwright image relies on are set here. */
      const RUNNER_ENV = {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
        HOME: "/root",
      };
      const KEY = "recording";

      /** One Durable Object per Google Meet recording (name = manifest id); it owns one container. */
      export class MeetRecorder extends DurableObject<Env> implements RecorderApi {
        private readonly core = new RecorderCore({
          load: () => this.ctx.storage.get<RecordingRecord>(KEY),
          save: (r) => this.ctx.storage.put(KEY, r),
          clear: async () => {
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.deleteAll();
          },
          setAlarm: (at) => this.ctx.storage.setAlarm(at),
          launch: (id, job, hardDeadline) => this.launch(id, job, hardDeadline),
          background: (task) => this.ctx.waitUntil(task),
          destroy: async (reason) => {
            if (this.ctx.container?.running) await this.ctx.container.destroy(reason);
          },
          now: () => Date.now(),
          log: (entry) => console.log(JSON.stringify(entry)),
        });

        start(id: string, job: RecordingJob): Promise<"started" | "exists"> {
          return this.core.start(id, job);
        }
        status(): Promise<RecordingStatus | undefined> {
          return this.core.status();
        }
        stop(): Promise<boolean> {
          return this.core.stop();
        }
        event(e: RunnerEvent): Promise<EventReply> {
          return this.core.event(e);
        }
        segmentStored(index: number, samples: number): Promise<void> {
          return this.core.segmentStored(index, samples);
        }
        override alarm(): Promise<void> {
          return this.core.alarm();
        }

        /** Container lifecycle as in Cellar's job runner: keep-alive entrypoint, then the runner via exec with the job on stdin. */
        private async launch(id: string, job: RecordingJob, hardDeadline: number): Promise<void> {
          const c = this.ctx.container;
          if (!c) throw new Error("no container configured");
          c.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
          await c.setInactivityTimeout(Math.max(hardDeadline - Date.now(), 0));
          await c.interceptOutboundHttp(CALLBACK_HOST, this.ctx.exports.RecorderCallback({ props: { recordingId: id } }));
          const proc = await c.exec(["/app/entrypoint.sh"], {
            cwd: "/app",
            env: RUNNER_ENV,
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          const writer = proc.stdin!.getWriter();
          await writer.write(new TextEncoder().encode(JSON.stringify(job)));
          await writer.close();
          this.ctx.waitUntil(proc.exitCode.then((code) => this.core.runnerExited(code)));
        }
      }
      ```
- [ ] Step 3: Create `meet/worker/index.ts`:
      ```ts
      import { WorkerEntrypoint } from "cloudflare:workers";
      import type { Env } from "./env.js";
      import { handleApi, handleCallback, type RecorderApi, type Store } from "./http.js";

      export { MeetRecorder } from "./recorder.js";

      /** Durable Object RPC stubs wrap results in Rpc.* types; at runtime the shape is RecorderApi. */
      const recorderFor = (env: Env, id: string) => env.MEET_RECORDER.getByName(id) as unknown as RecorderApi;

      /** Requests from a recording's container to http://meet-recorder.internal arrive here (interceptOutboundHttp). */
      export class RecorderCallback extends WorkerEntrypoint<Env, { recordingId: string }> {
        override fetch(request: Request): Promise<Response> {
          const id = this.ctx.props.recordingId;
          const store: Store = async (key, body, contentType) => {
            await this.env.BUCKET.put(key, body, { httpMetadata: { contentType } });
          };
          return handleCallback(request, id, recorderFor(this.env, id), store);
        }
      }

      export default {
        fetch: (request, env) => handleApi(request, env.RECORDER_TOKEN, (id) => recorderFor(env, id)),
      } satisfies ExportedHandler<Env>;
      ```
- [ ] Step 4: Verify - Run: `cd meet && npm run typecheck && npx esbuild worker/index.ts --bundle --format=esm --platform=neutral --external:cloudflare:workers --outfile=dist/worker-check.js && grep -c "meetings/" dist/worker-check.js && rm dist/worker-check.js` - Expected: typecheck exits 0; esbuild prints the output size with no errors; grep prints a count of at least 1 (the shared `keys` from `src/storage/keys.ts` is bundled).
- [ ] Step 5: Commit - `git add meet/worker/env.ts meet/worker/globals.d.ts meet/worker/recorder.ts meet/worker/index.ts && git commit -m "add the meet recorder Worker and Durable Object"`


#### Task 14: Container pure logic: end rules and exact segment splitting

**Files:**
- Create: `meet/bot/rules.ts`, `meet/bot/segments.ts`
- Test: `meet/bot/rules.test.ts`, `meet/bot/segments.test.ts`

**Interfaces:**
- Consumes: `EndReason` (Track A).
- Produces (consumed by Tasks 15-16):
  ```ts
  // meet/bot/rules.ts
  export interface CallObservation { inCall: boolean; endScreen?: "removed" | "meeting_ended"; participants?: number } // participants: People button count
  export interface RuleConfig { aloneTimeoutMs: number; maxDurationMs: number; lostUiMs: number }
  export interface RuleState { recordingSince: number; aloneSince?: number; outOfCallSince?: number }
  export function nextEnd(s: RuleState, o: CallObservation, now: number, stopRequested: boolean, c: RuleConfig): EndReason | undefined;
  // meet/bot/segments.ts
  export interface FinishedSegment { index: number; path: string; samples: number }
  export class SegmentSplitter {
    constructor(dir: string, segmentSamples: number, onSegment: (s: FinishedSegment) => void);
    write(chunk: Buffer): void;
    finish(): void;
  }
  ```

The splitter cuts by byte count, not by time, so segment `i` holds exactly samples `[i * segmentSamples, (i + 1) * segmentSamples)` of the capture; that is what `buildRawTracks` in `src/pipeline/assemble.ts` assumes when it places segment `i` at `i * SEGMENT_SAMPLES`.

**Steps:**
- [ ] Step 1: Create `meet/bot/rules.ts`:
      ```ts
      import type { EndReason } from "../../src/meet/protocol.js";

      /** What the runner sees in the Meet tab at one moment. */
      export interface CallObservation {
        /** The call UI (participant tiles or the self tile) is on screen. */
        inCall: boolean;
        /** An end screen Meet shows after the bot was removed or the call ended. */
        endScreen?: "removed" | "meeting_ended";
        /** Everyone in the call including the bot (People button count); undefined when it could not be read. */
        participants?: number;
      }

      export interface RuleConfig {
        aloneTimeoutMs: number;
        maxDurationMs: number;
        /** The call UI may vanish briefly while Meet reconnects; only a longer gap ends the recording. */
        lostUiMs: number;
      }

      export interface RuleState {
        recordingSince: number;
        aloneSince?: number;
        outOfCallSince?: number;
      }

      /** Decides whether the recording ends now. Keeps its timers in `s`. */
      export function nextEnd(
        s: RuleState,
        o: CallObservation,
        now: number,
        stopRequested: boolean,
        c: RuleConfig,
      ): EndReason | undefined {
        if (stopRequested) return "stopped";
        if (o.endScreen) return o.endScreen;
        if (now - s.recordingSince >= c.maxDurationMs) return "max_duration";
        // Exactly one tile is the bot itself; 0 or unknown means the count is not trustworthy.
        s.aloneSince = o.participants === 1 ? (s.aloneSince ?? now) : undefined;
        if (s.aloneSince !== undefined && now - s.aloneSince >= c.aloneTimeoutMs) return "alone";
        s.outOfCallSince = o.inCall ? undefined : (s.outOfCallSince ?? now);
        if (s.outOfCallSince !== undefined && now - s.outOfCallSince >= c.lostUiMs) return "meeting_ended";
        return undefined;
      }
      ```
- [ ] Step 2: Create `meet/bot/rules.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { nextEnd, type CallObservation, type RuleState } from "./rules.js";

      const MIN = 60_000;
      const config = { aloneTimeoutMs: 3 * MIN, maxDurationMs: 240 * MIN, lostUiMs: 30_000 };
      const inCall = (participants?: number): CallObservation => ({ inCall: true, participants });
      const fresh = (): RuleState => ({ recordingSince: 0 });

      test("/end, removal and the end screens end the recording at once, in that priority", () => {
        assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "removed" }, 1, true, config), "stopped");
        assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "removed" }, 1, false, config), "removed");
        assert.equal(nextEnd(fresh(), { inCall: false, endScreen: "meeting_ended" }, 1, false, config), "meeting_ended");
        assert.equal(nextEnd(fresh(), inCall(5), 1, false, config), undefined);
      });

      test("the bot alone for the full timeout ends the recording; anyone coming back resets the timer", () => {
        const s = fresh();
        assert.equal(nextEnd(s, inCall(1), 10_000, false, config), undefined);
        assert.equal(nextEnd(s, inCall(1), 10_000 + 3 * MIN - 1, false, config), undefined);
        assert.equal(nextEnd(s, inCall(2), 10_000 + 3 * MIN, false, config), undefined, "someone rejoined");
        assert.equal(nextEnd(s, inCall(1), 20 * MIN, false, config), undefined);
        assert.equal(nextEnd(s, inCall(1), 23 * MIN, false, config), "alone");
      });

      test("an uncountable participant list never counts as alone", () => {
        const s = fresh();
        for (const t of [0, 5 * MIN, 10 * MIN]) {
          assert.equal(nextEnd(s, inCall(undefined), t, false, config), undefined);
          assert.equal(nextEnd(s, inCall(0), t + 1, false, config), undefined);
        }
      });

      test("the call UI gone for 30 s ends the recording, a shorter blip does not", () => {
        const s = fresh();
        assert.equal(nextEnd(s, { inCall: false }, 1_000, false, config), undefined);
        assert.equal(nextEnd(s, inCall(3), 20_000, false, config), undefined, "back after a reconnect");
        assert.equal(nextEnd(s, { inCall: false }, 40_000, false, config), undefined);
        assert.equal(nextEnd(s, { inCall: false }, 70_000, false, config), "meeting_ended");
      });

      test("the maximum duration ends even a busy call", () => {
        assert.equal(nextEnd({ recordingSince: 1_000 }, inCall(8), 1_000 + 240 * MIN, false, config), "max_duration");
      });
      ```
- [ ] Step 3: Create `meet/bot/segments.ts`:
      ```ts
      import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
      import { join } from "node:path";

      const BYTES_PER_SAMPLE = 2;

      export interface FinishedSegment {
        index: number;
        path: string;
        samples: number;
      }

      /**
       * Cuts a continuous mono s16le stream into raw files of exactly `segmentSamples` samples (the last one
       * shorter), so segment i starts at sample i * segmentSamples of the capture.
       */
      export class SegmentSplitter {
        private index = 0;
        private fd?: number;
        /** Bytes written to the segment in progress. */
        private written = 0;

        constructor(
          private readonly dir: string,
          private readonly segmentSamples: number,
          private readonly onSegment: (s: FinishedSegment) => void,
        ) {
          mkdirSync(dir, { recursive: true });
        }

        write(chunk: Buffer): void {
          const size = this.segmentSamples * BYTES_PER_SAMPLE;
          let offset = 0;
          while (offset < chunk.length) {
            this.fd ??= openSync(this.path(), "w");
            const n = Math.min(size - this.written, chunk.length - offset);
            writeSync(this.fd, chunk, offset, n);
            this.written += n;
            offset += n;
            if (this.written === size) this.close();
          }
        }

        /** Closes the segment in progress; a trailing half sample is dropped. */
        finish(): void {
          if (this.fd !== undefined) this.close();
        }

        private path(): string {
          return join(this.dir, `${String(this.index).padStart(4, "0")}.pcm`);
        }

        private close(): void {
          closeSync(this.fd!);
          this.fd = undefined;
          const segment = { index: this.index, path: this.path(), samples: Math.floor(this.written / BYTES_PER_SAMPLE) };
          this.index++;
          this.written = 0;
          if (segment.samples > 0) this.onSegment(segment);
          else unlinkSync(segment.path);
        }
      }
      ```
- [ ] Step 4: Create `meet/bot/segments.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { mkdtempSync, readFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { SegmentSplitter, type FinishedSegment } from "./segments.js";

      test("a stream arriving in odd-sized chunks is cut into segments of exactly N samples", () => {
        const dir = mkdtempSync(join(tmpdir(), "meet-segments-"));
        const done: FinishedSegment[] = [];
        const splitter = new SegmentSplitter(dir, 4, (s) => done.push(s)); // 4 samples = 8 bytes
        const stream = Buffer.from(Array.from({ length: 19 }, (_, i) => i));
        for (const [from, to] of [[0, 3], [3, 8], [8, 15], [15, 19]]) splitter.write(stream.subarray(from, to));
        assert.deepEqual(done.map((s) => [s.index, s.samples]), [[0, 4], [1, 4]]);
        splitter.finish();
        assert.deepEqual(done.map((s) => [s.index, s.samples]), [[0, 4], [1, 4], [2, 1]]);
        assert.deepEqual(readFileSync(done[0]!.path), stream.subarray(0, 8));
        assert.deepEqual(readFileSync(done[1]!.path), stream.subarray(8, 16));
        assert.deepEqual(readFileSync(done[2]!.path), stream.subarray(16, 19), "the half sample stays in the file; ffmpeg ignores it");
      });

      test("finishing exactly on a boundary emits no empty segment", () => {
        const dir = mkdtempSync(join(tmpdir(), "meet-segments-"));
        const done: FinishedSegment[] = [];
        const splitter = new SegmentSplitter(dir, 2, (s) => done.push(s));
        splitter.write(Buffer.alloc(8));
        splitter.finish();
        assert.deepEqual(done.map((s) => s.index), [0, 1]);
      });
      ```
- [ ] Step 5: Verify - Run: `cd meet && npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exits 0; `# tests 18`, `# pass 18`, `# fail 0` (8 core + 3 http + 5 rules + 2 segments).
- [ ] Step 6: Commit - `git add meet/bot/rules.ts meet/bot/rules.test.ts meet/bot/segments.ts meet/bot/segments.test.ts && git commit -m "add Meet end rules and exact segment splitting"`


#### Task 15: Humanized input and the Meet page driver

**Files:**
- Create: `meet/bot/human.ts` (port of `spike/meet-bot/human.mjs`)
- Create: `meet/bot/meet-page.ts`

There is no unit test for these two files: they drive a real Meet tab through X11, which only the deploy smoke (Task 19) and the End-to-end section can exercise.

**Interfaces:**
- Consumes: `CallObservation` (Task 14).
- Produces (consumed by Task 16):
  ```ts
  // meet/bot/human.ts
  export const sleep: (ms: number) => Promise<void>;
  export function moveTo(x: number, y: number): Promise<void>;
  export function typeText(text: string): Promise<void>;
  export function pressKey(key: string): Promise<void>;
  export function wander(ms: number): Promise<void>;
  export function humanClick(page: Page, locator: Locator): Promise<void>;
  // meet/bot/meet-page.ts
  export const CONSENT_MESSAGE: string;
  export class MeetPage {
    static open(meetUrl: string, authState?: string): Promise<MeetPage>;
    signedOut(): Promise<boolean>;
    prejoin(guestName: string | undefined): Promise<boolean>;
    waitForAdmission(timeoutMs: number, stopRequested: () => boolean): Promise<"admitted" | "denied" | "not_admitted" | "stopped">;
    observe(): Promise<CallObservation>;
    postChat(text: string): Promise<boolean>;
    leave(): Promise<boolean>;
    screenshot(): Promise<Buffer>;
    close(): Promise<void>;
  }
  ```

**Gotcha:** Meet refuses joins driven by synthetic Playwright input ("You can't join this video call" about 3 s after "Ask to join"), so every click and keystroke before admission goes through `humanClick` / `typeText` (xdotool).
After admission, `page.keyboard.insertText` is used only to put the Thai consent text into the focused chat box, because xdotool cannot type Thai reliably; the box is still focused with a humanized click and sent with a real Return key.
Admission is detected with participant tiles or `[data-self-name]` plus the absence of lobby texts, not with the "Leave call" button, which also exists in the lobby (Vexa `selectors.ts:21-29`).
After admission the "Leave call" button (counted in the DOM, so a hidden toolbar does not matter) is the main in-call signal, so a layout without tiles (screen share, spotlight) is not mistaken for the call ending.
The participant count comes only from the number on the People button; tiles are used only to see that the call UI is there, because presentation layouts hide most tiles and a tile count of 1 there would end a live call as `alone`.
If the People button cannot be read, the alone rule never fires and the recording ends by the other rules or `MEET_MAX_DURATION_MIN`; End-to-end Scenario A checks the count, including during a screen share.

**Steps:**
- [ ] Step 1: Create `meet/bot/human.ts` (a typed port of `spike/meet-bot/human.mjs`, same timings, `type` renamed `typeText`, `sleep` and `pressKey` added):
      ```ts
      import { execFile } from "node:child_process";
      import { promisify } from "node:util";
      import type { Locator, Page } from "playwright";

      // Meet refuses joins driven by synthetic Playwright input, so clicks and keystrokes go through xdotool
      // as real X11 input with human-like timing (spike/meet-bot, verified 2026-10-28).
      const run = promisify(execFile);
      const xdo = (...args: (string | number)[]) => run("xdotool", args.map(String));
      const rand = (a: number, b: number) => a + Math.random() * (b - a);
      export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      async function mousePos(): Promise<{ x: number; y: number }> {
        const { stdout } = await xdo("getmouselocation", "--shell");
        const v = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split("=")));
        return { x: Number(v.X), y: Number(v.Y) };
      }

      /** Cubic bezier with two random control points, eased, with small jitter and a slight overshoot. */
      export async function moveTo(x: number, y: number): Promise<void> {
        const from = await mousePos();
        const dist = Math.hypot(x - from.x, y - from.y);
        const steps = Math.max(12, Math.round(dist / rand(12, 20)));
        const bend = () => rand(-0.3, 0.3) * dist;
        const c1 = { x: from.x + (x - from.x) * 0.3 + bend(), y: from.y + (y - from.y) * 0.3 + bend() };
        const c2 = { x: from.x + (x - from.x) * 0.7 + bend(), y: from.y + (y - from.y) * 0.7 + bend() };
        const over = { x: x + rand(-6, 6), y: y + rand(-4, 4) };
        for (let i = 1; i <= steps; i++) {
          const t0 = i / steps;
          const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2;
          const u = 1 - t;
          const px = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * over.x;
          const py = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * over.y;
          await xdo("mousemove", "--sync", Math.round(px + rand(-1, 1)), Math.round(py + rand(-1, 1)));
          await sleep(rand(6, 18));
        }
        await sleep(rand(60, 140));
        await xdo("mousemove", "--sync", Math.round(x), Math.round(y));
      }

      async function click(): Promise<void> {
        await sleep(rand(80, 200));
        await xdo("mousedown", 1);
        await sleep(rand(50, 120));
        await xdo("mouseup", 1);
      }

      export async function typeText(text: string): Promise<void> {
        await sleep(rand(200, 400));
        for (const ch of text) {
          await xdo("type", "--clearmodifiers", "--", ch);
          await sleep(rand(70, 220));
        }
      }

      export async function pressKey(key: string): Promise<void> {
        await sleep(rand(80, 200));
        await xdo("key", "--clearmodifiers", key);
      }

      export async function wander(ms: number): Promise<void> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          await moveTo(rand(200, 1080), rand(150, 600));
          await sleep(rand(800, 2500));
        }
      }

      /** Screen point for a locator: viewport box + window chrome offset, a random point near the center. */
      async function screenPoint(page: Page, locator: Locator): Promise<{ x: number; y: number }> {
        const box = await locator.boundingBox();
        if (!box) throw new Error("element has no box");
        const o = await page.evaluate(() => ({
          x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
          y: window.screenY + (window.outerHeight - window.innerHeight),
        }));
        return {
          x: o.x + box.x + box.width / 2 + rand(-box.width / 6, box.width / 6),
          y: o.y + box.y + box.height / 2 + rand(-box.height / 6, box.height / 6),
        };
      }

      export async function humanClick(page: Page, locator: Locator): Promise<void> {
        const p = await screenPoint(page, locator);
        await moveTo(p.x, p.y);
        await click();
      }
      ```
- [ ] Step 2: Create `meet/bot/meet-page.ts`:
      ```ts
      import { chromium, type Browser, type Page } from "playwright";
      import { humanClick, moveTo, pressKey, sleep, typeText, wander } from "./human.js";
      import type { CallObservation } from "./rules.js";

      /** Posted in the Meet chat right after the bot is let in (consent / PDPA). */
      export const CONSENT_MESSAGE =
        "🔴 บอทนี้กำลังบันทึกเสียงการประชุมเพื่อจัดทำบันทึกการประชุม (This call is being recorded to write meeting minutes.)";
      const CONSENT_PROBE = "This call is being recorded";

      // Meet's en-US UI texts, adapted from Vexa (Apache-2.0):
      // core/meetings/modules/join/src/googlemeet/selectors.ts and admission.ts.
      const WAITING = [
        /asking to be let in/i,
        /you.ll join the call when someone lets you in/i,
        /please wait until a meeting host brings you into the call/i,
        /waiting for the host to let you in/i,
      ];
      const DENIED = [
        /denied your request/i,
        /your request to join was denied/i,
        /you were denied/i,
        /weren.t allowed to join/i,
        /not allowed to join/i,
        /can.t join this video call/i,
        /can.t join this call/i,
        /meeting not found/i,
      ];
      const REMOVED = [/you.ve been removed from the meeting/i];
      const ENDED = [
        /the call ended because everyone left/i,
        /your host ended the meeting for everyone/i,
        /^meeting ended$/i,
        /^call ended$/i,
        /you left the meeting/i,
      ];
      /** Meet also renders a tile for the "Backgrounds and effects" preview; it is not a person. */
      const PHANTOM_TILE = "visual_effects|backgrounds and effects";

      const LAUNCH_ARGS = [
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,720",
        "--window-position=0,0",
        "--lang=en-US",
        "--disable-dev-shm-usage",
      ];

      /** One headful Chromium tab on a Google Meet call, driven like a person would. */
      export class MeetPage {
        private constructor(
          private readonly browser: Browser,
          private readonly page: Page,
        ) {}

        static async open(meetUrl: string, authState?: string): Promise<MeetPage> {
          const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
          const context = await browser.newContext({
            ...(authState ? { storageState: JSON.parse(authState) } : {}),
            locale: "en-US",
            viewport: null,
            permissions: ["microphone", "camera"],
          });
          const page = await context.newPage();
          // Container Chromium sometimes fails the first navigation with ERR_NETWORK_CHANGED.
          for (let attempt = 1; ; attempt++) {
            try {
              await page.goto(`${meetUrl}?hl=en`, { waitUntil: "domcontentloaded" });
              break;
            } catch (err) {
              if (attempt >= 3 || !String(err).includes("ERR_NETWORK_CHANGED")) throw err;
              await sleep(2_000);
            }
          }
          await sleep(5_000);
          return new MeetPage(browser, page);
        }

        /** With a bot account session: Google sent us to sign in, or Meet offers the guest name field. */
        async signedOut(): Promise<boolean> {
          return this.page.url().includes("accounts.google.com") || (await this.page.getByPlaceholder(/your name/i).count()) > 0;
        }

        /** Looks around like a person, mutes, types the guest name if needed, and asks to join. False when Meet offers no join button. */
        async prejoin(guestName: string | undefined): Promise<boolean> {
          await wander(12_000);
          const gotIt = this.page.getByRole("button", { name: /^(got it|dismiss)$/i });
          if (await gotIt.count()) await humanClick(this.page, gotIt.first());
          for (const name of [/turn off microphone/i, /turn off camera/i]) {
            const toggle = this.page.getByRole("button", { name });
            if (await toggle.count()) await humanClick(this.page, toggle.first());
          }
          if (guestName) {
            const input = this.page.getByPlaceholder(/your name/i);
            if (await input.count()) {
              await humanClick(this.page, input.first());
              await typeText(guestName);
            }
          }
          const join = this.page.getByRole("button", { name: /(ask to join|join now)/i });
          if (!(await join.count())) return false;
          await wander(3_600);
          await humanClick(this.page, join.first());
          return true;
        }

        async waitForAdmission(
          timeoutMs: number,
          stopRequested: () => boolean,
        ): Promise<"admitted" | "denied" | "not_admitted" | "stopped"> {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (stopRequested()) return "stopped";
            if (await this.anyVisible(DENIED)) return "denied";
            if (!(await this.anyVisible(WAITING)) && (await this.admittedUi())) return "admitted";
            await sleep(2_000);
          }
          return "not_admitted";
        }

        async observe(): Promise<CallObservation> {
          if (await this.anyVisible(REMOVED)) return { inCall: false, endScreen: "removed" };
          if (await this.anyVisible(ENDED)) return { inCall: false, endScreen: "meeting_ended" };
          // Only the People button count feeds the alone rule: tiles undercount in presentation layouts, and a false
          // "alone" would cut a live meeting short, while a missed one only costs container time until the limit.
          return { inCall: await this.stillInCall(), participants: await this.peopleCount() };
        }

        /** Opens the chat, posts `text`, and closes the chat again. True when the message shows in the chat. */
        async postChat(text: string): Promise<boolean> {
          try {
            await this.wakeToolbar();
            const open = this.page.getByRole("button", { name: /chat with everyone/i }).first();
            await humanClick(this.page, open);
            const box = this.page.getByRole("textbox", { name: /send a message/i }).first();
            await box.waitFor({ timeout: 10_000 });
            await humanClick(this.page, box);
            await this.page.keyboard.insertText(text);
            await pressKey("Return");
            await sleep(1_500);
            const posted = (await this.page.getByText(CONSENT_PROBE).count()) > 0;
            await humanClick(this.page, open); // close the panel so the tiles stay countable
            return posted;
          } catch {
            return false;
          }
        }

        /** Clicks "Leave call" like a person and checks the bot is out. */
        async leave(): Promise<boolean> {
          for (let attempt = 0; attempt < 2; attempt++) {
            await this.wakeToolbar();
            const leave = this.page.getByRole("button", { name: /^leave call$/i });
            if (await leave.count()) await humanClick(this.page, leave.first()).catch(() => {});
            const justLeave = this.page.getByRole("button", { name: /just leave the (meeting|call)/i });
            if (await justLeave.count()) await humanClick(this.page, justLeave.first()).catch(() => {});
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
              if ((await this.anyVisible([/you left the meeting/i])) || !(await this.stillInCall())) return true;
              await sleep(1_000);
            }
          }
          return false;
        }

        screenshot(): Promise<Buffer> {
          return this.page.screenshot();
        }

        async close(): Promise<void> {
          await this.browser.close();
        }

        /** Only valid in the lobby phase: tiles or the self tile, never the Leave button (the lobby has one too). */
        private async admittedUi(): Promise<boolean> {
          return (await this.participantTiles()) > 0 || (await this.selfTile());
        }

        /** After admission: the Leave button is in the DOM (even while the toolbar is hidden), or tiles are. */
        private async stillInCall(): Promise<boolean> {
          return (await this.page.locator('button[aria-label="Leave call"]').count()) > 0 || (await this.admittedUi());
        }

        /** The number Meet shows on the People button (everyone in the call, the bot included). */
        private peopleCount(): Promise<number | undefined> {
          return this.page.evaluate(() => {
            const button = document.querySelector('button[aria-label^="People"], button[aria-label*="Show everyone"]');
            const digits = (button?.textContent ?? "").match(/\d+/)?.[0] ?? button?.getAttribute("aria-label")?.match(/\d+/)?.[0];
            const n = Number(digits);
            return Number.isInteger(n) && n > 0 ? n : undefined;
          });
        }

        private async selfTile(): Promise<boolean> {
          return (await this.page.locator("[data-self-name]").count()) > 0;
        }

        /** Distinct participant ids on screen; the effects preview tile is skipped. */
        private participantTiles(): Promise<number> {
          return this.page.evaluate((phantom) => {
            const re = new RegExp(phantom, "i");
            const ids = [...document.querySelectorAll("[data-participant-id]")]
              .filter((el) => !re.test(`${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`))
              .map((el) => el.getAttribute("data-participant-id"));
            return new Set(ids).size;
          }, PHANTOM_TILE);
        }

        /** The call toolbar hides after a while; moving the mouse near it shows it again. */
        private async wakeToolbar(): Promise<void> {
          await moveTo(540 + Math.random() * 200, 640);
        }

        private async anyVisible(patterns: RegExp[]): Promise<boolean> {
          for (const p of patterns) {
            if (await this.page.getByText(p).first().isVisible().catch(() => false)) return true;
          }
          return false;
        }
      }
      ```
- [ ] Step 3: Verify - Run: `cd meet && npm run typecheck` - Expected: exit 0 for both tsconfigs.
- [ ] Step 4: Commit - `git add meet/bot/human.ts meet/bot/meet-page.ts && git commit -m "add the Meet page driver with humanized input"`

#### Task 16: Callback client, audio capture, and the runner

**Files:**
- Create: `meet/bot/callback.ts`, `meet/bot/capture.ts`, `meet/bot/runner.ts`

**Interfaces:**
- Consumes: `CALLBACK_HOST`, `RecordingJob`, `RecordingEnd`, `RunnerEvent`, `EventReply`, `EndReason` (Track A); `SegmentSplitter` (Task 14); `MeetPage`, `CONSENT_MESSAGE`, `sleep` (Task 15); `nextEnd` (Task 14).
- Produces: `dist/runner.mjs` (via `build:bot`), the program `entrypoint.sh` execs with the job on stdin; it exits after sending `ended`.
  ```ts
  // meet/bot/callback.ts
  export function sendEvent(e: RunnerEvent): Promise<EventReply>;
  export function uploadSegment(index: number, samples: number, flacPath: string): Promise<void>;
  export function uploadDebug(name: string, png: Buffer): Promise<void>;
  // meet/bot/capture.ts
  export interface Capture { readonly startedAt: number; readonly alive: boolean; stop(): Promise<void> }
  export function startCapture(dir: string, job: Pick<RecordingJob, "sampleRate" | "segmentSamples">): Capture;
  ```

**Gotcha:** the runner never writes to stdout (the Durable Object runs it with `stdout: "ignore"`); everything worth knowing travels as events, which the Durable Object logs.
`process.exit(0)` at the end is required: the exec, and therefore the container, ends only when the runner process exits.

**Steps:**
- [ ] Step 1: Create `meet/bot/callback.ts`:
      ```ts
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
      ```
- [ ] Step 2: Create `meet/bot/capture.ts`:
      ```ts
      import { execFile, spawn } from "node:child_process";
      import { rmSync } from "node:fs";
      import { promisify } from "node:util";
      import type { RecordingJob } from "../../src/meet/protocol.js";
      import { uploadSegment } from "./callback.js";
      import { SegmentSplitter, type FinishedSegment } from "./segments.js";

      const run = promisify(execFile);

      export interface Capture {
        /** Epoch ms of the first captured sample; the meeting timeline starts here. */
        readonly startedAt: number;
        /** False once ffmpeg stopped on its own. */
        readonly alive: boolean;
        /** Stops capturing and resolves when every segment is uploaded (or failed). */
        stop(): Promise<void>;
      }

      /**
       * Records the PulseAudio sink Chromium plays Meet into, as 24 kHz mono segments of exactly
       * job.segmentSamples, each sent to R2 as FLAC while the call goes on.
       */
      export function startCapture(dir: string, job: Pick<RecordingJob, "sampleRate" | "segmentSamples">): Capture {
        let chain = Promise.resolve();
        const splitter = new SegmentSplitter(dir, job.segmentSamples, (s) => {
          chain = chain.then(() => encodeAndUpload(s, job.sampleRate));
        });
        const startedAt = Date.now();
        const ff = spawn(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "meet.monitor", "-ac", "1", "-ar", String(job.sampleRate), "-f", "s16le", "pipe:1"],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let alive = true;
        let stopping = false;
        ff.stdout.on("data", (chunk: Buffer) => splitter.write(chunk));
        ff.on("error", () => {}); // a failed spawn also emits "close", which marks the capture dead
        const exited = new Promise<void>((resolve) =>
          ff.once("close", () => {
            alive = stopping;
            resolve();
          }),
        );
        return {
          startedAt,
          get alive() {
            return alive;
          },
          async stop() {
            stopping = true;
            ff.kill("SIGTERM");
            await exited;
            splitter.finish();
            await chain;
          },
        };
      }

      async function encodeAndUpload(s: FinishedSegment, sampleRate: number): Promise<void> {
        const flac = `${s.path}.flac`;
        try {
          await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", s.path, "-c:a", "flac", flac]);
          await uploadSegment(s.index, s.samples, flac);
        } catch {
          // The segment is lost; the Durable Object's segment list shows the gap and the pipeline skips it.
        } finally {
          rmSync(s.path, { force: true });
          rmSync(flac, { force: true });
        }
      }
      ```
- [ ] Step 3: Create `meet/bot/runner.ts`:
      ```ts
      /**
       * Container entry for one Google Meet recording. Reads the RecordingJob from stdin, joins the call,
       * records it, and reports to its Durable Object through http://meet-recorder.internal.
       */
      import type { EndReason, RecordingEnd, RecordingJob } from "../../src/meet/protocol.js";
      import { sendEvent, uploadDebug } from "./callback.js";
      import { startCapture } from "./capture.js";
      import { sleep } from "./human.js";
      import { CONSENT_MESSAGE, MeetPage } from "./meet-page.js";
      import { nextEnd, type CallObservation, type RuleState } from "./rules.js";

      const GUEST_NAME = "Meeting Minutes Bot";
      const HEARTBEAT_MS = 5_000;
      const OBSERVE_MS = 2_000;
      const LOST_UI_MS = 30_000;
      const SEGMENT_DIR = "/work/segments";
      /** Ends where a screenshot shows what Meet displayed. */
      const FAILURES: EndReason[] = ["not_admitted", "denied", "auth_expired", "join_failed", "crashed"];

      let stopRequested = false;
      let participants: number | undefined;

      async function readStdin(): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      }

      async function attend(page: MeetPage, job: RecordingJob): Promise<RecordingEnd> {
        if (job.authState && (await page.signedOut())) return { reason: "auth_expired", leftCleanly: true };
        if (!(await page.prejoin(job.authState ? undefined : GUEST_NAME))) {
          return { reason: "join_failed", detail: "no join button", leftCleanly: true };
        }
        stopRequested ||= (await sendEvent({ type: "waiting" })).stop;
        const admission = await page.waitForAdmission(job.admitTimeoutMs, () => stopRequested);
        if (admission !== "admitted") return { reason: admission, leftCleanly: true };

        // The notice goes up before the first sample is recorded (consent / PDPA).
        const consentPosted = await page.postChat(CONSENT_MESSAGE);
        const capture = startCapture(SEGMENT_DIR, job);
        stopRequested ||= (await sendEvent({ type: "recording", captureStartedAt: capture.startedAt, consentPosted })).stop;

        const state: RuleState = { recordingSince: capture.startedAt };
        const rules = { aloneTimeoutMs: job.aloneTimeoutMs, maxDurationMs: job.maxDurationMs, lostUiMs: LOST_UI_MS };
        let reason: EndReason | undefined;
        let detail: string | undefined;
        // Whatever happens in the loop or while leaving, the open segment is flushed and uploaded before "ended" goes out.
        try {
          while (!reason) {
            await sleep(OBSERVE_MS);
            if (!capture.alive) {
              reason = "crashed";
              detail = "audio capture stopped";
              break;
            }
            // Meet re-renders can make page.evaluate throw; treat that moment as "call UI not seen" and let the 30 s rule decide.
            const seen = await page.observe().catch((): CallObservation => ({ inCall: false }));
            participants = seen.participants;
            reason = nextEnd(state, seen, Date.now(), stopRequested, rules);
          }
          const leftCleanly = reason === "removed" || reason === "meeting_ended" ? true : await page.leave().catch(() => false);
          return detail ? { reason, detail, leftCleanly } : { reason, leftCleanly };
        } finally {
          await capture.stop();
        }
      }

      async function main(): Promise<void> {
        const job = JSON.parse(await readStdin()) as RecordingJob;
        process.once("SIGTERM", () => {
          stopRequested = true;
        });
        const beat = setInterval(() => {
          sendEvent({ type: "heartbeat", participants }).then(
            (reply) => {
              stopRequested ||= reply.stop;
            },
            () => {},
          );
        }, HEARTBEAT_MS);

        let page: MeetPage | undefined;
        let end: RecordingEnd;
        try {
          stopRequested ||= (await sendEvent({ type: "joining" })).stop;
          if (stopRequested) {
            end = { reason: "stopped", leftCleanly: true }; // the bot gave up on this start before the container came up
          } else {
            page = await MeetPage.open(job.meetUrl, job.authState);
            end = await attend(page, job);
          }
        } catch (err) {
          end = { reason: "crashed", detail: String((err as Error)?.message ?? err).slice(0, 300), leftCleanly: false };
        }
        clearInterval(beat);
        if (page && FAILURES.includes(end.reason)) {
          await page
            .screenshot()
            .then((png) => uploadDebug("failure.png", png))
            .catch(() => {});
        }
        await sendEvent({ type: "ended", ...end }).catch(() => {});
        await page?.close().catch(() => {});
      }

      await main();
      process.exit(0);
      ```
- [ ] Step 4: Verify - Run: `cd meet && npm run typecheck && npx esbuild bot/runner.ts --bundle --platform=node --target=node22 --format=esm --external:playwright --outfile=dist/runner.mjs && node --check dist/runner.mjs && echo BUNDLE_OK` - Expected: typecheck exits 0; esbuild writes `dist/runner.mjs`; last line `BUNDLE_OK`.
- [ ] Step 5: Commit - `git add meet/bot/callback.ts meet/bot/capture.ts meet/bot/runner.ts && git commit -m "add the Meet recording runner"`


#### Task 17: Container image, entrypoint, and the one-time `meet:login`

**Files:**
- Create: `meet/bot/login.ts` (port of `spike/meet-bot/login.mjs`)
- Create: `meet/Dockerfile`, `meet/entrypoint.sh`, `meet/.dockerignore`

**Interfaces:**
- Consumes: `dist/runner.mjs` and `dist/login.mjs` from `npm run build:bot` (Task 10 script, Task 16 runner).
- Produces: image entrypoint `/app/entrypoint.sh` (no argument: recording run reading the job from stdin; `login`: noVNC sign-in on port 6080 writing `/out/meet-auth.json`); local tag `meet-recorder:local`.

**Gotcha:** wrangler and podman both read only `meet/.dockerignore` for this context; it is an allowlist so `auth/` (a real Google session) and `node_modules` can never enter the image.
`npm run image:local` builds for the host architecture (arm64 on this Mac) for `meet:login`; the Cloudflare image is built for `linux/amd64` in Task 19.

**Steps:**
- [ ] Step 1: Create `meet/bot/login.ts` (a typed port of `spike/meet-bot/login.mjs`):
      ```ts
      import { spawn } from "node:child_process";
      import { chromium } from "playwright";

      // Sign-in runs in a plain Chromium process with no automation attached, because Google refuses sign-in from
      // automated browsers. Playwright opens the profile only afterwards, to export the session.
      const profileDir = "/out/meet-profile";
      const statePath = "/out/meet-auth.json";
      const commonArgs = ["--password-store=basic", "--no-first-run", "--lang=en-US", "--window-position=0,0", "--window-size=1280,720"];

      console.log("Open http://localhost:6080/vnc.html, sign in to the bot Google account, then close Chromium.");
      const browser = spawn(chromium.executablePath(), [`--user-data-dir=${profileDir}`, ...commonArgs, "--no-sandbox", "https://accounts.google.com/"], {
        stdio: "ignore",
      });
      await new Promise((resolve) => browser.on("exit", resolve));

      const context = await chromium.launchPersistentContext(profileDir, { headless: true, args: commonArgs });
      await context.storageState({ path: statePath });
      const page = await context.newPage();
      await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
      const signedIn = !page.url().includes("accounts.google.com");
      await context.close();
      console.log(
        signedIn
          ? `RESULT signed in, saved ${statePath}. Copy it to the bot server (MEET_AUTH_STATE_FILE) and delete auth/meet-profile.`
          : "RESULT not signed in (redirected to accounts.google.com)",
      );
      process.exit(signedIn ? 0 : 1);
      ```
- [ ] Step 2: Create `meet/Dockerfile`:
      ```dockerfile
      FROM mcr.microsoft.com/playwright:v1.64.1-noble

      RUN apt-get update \
       && apt-get install -y --no-install-recommends pulseaudio xvfb ffmpeg xdotool x11vnc novnc websockify \
       && rm -rf /var/lib/apt/lists/*

      WORKDIR /app
      # The base image already holds the browsers for this exact Playwright version.
      ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
      COPY package.json package-lock.json ./
      RUN npm ci --omit=dev
      COPY dist/runner.mjs dist/login.mjs ./dist/
      COPY entrypoint.sh ./
      RUN chmod +x entrypoint.sh && mkdir -p /work /out

      ENTRYPOINT ["/app/entrypoint.sh"]
      ```
- [ ] Step 3: Create `meet/entrypoint.sh`:
      ```bash
      #!/bin/bash
      set -e
      export DISPLAY=:99
      export XDG_RUNTIME_DIR=/tmp/xdg
      mkdir -p "$XDG_RUNTIME_DIR" /work

      # Background daemons must not hold this script's stdin or stdout: the runner reads its job from stdin,
      # and an inherited stdout keeps an exec stream open forever.
      Xvfb :99 -screen 0 1280x720x24 -nolisten tcp </dev/null >/dev/null 2>&1 &

      if [ "$1" = "login" ]; then
        sleep 1
        x11vnc -display :99 -forever -nopw -quiet -rfbport 5900 </dev/null >/dev/null 2>&1 &
        websockify --web /usr/share/novnc 6080 localhost:5900 </dev/null >/dev/null 2>&1 &
        exec node /app/dist/login.mjs
      fi

      pulseaudio --start --exit-idle-time=-1 --daemonize=yes --disallow-exit </dev/null >/dev/null 2>&1
      # Chromium plays the call into "meet"; the runner records meet.monitor.
      pactl load-module module-null-sink sink_name=meet sink_properties=device.description=meet >/dev/null
      # The default microphone is a silent sink's monitor, so the bot can never send the call audio back into the call.
      pactl load-module module-null-sink sink_name=mic sink_properties=device.description=mic >/dev/null
      pactl set-default-sink meet
      pactl set-default-source mic.monitor
      exec node /app/dist/runner.mjs
      ```
      and `chmod +x meet/entrypoint.sh` (git keeps the mode).
- [ ] Step 4: Create `meet/.dockerignore`:
      ```
      # Allowlist: only what the image needs. auth/ holds a real Google session and must never be sent.
      *
      !package.json
      !package-lock.json
      !dist/runner.mjs
      !dist/login.mjs
      !entrypoint.sh
      ```
- [ ] Step 5: Verify - Run: `cd meet && npm run image:local && podman run --rm --entrypoint bash meet-recorder:local -c 'ls /app/dist; node -p "require(\"/app/node_modules/playwright/package.json\").version"; for b in Xvfb pulseaudio pactl ffmpeg xdotool x11vnc websockify; do command -v $b >/dev/null || echo MISSING $b; done; test ! -e /app/auth && echo NO_AUTH_IN_IMAGE'` - Expected: build succeeds; output lists `login.mjs` and `runner.mjs`, then `1.64.1`, no `MISSING` line, and `NO_AUTH_IN_IMAGE`.
- [ ] Step 6: Commit - `git add meet/bot/login.ts meet/Dockerfile meet/entrypoint.sh meet/.dockerignore && git commit -m "add the meet recorder container image and login flow"`

---

### Track D - integration (main checkout, after Tracks B and C are merged)

#### Task 18: Docs and the VPS session mount

**Files:**
- Modify: `docker-compose.yml` (anchor: `- meeting-data:/data`, ~L10)
- Modify: `README.md` (add a `## Google Meet recording` section before `## Things to know`; add a `/record-meet` row to the `## Commands` table; add the two new R2 paths to `## Files in R2`)
- Modify: `AGENTS.md` (anchors: `## Project overview`, `## Build and test commands`, `## Architecture map`, `## Gotchas`)

**Interfaces:**
- Consumes: everything above.
- Produces: operator documentation that Task 19 and the user follow.

**Steps:**
- [ ] Step 1: In `docker-compose.yml` add under `volumes:` of the service:
      ```yaml
            # Bot Google account session for /record-meet (MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json).
            - ./secrets:/run/secrets/meet:ro
      ```
- [ ] Step 2: In `README.md` add `## Google Meet recording` with these facts, one sentence per line:
      - `/record-meet url:<link>` sends a bot into a Google Meet call; it posts the same minutes, PIN page, and `#meeting-of-minutes` message as `/record`.
      - The recorder runs on Cloudflare Containers (`meet/`): a Worker, one Durable Object per recording, and a Playwright Chromium container (standard-2, about $0.08 per recording hour, at most 2 at a time).
      - The bot announces the recording in the Discord channel and posts a Thai/English notice in the Meet chat.
      - The audio is one mixed track, so the transcript has no speaker names and the page has no per-speaker files.
      - It ends on `/end`, when only the bot is left for `EMPTY_CHANNEL_TIMEOUT_MIN`, when the bot is removed or the call ends, or after `MEET_MAX_DURATION_MIN`.
      - Setup, numbered: (1) `cd meet && npm ci`; (2) `npm run meet:login`, open `http://localhost:6080/vnc.html`, sign in to the bot Google account, close Chromium, and find the session in `meet/auth/meet-auth.json`; (3) deploy as in the next list; (4) `npx wrangler secret put RECORDER_TOKEN -c wrangler.deploy.jsonc` with the output of `openssl rand -base64 48`; (5) on the VPS set `MEET_RECORDER_URL`, `MEET_RECORDER_TOKEN` (same value), `MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json`, copy the session to `./secrets/meet-auth.json` with `chown 1000:1000` and `chmod 600`, then `docker compose up -d --build` and `docker compose exec meeting-bot node dist/register-commands.js`.
      - Deploy from podman, numbered: `npm run build:bot`; `TAG=$(git rev-parse --short HEAD)`; `podman build --platform linux/amd64 -t everymeet-meet-recorder:$TAG .`; `WRANGLER_DOCKER_BIN=podman npx wrangler containers push everymeet-meet-recorder:$TAG` (prints `registry.cloudflare.com/<account-id>/everymeet-meet-recorder:<tag>`); write `wrangler.deploy.jsonc` as a copy of `wrangler.jsonc` whose `image` is that registry tag (the file is gitignored because it holds the account id); `npx wrangler deploy -c wrangler.deploy.jsonc`.
      - Why the registry tag: with podman, `wrangler deploy` on the Dockerfile fails on `--provenance=false`, and after a push the rollout can fail with `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE` because wrangler reads the digest from podman's local store.
      - A new deploy needs about a minute before containers start ("no container instance available" until then).
      - Logs: `npx wrangler tail everymeet-meet-recorder` shows one JSON line per recorder event; a failed join leaves `meetings/<id>/debug/failure.png` in R2.
      - When the session expires the bot says so in Discord; run step (2) again and replace the file on the VPS (no restart needed, it is read on every `/record-meet`).
      - `failure.png` can show participants' names, faces, and chat, so the R2 lifecycle rule should delete `meetings/*/debug/` together with `meetings/*/segments/` (about 30 days, PDPA).
      Commands table row: `| /record-meet url:<link> | anyone | sends the bot into a Google Meet call and records it |`.
      Files in R2 additions: `meetings/<id>/segments/meet/*.flac  5-min Google Meet segments` and `meetings/<id>/debug/failure.png  screenshot when a Meet join fails`.
- [ ] Step 3: In `AGENTS.md`:
      - Project overview: add one paragraph: "`/record-meet` records a Google Meet call instead: the recorder runs on Cloudflare Containers (`meet/`), uploads 5-minute FLAC segments to R2 through its Durable Object, and the bot polls it and feeds the same pipeline with one mixed pseudo-participant `meet`."
      - Build and test commands: add `cd meet && npm ci && npm run typecheck && npm test   # the meet-recorder package (Worker + container)` and `cd meet && npm run meet:login   # one-time bot Google account sign-in (podman)`; the quality-gate bullet becomes "Run `npm run typecheck` and `npm test` (root) and, when `meet/` or `src/meet/protocol.ts` / `src/storage/keys.ts` changed, the same two in `meet/`".
      - Architecture map rows: `| src/meet/ | Google Meet side of the bot: MeetSession (poll, Discord messages, manifest), recorder client, VAD, link parsing, shared protocol.ts |`, `| src/recorder/active.ts | One active recording per guild across Discord and Meet |`, `| src/storage/keys.ts | R2 key builders, import-free so the Worker can bundle them |`, `| meet/ | Separate npm package: Cloudflare Worker + Durable Object (worker/) and the Playwright container runner (bot/) |`.
      - Gotchas: "Meet DOM texts and selectors live only in `meet/bot/meet-page.ts`; when joins or end detection break after a Meet UI change, start from `failure.png` in R2 and the `wrangler tail` events.", "`src/meet/protocol.ts` and `src/storage/keys.ts` are bundled into the Worker and the container: keep them free of imports.", and in Security considerations extend the R2 lifecycle bullet to `meetings/*/debug/` (Meet failure screenshots can show people).
- [ ] Step 4: Verify - Run: `grep -c "record-meet" README.md AGENTS.md && grep -n "secrets" docker-compose.yml && node -e 'const fs = require("fs"); for (const f of ["README.md", "AGENTS.md"]) if (fs.readFileSync(f, "utf8").includes("\u2014")) { console.log("EM_DASH in " + f); process.exit(1); } console.log("NO_EM_DASH")'` - Expected: both counts at least 1; the compose line `- ./secrets:/run/secrets/meet:ro` is printed; last line `NO_EM_DASH`.
- [ ] Step 5: Commit - `git add docker-compose.yml README.md AGENTS.md && git commit -m "document Google Meet recording"`


#### Task 19: Deploy the recorder and smoke-test the container callback path on Cloudflare

**Files:**
- Create (gitignored, never committed): `meet/wrangler.deploy.jsonc`, `meet/auth/recorder-token`

**Interfaces:**
- Consumes: the merged tree; `meet/auth/meet-auth.json` (bot account session from `npm run meet:login`).
- Produces: deployed Worker `everymeet-meet-recorder` with secret `RECORDER_TOKEN`; its workers.dev origin (`<WORKER_URL>`) for `MEET_RECORDER_URL`.

**Gotcha:** Task 0 proved the bare transport; this is the first run of the real Worker, Durable Object, and runner together, so Step 4 is the gate before anyone uses `/record-meet`.
Never print `meet/auth/meet-auth.json` or the token; pass them with `--rawfile` / `$(cat ...)` only.

**Rollback:** `cd meet && npx wrangler delete -c wrangler.deploy.jsonc` removes the Worker and its Durable Objects; remove the container application with `npx wrangler containers list` then `npx wrangler containers delete <ID>`; delete smoke objects with `npx wrangler r2 object delete meeting-recordings/meetings/<SMOKE_ID>/segments/meet/0000.flac --remote` (and `.../debug/failure.png` if it exists).

**Steps:**
- [ ] Step 1: Preconditions (STOP and ask the user if any fails) - `cd meet && npx wrangler whoami | grep -ci "logged in"` prints at least 1; `test -s auth/meet-auth.json && echo SESSION_PRESENT` prints `SESSION_PRESENT` (if not: 👤 the user runs `npm run meet:login` and signs in through `http://localhost:6080/vnc.html`, because typing Google credentials is a person's job); `podman info >/dev/null && echo PODMAN_UP`.
- [ ] Step 2: Build and push the amd64 image:
      ```bash
      cd meet
      npm run build:bot
      TAG=$(git rev-parse --short HEAD)
      podman build --platform linux/amd64 -t everymeet-meet-recorder:$TAG .
      WRANGLER_DOCKER_BIN=podman npx wrangler containers push everymeet-meet-recorder:$TAG
      ```
      Copy the printed `registry.cloudflare.com/<account-id>/everymeet-meet-recorder:<tag>` into `meet/wrangler.deploy.jsonc`, a copy of `wrangler.jsonc` with only the `image` value changed.
      If `containers push` itself fails on podman, use the provenance shim from the global memory "Cellar deploy on podman" (a script that drops `--provenance*` arguments and execs podman, set as `WRANGLER_DOCKER_BIN`).
- [ ] Step 3: Deploy and set the secret:
      ```bash
      npx wrangler deploy -c wrangler.deploy.jsonc
      mkdir -p auth && (umask 077 && openssl rand -base64 48 > auth/recorder-token)
      npx wrangler secret put RECORDER_TOKEN -c wrangler.deploy.jsonc < auth/recorder-token
      ```
      Note the workers.dev URL printed by the deploy as `<WORKER_URL>`, then wait 60 s (a new container app needs about a minute).
- [ ] Step 4: Verify - Manual: live smoke against the test room (the user allows the bot to join it any time), in a second terminal `npx wrangler tail everymeet-meet-recorder --format json` running:
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' <WORKER_URL>/recordings/smoke-x
      curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $(cat auth/recorder-token)" <WORKER_URL>/recordings/smoke-x
      SMOKE_ID=smoke-$(date +%s)
      jq -n --rawfile auth auth/meet-auth.json '{meetUrl:"https://meet.google.com/jku-cpry-bcg", authState:$auth, sampleRate:24000, segmentSamples:7200000, admitTimeoutMs:300000, aloneTimeoutMs:180000, maxDurationMs:600000}' \
        | curl -s -w '%{http_code}\n' -X POST -H "authorization: Bearer $(cat auth/recorder-token)" -H 'content-type: application/json' --data @- <WORKER_URL>/recordings/$SMOKE_ID
      # poll every 10 s until "state":"recording" (at most 3 minutes), wait 60 s more, then:
      curl -s -X POST -H "authorization: Bearer $(cat auth/recorder-token)" <WORKER_URL>/recordings/$SMOKE_ID/stop -w '%{http_code}\n'
      # poll every 10 s until "state":"ended" (at most 2 minutes)
      curl -s -H "authorization: Bearer $(cat auth/recorder-token)" <WORKER_URL>/recordings/$SMOKE_ID
      npx wrangler r2 object get meeting-recordings/meetings/$SMOKE_ID/segments/meet/0000.flac --remote --file /tmp/smoke.flac
      ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/smoke.flac
      ```
      Expected: the two auth checks print `401` then `404`; start prints `202`; the tail shows events `joining`, `waiting`, `recording` (with `consentPosted`), heartbeats every ~5 s, `stop requested`, `segment` (index 0), `ended` with `reason: "stopped"`, then `destroy`; the final status has `"state":"ended"`, `"end":{"reason":"stopped","leftCleanly":true}` and one segment whose `samples / 24000` equals the ffprobe duration within 0.1 s; the Meet chat of the test room shows the consent notice.
      If no event ever arrives (the state stays `starting` until `container_lost`) or the segment upload fails, STOP: the `interceptOutboundHttp` path does not work in production, and the transport has to be re-decided with the user (see Failure handling).
- [ ] Step 5: Clean up the smoke objects (Rollback line, R2 part) and note `<WORKER_URL>` for the End-to-end section.
  No commit (all files of this task are gitignored).

## Failure handling summary

- **Container callbacks never reach the Durable Object in production** - Detect: Task 0 Step 4 prints `ERR ...` or a non-200 status, or later Task 19 Step 4 shows no events after `start`, or `segment` PUTs fail while events work.
  Respond: STOP Track D, report the tail output to the user; do not invent a fallback transport (a public Worker route with a per-recording token is the likely alternative but changes the security model and needs a user decision).
- **Meet UI drift (join, admission, chat, tiles, or leave stop working)** - Detect: `failure.png` in R2, events stuck at `waiting`, `consentPosted: false`, heartbeats with `participants` missing or never 1 when the bot is alone.
  Respond: adjust only `meet/bot/meet-page.ts` strings/selectors, rebuild and redeploy (Task 19 Steps 2-3), and record the change as a `> Deviation:` under Task 15.
- **`wrangler containers push` or rollout fails on podman** - Detect: `--provenance` errors or `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.
  Respond: use the shim and the registry-tag config exactly as in Task 19 Step 2; if the image did not change, `npx wrangler deploy -c wrangler.deploy.jsonc --containers-rollout=none` deploys the Worker only.
- **A second Discord client on the same bot token during E2E** - Detect: every slash command is answered twice or fails with "already acknowledged". Respond: stop and ask the user which process to stop; never stop the production VPS bot without asking.

## End-to-end verification

Prerequisites, each checked before the scenarios:
- [ ] Run: `npm run typecheck && npm test 2>&1 | tail -8 && cd meet && npm run typecheck && npm test 2>&1 | tail -8` - Expected: both typechecks exit 0; root `# pass 50`, `# fail 0`; meet `# pass 18`, `# fail 0`.
- [ ] Manual: `grep -c '^MEET_' .env` prints `0`, then append without printing secrets: `printf 'MEET_RECORDER_URL=%s\nMEET_RECORDER_TOKEN=%s\nMEET_AUTH_STATE_FILE=%s\n' "<WORKER_URL>" "$(cat meet/auth/recorder-token)" "$PWD/meet/auth/meet-auth.json" >> .env`, then `npm run build && npm run register` - Expected: `Registered 3 commands` (instant only when `DISCORD_GUILD_ID` is set in `.env`; otherwise wait up to an hour).
- [ ] 👤 Human: confirm that the Discord bot in the local `.env` is not running anywhere else right now (stop the VPS container or use a test application) and name the Discord test server and text channel to use - Expected: a yes plus the server/channel names - Proxy: none needed (a confirmation, not a check of the product).
- [ ] Manual: start the bot with `npm run dev` (keep its log) and `cd meet && npx wrangler tail everymeet-meet-recorder --format json` in another terminal - Expected: the bot logs `logged in as` and `playback page listening on :8787`.

Scenario A - natural end when everyone leaves:
- [ ] 👤 Human: in the Discord test channel run `/record-meet url:https://meet.google.com/jku-cpry-bcg`, join that Meet from another device (admit the bot if Meet asks), check the Meet chat shows the Thai/English recording notice, read Thai text aloud for about 6 minutes while sharing a browser tab ("Present now") for the middle 4 of them, then leave the call - Expected: Discord shows "Joining Google Meet **jku-cpry-bcg**..." and within about 2 minutes "🔴 I am recording the Google Meet call jku-cpry-bcg"; about 3 minutes after leaving, a minutes post with PIN appears in `#meeting-of-minutes` - Proxy: `src/bot.test.ts` "/record-meet works from any channel..." and `src/meet/session.test.ts` "the channel is told once recording starts..." prove the same messages and hand-off without Discord.
- [ ] Manual: from the tail and R2 for that recording id (from the bot log line `recording Google Meet jku-cpry-bcg as <id>`): heartbeats show `participants` 2 while the person is in (also during the screen share, so the share never triggers `alone`) and 1 after they leave; `ended` has `reason: "alone"`, `leftCleanly: true`, followed by `destroy`; a `segment` event for index 0 has `samples: 7200000` and several MB of `bytes` (a full 5-minute segment went through the callback); `npx wrangler r2 object get meeting-recordings/meetings/<id>/transcript.txt --remote --pipe | sed -n '9,14p'` shows lines like `[00:00:12] <Thai text>` without speaker names; `npx wrangler r2 object get meeting-recordings/meetings/<id>/manifest.json --remote --pipe | jq '{status, endReason, segments: .participants.meet.segments, outputs: .outputs.tracks}'` gives `"status": "done"`, `"endReason": "everyone left the Google Meet call for 3 minutes"`, segments `[0, 1]` (or more), `outputs: {}`.
- [ ] 👤 Human: open the posted "ฟังเสียงบันทึกการประชุม" link, enter the PIN from the post, play the audio, and skim the Thai summary - Expected: the page shows the Meet title, the audio plays the call, there is no "เสียงแยกรายคน" section, and the summary reflects what was said without inventing speaker names - Proxy: `src/web/server.test.ts` (PIN flow) and the Task 6 run test (no per-speaker track, unnamed transcript, prompt tells the model speakers are unknown).

Scenario B - `/end` from Discord:
- [ ] 👤 Human: start `/record-meet` again on the test room, stay in the call for 2 minutes, then run `/end` in Discord - Expected: Discord replies "Recording in **Google Meet jku-cpry-bcg** stopped..."; the bot leaves the Meet call within about 20 s; a minutes post follows - Proxy: `src/bot.test.ts` "/end on a Meet recording tells the recorder to stop..." and `meet/worker/core.test.ts` "runner events move the state along, and /end reaches the runner in its next reply".
- [ ] Manual: tail shows `stop requested`, then `ended` with `reason: "stopped"`, `leftCleanly: true`, then `destroy`; the manifest `endReason` is `ended by <name> with /end`.

Scenario C - the bot restarts mid-meeting:
- [ ] 👤 Human: start `/record-meet` again and stay in the call talking for about 4 minutes, then leave when the agent says the bot is back - Expected: the final post has no "บอท Google Meet หยุดทำงานระหว่างประชุม" note - Proxy: `src/meet/session.test.ts` "after a bot restart a Meet recording is re-attached...".
- [ ] Manual: about 1 minute after "🔴 I am recording", stop `npm run dev` with Ctrl-C and start it again within 30 s - Expected: the bot log shows `re-attached to Google Meet recording <id>`; the tail shows heartbeats continuing without a gap; the final manifest has no `recovered` field and `ffprobe` on `meeting.mp3` gives a duration within 5 s of the time from "recording" to "ended" in the tail.

Cleanup:
- [ ] Manual: `npx wrangler tail` shows a `destroy` line for every recording started in this section, and `curl -s -H "authorization: Bearer $(cat meet/auth/recorder-token)" <WORKER_URL>/recordings/<id>` for each shows `"state":"ended"` - Expected: no recording left in another state (no container left running).

## Phase 2 outline (separate plan, not built here)

- Capture per-participant audio inside the page instead of the PulseAudio mix: Meet plays each remote stream through its own `<audio>` element; an `AudioContext` + worklet per element yields PCM per channel (Vexa `core/meetings/modules/gmeet-capture/src/gmeet-capture.ts`).
- Channels are an anonymous rotating pool, so names come from the speaking indicator on `[data-participant-id]` tiles (name in `span.notranslate`, self excluded with `[data-self-name]`), bound to channels by energy-to-glow correlation (Vexa `gmeet-channel-binder.ts`).
- Each bound speaker becomes a real participant in the Manifest with its own segments, which makes the existing per-speaker transcription and names work unchanged; unbound audio stays on the `meet` mixed track.
- The RTCPeerConnection hook and CSRC polling in Vexa are for other platforms' mixed lanes and are experimental; they are not the first choice for Meet.
- Open risks to settle in that plan: class-name based selectors, CPU cost of per-channel worklets on standard-2, and timeline alignment between page audio clocks and the capture clock.

## Confidence derivation

Start at 10 and subtract per the writing-plans rubric, counted in this file:
- Consumes entries without a full signature: 0 (every cross-track entry is spelled out).
- Patterns-to-Mirror SOURCEs not verified against the real file: 0 (all four repo SOURCEs were read at 52866bd; the Cellar snippet was quoted by an explorer from `job-runner.ts:25-51`, and the spike snippet was read directly).
- Verify - Human with no paired proxy: 0 (the one Human item without a proxy is a confirmation, not a product check).
- NOT-building entries that cut a requirement on an unproven codebase claim: 0.
- Tasks touching a shared or inferred type without consumers listed: 0 (`Manifest` in Task 2, `Config` in Task 3, `activeSessions` in Task 7, `keys` in Task 1 list their consumers).
- Preflight checks written but never run: 0 (deploy-time checks live in Task 19 Step 1 and were not run because they need live authenticated calls).
- Task 0 is an ops probe in a scratch directory, not a track, so the cost floor does not apply to it.
- Parallel tracks below the cost floor: 0 (A has 3 tasks and 18 files, B 6 tasks, C 8 tasks).
- One point off by judgement for the two unknowns no planning-time check can settle: `interceptOutboundHttp` uploads in production (Task 0 gates it before Track C) and Meet People-count/chat selectors in a real call (End-to-end Scenario A gates them).
Result: 9/10.
