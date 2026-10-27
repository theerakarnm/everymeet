# Everymeet TypeScript to Rust Migration Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-10-27-rust-migration.md` - the runner that ticks these checkboxes.
>
> **For the executing agent:** Implement this plan sequentially in ONE worktree (Tasks 9-15 share one crate's files).
> Steps use checkbox (`- [ ]`) syntax; tick them as you go.
> Run the `## Preflight` checks BEFORE Task 0 and report anything down.
> Code in Steps is reference code. Nothing compiled it. When rustc, cargo, tsc or a crate's docs reject a snippet, the tool wins: correct it minimally and record a `> Deviation:` line under the task.
> Tasks 0 and 1 are GATES. If either fails, STOP the whole plan and report.

**Read first:** the feasibility verdict and the scrutinize review both say do not migrate. Task 0 is designed to stop the plan unless the user names a limit the Node bot misses. Do not start Task 1 without a `GO` in `migration/gate.md`.
**Goal:** Replace the Node/TypeScript Discord meeting bot with a Rust implementation that behaves identically through its external interfaces (HTTP playback, R2 object layout, manifest JSON, OpenRouter requests, Discord messages), proven by a judge that runs against both.
**Architecture:** Structure-preserving port. One Rust crate in `rust/` mirrors `src/` file by file (`recorder/`, `pipeline/`, `storage/`, `web/`, `util/`). Voice receive moves from `@discordjs/voice` to `songbird` with `DecodeMode::Decode(DecodeConfig::new(Channels::Mono, SampleRate::Hz24000))`, so songbird decrypts (transport and DAVE) and decodes straight to 24 kHz mono PCM, like Node's per-utterance OpusScript at 24 kHz. A portable parity judge in `judge/` (Node, outside `src/`) drives both implementations over HTTP, a fake S3 server, a fake OpenRouter server, and a publish-payload dump.
**Tech Stack:** Rust (tokio, serenity, songbird, axum, aws-sdk-s3, reqwest, serde, scrypt, hmac, sha2), ffmpeg on PATH, Node 22 for the judge and for the old implementation.
**Spec:** none - planned from conversation. Inputs: the feasibility report in this session (verdict "don't migrate now", override requested by the user), `/tmp/mk` Claude Code Migration Kit (`README.md`, `prompts/00b-judge-setup.md`, `templates/RULEBOOK.md`), and `AGENTS.md`.
**Base commit:** 98773f6 (plus untracked `CLAUDE.md` and `migration/cost-log.tsv`). Every line reference below describes this tree. When an anchor does not match, run `git log --oneline 98773f6..HEAD` to tell "the plan was wrong" from "the file moved on".
**Confidence:** 7/10 - resolved and compiled in a scratch crate: serenity 0.12.5 + songbird 0.6.1, `DecodeMode::Decode`, `VoiceTick`, `decoded_voice`, `SpeakingStateUpdate`; reviewer 2 verified in songbird's source that lost packets give 80 ms in mono 24 kHz, which the plan avoids by writing only received packets. Unverified: issue 310 (DAVE receive stall, tested by Task 1) and serenity interaction code (Task 15). Arithmetic: 10, -2 (Preflight items that could not be satisfied while planning: Discord credentials, staging services and Playwright are NOT available; the plan STOPs at Task 0 without them), -1 (Rust tasks 10-15 list `Consumes` as `Tasks N produces`, whose full signatures are in those tasks' own Produces blocks; single sequential track, so no cross-worktree consumer exists). Execution is sequential.
**NOT building:**
- No redesign: no new features, no schema changes to `Manifest`, no new commands, no behavior fixes. Defects are ported bug-for-bug and marked `BUG(port):`.
- No judge work (Tasks 3-7) before both gates (Tasks 0 and 1) pass: those tasks change `src/` and ship judge entry points in the Node image.
- No removal of the Node implementation. It stays in `src/` until the cutover task passes and the user signs off.
- No fake Discord gateway in the judge. The recorder and interaction layers are verified by ported session-level tests (which replace `@discordjs/voice` and the Discord REST surface with scripted doubles, as `src/bot.test.ts:63-182` does) plus a real-guild human check; a gateway fake would cost more than it proves.
- No change to R2 key layout (`src/storage/r2.ts:22-31`), PIN scheme, cookie format, or Thai copy.
- No Bun, no Docker Desktop work, no CI setup (the repo has none).

## Global Constraints

