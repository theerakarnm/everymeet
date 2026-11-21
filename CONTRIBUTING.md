# Contributing

Thank you for helping with everymeet.
This repo is the meeting minutes engine only.
Accounts, billing, quotas, and customer-facing pages belong to a separate hosted service, so requests for them are out of scope here.

## Before you start

You need Node >= 22.12 and npm (not Bun), and ffmpeg on your PATH.
Run `npm install`, then `npm run typecheck` and `npm test`.
When you change `meet/`, `src/meet/protocol.ts`, or `src/storage/keys.ts`, also run `npm run typecheck` and `npm test` inside `meet/`.
When you add, remove, or upgrade a dependency, run `npm run licenses`.

## Style

Follow AGENTS.md: it describes the code style, the architecture, and the tests.
Tests use fakes only and never call Discord, Google, Cloudflare, Resend, or OpenRouter.
User-facing text on web pages and in emails is Thai.
The repo is public, so code, tests, and docs use placeholders only (for example `example.com`), never real addresses, ids, tokens, or Meet codes.

## Commits

Use Conventional Commits, for example `fix(recorder): keep a late speaker's track`.
Keep each commit to one subsystem (recorder, pipeline, web, storage, api, meet) where practical.

## Developer Certificate of Origin

Every commit carries a `Signed-off-by: Name <email>` line, which `git commit -s` adds for you.
The sign-off certifies the Developer Certificate of Origin 1.1 (https://developercertificate.org).
Contributions are licensed under AGPL-3.0-only, like the rest of the project.
There is no CLA, so contributors keep their copyright, and the project can never be relicensed without the consent of every contributor.
Maintainers check the sign-offs before merging.
