# Translation Rulebook - TypeScript to Rust

> **The meta-rule: if two agents could answer a question differently, the answer goes in this file.**
> This document is read by every implementer, reviewer, and fixer before they touch code.
> It is read-only inside any loop - amendments are queued for the human and applied between batches.
>
> For a filled-in example at production scale, see Bun's [PORTING.md](https://github.com/oven-sh/bun/commit/46d3bc29f270fa881dd5730ef1549e88407701a5) (576 lines, Zig→Rust) - the shape below is that document, generalized.

Read this whole document before writing any code.

## 0. Scope and posture

- This is a **structure-preserving** migration: same architecture, same data structures, same file boundaries unless a rule below says otherwise.
  You are translating, not improving.
- Drafts must typecheck: run `cargo check` per task.
  `cargo check` is cheap in this repo, so the compiler grades work as it lands, not only at review.
- First pass optimizes for **correct translation**, not performance.
  Known slow-but-faithful translations are fine: mark them `PERF(port):` with one line on what the fast version would be, and move on.

## 1. Ecosystem adoption - what we use and what we ban

The target ecosystem will offer idiomatic alternatives for everything.
Decide once, here, which are adopted and which are banned - or every agent decides differently and the codebase becomes a museum of styles.

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

## 2. Constructs with no equivalent - one canonical mapping each

Every source construct the target lacks gets exactly one translation, listed here.
An implementer who invents a second mapping for a listed construct is violating a rule; a reviewer who sees an unlisted construct flags it for this table.

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

### Gap sites

Decisions about the gap sites below are made once, here.
This list replaces the kit's separate inventory, which nothing in this plan would check.
Each row names its Rust translation from the constructs table above.