- Audio format everywhere: 24 kHz mono signed 16-bit LE. `SAMPLE_RATE = 24_000`, `BYTES_PER_SAMPLE = 2`, `SEGMENT_SECONDS = 300` (`src/config.ts:66-71`).
- R2 key layout is frozen: `meetings/{id}/manifest.json`, `meetings/{id}/segments/{userId}/{0000}.flac`, `tracks/{userId}.ogg`, `meeting.mp3`, `transcript.txt`, `summary-full.md`, `summary-short.md` (`src/storage/r2.ts:22-31`).
- Manifest JSON stays byte-compatible in field names (camelCase) so the Rust bot can read manifests written by Node and the reverse (`src/storage/manifest.ts:6-50`). Meetings already in R2 must stay playable.
- PINs: 6 digits, scrypt (Node defaults N=16384, r=8, p=1, 32-byte key), salt and hash are base64url, compared in constant time. Rust must verify hashes Node wrote (`src/util/pin.ts:8-20`).
- Playback cookie: `ma_{id}`, value `"{expMs}.{base64url hmac-sha256(secret, "{id}.{expMs}")}"`, 12 h TTL, HttpOnly, SameSite=Lax, Secure when `PUBLIC_BASE_URL` starts with `https://`, path `/m/{id}` (`src/web/server.ts:137-143`, `src/util/pin.ts:27-42`).
- 5 wrong PINs per (meeting id, IP) lock for 15 minutes; IP comes from `X-Forwarded-For` first entry only when `TRUST_PROXY` is true (`src/web/server.ts:15-17, 31-67`).
- Every page response carries `Cache-Control: no-store`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and the exact CSP string at `src/web/server.ts:92-95`.
- Meeting ids: 12 random bytes base64url (16 chars), validated against `^[A-Za-z0-9_-]{16}$` before any use (`src/util/pin.ts:25`).
- All environment access goes through one `config` module, validated at boot (fail fast), same variable names and defaults as `src/config.ts:8-48` and `.env.example`. New variables go in `.env.example` in the same change.
- Log through a `logger(scope)` helper only; never log tokens or secrets (`AGENTS.md` Security).
- Attachment and download file names use the UTC date (`new Date(startedAt).toISOString().slice(0,10)`, `src/pipeline/publish.ts:75`, `src/web/server.ts:153`), NOT the Bangkok date: port as is and mark `BUG(port)`. The judge fixture starts at 17:30 UTC so the two differ.
- User-facing playback strings stay Thai. Times stay Asia/Bangkok, never UTC. `bangkokDateTime` must match `Intl.DateTimeFormat("th-TH", {dateStyle:"medium", timeStyle:"short"})`, which prints the Buddhist-era year (verified: epoch 1793070000000 prints `27 ต.ค. 2569 10:00`).
- The bot announces that it is recording in the command channel and the voice channel chat (consent / PDPA). Keep it (`src/interactions.ts:57-62`).
- One recording per guild at a time (`src/interactions.ts:23-30`).
- Every fallback model pair (transcribe, summary) keeps working (`AGENTS.md` Gotchas; `src/pipeline/openrouter.ts:94-108, 115-133`).
- `SESSION_SECRET` min 32 chars; R2 bucket stays private; playback only through presigned URLs.
- New runtime dependencies need a reason. The adopted Rust crates are listed in the rulebook (Task 2). Anything else needs a rulebook amendment first.
- Quality gate for the Node side stays `npm run typecheck && npm test`. For the Rust side it is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` run in `rust/`.

## Patterns to Mirror

### Naming
<!-- SOURCE: src/storage/r2.ts:22-31 -->
```ts
export const keys = {
  manifest: (id: string) => `meetings/${id}/manifest.json`,
  segment: (id: string, userId: string, index: number) =>
    `meetings/${id}/segments/${userId}/${String(index).padStart(4, "0")}.flac`,
  track: (id: string, userId: string) => `meetings/${id}/tracks/${userId}.ogg`,
```
Rust mirror: `rust/src/storage/r2.rs` exposes `pub mod keys { pub fn segment(id: &str, user_id: &str, index: u32) -> String }` with the same strings. File and module names equal the TS file names with `_` for `-` (`track-writer.ts` becomes `track_writer.rs`, `segment-uploader.ts` becomes `segment_uploader.rs`).

### Error handling
<!-- SOURCE: src/pipeline/openrouter.ts:7-15, 17-33 -->
```ts
export class HttpError extends Error {
  constructor(readonly status: number, body: string) { super(`HTTP ${status}: ${body.slice(0, 500)}`); }
}
const retryable = (err: unknown) =>
  !(err instanceof HttpError) || err.status === 408 || err.status === 429 || err.status >= 500;
```
Retry waits are `[2000, 6000, 15000]` ms, 3 attempts. Rust mirror: `thiserror` enum with an `Http { status, body }` variant; same retry predicate and waits.

### Tests
<!-- SOURCE: src/web/server.test.ts:5-7, 36-38 -->
```ts
mockR2();
process.env.TRUST_PROXY = "true"; // as behind Nginx; the tests send X-Forwarded-For
const { createApp } = await import("./server.js");
const submitPin = (id: string, pin: string, ip = newIp()) =>
  app.request(`/m/${id}`, { method: "POST", body: new URLSearchParams({ pin }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip } });
```
Tests sit next to the code. Rust mirror: `#[cfg(test)] mod tests` in the same file for pure units; HTTP tests in `rust/tests/web.rs` using `tower::ServiceExt::oneshot` against `create_app(...)`.

### Pure planning module
<!-- SOURCE: src/pipeline/plan.ts:22-28 -->
```ts
export const DEFAULT_PLAN: PlanOptions = {
  mergeGap: 2 * SAMPLE_RATE, maxTurn: 60 * SAMPLE_RATE, minTurn: Math.round(0.4 * SAMPLE_RATE),
  maxChunk: 120 * SAMPLE_RATE, joinGap: Math.round(0.6 * SAMPLE_RATE),
};
```
`plan.rs` stays I/O-free. Note `Math.round(0.4*24000)=9600` and `Math.round(0.6*24000)=14400` are exact integers, so integer literals are safe.

## Preflight

### DURABLE - true until the repo itself changes

- `JUDGE_PIN` and `JUDGE_*` ports are read straight from the environment by judge code only; this is a judge-only exception to the config-module rule.
- Node implementation is a single package, npm lockfile, Node >= 22.12 - Evidence: `package.json` engines, `package-lock.json` present (`bun.lock` is stale; do not use). Consequence: judge runs the old bot with `node --import tsx`.
- No route-level Discord fake exists; `src/bot.test.ts` mocks `@discordjs/voice` through `node:test` `mock.module` - Evidence: `src/test/setup.ts` has only R2 and OpenRouter fakes. Consequence: Tasks 13-15 verify with ported unit tests plus a human guild check.
- Old tests: 31 tests, 4 files; `src/web/server.test.ts` (6) hits HTTP via `createApp().request`; the rest import internals. Consequence: they are reference material for porting, the judge is the cross-implementation referee.
- `AGENTS.md` states Node 22 is a hard constraint because of `@discordjs/voice` and DAVE. This plan reopens that decision. Task 18 rewrites that paragraph only after cutover.
- The Node build uses TypeScript 7, `rootDir: src`, `include: ["src"]` (`tsconfig.json`). The judge lives in `judge/`, outside `src/`, so it is not typechecked by the existing config.

### PERISHABLE - recapture before task 1

- [Node baseline] - Check: `cd <repo> && npm run typecheck && npm test 2>&1 | tail -8` - Planning run: typecheck 0 errors; 31 pass, 0 fail, about 3 s. Needed by: every Node task's "no new failures".
- [Rust toolchain] - Check: `cargo --version && rustc --version` - Planning run: cargo 1.99.0. Needed by: Tasks 1, 4-17.
- [ffmpeg and ffprobe on PATH] - Check: `which ffmpeg ffprobe` - Planning run: both under /opt/homebrew/bin. Needed by: Tasks 3, 9, 10, 13 (ffmpeg shelling is part of the pipeline).
- [Crate resolution] - Check: `cd $(mktemp -d) && cargo init x && cd x && cargo add tokio --features full && cargo add serenity --no-default-features --features client,gateway,rustls_backend,model,cache,voice && cargo add songbird --features receive,driver,gateway,serenity && cargo check` - Planning run: resolved serenity 0.12.5 + songbird 0.6.1 (+ opus2 0.4.0, davey 0.1.5), `cargo check` finished in 46 s. Needed by: Task 1. If it fails to resolve compatible serenity and songbird versions, STOP and ask.
- [Port 8787 is busy on the dev machine by an unrelated `bun` process] - Check: `lsof -i :8787`. Consequence: the judge starts both bots on ephemeral ports it chooses (`JUDGE_NODE_PORT`, `JUDGE_RUST_PORT`, default 18701 and 18702). Check `lsof -i :18701 -i :18702` returns nothing (planning run: nothing listening).
- [Git state] - Check: `git status --short` - Planning run: `?? CLAUDE.md`, `?? migration/`. Needed by: clean commits. Commit those two only if the user asks.
- [Real Discord credentials for Tasks 0, 1 and 17] - Planning run: all three `SPIKE_*` variables NOT set. Check: `test -n "$SPIKE_DISCORD_TOKEN" && test -n "$SPIKE_GUILD_ID" && test -n "$SPIKE_VOICE_CHANNEL_ID"` (prints set / NOT set). Needed by: the `Verify - Human` boxes. Use a throwaway test bot and guild, never the production token. If NOT set, the executor STOPs at Task 0 and asks the user to supply a throwaway bot and guild; nothing later can be verified without them.
- [Container engine] - Check: `which docker podman` - Planning run: only podman (`/opt/homebrew/bin/podman`). Tasks 16-17 use `$CE` (= `podman`, or `docker` if present) for `build`, `run`, `kill`, `stats`; compose via `$CE compose`.
- [Staging services for Task 17] - Check: `test -n "$STAGING_R2_BUCKET" && test -n "$STAGING_OPENROUTER_API_KEY" && test -n "$STAGING_PUBLIC_BASE_URL"` (prints set / NOT set) and `curl -sf $STAGING_PUBLIC_BASE_URL/healthz` once the container runs. A separate staging R2 bucket with its own keys, a real OpenRouter key, and an HTTPS URL or tunnel are needed. Planning run: all three `STAGING_*` variables NOT set. Mapping for the Rust container's `.env.staging`: `R2_BUCKET=$STAGING_R2_BUCKET`, `OPENROUTER_API_KEY=$STAGING_OPENROUTER_API_KEY`, `PUBLIC_BASE_URL=$STAGING_PUBLIC_BASE_URL`, plus a staging `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, and the throwaway bot's `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. If NOT set at Task 17, that Human box stays unticked and the plan is reported as awaiting human. The rollback `aws` CLI: `which aws`; if absent use the Cloudflare dashboard (a Human step).
- [Playwright for the End-to-end Manual item] - Check: `npx playwright --version`. Planning run: `npx playwright --version` failed (not installed). If absent, the Manual item falls back to `curl` for the 302 and a Range request.
- [treehouse] - Check: `which treehouse` - Planning run: installed. Not needed: sequential single worktree.

## Execution

**Tracks:**
- Track A (single, sequential) - Tasks 0-7, then 9-18 (Task 8 was removed: the gap inventory had no consumer; its rows live in the rulebook, Task 2). No parallelism: Tasks 9-15 all create files under one new crate, so a second worktree would conflict on `rust/Cargo.toml`, `rust/src/main.rs`, and `rust/src/lib.rs`.

**Merge order:** one branch `rust-migration`, merged only after Task 17 passes and the user signs off. Task 18 (retire Node) is a separate follow-up merge.
**Shared files:** `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/src/lib.rs` (module declarations), `.env.example`, `.gitignore`: owned by Task 9 (scaffold), extended by later tasks in sequence.
**Worktree setup:** single worktree, the current checkout. No `treehouse get`.
**Teardown:** none.

---

### Task 0: GATE - is the migration worth doing?

The stated reasons are memory safety and performance. Planning evidence against both:
- Memory safety: TypeScript on Node has no memory-unsafe code. Today's only native code is sandboxed wasm Opus (`opusscript`, `src/recorder/session.ts:19`) and the separate ffmpeg process. The Rust port links C libopus (`opus2`) and the `davey` DAVE crate into the process, so in-process native code grows.
- Performance: decoding is not a cost. Measured on this machine on 2026-10-27: 30,000 Opus packets (10 speaker-minutes) decode in 1,166 ms with `opusscript` at 24 kHz mono, which is 0.19% of one core per speaker; the benchmark process used 57 MB RSS. Meeting processing is ffmpeg plus OpenRouter, which stay the same in Rust. Rust can only save the Node process's own memory, and `docker-compose.yml` sets no memory limit.

So the gate starts with a question, not a measurement.

**Files:**
- Create: `migration/gate.md`

**Interfaces:**
- Consumes: the user's answer.
- Produces: `migration/gate.md` with the target, the measured value if one was measured, and the decision line `GO` or `STOP`.

**Steps:**
- [ ] Step 1: 👤 Verify - Human: the user names the concrete limit the migration must meet (for example: container memory limit in MB, host size, monthly cost, a crash or incident class). Expected: one number or one named incident written into `migration/gate.md`. Proxy: none needed beyond the file, since this is a decision, not a check of code.
- [ ] Step 1b: The user may instead state that the migration is their decision with no measurable target (stated 2026-10-27: "I just want to change to Rust"). Then write `GO: user decision, no measurable target` in `migration/gate.md`, skip Steps 2-4, and continue. The risks in the evidence above stay recorded in the file.
- [ ] Step 2: If the user names no limit and does not decide to migrate anyway, write `STOP: no target the Node bot misses` in `migration/gate.md`, commit, and end the plan here. Offer the TypeScript-only alternative instead: switch the synchronous reads in `buildRawTracks` (`src/pipeline/assemble.ts:52-66`) and `readChunkAudio` (`src/pipeline/transcribe.ts:15-24`) to `fs.promises`, because they block the event loop for other guilds' recordings and the web server while a meeting is processed.
- [ ] Step 3: If a memory or CPU limit is named, measure the Node bot against it: write `migration/sample-ps.sh` (loop: `ps -o rss=,pcpu= -p "$1" >> migration/baseline-node.csv; sleep 10`), run the bot with `npx tsx --env-file-if-exists=.env src/index.ts` (so the sampled pid is the bot, not a `tsx watch` parent) in the throwaway guild for a 30-minute two-speaker recording plus processing. 👤 Verify - Human: the recording session happens. Proxy: Step 4 computes the numbers from the CSV.
- [ ] Step 4: Verify - Run: `awk '{r=$1>m?$1:m; m=r; c+=$2; n++} END {printf "peak_rss_mb=%.0f mean_cpu=%.1f\n", m/1024, c/n}' migration/baseline-node.csv` - Expected: one line with both numbers. Write `GO` in `migration/gate.md` only if Node misses the named limit; else `STOP`.
- [ ] Step 5: Commit - `git add migration/gate.md migration/sample-ps.sh migration/baseline-node.csv && git commit -m "migration: go/no-go gate"` (the script and CSV only if Step 3 ran).

---

### Task 1: GATE - voice receive spike (songbird under DAVE)

This task decides if the migration is feasible.
If it fails, STOP the plan, report which check failed, and do not start Task 2.

**Files:**
- Create: `rust/spikes/voice-receive/Cargo.toml`
- Create: `rust/spikes/voice-receive/src/main.rs`
- Create: `rust/spikes/README.md` (what was run, versions, result, date)

**Interfaces:**
- Consumes: env `SPIKE_DISCORD_TOKEN`, `SPIKE_GUILD_ID`, `SPIKE_VOICE_CHANNEL_ID`, optional `SPIKE_SECONDS` (default 120).
- Produces: `spike-out/{userId}.pcm` (24 kHz mono s16le, positional writes like `TrackWriter`) and a printed line per speaker: `user=<id> first_packet_ms=<n> samples=<n> max_gap_ms=<n> plc_ticks=<n> max_samples_per_tick=<n>`; install `tracing_subscriber` in the spike (the real bot has none) so songbird's `DAVE decryption failed` and decode warnings are visible when diagnosing issue 310. Produces the answers recorded in `rust/spikes/README.md`: (a) final crate versions of serenity and songbird (resolved in planning: 0.12.5 and 0.6.1); (b) does `DecodeMode::Decode(DecodeConfig::new(Channels::Mono, SampleRate::Hz24000))` deliver `VoiceData::decoded_voice` (24 kHz mono i16 PCM, already transport- and DAVE-decrypted) per user; (c) does DAVE receive survive a second person joining mid-call (issue 310).

**Gotcha:** playback timeline: songbird's loss concealment is wrong for mono 24 kHz (80 ms per lost packet), so write only ticks where `data.packet.is_some()`. Songbird receive is feature-gated and needs `Config::default().decode_mode(DecodeMode::Decode(DecodeConfig::new(Channels::Mono, SampleRate::Hz24000)))`. Do NOT use `DecodeMode::Pass`: per the songbird 0.6.1 docs it hands packets over unchanged (still encrypted), so a hand-written Opus decode would fail for the wrong reason. `DecodeMode::Decrypt` plus `opus2` is the fallback only if exact packet-loss parity is required, and then the spike must prove the payload is DAVE-decrypted. Register handlers with `Call::add_global_event(CoreEvent::VoiceTick.into(), ...)` and `CoreEvent::SpeakingStateUpdate` to map SSRC to user id. Check the songbird 0.6 docs and `examples/` in its repo for the exact `VoiceTick` payload (`speaking: HashMap<u32, VoiceData>`, `silent: HashSet<u32>`); the shape below compiled against songbird 0.6.1 in a scratch crate during planning (the compiler still wins). Open upstream issue serenity-rs/songbird#310 reports receive stalling after an MLS transition when a member joins; this spike must exercise exactly that.

**Steps:**
- [x] Step 1: First add to `.gitignore`: `rust/**/target/` and `rust/spikes/**/spike-out/` (recorded voices of real people must never reach git; `cargo init` inside an existing repo writes no `.gitignore`). Then create the spike crate and resolve versions.
      ```bash
      mkdir -p rust/spikes/voice-receive/src && cd rust/spikes/voice-receive
      cargo init --name voice-receive
      cargo add tokio --features full
      cargo add serenity --no-default-features --features client,gateway,rustls_backend,model,cache,voice
      cargo add songbird --features receive,driver,gateway,serenity
            ```
- [x] Step 2: Write `src/main.rs`: login with `GatewayIntents::GUILDS | GUILD_VOICE_STATES`, build the client with `songbird::register_from_config(client_builder, Config::default().decode_mode(DecodeMode::Decode(DecodeConfig::new(Channels::Mono, SampleRate::Hz24000))))`, join `SPIKE_VOICE_CHANNEL_ID` with `self_deaf(false)`, register a `VoiceTick` handler. On each tick, for every user in `speaking`, take `data.decoded_voice` (24 kHz mono i16) and write contiguously like `TrackWriter` (cursor = `max(cursor, elapsed_ms*24)` at utterance start, then append) and ONLY when `data.packet.is_some()`, into `spike-out/{user}.pcm` with `FileExt::write_at`.
      ```rust
      // sketch - the compiler and songbird docs win
      struct Rx { start: Instant, ssrc_to_user: Mutex<HashMap<u32, u64>>, out: Mutex<HashMap<u64, UserOut>> }
      #[async_trait]
      impl VoiceEventHandler for Rx {
          async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
              match ctx {
                  EventContext::SpeakingStateUpdate(s) => { if let Some(u) = s.user_id { self.ssrc_to_user.lock().await.insert(s.ssrc, u.0); } }
                  EventContext::VoiceTick(t) => { for (ssrc, data) in &t.speaking { if let Some(pcm) = &data.decoded_voice { /* write_at(pcm as bytes) */ } } }
                  _ => {}
              }
              None
          }
      }
      ```
      > Deviation: songbird 0.6.1 has no `VoiceEventHandler` trait; the receive handler implements `songbird::events::EventHandler` (`async_trait`) instead.
      > Deviation: `EventData::new`/`add_global_event` take the handler by value with no `Arc<T>` blanket impl, so shared state sits in an `Arc<Rx>` wrapper (`RxHandle`).
      > Deviation: `tracing` and `tracing-subscriber` added as direct dependencies (the Interfaces section requires the subscriber, and `tracing::error!` needs the `tracing` macros).
      > Deviation: `EventContext::SpeakingStateUpdate` wraps `songbird::model::payload::Speaking` directly; its `user_id` is `Option<UserId>` with `UserId(pub u64)`, so the sketch's `s.ssrc` / `u.0` access compiled unchanged.
- [x] Step 3: Verify - Run: `cd rust/spikes/voice-receive && cargo build` - Expected: exit 0 (fix API drift here).
- [x] Step 4: Add unit tests in the same file for the pure part (cursor placement `max(cursor, elapsed_ms*24)`, gap computation, and a scripted tick with `packet: None` and 1920 decoded samples that must not move the cursor) and Verify - Run: `cargo test` - Expected: 3 pass, 0 fail. This is the non-Discord proxy for the Human box below.
- [ ] Step 5: 👤 Verify - Human: with a throwaway bot in a throwaway guild, run `SPIKE_SECONDS=180 cargo run`. Person A speaks for 20 s, then Person B joins the channel and speaks for 20 s, then both speak over each other for 20 s. Expected: two `pcm` files in `spike-out/`, each playable (`ffmpeg -f s16le -ar 24000 -ac 1 -i spike-out/<id>.pcm out.wav`) with intelligible speech from the right person, the log line shows `max_gap_ms` under 400 during continuous speech, `max_samples_per_tick` is never above 480 (a larger value means concealment frames leaked into the timeline), and no stall after Person B joined. Proxy: Step 4 asserts the cursor math and the lost-packet rule and Step 3 proves the receive handler compiles against the real crate API.
      > Awaiting human: two-person run for (c). One-person run done 2026-10-27: (a) and (b) PASS, see rust/spikes/README.md.
      > Deviation: Steps 6-7 done by the orchestrator inline (docs only, data from the live run).
      > Deviation: 2026-10-27 the user approved starting Tasks 2-7 before (c) passes, accepting that judge work may be wasted if (c) fails. Task 9 still waits for (c).
- [x] Step 6: Write `rust/spikes/README.md` with crate versions from `Cargo.lock`, the date, the three answers (a)(b)(c), and PASS or FAIL. FAIL if (b) decoded 24 kHz mono PCM is not delivered under DAVE (then Task 15 needs a different decode path, re-plan) or (c) receive stalls.
- [x] Step 7: Commit - `git add .gitignore rust/spikes/README.md rust/spikes/voice-receive/Cargo.toml rust/spikes/voice-receive/Cargo.lock rust/spikes/voice-receive/src && git commit -m "spike: verify songbird voice receive under DAVE"`

---

### Task 2: Rulebook (decisions made once)

**Files:**
- Create: `migration/RULEBOOK.md` (copy of `/tmp/mk/templates/RULEBOOK.md` with every placeholder filled)

**Interfaces:**
- Consumes: Task 1 README answers.
- Produces: the decisions below, which every later task treats as binding.

**Steps:**
- [x] Step 1: Copy the template: `cp /tmp/mk/templates/RULEBOOK.md migration/RULEBOOK.md`. If `/tmp/mk` is gone: `git clone --depth 1 https://github.com/anthropics/code-migration-kit-with-claude-code.git /tmp/mk`.
- [x] Step 2: Fill §0 (structure-preserving; the compiler is allowed in this repo because `cargo check` is cheap, so replace the "do not run the compiler" bullet with "run `cargo check` per task").
- [x] Step 3: Fill §1 with exactly these decisions:

      | Area | Decision |
      |---|---|
      | Async runtime | `tokio` (multi-thread). One `tokio::spawn` per former `setTimeout` timer and per former promise chain. |
      | Discord | `serenity` for gateway, REST, interactions, embeds. `songbird` for voice with `DecodeMode::Decode` (24 kHz mono). |
      | Opus decode | songbird `DecodeMode::Decode` at 24 kHz mono; no direct `opus2` dependency. Lost-packet ticks (`packet: None`) are ignored, exactly like Node; see the utterance rule below. Accepted small difference: songbird's playout buffer (about 5 packets) starts each utterance about 100 ms later than Node's first-packet time. |
      | HTTP server | `axum` + `tower`. |
      | HTTP client | `reqwest` (rustls). |
      | S3 | `aws-sdk-s3` with `endpoint_url` override, `force_path_style(config.r2_endpoint.is_some())` (as `src/storage/r2.ts` after Task 3) and presigning. |
      | JSON | `serde`, `serde_json`; `#[serde(rename_all = "camelCase")]`; `Option` fields use `skip_serializing_if`. |
      | Config | `serde` + manual validation in `config.rs`, same names and defaults as `src/config.ts`. No `dotenv` crate; the compose file already injects env. |
      | Crypto | `scrypt` (params log_n=14, r=8, p=1, len=32), `hmac`, `sha2`, `base64` (URL_SAFE_NO_PAD; Node's `Buffer.from(x,"base64url")` is more lenient than this and accepts e.g. a trailing `=`/`!`: accepted difference, `BUG(port)`; the judge malformed-cookie vector must be one Node itself rejects), `subtle` for constant-time compare, `rand`. |
      | ffmpeg | `tokio::process::Command`, same arguments as `src/util/ffmpeg.ts`, same 4000-byte stderr tail. |
      | CLI / subcommands | `clap` (derive, `version`) for `web-only`, `healthcheck`, `--version`. |
      | Ordered maps | `indexmap` (serde feature). |
      | Errors | `thiserror` for typed errors; `anyhow` only in `main.rs`. |
      | Logging | hand-rolled `logger(scope)`; `info/warn/error(msg, extra: Option<&dyn Display>)` with the same line format as `src/util/log.ts` (the optional `extra` prints like the stack in Node). No `tracing`. |
      | Local env files | no `.env` loader; compose injects env. Local runs use `set -a; . ./.env; set +a` (Node used `--env-file-if-exists`). |
      | axum routing | axum 0.8 path syntax `/m/{id}`; the old `:id` form panics at router build. |
      | Concurrency limiter | `tokio::sync::Semaphore`, no crate (mirrors `util/limit.ts`). |

- [x] Step 4: Fill §2 (constructs with no equivalent) with these rows:

      | Source construct | Rust translation |
      |---|---|
      | `Map<string, MeetingSession>` `activeSessions` | `Arc<Mutex<HashMap<GuildId, Arc<MeetingSession>>>>` in `recorder::session` |
      | `setTimeout` / `clearTimeout` | `tokio::task::JoinHandle` stored in the session; clear = `.abort()` |
      | `this.ending ??= this.doEnd(reason)` (idempotent end, flag readable synchronously by `subscribe`, `showPrompt`, `handleContinue`, `checkEmpty`) | an `AtomicBool ending` set FIRST (`swap(true)`), plus a `tokio::sync::OnceCell<()>` so later callers await the same completion; all `TrackWriter`s sit behind one `Mutex` that `end()` holds across the synchronous part of `doEnd` (`session.ts:318-339`) so the tick handler cannot write while segments close |
      | sparse file via `ftruncate` + positional `writeSync` | `std::fs::File` + `std::os::unix::fs::FileExt::write_at` + `set_len` (Linux and macOS only) |
      | `Date.now()` | `SystemTime` as `u64` ms (`now_ms()`), so `Manifest` fields stay JSON numbers |
      | optional manifest fields | `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]` so the JSON never gains `null`s |
      | `Record<string, Participant>` and `outputs.tracks` | `indexmap::IndexMap<String, _>` (serde feature) with `serde_json` feature `preserve_order`. Insertion order is visible output: it orders `meetingContext` in every chat prompt (`summarize.ts:16-21`), the embed speakers field, the player track list, ffmpeg amix inputs, and transcription jobs. Discord ids are not sorted lexicographically by join order. |
      | `Intl.DateTimeFormat("th-TH", ...)` | hand-written formatter: `D MMM BBBB HH:mm` with Thai short months `ม.ค. ก.พ. มี.ค. เม.ย. พ.ค. มิ.ย. ก.ค. ส.ค. ก.ย. ต.ค. พ.ย. ธ.ค.`, year + 543, 24 h, Asia/Bangkok = UTC+7 with no DST (`chrono` is NOT adopted; use plain arithmetic on epoch ms) |

- [x] Step 5: Add a short "Gap sites" list to §2 (replaces the kit's separate inventory, which nothing here would check): shared mutable `manifest` mutated from session, uploader, and pipeline; the `activeSessions` global map; timer handles in `MeetingSession`; `participants[userId]!` non-null assertions (`rg -c '\]!' src`); `any` JSON from OpenRouter; `Buffer` PCM slices. Each row names its Rust translation from the table above.
- [x] Step 5b: Add the BUG rule, the utterance rule, and the voice rule:
      - Utterance rule: write `decoded_voice` ONLY on ticks where `data.packet.is_some()` and the PCM is non-empty. Songbird's loss concealment is wrong for mono 24 kHz (`songbird-0.6.1/src/driver/tasks/ssrc_state.rs:111-118` allocates a stereo 1920-sample frame, so one lost or DAVE-dropped packet yields 80 ms instead of 20 ms; verified in a scratch crate), and Node writes only received packets (`src/recorder/session.ts:194-205`). An utterance starts on the first such tick and ends after 1000 ms without one. This replaces `EndBehaviorType.AfterSilence, duration: 1000` (`src/recorder/session.ts:187`). `TrackWriter` semantics (`beginUtterance(expectedSample)`, `max(cursor, expected)`) are unchanged.
      - Voice rule: bots are skipped (`member.user.bot`), `selfDeaf=false`, `selfMute=true`.
      - Order rule: judge comparisons must NOT sort object keys for `participants` and `outputs.tracks`; fixtures use ids whose join order differs from their sorted order.
- [x] Step 6: Verify - Run: `grep -nE '\[(source language|target language|e\.g\.|why|path pattern|add rows|your gap|date|who|N|high|Module|Test file|decide|default:|source raises)' migration/RULEBOOK.md | wc -l` - Expected: `0`. Also fill or delete §3-§5 of the template (every section is either filled or removed).
- [x] Step 7: Commit - `git add migration/RULEBOOK.md && git commit -m "docs: migration rulebook for TypeScript to Rust"`

---

### Task 3: Make the Node bot judge-ready (endpoint overrides, publish split)

The judge must talk to fake services and capture the Discord post without a gateway.
These are small, backward-compatible changes to the old code, mirrored in Rust later.

**Files:**
- Modify: `src/config.ts` (anchor: `R2_BUCKET: z.string().min(1)`, ~L16; add `R2_ENDPOINT` and `OPENROUTER_BASE_URL`)
- Modify: `src/storage/r2.ts` (anchor: `endpoint: \`https://${c.R2_ACCOUNT_ID}`, ~L15)
- Modify: `src/pipeline/openrouter.ts` (anchor: `const BASE = "https://openrouter.ai/api/v1";`, ~L6)
- Modify: `.env.example`

**Interfaces:**
- Consumes: none.
- Produces: optional env `R2_ENDPOINT` (full URL, default `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`), optional env `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`). When `R2_ENDPOINT` is set, S3 client uses `forcePathStyle: true`.

