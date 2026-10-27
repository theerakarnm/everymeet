# Judge validation report (Task 7)

Date: 2026-10-27
Tree: branch `rust-migration`, Task 6 committed at 95989b3.
The judge is the portable referee between the Node bot and the Rust port.
This report records what it covers, what it caught, and what the adversarial review changed.

## Test-count receipt

`rg -c "^test\(" src --glob "*.test.ts"`:

| File | Tests | Portable? |
| --- | --- | --- |
| src/pipeline.test.ts | 7 | reference material: plan math, assemble, PIN, truncate, STT fallback are re-covered by judge scenarios 6, 8, 12, 13 |
| src/pipeline/run.test.ts | 6 | reference material: happy path, fallback, short limit, recovery re-covered by scenarios 6, 7, 8, 11 |
| src/web/server.test.ts | 6 | reference material: PIN gate, login, lockout, headers re-covered by scenarios 1-4 over real HTTP |
| src/bot.test.ts | 12 | internal-bound: mocks `@discordjs/voice` and the Discord REST surface via `mock.module`; ported as session-level tests in Task 15 instead |
| src/pipeline/publish.test.ts | 4 | reference material: publish payload re-covered byte-exactly by the `judge-publish.json` golden in scenario 6 |

Total: 35 Node tests, `npm test` reports 35 pass / 0 fail.
The judge replaces the portable parts of these files with 13 scenarios that run the real
processes over HTTP, a fake S3, a fake OpenRouter and real ffmpeg, so they also bind the Rust port.

## Clean pass

`node judge/run.mjs --impl node`: 13/13 PASS, exit 0, run twice back to back (deterministic).
After the review fixes below: 13/13 PASS again, twice.

## Caught mutations

`node judge/validate.mjs` applies each patch in `judge/mutations/` to the Node source,
runs the full judge, asserts at least one scenario FAILS, and reverts with `git apply -R`.

| Mutation | Change | Caught by |
| --- | --- | --- |
| max-fails-6.patch | `MAX_FAILS = 5` to `6` in src/web/server.ts | web/lockout |
| csp-media-http.patch | CSP `media-src` gained `http:` in src/web/server.ts | web/security-headers |
| retryable-400.patch | `retryable` accepts 400 in src/pipeline/openrouter.ts | pipeline/fallback |
| short-max-1500.patch | `SHORT_MAX = 1499` to `1500` in src/pipeline/summarize.ts | pipeline/short-summary-limit |
| merge-gap-3s.patch | `mergeGap: 2 * SAMPLE_RATE` to `3 * SAMPLE_RATE` in src/pipeline/plan.ts | pipeline/happy |
| amix-normalize-1.patch | `normalize=0` to `normalize=1` in src/pipeline/assemble.ts | pipeline/happy |

Result: `6/6 mutations caught`, exit 0, `git status --short src` empty after the run.

## Reviewer findings

The plan calls for two fresh reviewer subagents with disjoint batches (1-7 and 8-13).
Deviation: the executor ran the two reviews inline in this session (same reviewer, two
disjoint passes) because the orchestrator forbids spawning further agents.
Each scenario was compared against the original test or source behavior it claims to cover.

Confirmed findings, all fixed in `judge/scenarios/`:

- web/login-and-files never requested a track for a user missing from the manifest.
  Fixed: `file/track/someone-else` must give 404 (mirrors server.test.ts test 2).
- web/login-and-files had no cross-meeting cookie check.
  Fixed: a done manifest for a second meeting id is seeded, and the first meeting's
  cookie must get the PIN page there (mirrors server.test.ts test 3).
- pipeline/happy replaced `pin` with a placeholder before the golden compare, so the
  original assertions "the posted PIN verifies against the stored hash" and "the PIN
  itself is never stored" were lost.
  Fixed: `assertStoredPin` runs the Node scrypt construction against the stored
  salt/hash and rejects a plaintext PIN before normalizing (mirrors run.test.ts test 1).
- pipeline/fallback covered STT failure only; total summary failure (run.test.ts test 5)
  was covered nowhere.
  Fixed: a third sub-run makes both summary models return 400 and asserts the CLI exits
  non-zero with `All summary models failed`, while meeting.mp3, the per-speaker tracks
  and transcript.txt stay in R2 and no summary keys are written.
  The Discord failure notice itself is session-level and stays with the Task 12 ported tests.
- crypto/golden-vectors never verified that a cookie is bound to its meeting id and its
  secret (pipeline.test.ts "PIN hashing and signed access cookies").
  Fixed: two derived negative vectors, wrong meeting id and wrong secret, must be rejected.
- crypto/golden-vectors accepted any PIN string shape.
  Fixed: `verify-pin 12ab56` must be rejected.

Reviewed and found equal or stronger than the originals:

- web/lockout, web/security-headers: exact Thai messages and the exact CSP string,
  where the old tests used partial regex matches.
- web/html-snapshot: byte comparison against Node-recorded goldens, no old equivalent.
- pipeline/short-summary-limit: exact 1500/1499 boundary and the exact truncated
  output, where the old test only checked a length bound.
- pipeline/empty, pipeline/segment-from-r2: new coverage, no old equivalent.
- recovery/closes-at-heartbeat: exact clipped utterance arrays, where the old test
  checked transcript line prefixes.
- time/format: 40 fixed inputs deep-equal to the Node golden table, including every
  edge the plan names.

Known judge scope limits (by design, not findings):

- The judge never deletes the meeting directory (`CLEANUP_LOCAL` is ignored by the
  CLI, Task 4), so the cleanup assertion of run.test.ts test 1 stays with the
  session-level tests.
- The `status: "failed"` manifest save and the Discord failure notice are behaviors
  of `run()`, which the judge does not drive; the CLI surface covers the observable
  parts (non-zero exit, error message, R2 contents).
- Recorder and interaction behavior stays with the ported session tests (Tasks 13-15)
  plus the real-guild human check; the judge has no gateway fake by design.

## Gate

This report is the sign-off material for the human gate before Task 9:
the judge is real, it fails on behavior changes, and its assertions are at least as
strong as the internal tests they replace.