| Gap site | Rust translation |
|---|---|
| shared mutable `manifest` mutated from session, uploader, and pipeline | one `Arc<Mutex<Manifest>>` per meeting, shared by `Arc` clones (the `activeSessions` row's locking shape) |
| the `activeSessions` global map | `Arc<Mutex<HashMap<GuildId, Arc<MeetingSession>>>>` in `recorder::session` |
| timer handles in `MeetingSession` | `tokio::task::JoinHandle` stored in the session; clear = `.abort()` |
| `participants[userId]!` non-null assertions (`rg -c '\]!' src`) | `IndexMap::get` returns `Option`; the same sites narrow it with `.expect("participant registered before use")` |
| `any` JSON from OpenRouter | `serde_json::Value` at the boundary, then typed `#[serde(rename_all = "camelCase")]` structs before use |
| `Buffer` PCM slices | `&[u8]` / `Vec<u8>` of little-endian `i16` samples (`i16::to_le_bytes` / `i16::from_le_bytes`) |

**The BUG rule:** when the source's behavior is itself defective (malformed output, crash), reproduce it bug-for-bug and mark the site `BUG(port):` with a repro - behavior matching asserts the defective output; fixes ship only in a flagged post-parity change.
The port's job is fidelity; improvement is a separate, reviewable commit.

**The file-name rule:** attachment and download file names use the UTC date (`new Date(startedAt).toISOString().slice(0,10)`, `src/pipeline/publish.ts:75`, `src/web/server.ts:153`), NOT the Bangkok date.
Port as is and mark the site `BUG(port):`.
The judge fixture starts at 17:30 UTC so the two dates differ.

**The UNKNOWN rule:** when neither this table nor the gap list decides a case, translate to the most conservative representation the target offers, mark it `TODO(port):` with the open question, and keep moving.
UNKNOWN is an answer; a stalled batch is not.

**The utterance rule:** write `decoded_voice` ONLY on ticks where `data.packet.is_some()` and the PCM is non-empty.
Songbird's loss concealment is wrong for mono 24 kHz (`songbird-0.6.1/src/driver/tasks/ssrc_state.rs:111-118` allocates a stereo 1920-sample frame, so one lost or DAVE-dropped packet yields 80 ms instead of 20 ms; verified in a scratch crate), and Node writes only received packets (`src/recorder/session.ts:194-205`).
An utterance starts on the first such tick and ends after 1000 ms without one.
This replaces `EndBehaviorType.AfterSilence, duration: 1000` (`src/recorder/session.ts:187`).
`TrackWriter` semantics (`beginUtterance(expectedSample)`, `max(cursor, expected)`) are unchanged.

**The voice rule:** bots are skipped (`member.user.bot`), `selfDeaf=false`, `selfMute=true`.

**The order rule:** judge comparisons must NOT sort object keys for `participants` and `outputs.tracks`; fixtures use ids whose join order differs from their sorted order.

## 3. The sanctioned escape hatch

Translations that can't be expressed safely get exactly one pressure valve, used visibly:

- The one platform-specific construct, `std::os::unix::fs::FileExt::write_at` (§2), is safe and needs no escape hatch.
- Every deferred decision carries a greppable marker: `TODO(port):`, `PERF(port):`, `BUG(port):`.
  These markers are the queue for later steps - the format is load-bearing, do not vary it.

## 4. Naming and output paths

Done-ness is detected by output files existing on disk, so these rules are what make the whole run resumable.
They are not style preferences.

- Source `src/<area>/<file>.ts` maps one-to-one to target `rust/src/<area>/<file>.rs`.
  The areas are `recorder`, `pipeline`, `storage`, `web`, `util`.
  One source file, one target file, no exceptions without a rule here.
- File and module names equal the TS file names with `_` for `-` (`track-writer.ts` becomes `track_writer.rs`).
- Module declarations live in `rust/src/lib.rs`; Rust `use` paths replace ESM specifiers, so the `.js` extension rule of the TypeScript repo does not carry over.
- Shared types have one home: config in `config.rs`, `Manifest` in `storage/manifest.rs`, R2 keys in `storage/r2.rs`, the logger in `util/log.rs`, the limiter in `util/limit.rs`.
  An unassigned shared type becomes incompatible local copies, so assign before the first use.
- Tests sit next to the code as `#[cfg(test)] mod tests` for pure units; HTTP tests go in `rust/tests/web.rs` against `create_app(...)`.

## 5. Deviation log

Every departure from the documented process gets one line here - skipped passes, waived checks, untriggered defaults.
ID'd `DEV-001` style: ID, date, what was skipped or waived, who sanctioned it.
Written at gates, by the human or with the human's sign-off.
A deviation nobody logged is a deviation nobody approved.

| ID | Date | Deviation | Sanctioned by |
|---|---|---|---|
| DEV-001 | 2026-10-27 | Tasks 2-7 started before Task 1 check (c) (second member joins mid-call, songbird issue 310) passed; Task 9 still waits for (c) | user |

## Rust engineering standard

Source: `migration/rust-best-practices.md` (copied from the user's gist on 2026-10-27).
It binds Tasks 9-17 with the tailoring below.
Where it conflicts with the BUG(port) rule, the BUG(port) rule wins: behavior parity with Node comes first.

Adopted as written:
- Newtypes for domain ids that cross module boundaries: `MeetingId` (validated against `SESSION_ID_RE` in its constructor), `SampleIndex` and `SampleCount` for PCM positions. Discord ids use serenity's `UserId`, `GuildId`, `ChannelId`.
- Enums instead of boolean flags or sentinel values (for example the meeting `status` and the end reason).
- `Result` with typed `thiserror` errors per module; `anyhow` only in `main.rs` and `src/bin/*`.
- No `unwrap()`, `expect()`, `panic!`, `todo!`, `unimplemented!`, `dbg!` outside tests (enforced by lints below).
- Checked arithmetic at trust boundaries: PCM byte offsets, WAV header sizes, chunk packing, manifest numbers read from R2.
- Validate external input in all builds; `debug_assert!` only for internal invariants, never with side effects.
- Bounded work: every queue, retry loop, and concurrent fan-out has an explicit limit taken from config (`TRANSCRIBE_CONCURRENCY`, retry counts as in Node).
- Borrow instead of clone by default; `Arc` only for state that is truly shared across tasks (`AppState`, the session map).
- `#![forbid(unsafe_code)]` in the crate.
- Comments explain why, not what; TODOs name a task or issue.

Tailored for this crate:
- Memory profile: the whole crate is **allocation-conscious** (an I/O-bound bot whose cost is ffmpeg and remote APIs).
  The strict-heapless and allocation-free-steady-state profiles, `no_std`, the `disallowed-types` allocation guardrails, and the `no_alloc` counting test do not apply.
  The voice-receive tick path should still reuse its per-user buffers rather than allocate per tick.
- `missing_docs` is off: this is an application crate with no public library API.
- Performance benchmarks are not merge gates; Task 17's resource comparison is the only performance check.

Lint and profile baseline for `rust/Cargo.toml`:

```toml
[lints.rust]
unsafe_code = "forbid"
unused_must_use = "deny"

[lints.clippy]
all = { level = "deny", priority = -1 }
pedantic = { level = "warn", priority = -1 }
dbg_macro = "deny"
expect_used = "deny"
panic = "deny"
todo = "deny"
unimplemented = "deny"
unwrap_used = "deny"
module_name_repetitions = "allow"
must_use_candidate = "allow"
missing_errors_doc = "allow"

[profile.release]
overflow-checks = true
```

`rust/clippy.toml`: `allow-unwrap-in-tests = true` and `allow-expect-in-tests = true`.
A local suppression uses `#[expect(lint, reason = "...")]` on the narrowest item.

Required checks for every Rust task commit (run in `rust/`):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```