**Steps:**
- [x] Step 1: In `src/config.ts` add after `R2_BUCKET`:
      ```ts
      /** Optional S3 endpoint override (tests, local fakes). Default is the R2 account endpoint. */
      R2_ENDPOINT: z.url().optional(),
      ```
      and after `OPENROUTER_API_KEY`:
      ```ts
      OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
      ```
- [x] Step 2: In `src/storage/r2.ts` replace the `endpoint:` line and add path style:
      ```ts
      endpoint: c.R2_ENDPOINT ?? `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: !!c.R2_ENDPOINT,
      ```
- [x] Step 3: In `src/pipeline/openrouter.ts` delete `const BASE = ...` and use `` `${config().OPENROUTER_BASE_URL}${path}` `` inside `post()` (anchor: `await fetch(\`${BASE}${path}\``). Note the test helper strips `/api/v1` from the path (`src/test/setup.ts`, `mockOpenRouter`); the default keeps that working.
- [x] Step 4: Add both variables, commented with defaults, to `.env.example`. Also blank the real-looking `R2_ACCOUNT_ID=` value there (it is a committed account identifier).
- [x] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: 0 type errors, 31 pass, 0 fail.
- [x] Step 6: Commit - `git add src/config.ts src/storage/r2.ts src/pipeline/openrouter.ts .env.example && git commit -m "add R2_ENDPOINT and OPENROUTER_BASE_URL overrides"`

