# Spec: Google Meet recording (condensed copy of the task brief of 2026-10-29, with the spike findings and the user decisions)

## Goal
Add Google Meet recording to the bot: a Discord slash command (e.g. /record-meet url:<meet link>) sends a bot into a Google Meet call, records the call audio, and when the meeting ends produces the same Thai minutes, PIN playback page, and #meeting-of-minutes post as Discord recordings, reusing the existing pipeline (src/pipeline/*) as much as possible.

## What the spike proved (spike/meet-bot/)
- Plain Playwright fill/click -> 'You can't join this video call' ~3s after Ask to join.
  Humanized xdotool input (human.mjs) -> 3/4 guest joins passed.
  Signed-in bot account (session from login.mjs via noVNC, Playwright storageState, MEET_AUTH_STATE_FILE) + humanized input -> 4/4 joins.
  Cloudflare Containers verified: Worker + DO MeetSpike, ctx.container start sleep + exec entrypoint, Bearer token, standard-2 amd64: signed-in bot joined 2/2 and recorded clear speech.
  New app needs ~1 min before 'no container instance' stops; deploy by registry tag (digest mismatch IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE); exec stdout stream never closes because Xvfb/pulseaudio inherit it.
- Audio from Meet reaches the pulse monitor.
  Container Chromium sometimes hits net::ERR_NETWORK_CHANGED on first goto; retry.
  Podman on macOS: /tmp not shared into the VM.
- 15-min CF run: CPU mean 0.26 cores, RSS ~1.7 GB. ~$0.076/h standard-2.
- Reference for CF Containers pattern: /Users/jametirakarn/Desktop/Theerakarnm/Cellar/src/worker/container/job-runner.ts (DO per job, container.start + exec, stdin payload for secrets, interceptOutboundHttp callbacks, alarms as deadline).
  Vexa (Apache-2.0) at /tmp/meetbots/vexa; Attendee (ELv2, ideas only).

## Existing codebase facts to respect
- Pipeline works from a Manifest (participants with utterances, segments, uploaded).
  Segments in R2 at keys.segment(id, userId, index) as FLAC, 5-min. assemble.ensureSegment downloads FLAC when local PCM missing. transcribe packs chunks from utterances, so the Meet recorder must produce utterances (e.g. energy/VAD).
- Manifest is Discord-shaped: decide the smallest clean change; list every consumer of any changed type.
- One recording per guild invariant must hold across Discord and Meet.
- Auto-end rules today: 2 h continue prompt, empty channel 3 min, /end.
  Define Meet equivalents (alone N min, removed/kicked, meeting ended, /end, max lifetime).
- Crash recovery (recoverUnfinished, heartbeatAt) must work for Meet recordings too.
- Consent/PDPA: announce in Discord command channel AND in the Meet chat right after joining.
- Config only through src/config.ts zod + .env.example.
  Optional bot-account session (MEET_AUTH_STATE_FILE, guest mode when unset), one-time meet:login, session never committed or logged, Discord notice when session expired.
- Quality gate: npm run typecheck, npm test.
  Tests must not hit real Discord/Google/Cloudflare/OpenRouter.
- Production: docker compose on VPS. Meet recorder runs on Cloudflare Containers: Worker + DO + container image deployable with wrangler; VPS talks to it over HTTPS with a shared secret.

## Decisions already made (user)
- Cloudflare Containers, standard-2, TypeScript only (no Rust).
- Deferred: CPU tuning, the exec stdout stream issue.
  Design so they are not needed (report via callbacks/R2), make "Leave call" click and its verification part of the normal flow.
- Audio to R2 via container -> Worker callback (interceptOutboundHttp) with the R2 binding; no R2 S3 keys in the container.
- Phase 1 = one mixed track as a single pseudo-participant, honestly labelled; per-speaker (RTCPeerConnection hook + CSRC / active speaker as in Vexa) only outlined for a later plan.
- Bot session stays on the VPS, sent per run in the request to the Worker, never stored on Cloudflare.

## Must decide and justify
1.
Repo layout for the new deployable and sharing code without duplicating sources of truth (Dockerfile-on-stdin: only <context>/.dockerignore applies).
2.
Audio to R2 (decided above).
3.
How the VPS learns the meeting ended and how /end reaches the container.
4.
Speaker attribution scope (decided above).
5.
How the session reaches the container per run, where it lives on the VPS.
6.
Testing strategy: pure units, Worker logic testable without Cloudflare, one manual E2E on https://meet.google.com/jku-cpry-bcg.
7.
Deployment/operations: wrangler deploy from podman (digest pitfall, --provenance shim), secrets, cost guardrails (max_instances, lifetime deadline, destroy on finish).
Keep it lean: no speculative generality, no fallbacks the user did not ask for (existing transcribe/summary fallbacks must keep working).