---

### Task 4: Node publish split and `judge-cli`

**Files:**
- Modify: `src/pipeline/publish.ts` (anchor: `export async function publishMinutes`, ~L47; extract the message construction into `export function buildMinutesMessage(m, opts)` returning plain JSON)
- Modify: `src/pipeline/run.ts` (anchor: `async function run`, ~L26; export `runPipeline`; anchor: `export async function recoverUnfinished`, ~L98; extract `closeAtHeartbeat`)
- Create: `src/judge-cli.ts`
- Create: `src/pipeline/publish.test.ts`

**Interfaces:**
- Consumes (existing TS, unchanged): `buildRawTracks(m: Manifest): Promise<Record<string,string>>`, `encodeTracks(raw: Record<string,string>): Promise<Record<string,string>>`, `mixTracks(m: Manifest, raw: Record<string,string>): Promise<string>` (`src/pipeline/assemble.ts`); `transcribeMeeting(m: Manifest, raw: Record<string,string>): Promise<TranscriptResult>` (`src/pipeline/transcribe.ts`); `fullSummary(m: Manifest, transcript: string)`, `shortSummary(m: Manifest, full: string)`: `Promise<{model: string; text: string}>` (`src/pipeline/summarize.ts`); `putFile(key: string, path: string, contentType: string)`, `putText(key: string, body: string, contentType?: string)`: `Promise<void>` (`src/storage/r2.ts`).
- Produces:
  - `export function buildMinutesMessage(m: Manifest, opts: { pin: string; shortSummary: string; fullSummary: string; transcript: string; note?: string }): { content: string; embed: { title: string; description: string; color: number; fields: { name: string; value: string; inline: boolean }[]; footer: string }; linkLabel: string; linkUrl: string; files: { name: string; text: string }[] }`
  - CLI: `node --import tsx src/judge-cli.ts process <meetingId>` reads `{DATA_DIR}/meetings/<id>/manifest.json` and segment files, runs the same steps 1-3 of `run()` (`src/pipeline/run.ts:28-70`) with a fixed PIN from env `JUDGE_PIN` (6 digits), then writes `{DATA_DIR}/judge-publish.json` = `buildMinutesMessage(...)` instead of posting, and exits 0. Final manifest state, exactly: `pin = hashPin(JUDGE_PIN)`, `status: "done"`, `outputs` filled except `postedMessageUrl`, uploaded through `saveEverywhere`. It never deletes the meeting directory (`CLEANUP_LOCAL` is ignored by the CLI). Web scenarios get their `done` manifest by running `process` first against the fake S3. `recover` calls a new exported pure `closeAtHeartbeat(m: Manifest): Manifest` (extracted from `recoverUnfinished`, `src/pipeline/run.ts:100-117`, which uses it too) so the judge tests the real logic, not a copy.

**Gotcha:** `publishMinutes` must keep identical Discord output; `buildMinutesMessage` is a pure refactor. The embed footer text is sliced to 2048 and fields to 1024 inside the builder.

**Steps:**
- [ ] Step 1: Extract `buildMinutesMessage` from `publishMinutes` (`src/pipeline/publish.ts:48-91`), then have `publishMinutes` convert the plain JSON to `EmbedBuilder`/`ButtonBuilder`/`AttachmentBuilder` and send.
- [ ] Step 2: Write `src/judge-cli.ts`. Reuse `run()` logic by exporting a `runPipeline(m, pin)` from `src/pipeline/run.ts` that returns `{ lines, shortSummary, fullSummary, transcript, notes }` and is called by both `run()` and the CLI (anchor: `async function run`). Do not duplicate the pipeline body.
- [ ] Step 3: Add a unit test `src/pipeline/publish.test.ts` that asserts `buildMinutesMessage` for a fixed manifest returns the exact title `สรุปการประชุม - daily-standup`, field names `เริ่มประชุม`, `ระยะเวลา`, `ผู้พูด`, and the file names `summary-full-2026-10-12.md` and `transcript-2026-10-12.txt`.
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: 0 type errors, 0 fail, and at least 32 pass (31 baseline plus the new `publish.test.ts`).
- [ ] Step 5: Commit - `git add src/pipeline/publish.ts src/pipeline/run.ts src/pipeline/publish.test.ts src/judge-cli.ts && git commit -m "split publish message builder and add judge-cli"` (`src/judge-*.ts` compile into `dist/` and ship in the Node image until Task 18 deletes them; accepted)

---

### Task 5: Judge, part 1 - fake services and fixtures

**Files:**
- Create: `judge/package.json` (`"type":"module"`, no dependencies)
- Create: `judge/fake-s3.mjs`
- Create: `judge/fake-openrouter.mjs`
- Create: `judge/fixtures.mjs`

**Interfaces:**
- Produces:
  - `startFakeS3(): Promise<{ url: string; objects: Map<string, Buffer>; close(): Promise<void> }>` - path-style `PUT /{bucket}/{key}`, `GET /{bucket}/{key}` (supports `Range`); it MUST decode `aws-chunked` request bodies (hex-size;chunk-signature framing plus checksum trailer), because both AWS SDKs send streamed `putFile` bodies that way (verified in `node_modules/@aws-sdk/checksums`). Never disable checksums in production code to suit the fake, 404 `<Error><Code>NoSuchKey</Code></Error>` for missing keys; ignores signatures (so presigned URLs resolve too).
  - `startFakeOpenRouter(script?: (call) => {status:number, body:any}): Promise<{ url: string; calls: {path:string; body:any}[]; close(): Promise<void> }>` - base URL `${url}/api/v1`. Default behavior is deterministic: `/audio/transcriptions` returns `{ text: "ข้อความทดสอบ <sha8>", segments: [{start:0.1,end:1,text:"<sha8> #1"},{start:wavSeconds-1.0,end:wavSeconds,text:"<sha8> #2"}] }` where `<sha8>` is `sha256(wav).slice(0,8)` (the second segment lands in a later packed piece, so the transcript golden catches `toSessionSample` and line-to-speaker mapping bugs); `/chat/completions` returns `{choices:[{message:{content:"สรุป <sha256(last user message).slice(0,8)>"}}]}`.
  - `makeMeetingFixture(dataDir: string, s3: { objects: Map<string, Buffer> }): { id: string; manifest: object }` (fixed id `FIXTUREFIXTURE12`, 16 chars; fixed `startedAt` of 2026-12-31T17:30:00Z so the Bangkok date and the UTC date differ) writes a manifest with 2 participants and PCM segments made of 440 Hz and 660 Hz tones (generated in JS, 24 kHz s16le), including one speaker with utterances spanning a segment boundary, a 90 s silence gap, and a 2.5 s same-speaker pause (between `mergeGap` 2 s and 3 s). Participant ids are `900000000000000002` (joins first) and `100000000000000001` (joins second), so join order differs from sorted order. The fixture also seeds the FLAC segments into `s3.objects` and sets `participants[*].uploaded` accordingly (the pipeline does not upload segments; the recorder does; scenario 10 needs `uploaded`, `src/pipeline/assemble.ts:20`).

**Steps:**
- [ ] Step 1: Implement the three files with `node:http` only. `fake-s3.mjs --serve <port>` runs the fake as a standalone server (used by the End-to-end Manual item).
- [ ] Step 2: Verify - Run: `node judge/fake-s3.mjs --selftest && node judge/fake-openrouter.mjs --selftest` - Expected: each prints `selftest ok`. The S3 self-test uploads a `createReadStream` through `@aws-sdk/client-s3` (run from the repo root so `node_modules` resolves, `R2_ENDPOINT` style endpoint, `forcePathStyle`) and asserts the stored bytes equal the file; a raw-HTTP PUT self-test is not enough.
- [ ] Step 3: Commit - `git add judge && git commit -m "judge: fake S3, fake OpenRouter, fixtures"`

---

### Task 6: Judge, part 2 - scenarios and runner

**Files:**
- Create: `judge/run.mjs`
- Create: `judge/scenarios/web.mjs`
- Create: `judge/scenarios/pipeline.mjs`
- Create: `judge/scenarios/crypto-compat.mjs`
- Create: `src/judge-web.ts`
- Modify: `src/judge-cli.ts`
- Create: `judge/golden/` (recorded from the Node bot)

**Interfaces:**
- Consumes: env `R2_ENDPOINT`, `OPENROUTER_BASE_URL` (Task 3); CLI `node --import tsx src/judge-cli.ts <process|recover|verify-pin|verify-access|bangkok|duration> ...` (Task 4/6); `startFakeS3()`, `startFakeOpenRouter(script?)`, `makeMeetingFixture(dataDir, s3)` (Task 5, signatures there).
- Produces: `node judge/run.mjs --impl node|rust [--record-golden]` prints one line per scenario `PASS|FAIL <name>` and a final `N/N`. Exit 0 only if all pass. `--impl rust` starts `rust/target/release/meetbot` (server) and `rust/target/release/judge-cli`.
- Implementation commands: node server `node --import tsx src/index.ts` is NOT used (needs Discord). The judge instead starts the web server through a tiny entry `src/judge-web.ts` that calls `startWebServer()` (Create it in this task; 3 lines) and the Rust equivalent `meetbot web-only` (Task 13).

**Scenarios (each one asserts the same expected values against either implementation):**
1. `web/pin-gate`: `GET /m/{id}` without cookie returns 200 with `name="pin"` and no `<audio`; `GET /m/{id}/file/audio` returns 303 with `location: /m/{id}`.
2. `web/login-and-files`: correct PIN returns 303 to `/m/{id}`; `set-cookie` matches `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/m/{id}`, `Max-Age=43200` (normalize the cookie value); player page contains `<audio`, `/file/audio`, `/file/summary`, `/file/transcript`, two `/file/track/<id>` links in join order (`900000000000000002` before `100000000000000001`); `GET /file/audio` returns 302 whose `location` host/path equals the fake S3 and key `meetings/{id}/meeting.mp3` (normalize query); `?download=1` has `response-content-disposition=attachment; filename*=UTF-8''meeting-2026-12-31.mp3` in the query.
3. `web/lockout`: 5 wrong PINs from one IP give 401 with the messages `PIN ไม่ถูกต้อง (เหลือ 4 ครั้ง)`, then 3, 2, 1, and the 5th gives `(เหลือ 0 ครั้ง)`; the 6th attempt (even with the correct PIN) gives 429 with `ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ 15 นาที` (`src/web/server.ts:35-53, 127-134`); a different IP is not locked; with `TRUST_PROXY=true` the IP comes from the first `X-Forwarded-For` entry.
4. `web/security-headers`: all five headers, exact CSP, on 200, 303, 404 responses; invalid id (`/m/short`) gives 404; `processing` status gives 404.
5. `web/html-snapshot`: the PIN page and the player page HTML are byte-equal after whitespace normalization to golden files in `judge/golden/` recorded from the Node implementation (Task 6).
6. `pipeline/happy`: run `judge-cli process` with fixtures and fake services. Assert: the set of R2 keys written equals `{manifest, tracks/900000000000000002.ogg, tracks/100000000000000001.ogg, meeting.mp3, transcript.txt, summary-full.md, summary-short.md, segments/*}`; `transcript.txt` equals the golden; fake OpenRouter saw the same STT calls as a sorted multiset of `(model, sha256 of the decoded WAV input_audio.data)` (STT runs up to 4 jobs concurrently, so arrival order is not asserted); chat calls are sequential, so their order, models, system prompts and user prompts are compared exactly; chat requests have the same system prompt and user prompt text; final manifest JSON deep-equals the golden after replacing `pin.salt/hash`; `ffprobe` of `meeting.mp3` reports codec `mp3`, 1 channel, duration within 50 ms of the golden; each `.ogg` reports codec `opus`; the decoded PCM of `meeting.mp3` has `astats` overall RMS and peak within 0.5 dB of the golden (this is what catches an `amix` normalization change); `judge-publish.json` deep-equals the golden.
7. `pipeline/fallback`: fake OpenRouter returns HTTP 400 (not 500, which would sleep 2 s + 6 s per model per chunk in `withRetry`, `openrouter.ts:28-30`) for the primary transcribe model only; assert exactly 2 calls to the primary model per chunk (verbose request, then the plain retry, `openrouter.ts:78-85`) and then the fallback model's calls (the judge cannot see `modelsUsed`, it is only logged, `run.ts:46`); all-models-fail yields the `[ถอดเสียงช่วงนี้ไม่สำเร็จ]` mark and the publish note `ถอดเสียงไม่สำเร็จ N จาก M ช่วง`. This 400 scenario is also what catches a `retryable` change.
8. `pipeline/short-summary-limit`: three sub-cases against `src/pipeline/summarize.ts:80-90`: (a) first reply exactly 1500 chars: assert 2 short-summary chat calls (the second, 800-char ask, is made); (b) first reply exactly 1499 chars: assert 1 call; (c) both replies 1600 chars with newlines: assert the final text is at most 1499 chars, ends with `…`, and cuts at the last line break when that is past 60% of the limit.
9. `pipeline/empty`: a manifest with no utterances produces `full = "# สรุปการประชุม\n\nไม่พบเสียงพูดในการบันทึกนี้"` and no chat calls.
10. `pipeline/segment-from-r2`: delete the local PCM of one uploaded segment, pre-seed the FLAC in the fake S3, assert the result is identical (`src/pipeline/assemble.ts:14-28`).
11. `recovery/closes-at-heartbeat`: a `status: "recording"` manifest on disk is closed at `heartbeatAt`, `recovered: true`, `endReason: "the bot restarted during the meeting"`, utterances beyond the end clipped (`src/pipeline/run.ts:96-115`). Entry: `judge-cli recover`.
12. `crypto/golden-vectors`: golden vectors recorded once from Node into `judge/golden/crypto.json`: a `{salt,hash}` for PIN `123456`, a cookie value with a far-future expiry (`verifyAccess` rejects expired values, `pin.ts:35`), and one malformed cookie (bad base64, non-numeric expiry). Each implementation must verify the good vectors and reject the wrong PIN and the malformed cookie. Entry: `judge-cli verify-pin <pin> <salt> <hash>` and `judge-cli verify-access <id> <value> <secret>`. The reverse direction (Rust signs or hashes, Node verifies) runs once in Task 17 while both implementations exist, via `judge/cross-crypto.mjs`.
13. `time/format`: `judge-cli bangkok <ms>` and `judge-cli duration <seconds>` outputs equal for 40 fixed inputs (include a year boundary, 00:00 Bangkok, 12 h boundary, 0 s, 59 s, 3600 s, 3725 s).

**Mutations:** Task 7 mutates the Node source with patch files in `judge/mutations/*.patch`; the runner itself has no mutation switch.

**Steps:**
- [ ] Step 1: Add `src/judge-web.ts` (`import { startWebServer } from "./web/server.js"; startWebServer();`) and extend `src/judge-cli.ts` with the `recover`, `verify-pin`, `sign-access`, `verify-access`, `bangkok`, `duration` subcommands calling the existing functions.
- [ ] Step 2: Implement the runner and scenarios.
- [ ] Step 3: Verify - Run: `npm run typecheck && node judge/run.mjs --impl node --record-golden` - Expected: scenarios 1-4 and 6-13 PASS on first run, and `judge/golden/` is created. Scenario 5 is skipped on `--record-golden`.
- [ ] Step 4: Verify - Run: `node judge/run.mjs --impl node` - Expected: `13/13` PASS twice in a row (determinism).
- [ ] Step 5: Commit - `git add judge src/judge-web.ts src/judge-cli.ts && git commit -m "judge: portable parity scenarios and goldens from the Node bot"`

---

### Task 7: Judge validation (known answers and mutations)

**Interfaces:**
- Consumes: `node judge/run.mjs --impl node|rust [--record-golden]` (Task 6, exit 0 only if all scenarios pass). Produces: `node judge/validate.mjs` printing `caught <mutation> by <scenario>` per mutation, exit 0 only if all six are caught.

**Files:**
- Create: `judge/mutations/*.patch` (one per mutation)
- Create: `judge/validate.mjs`
- Create: `migration/judge-report.md`

**Steps:**
- [ ] Step 1: Write six mutation patches against the Node source, each a one-line behavior change: (1) `MAX_FAILS = 5` to `6` in `src/web/server.ts` (scenario 3); (2) CSP string changed; (3) `retryable` accepts 400 in `openrouter.ts` (scenario 7, 400 call count); (4) `SHORT_MAX = 1499` to `1500` (scenario 8a/8b); (5) `mergeGap: 2 * SAMPLE_RATE` to `3 * SAMPLE_RATE` in `plan.ts` (the 2.5 s pause fixture changes the STT audio hash); (6) `amix ... normalize=0` to `normalize=1` in `assemble.ts` (scenario 6 loudness check).
- [ ] Step 2: `judge/validate.mjs` applies each patch, runs `node judge/run.mjs --impl node`, asserts at least one scenario FAILS, reverts with `git apply -R <patch>` (never `git checkout -- src`, which would wipe uncommitted work), and prints `caught <name> by <scenario>`.
- [ ] Step 3: Two adversarial reviewers: spawn two fresh subagents (Opus 5.5, thinking medium, per the user's reviewer-model preference) with disjoint scenario batches (1-7 and 8-13). Brief: "Compare each scenario to the original test or source behavior it claims to cover (`src/web/server.test.ts`, `src/pipeline/run.test.ts`, `src/pipeline.test.ts`, `src/bot.test.ts`, and `src/**` for untested behavior). Report any weakened assertion: loosened tolerance, dropped field, truthy where exact was possible." Fix every confirmed finding and re-run Step 2 of Task 6.
- [ ] Step 4: Write `migration/judge-report.md`: portable vs internal-bound test counts as a receipt (`rg -c "^test\(" src --glob '*.test.ts'`), clean-pass line `13/13`, six caught mutations, reviewer findings.
- [ ] Step 5: Verify - Run: `node judge/validate.mjs && git status --short src | wc -l` - Expected: six lines starting `caught`, then `0` (source restored).
- [ ] Step 6: 👤 Verify - Human: read `migration/judge-report.md`, sign off that the judge is real before Task 9 (the kit's gate). Proxy: Step 5 shows 6/6 mutations caught and 13/13 clean pass.
- [ ] Step 7: Commit - `git add judge migration && git commit -m "judge: validate against mutations and reviewers"`

---

### Task 9: Rust scaffold, config, util

**Files:**
- Create: `rust/Cargo.toml` (`[package] name = "meetbot"`; binaries are discovered by file name, with no explicit `[[bin]]` entries: `src/main.rs` is `meetbot`, `src/bin/judge-cli.rs` is `judge-cli` (created in Task 12), `src/bin/register-commands.rs` is `register-commands` (created in Task 15)), `rust/rust-toolchain.toml` (pin the toolchain seen in Preflight), `rust/src/lib.rs`, `rust/src/main.rs`, `rust/src/config.rs`
- Create: `rust/src/util/{mod.rs,log.rs,time.rs,wav.rs,pin.rs,ffmpeg.rs,limit.rs}`


**Interfaces:**
- Produces (frozen, later tasks consume):
  - `pub struct AppState { pub config: Config, pub s3: S3Client, pub http: reqwest::Client }` built once in `main` and passed as `Arc<AppState>` to `create_app`, the pipeline functions and the session; tests build their own `AppState` (own stub URLs for `R2_ENDPOINT` and `OPENROUTER_BASE_URL`), so tests run in parallel with no global config and no `env::set_var`. `pub fn load_config(env: &HashMap<String,String>) -> Result<Config, String>` (multi-line error shaped like `src/config.ts:54-60`); `main` calls it with `std::env::vars()`. A later task's I/O function listed without an `AppState` argument takes `&AppState` (or `Arc<AppState>`) as its first parameter; adding it is NOT a changed `Produces:` signature and does not trigger the STOP rule. A global `config()` does NOT exist.
  - Constants stay module-level: `SAMPLE_RATE`, `BYTES_PER_SAMPLE`, `SEGMENT_SECONDS`, `SEGMENT_SAMPLES` below. Only functions that do I/O (S3, HTTP, ffmpeg paths from config, Discord) take the state; pure functions (`plan.rs`, `pin`, `time`, `wav`, `build_minutes_message`, `choose_output_channel`) do not.
  - (superseded) `pub fn config() -> &'static Config` (panics at boot with the same multi-line message as `src/config.ts:54-60` when invalid); `pub const SAMPLE_RATE: u32 = 24_000; BYTES_PER_SAMPLE: usize = 2; SEGMENT_SECONDS: u32 = 300; SEGMENT_SAMPLES: u64 = 7_200_000`.
  - `pub fn hms(total_seconds: f64) -> String`, `pub fn duration_th(total_seconds: f64) -> String`, `pub fn bangkok_date_time(ms: u64) -> String`
  - `pub fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8>`
  - `pub fn generate_pin() -> String`, `pub fn hash_pin(pin: &str) -> PinHash { salt: String, hash: String }`, `pub fn verify_pin(pin: &str, salt: &str, hash: &str) -> bool`, `pub fn new_session_id() -> String`, `pub fn is_session_id(s: &str) -> bool`, `pub fn sign_access(session_id: &str, secret: &str, ttl_ms: u64) -> String`, `pub fn verify_access(session_id: &str, value: Option<&str>, secret: &str) -> bool`
  - `pub async fn ffmpeg(args: &[&str]) -> Result<(), FfmpegError>`, `pub fn raw_input(path: &str) -> Vec<String>`
  - `pub fn logger(scope: &'static str) -> Logger` with `info/warn/error(&self, msg: &str, extra: Option<&dyn std::fmt::Display>)`.
  - `pub async fn sleep_ms(ms: u64)`.

**Gotcha:** Node `scryptSync(pin, salt, 32)` passes the salt STRING (base64url text) as UTF-8 bytes, not decoded bytes (`src/util/pin.ts:11,17`). Rust must pass `salt.as_bytes()`. `Params::new(14, 8, 1, 32)`. Also `Number("12.5")`-style env coercions: `z.coerce.number().int()` rejects fractions for ports and concurrency; `positive()` accepts fractions for the minute settings. Mirror each.

**Steps:**
- [ ] Step 1: Create the crate and add dependencies listed in the rulebook (`cargo add` each; features as in the rulebook).
- [ ] Step 2: Port each util file. Reference for `verify_pin`:
      ```rust
      pub fn verify_pin(pin: &str, salt: &str, hash: &str) -> bool {
          if pin.len() != 6 || !pin.bytes().all(|b| b.is_ascii_digit()) { return false; }
          let mut out = [0u8; 32];
          scrypt::scrypt(pin.as_bytes(), salt.as_bytes(), &scrypt::Params::new(14, 8, 1, 32).unwrap(), &mut out).unwrap();
          let Ok(expected) = URL_SAFE_NO_PAD.decode(hash) else { return false };
          expected.len() == out.len() && bool::from(out.ct_eq(&expected[..]))
      }
      ```
- [ ] Step 3: Port the unit tests that exist for these utilities (grep `src/pipeline.test.ts` for `hms`, `pcmToWav`, `truncate`, and the PIN/cookie tests at ~L160-178) as `#[cfg(test)]` modules, plus golden tests for `bangkok_date_time` using the 40 inputs from judge scenario 13.
- [ ] Step 4: Verify - Run: `cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` - Expected: 0 warnings, all tests pass (at least 12), 0 fail.
- [ ] Step 5: Commit - `git add rust .gitignore && git commit -m "rust: scaffold, config, and utilities"`

---

### Task 10: Rust storage and pure planning

**Files:**
- Create: `rust/src/storage/{mod.rs,manifest.rs,r2.rs}`, `rust/src/pipeline/{mod.rs,plan.rs}`, `rust/tests/manifest_compat.rs`

**Interfaces:**
- Consumes: Task 9 produces.
- Produces:
  - `pub struct Manifest {...}` with fields and JSON names exactly as `src/storage/manifest.ts:23-50` (`guild_id` serializes as `guildId`, etc.); `pub enum MeetingStatus { Recording, Processing, Done, Failed }` serialized lowercase; `pub struct Utterance { start: u64, end: u64 }`; `pub struct Participant { display_name: String, utterances: Vec<Utterance>, segments: Vec<u32>, uploaded: Vec<u32> }`.
  - `pub fn meeting_dir(id: &str) -> PathBuf`, `pub fn save_local(m: &Manifest) -> io::Result<()>` (tmp file then rename), `pub async fn save_everywhere(m: &Manifest) -> Result<()>`, `pub fn load_local(id: &str) -> Option<Manifest>`, `pub async fn load_remote(id: &str) -> Result<Option<Manifest>>`, `pub fn unfinished_local() -> Vec<Manifest>`.
  - `pub mod keys` (same strings), `pub async fn put_file(key: &str, path: &Path, content_type: &str) -> Result<()>`, `put_text(key, body, content_type)`, `get_text(key) -> Result<Option<String>>`, `download_to(key, path)`, `presign(key: &str, download_name: Option<&str>, seconds: u64) -> Result<String>`.
  - `plan.rs`: `PlanOptions`, `DEFAULT_PLAN`, `Piece`, `Chunk`, `Line`, `build_turns`, `pack_chunks`, `to_session_sample`, `merge_lines` with the signatures of `src/pipeline/plan.ts` (`maxJoinGap` default `45 * SAMPLE_RATE`).

**Gotcha:** Node's `JSON.stringify(m)` of `pin` and `outputs` omits `undefined` fields; Rust must `skip_serializing_if`. Unknown extra fields in old manifests must be tolerated (`#[serde(default)]`, no `deny_unknown_fields`). `presign` must apply `ResponseContentDisposition` as `attachment; filename*=UTF-8''{percent-encoded name}` (`src/storage/r2.ts:71-73`), where percent-encoding matches JS `encodeURIComponent` (unreserved set `A-Za-z0-9-_.!~*'()`).

**Steps:**
- [ ] Step 1: Implement and port tests: every `buildTurns/packChunks/toSessionSample/mergeLines` test in `src/pipeline.test.ts` becomes a Rust unit test with the same inputs and expected values.
- [ ] Step 2: Add `rust/tests/manifest_compat.rs`: deserialize a Node-written manifest (copy of `judge/golden` manifest) and re-serialize; assert JSON equality after parsing both to `serde_json::Value` with `preserve_order` on, and assert `participants` key order is unchanged. Required manifest fields use `#[serde(default)]` where Node never validated them (`loadRemote` is an unchecked cast, `src/storage/manifest.ts:73-76`; the ported web fixtures omit `guildId`, `commandChannelId`, `startedBy`).
- [ ] Step 3: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test` - Expected: 0 warnings, all pass, including the ported `plan` tests and `manifest_compat`.
- [ ] Step 4: Commit - `git add rust && git commit -m "rust: storage, manifest, and plan modules"`

---

### Task 11: Rust OpenRouter client, transcription, summaries

**Files:**
- Create: `rust/src/pipeline/{openrouter.rs,transcribe.rs,summarize.rs}`

**Interfaces:**
- Consumes: Tasks 9-10 produces.
- Produces: `pub async fn transcribe(wav: &[u8]) -> Result<SttResult>` where `SttResult { model: String, text: String, segments: Option<Vec<SttSegment>> }`; `pub async fn chat(messages: &[ChatMessage], max_tokens: u32) -> Result<ChatReply { model, text }>`; `pub async fn transcribe_meeting(m: &Manifest, raw_tracks: &IndexMap<String,PathBuf>) -> TranscriptResult { lines, text, models_used, failed_chunks, total_chunks }`; `pub fn format_transcript(m, lines) -> String`; `pub fn speaker_name`; `pub async fn full_summary(m, transcript) -> Result<ChatReply>`; `pub async fn short_summary(m, full) -> Result<ChatReply>`; `pub fn truncate(text: &str, limit: usize) -> String`; `pub const SHORT_MAX: usize = 1499`.

**Gotcha:** `transcribe_meeting` collects job results in job order (`join_all`), never completion order, because `mergeLines` is a stable sort that breaks ties by input order (`src/pipeline/plan.ts:103`). String lengths: JS `text.length` counts UTF-16 code units, Rust `len()` counts bytes, `chars().count()` counts code points. Thai characters are BMP, so UTF-16 units equal code points. Use `text.chars().count()` for `SHORT_MAX` checks and for `truncate` slicing; emoji outside the BMP would differ by one, note it as `BUG(port)` and cover with a test.
The system prompts (Thai) are copied verbatim from `src/pipeline/summarize.ts:8-14` and the user prompts including all newlines; the judge compares them exactly.
Request timeouts: transcription 180 s, chat 600 s. First STT request includes `response_format: "verbose_json"` and `timestamp_granularities: ["segment"]`; on HTTP 400 retry without both.

**Steps:**
- [ ] Step 1: Implement the three modules. `reqwest::Client` built once. Retry helper mirrors `withRetry` (`[2000, 6000, 15000]` ms waits, 3 attempts).
- [ ] Step 2: Port tests from `src/pipeline/run.test.ts` that cover fallback and failure marks (that file uses HTTP 400 for the primary model, ~L75), using a local `axum` stub server on an ephemeral port as the OpenRouter (set `OPENROUTER_BASE_URL`).
- [ ] Step 3: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test -- openrouter transcribe summarize` - Expected: all pass, 0 fail.
- [ ] Step 4: Commit - `git add rust && git commit -m "rust: openrouter client, transcription, summaries"`

---

### Task 12: Rust assemble, publish, run orchestrator, `judge-cli`

**Files:**
- Create: `rust/src/pipeline/{assemble.rs,publish.rs,run.rs}`, `rust/src/bin/judge-cli.rs`, `rust/tests/pipeline.rs`

**Interfaces:**
- Consumes: Tasks 9-11 produces; `serenity::http::Http` for sending.
- Produces:
  - `assemble.rs`: `pub fn total_samples(m: &Manifest) -> u64`, `pub async fn build_raw_tracks(m: &Manifest) -> Result<IndexMap<String, PathBuf>>`, `pub async fn encode_tracks(raw: &IndexMap<String,PathBuf>) -> Result<IndexMap<String,PathBuf>>`, `pub async fn mix_tracks(m: &Manifest, raw: &IndexMap<String,PathBuf>) -> Result<PathBuf>`.
  - `publish.rs`: `pub fn choose_output_channel(channels: &[ChannelInfo], minutes: &str, fallback: &str, command_channel: Option<ChannelId>) -> Option<ChannelId>` (pure; `ChannelInfo { id, name, is_text_or_announcement, can_post }`; order: minutes channel, fallback channel, command channel, as `src/pipeline/publish.ts:30-46`), `pub fn build_minutes_message(m: &Manifest, o: &MinutesOpts) -> MinutesMessage` (serializes to the same JSON as Task 4's `buildMinutesMessage`), `pub async fn publish_minutes(http: &Http, cache: &Cache, m: &Manifest, o: &MinutesOpts) -> Result<String>`, `pub async fn notify_failure(...)`, `pub async fn find_output_channel(...)`.
  - `run.rs`: `pub async fn process_meeting(ctx: Arc<AppState>, m: Manifest)` (concurrency 2 via `Semaphore`), `pub async fn recover_unfinished(ctx: Arc<AppState>)`, `pub async fn run_pipeline(m: &mut Manifest, pin: &str) -> PipelineOut` (the same body the CLI uses).
  - `judge_cli` subcommands identical to Task 6: `process`, `recover`, `verify-pin`, `sign-access`, `verify-access`, `bangkok`, `duration`.

**Gotcha:** `build_raw_tracks` must keep the sparse-file trick: skip all-zero 1 MiB blocks, `set_len(total * 2)` first (`src/pipeline/assemble.ts:44-71`). ffmpeg arguments must be identical to `src/pipeline/assemble.ts:80-97` and `src/util/ffmpeg.ts:20` (`-f s16le -ar 24000 -ac 1`, `libopus -b:a 32k -application voip`, `amix=...:normalize=0,alimiter=limit=0.95`, `libmp3lame -b:a 64k`).

**Steps:**
- [ ] Step 1: Implement. Port ALL six `src/pipeline/run.test.ts` cases, including `findOutputChannel` order/permissions (tests 4 and 5 there, against `choose_output_channel`) and the `notifyFailure` text, plus happy path with tone audio through real ffmpeg and recovery as `rust/tests/pipeline.rs` using the fake S3 from Task 5 started as a child Node process, or a small `axum` S3 stub inside the test crate (pick the stub; no Node dependency in `cargo test`).
- [ ] Step 2: Build release binaries: `cd rust && cargo build --release --bins`.
- [ ] Step 3: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test --test pipeline` - Expected: 0 warnings, all pass.
- [ ] Step 3b: Verify - Run: `node judge/run.mjs --impl rust 2>&1 | tail -20` - Expected: scenarios 6-13 PASS; scenarios 1-5 FAIL or SKIP only because the web server is not built yet (Task 13). List any other FAIL, fix it in Rust, never in the judge unless the judge is proven wrong against the Node run.
- [ ] Step 4: Commit - `git add rust && git commit -m "rust: assemble, publish, pipeline orchestrator, judge-cli"`

---

### Task 13: Rust web server

**Files:**
- Create: `rust/src/web/{mod.rs,server.rs,templates.rs}`, `rust/tests/web.rs`
- Modify: `rust/src/main.rs` (anchor: `fn main`; add `web-only` subcommand starting only the web server)

**Interfaces:**
- Consumes: Tasks 9-10 produces.
- Produces: `pub fn create_app() -> axum::Router`, `pub async fn start_web_server()`; routes `GET /healthz`, `GET /m/{id}`, `POST /m/{id}`, `GET /m/{id}/file/{kind}` and `/m/{id}/file/{kind}/{user_id}`.

**Gotcha:** Hono's `c.redirect(url, 303)` and `302` map to `axum::response::Redirect::to` (303) and a manual `302` with `Location`. `templates.rs` must output the same HTML as `src/web/templates.ts` including the `esc()` set `& < > " '`. Cookie `Path=/m/{id}`, `Max-Age=43200`. Wrong PIN message `PIN ไม่ถูกต้อง (เหลือ N ครั้ง)`; locked message `ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ 15 นาที` (`src/web/server.ts:140-148`). The 1-minute manifest cache applies only to `done` manifests. The lockout map is pruned every 10 minutes.

**Steps:**
- [ ] Step 1: Port `src/web/server.test.ts` (all 6 tests) to `rust/tests/web.rs` with `tower::ServiceExt::oneshot`.
- [ ] Step 2: Implement.
- [ ] Step 3: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test --test web` - Expected: 6 pass, 0 fail.
- [ ] Step 4: Verify - Run: `cd rust && cargo build --release --bins && cd .. && node judge/run.mjs --impl rust 2>&1 | tail -16` - Expected: `13/13` PASS (including scenario 5 against the Node-recorded HTML goldens).
- [ ] Step 5: Commit - `git add rust && git commit -m "rust: playback web server"`

---

### Task 14: Rust recorder (track writer, uploader)

**Files:**
- Create: `rust/src/recorder/{mod.rs,track_writer.rs,segment_uploader.rs}`

**Interfaces:**
- Consumes: Tasks 9-10 produces.
- Produces:
  - `pub fn segment_path(user_dir: &Path, index: u32) -> PathBuf` (`0000.pcm` style, 4-digit zero pad).
  - `pub struct TrackWriter`: `new(user_dir: PathBuf, on_segment_touched: Box<dyn FnMut(u32) + Send>) -> io::Result<Self>`, `cursor: u64` (pub field), `speaking(&self) -> bool`, `begin_utterance(&mut self, expected_sample: u64)`, `write(&mut self, pcm: &[u8]) -> io::Result<()>`, `end_utterance(&mut self) -> Option<Utterance>`, `open_segments(&self) -> Vec<u32>`, `touched_segments(&self) -> Vec<u32>`, `close_segment(&mut self, index: u32, length_samples: u64) -> io::Result<PathBuf>`, `close_all(&mut self)`.
  - `pub struct SegmentUploader`: `new(manifest: Arc<Mutex<Manifest>>)`, `enqueue(&self, user_id: &str, index: u32, raw_path: PathBuf)`, `async drain(&self)`; serial queue (a `tokio::sync::mpsc` consumer task), failures logged not fatal, FLAC temp file removed in all cases (`src/recorder/segment-uploader.ts:28-44`).

**Gotcha:** `begin_utterance` rule `start = max(cursor, floor(expected))` and `write` splitting at segment boundaries must match `src/recorder/track-writer.ts:48-70` exactly. Positional writes with `FileExt::write_at`.

**Steps:**
- [ ] Step 1: Port the track-writer tests from `src/bot.test.ts` (`each speaker gets their own track, placed at the real time they spoke`, `finished 5-minute segments are backed up`) at the unit level: feed PCM and assert file contents and returned utterances. Add boundary cases: utterance exactly at 7_200_000, utterance spanning two segments, `expected_sample` earlier than `cursor`, `close_segment` padding for a short last segment.
- [ ] Step 2: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test recorder` - Expected: all pass, 0 fail.
- [ ] Step 3: Commit - `git add rust && git commit -m "rust: track writer and segment uploader"`

---

### Task 15: Rust session, interactions, main

**Files:**
- Create: `rust/src/recorder/session.rs`, `rust/src/interactions.rs`, `rust/src/commands.rs`, `rust/src/bin/register-commands.rs`
- Modify: `rust/src/main.rs` (anchor: `fn main`; full bot startup, signal handling)

**Interfaces:**
- Consumes: Tasks 9-14 produces.
- Produces:
  - `pub struct MeetingSession` with `pub async fn start(opts: StartOpts) -> Result<Arc<MeetingSession>>`, `pub async fn end(&self, reason: &str)` (idempotent), `pub async fn handle_continue(&self, click: ContinueClick)`, `pub fn check_empty(&self)`, `pub fn id(&self) -> &str`, `pub fn manifest(&self) -> Manifest` (snapshot).
  - `pub static ACTIVE_SESSIONS` keyed by `GuildId`.
  - `pub const CONTINUE_BUTTON_PREFIX: &str = "meeting-continue:"`.
  - Slash commands `record` and `end` registered with the same names, descriptions, and guild-only context as `src/commands.ts:4-10`.
  - Messages (exact English strings from `src/interactions.ts:21-90`): "Join a voice channel first, then use /record.", "I am already recording in **{name}**. Use /end there first.", "I don't have permission to join **{name}**.", "I couldn't join the voice channel. Please try again.", "I am recording the voice in channel {name}" (and `🔴 ` prefixed copy in the voice channel chat when it differs), "Nothing is being recorded right now.", and the `/end` reply.

**Gotcha:** Behavior to preserve, each with its source:
- Segment close rule on each 15 s tick: `index < safeBoundary && (!writer.speaking || writer.cursor >= segEnd)` where `safeBoundary = floor((nowSample - 15*24000) / 7_200_000)` (`src/recorder/session.ts:225-236`).
- Heartbeat updated and manifest saved locally every tick.
- Reconnect: on `Disconnected`, wait up to 5 s for Signalling or Connecting, else end with "the bot was disconnected from the voice channel" (`session.ts:131-141`). songbird auto-reconnects by default; map this to the driver's `DriverDisconnect` / `DriverReconnect` events.
- `end()`: clear timers, edit prompt message to `Recording ended: {reason}.`, flush open utterances, destroy the connection, compute `endedAt` from `max(nowSample, writers' cursors)`, close and enqueue every open segment (last one cut to `endSample - index*7_200_000` samples), `drain`, status `processing`, save everywhere (fall back to local on error), call `on_finished` (`session.ts:318-361`).
- Auto-end rules: continue prompt after `CONTINUE_PROMPT_AFTER_MIN` with a button `Continue recording`, ends after `CONTINUE_PROMPT_TIMEOUT_MIN`; Continue resets the cycle; empty channel (humans only, bots excluded) for `EMPTY_CHANNEL_TIMEOUT_MIN` ends (`session.ts:246-308`).
- Utterance rule from the rulebook replaces the per-user `receiver.subscribe`.
- Shutdown: on SIGINT/SIGTERM end all active sessions, then exit (`src/index.ts:25-31`). Recovery runs once at `ready`.
- Intents: `GUILDS | GUILD_VOICE_STATES` only.

**Steps:**
- [ ] Step 1: Implement `session.rs` with a `VoiceTick` handler feeding a per-user state machine (`Idle`, `Speaking { last_packet_ms }`) and a 20 ms-resolution timer check for the 1000 ms silence rule.
- [ ] Step 2: Port ALL 12 tests of `src/bot.test.ts` at session level (the 2 recording tests too: bots ignored, meeting length includes the last words, segment closes on the 15 s tick, `uploaded:[0]` lands in the R2 manifest mid-meeting; plus the R2-down-at-`/record` test, `bot.test.ts:280`) using `tokio::time::pause()`, a scripted `VoiceTick` source, and one `DiscordPort` trait covering interaction replies (reply, defer, edit), member voice-channel lookup, permission check, channel send and fetch. No other abstraction over serenity. `handle_continue` takes a `ContinueClick { user_name: String, reply: Box<dyn Reply> }` built from the serenity interaction in `interactions.rs`, not the concrete serenity type. Add the lost-packet test (`packet: None` with 1920 decoded samples must not move the cursor).
- [ ] Step 3: Verify - Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test --test session` - Expected: 13 pass, 0 fail (12 ported `bot.test.ts` tests plus the lost-packet test). Put all session tests in `rust/tests/session.rs` and run `cargo test --test session` so the count is exact.
- [ ] Step 4: Verify - Run: `cd rust && cargo build --release --bins && ls target/release | grep -E '^(meetbot|register-commands|judge-cli)$' | wc -l` - Expected: `3`.
- [ ] Step 5: Commit - `git add rust && git commit -m "rust: recording session, interactions, bot entry"`

---

### Task 16: Container and compose for the Rust bot

**Files:**
- Modify: `rust/src/main.rs` (anchor: `fn main`; `healthcheck` subcommand)
- Create: `rust/Dockerfile`
- Create: `docker-compose.rust.yml`
- Modify: `.dockerignore` (anchor: first line; add `rust/target`)

**Interfaces:**
- Produces: image `meeting-bot-rust` exposing 8787, same env file, same `meeting-data` volume contract (`DATA_DIR=/data`), same `stop_grace_period: 60s`, healthcheck hitting `/healthz`, binds `127.0.0.1:8787` (`docker-compose.yml:11-12`).

**Gotcha:** the runtime stage needs `ffmpeg`, `ca-certificates`, and libopus only if `opus2` links dynamically (check with `ldd target/release/meetbot`); prefer the crate's bundled static build if available. Run as non-root. The Node healthcheck is a `node -e fetch`; the Rust image has no node, so use a `meetbot healthcheck` subcommand that GETs `/healthz`.

**Steps:**
- [ ] Step 1: Write the multi-stage Dockerfile (`rust:1` build with `cargo build --release`, `debian:stable-slim` runtime).
- [ ] Step 2: Add `meetbot healthcheck` to `main.rs` (exit 0 on 2xx, else 1).
- [ ] Step 3: Verify - Run: `$CE build --format docker -f rust/Dockerfile -t meeting-bot-rust . && $CE run --rm meeting-bot-rust meetbot --version` - Expected: build exits 0 and prints a version line. `meetbot --version` prints `meetbot <Cargo package version>` (clap `version` attribute).
- [ ] Step 4: Commit - `git add rust docker-compose.rust.yml .dockerignore && git commit -m "rust: container image and compose file"`

---

### Task 17: Staging check and cutover decision

**Files:**
- Create: `migration/cutover-report.md`
- Create: `judge/cross-crypto.mjs`

**Interfaces:**
- Consumes: `judge-cli` of both implementations (Tasks 4, 12). Produces: `node judge/cross-crypto.mjs` printing `N/N` for the four cross directions (hash and cookie, each way).

**Steps:**
- [ ] Step 1: Verify - Run: `cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cd .. && npm run typecheck && npm test 2>&1 | tail -6 && node judge/run.mjs --impl node | tail -1 && node judge/run.mjs --impl rust | tail -1` - Expected: all green, Node `13/13`, Rust `13/13`, Node tests 31+ pass 0 fail.
- [ ] Step 2: Verify - Run: `node judge/validate.mjs | grep -c '^caught'` - Expected: `6` (judge still catches breakage after all changes).
- [ ] Step 3: 👤 Verify - Human: in the throwaway guild, run the Rust bot (`$CE compose -f docker-compose.rust.yml up`) with the staging env: `/record` with two people speaking for 6 minutes (crossing one 5-minute segment boundary), `/end`. Expected: announcement in the command channel and voice chat, post in `#meeting-of-minutes` within a few minutes with embed, PIN, `summary-full-*.md` and `transcript-*.txt`; the playback link asks for the PIN, plays mixed audio, seeks late in the file, and downloads per-speaker `.ogg`. Then kill the container with `$CE kill` mid-recording, restart it, and expect the meeting to be recovered and posted with the restart note. Proxy: Task 17 Step 1 (judge 13/13 covers the HTTP, R2, OpenRouter, and publish payload) and Task 15 Step 3 (ported session tests).
- [ ] Step 4: Verify - Manual: after the Human run, `ffprobe` the downloaded `meeting.mp3` and one `.ogg`; Expected: codecs `mp3` and `opus`, mixed duration within 2 s of the recorded length.
- [ ] Step 5: Write `migration/cutover-report.md`: judge results, human run notes, memory (RSS) and CPU of both bots during a 30-minute test (`$CE stats --no-stream`), and the go or no-go recommendation. This is where the "better performance" claim gets numbers; if the Rust bot is not measurably better on RSS or CPU, say so.
- [ ] Step 6: Verify - Run: `node judge/cross-crypto.mjs` - Expected: `4/4` (Rust hash verified by Node, Node hash by Rust, Rust cookie by Node, Node cookie by Rust).
- [ ] Step 7: Commit - `git add migration judge && git commit -m "migration: cutover report"`

**Rollback:** the staging run writes to a staging R2 bucket and a throwaway guild: delete the bucket prefix `meetings/` with the R2 lifecycle rule or `aws s3 rm --recursive` against the staging endpoint. No production data is touched.

---

### Task 18: Retire Node (only after the user signs off the cutover report)

**Files:**
- Delete: `src/`, `package.json`, `package-lock.json`, `bun.lock`, `tsconfig*.json`, `Dockerfile`, `diag-commands.mts` (keep `judge/` Node-only because it is the regression harness; give it its own `package.json` already created)
- Modify: `AGENTS.md`, `README.md`, `docker-compose.yml`
- Rollback: `git revert` of this commit restores the Node implementation; nothing outside git changes.

**Steps:**
- [ ] Step 1: Rewrite `AGENTS.md`: remove "Hard constraint: Node 22, not Bun" and replace with the Rust toolchain, the commands in Global Constraints, the architecture map pointing to `rust/src/`, and the judge commands. Keep Security, Gotchas, and Testing sections updated. Write each sentence on its own line.
- [ ] Step 2: Replace `docker-compose.yml` with the Rust compose file's content and update `README.md` commands.
- [ ] Step 3: Remove the Node files listed above, keep a git tag `node-final` on the commit before this one: `git tag node-final HEAD~0` before deleting.
- [ ] Step 4: Verify - Run: `cd rust && cargo test && cd .. && node judge/run.mjs --impl rust | tail -1` - Expected: all pass, `13/13` (the judge no longer has a Node implementation to compare to, so scenario goldens in `judge/golden/` are the reference).
- [ ] Step 5: Commit - `git add -A && git commit -m "retire the Node implementation"`

## Failure handling summary

- **Task 1 gate fails** - Detect: spike README says FAIL, or no intelligible PCM for the second speaker. Respond: STOP the plan, do not start Task 2, report the exact check that failed and upstream issue links.
- **Judge disagrees with Rust on a scenario** - Detect: `node judge/run.mjs --impl rust` shows FAIL while `--impl node` passes. Respond: treat Node as the spec, fix Rust; only change the judge if the same scenario is shown wrong against the original source, and then re-run `judge/validate.mjs`.
- **An API in this plan does not exist in the pinned crate** - Detect: `cargo check` error. Respond: correct minimally per the crate docs and record a `> Deviation:` under the task; if the change alters a `Produces:` signature, STOP and ask.
- **ffmpeg byte differences** - Detect: judge compares mp3 or ogg bytes. Respond: the judge compares codec, channels, and duration only, never bytes; do not loosen anything else.

## End-to-end verification

Run this section after Task 17 and before Task 18 (`validate.mjs` needs `src/`). The Manual item needs `node judge/fake-s3.mjs --serve <port>` (a standalone mode of the fake, added in Task 5 alongside `--selftest`).

- [ ] Run: `cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` - Expected: exit 0, 0 failures.
- [ ] Run: `node judge/run.mjs --impl rust | tail -1` - Expected: `13/13`.
- [ ] Run: `node judge/validate.mjs | grep -c '^caught'` - Expected: `6`.
- [ ] Manual: start the Rust web-only server against the fake S3 (`R2_ENDPOINT=<fake> meetbot web-only`), load a judge fixture meeting with Playwright, enter the PIN, and press play on the audio element - Expected: login succeeds, `audio.currentTime` advances, `audio.duration` is within 1 s of the fixture length.
- [ ] 👤 Human: the real-guild recording and kill-restart recovery described in Task 17 Step 3 - Expected: minutes posted with PIN, playable page, recovery note after restart - Proxy: the judge's `13/13` run above covers everything except live Discord voice and gateway behavior.
