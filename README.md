# Meeting Minutes Bot

Discord bot that records a voice channel per speaker, uploads the audio to Cloudflare R2, transcribes it with OpenRouter, writes Thai meeting minutes, and posts them to `#meeting-of-minutes` (or `#general`).
This repo is the open-source engine (AGPL-3.0) that anyone can self-host.
A hosted service may use it through the HTTP API.

## How it works

```
/record ──► bot joins voice ──► per-speaker 24 kHz tracks on one shared timeline (silence kept)
              │                  └─ every 5 min: finished segment ─► FLAC ─► R2   (crash safety)
              │
   auto-end rules: 2h "Continue recording?" button (5 min to click) · channel empty 3 min
              ▼
/end ──► per-speaker .ogg + mixed .mp3 ─► R2
     ──► transcription per speaker (MAI-Transcribe 2, fallback Gemini 3.5 Transcribe)
     ──► transcript interleaved by time: [00:12:03] Name: ...
     ──► full Thai summary + short summary (<1500 chars) (Sonnet 5.5, fallback GPT-6.1 Sol Pro)
     ──► post: embed with short summary, PIN, "listen" button, summary-full.md + transcript.txt attached
```

**Why per-speaker transcription works well:** Discord gives one audio stream per user, so names come for free and nobody's speech is mixed with another's. Each speaker's speech is packed into requests of up to ~2 minutes (silence skipped, original timestamps remembered), so a 1-hour meeting with 4 people needs roughly 30-40 transcription calls rather than hundreds.

**Playback page:** `https://<PUBLIC_BASE_URL>/m/<id>` asks for the 6-digit PIN from the Discord message (5 wrong tries per IP locks for 15 minutes). After that, a signed cookie (12h) gives access to the mixed audio, per-speaker tracks, transcript and full summary. Files stream straight from R2 via short-lived signed URLs, so the bucket stays private.

**Crash recovery:** if the bot dies mid-meeting, on restart it closes the meeting at the last heartbeat (every 15 s), processes what it has, and marks the post as recovered. Meetings that were mid-processing are retried.

## Self-hosting

Anyone can run the engine on their own server.
It is one Node process (Docker image) plus an R2 bucket, and for Google Meet also the recorder in `meet/` on Cloudflare.
Turn on only the surfaces you need.

### What each surface needs

| Surface | Needs |
|---|---|
| Every surface | An R2 bucket, an OpenRouter key, the public HTTPS address of the playback page, `SESSION_SECRET` |
| Discord bot (`/record`) | A Discord application |
| `/meet` page | The `meet/` recorder on Cloudflare Containers, `ALLOWED_EMAILS`, and a Resend key with a verified sending domain |
| Calendar invitations | Everything the `/meet` page needs, plus the bot Google account's secret iCal address and `MEET_BOT_EMAIL`; organizers must be on `ALLOWED_EMAILS` |
| HTTP API | The `meet/` recorder and `API_KEYS`; for webhooks `WEBHOOK_SECRET` and `WEBHOOK_URL`; Resend only for the `email` delivery mode |

Discord is optional: a Meet-only engine leaves `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` empty.

### Minimal `.env` per surface

Start from `.env.example`; every value below is a placeholder.
All surfaces:

```bash
R2_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=meeting-recordings
OPENROUTER_API_KEY=<openrouter-key>
PUBLIC_BASE_URL=https://meet.example.com
SESSION_SECRET=<openssl rand -base64 48>
```

Discord bot:

```bash
DISCORD_TOKEN=<bot-token>
DISCORD_CLIENT_ID=<application-id>
```

`/meet` page:

```bash
MEET_RECORDER_URL=https://everymeet-meet-recorder.<subdomain>.workers.dev
MEET_RECORDER_TOKEN=<openssl rand -base64 48>
MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json
ALLOWED_EMAILS=alice@example.com, @example.org
RESEND_API_KEY=<resend-key>
EMAIL_FROM=minutes@mail.example.com
```

Calendar invitations (on top of the `/meet` page):

```bash
MEET_BOT_EMAIL=bot@example.com
CALENDAR_ICAL_URL=<secret iCal address of the bot account>
```

HTTP API (with `MEET_RECORDER_URL` and `MEET_RECORDER_TOKEN`):

```bash
API_KEYS=service:<openssl rand -base64 36 | tr '+/' '-_' | tr -d '='>
WEBHOOK_SECRET=<echo "whsec_$(openssl rand -base64 32)">
WEBHOOK_URL=https://service.example.com/webhooks/everymeet
```

The engine checks these rules at boot and names every missing setting.

### Cost

At most 2 Google Meet recordings run at once (`MAX_MEET_RECORDINGS`), so the recorder bill has a fixed ceiling.
A Meet recording costs about $0.08 per recording hour for the container (standard-2), plus transcription and summary on OpenRouter for every recording, Discord included.
R2 holds about 29 MB of mixed audio per meeting hour, plus the per-speaker tracks and the 5-minute segments.

### Consent and PDPA

Whoever runs the engine is the one recording people, and is responsible for their consent and for how long the recordings are kept.
The engine announces every recording (Discord: the command channel and the voice chat; Google Meet: a Thai/English message in the Meet chat), and keeping that notice is your duty.
Decide a retention period and set an R2 lifecycle rule for it (see Cloudflare R2 below).

### Upgrading from older builds

Builds before 2026-11-21 used `users.json` and `SEED_ADMIN_EMAIL`; set `ALLOWED_EMAILS` instead and delete `DATA_DIR/users.json`.

### 1. Discord application
1. Discord Developer Portal → New Application → **Bot** → copy the token (`DISCORD_TOKEN`) and the Application ID (`DISCORD_CLIENT_ID`).
2. No privileged intents are needed.
3. Invite URL (OAuth2 → URL Generator): scopes `bot` + `applications.commands`; permissions **View Channels, Send Messages, Embed Links, Attach Files, Connect**.
4. Create a text channel named `meeting-of-minutes` (optional; falls back to `general`, then the channel where `/record` was used).

### 2. Cloudflare R2
1. Create a bucket (keep public access **off**).
2. R2 → Manage API tokens → **Object Read & Write** for that bucket → fill `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`.
3. Recommended: a lifecycle rule to delete `meetings/*/segments/` and `meetings/*/debug/` after 30 days (crash backups and Meet failure screenshots).

### 3. Deploy on the VPS
```bash
cp .env.example .env        # fill in values; SESSION_SECRET: openssl rand -base64 48
docker compose up -d --build
docker compose exec meeting-bot node dist/register-commands.js   # once (and after changing commands)
```

Nginx in front (HTTPS for the playback page):
```nginx
server {
  server_name meet.example.com;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
  # listen 443 ssl; ... (certbot)
}
```
Voice traffic is outbound UDP from the bot; no inbound ports needed besides the page.

### Local development
```bash
npm install
npm test            # unit + audio pipeline tests (needs ffmpeg)
npm run dev
```

## Commands
| Command | Who | What |
|---|---|---|
| `/record` | anyone in a voice channel | joins and replies *"I am recording the voice in channel {name}"* |
| `/end` | anyone | stops, processes, posts minutes |

Google Meet calls are recorded from the web page or a calendar invitation, not from Discord (see below).

One recording per server at a time.

## Files in R2
```
meetings/<id>/manifest.json         state + PIN hash (never the PIN)
meetings/<id>/segments/<user>/*.flac  5-min crash backups
meetings/<id>/segments/meet/*.flac  5-min Google Meet segments
meetings/<id>/debug/failure.png      screenshot when a Meet join fails
meetings/<id>/tracks/<user>.ogg      per-speaker audio (Opus 32 kbps)
meetings/<id>/meeting.mp3            mixed audio (64 kbps, ~29 MB/hour)
meetings/<id>/transcript.txt
meetings/<id>/summary-full.md, summary-short.md
```

## Google Meet recording

Meet recording is optional.
It stays off unless `MEET_RECORDER_URL` and `MEET_RECORDER_TOKEN` are both set.
The `/meet` page and the calendar trigger also need `RESEND_API_KEY` and `EMAIL_FROM`; API recordings in webhook mode need neither.
It does not use Discord at all.

Two ways to start a recording:

- **Web page:** open `<PUBLIC_BASE_URL>/meet`, enter your email, and open the single-use login link the bot emails (valid 15 minutes).
  This is magic-link login for the addresses and domains in `ALLOWED_EMAILS`; there are no accounts and no signup.
  Paste the Meet link, add extra recipient emails if you like, and press เริ่มบันทึก.
  The page lists your recordings with their state and a stop button.
- **Calendar invitation:** invite the bot Google account (`MEET_BOT_EMAIL`) to a Google Calendar event that has a Meet link.
  The bot reads its calendar every minute and joins from one minute before the start until 15 minutes after it, but only when the event organizer is on `ALLOWED_EMAILS` (addresses are compared without case).
  Every occurrence of a recurring event is started at most once; deleted, cancelled, and moved occurrences are followed.
  New invitations show up only after Google refreshes the calendar feed, which can take a few minutes, so invite the bot well before the meeting.
  Calendar starts are off unless `CALENDAR_ICAL_URL` is set; check the feed once before you rely on them (see Check the calendar feed once).

Accounts, billing, and per-customer limits belong to the hosted service that uses the engine's API (`docs/api.md`), not to the engine.
Link requests are rate limited per IP and per email address.
All login emails together are capped at `MEET_LOGIN_MAIL_DAILY_CAP` per 24 hours (default 300), to protect the Resend quota the minutes need; over the cap the page gives the usual answer but sends no link, and the log says why.
When the meeting ends, the bot emails the short summary, the playback link, and the PIN: for a calendar start to the organizer and every invitee who did not decline (never the bot account), for a web start to the starter and the extra addresses.
Problems (the bot was not let in, the bot account session expired, the recorder failed) are emailed to the organizer or starter.
At most 2 Meet recordings run at once and only one per Meet call; a further start is refused on the page or by email.
The recorder runs on Cloudflare Containers (`meet/`): a Worker, one Durable Object per recording, and a Playwright Chromium container (standard-2, about $0.08 per recording hour).
The only recording notice is the Thai/English message the bot posts in the Meet chat; if it cannot post it, the starter gets an email asking them to tell the participants.
The audio is one mixed track, so the transcript has no speaker names and the page has no per-speaker files.
The bot waits up to 15 minutes to be let in and then up to 15 minutes for someone else to join.
It ends when only the bot has been left for `EMPTY_CHANNEL_TIMEOUT_MIN` after someone else was there, when the bot is removed or the call ends, after `MEET_MAX_DURATION_MIN`, or when someone presses stop.
The minutes arrive a few minutes after the end.
If nobody spoke (for example nobody came, and the bot left after 15 minutes), only the organizer or starter gets the minutes, which then say that no speech was found.

The bot-account session file (`meet-auth.json`) is a full login credential for the bot Google account.
Never commit it and never log it.

### Setup

1. `cd meet && npm ci`.
2. `npm run meet:login`, open `http://localhost:6080/vnc.html`, sign in to the bot Google account, and close Chromium.
   The session is in `meet/auth/meet-auth.json`.
3. Deploy as in the next list.
4. `npx wrangler secret put RECORDER_TOKEN -c wrangler.deploy.jsonc` with the output of `openssl rand -base64 48`.
5. On the VPS set `MEET_RECORDER_URL`, `MEET_RECORDER_TOKEN` (same value), and `MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json` in `.env`.
   Copy the session to `./secrets/meet-auth.json`, then run `chown 1000:1000` and `chmod 600` on it.
   Also set `ALLOWED_EMAILS` (the addresses and `@domains` that may sign in), `RESEND_API_KEY`, `EMAIL_FROM`, and optionally `MEET_LOGIN_MAIL_DAILY_CAP` (see .env.example).
   For calendar starts also set `MEET_BOT_EMAIL` and `CALENDAR_ICAL_URL` (step 8).
   Run `docker compose up -d --build`.
6. Run `npm run register` once after the deploy so Discord drops the old `/record-meet` command (in the container: `docker compose exec meeting-bot node dist/register-commands.js`).
7. Email goes out through Resend from a domain you verified there (for example `mail.example.com`).
   In Resend > API Keys create a key with "Sending access" restricted to that domain for `RESEND_API_KEY`, and set `EMAIL_FROM` to an address on it (for example `minutes@mail.example.com`).
8. Calendar (optional, for calendar starts): in the bot Google account set Google Calendar > Settings > Event settings > "Add invitations to my calendar" to "From everyone".
   Copy Settings for my calendars > Integrate calendar > "Secret address in iCal format" into `CALENDAR_ICAL_URL`.
   Treat that address like a password; if it leaks, reset it there and update `.env`.

### Check the calendar feed once

The calendar trigger trusts the `ORGANIZER` of an invitation in the bot's iCal feed, and two things about that feed were not tested against Google.
Check both once with your bot account before you rely on `ALLOWED_EMAILS` for calendar starts.
Never print or paste the secret iCal address; the commands below read it from `.env`.

1. Feed delay for new invitations.
   Run this poller, then at once create a one-off event titled `everymeet probe fresh` with a Meet link that invites the bot account:
   ```bash
   node --env-file=.env -e '
   const t0 = Date.now();
   setInterval(async () => {
     const text = (await (await fetch(process.env.CALENDAR_ICAL_URL)).text()).replace(/\r?\n[ \t]/g, "");
     if (text.includes("SUMMARY:everymeet probe fresh")) { console.log(`seen after ${Math.round((Date.now() - t0) / 1000)} s`); process.exit(0); }
   }, 30_000);'
   ```
   If it takes longer than about 5 minutes, calendar starts work only for events created at least that long before they start.
2. Forged organizer in an invitation from a stranger.
   From a mailbox that is not on `ALLOWED_EMAILS`, email the bot account two iCal invitations (`text/calendar; method=REQUEST`) for tomorrow with a Meet link in `DESCRIPTION`.
   The control names that mailbox as `ORGANIZER` and has the title `everymeet probe control`; the forged one has the title `everymeet probe forged` and names an address on `ALLOWED_EMAILS` as `ORGANIZER`.
   After 5 minutes check the feed, with the allowed address as the argument (it prints no address):
   ```bash
   node --env-file=.env -e '
   fetch(process.env.CALENDAR_ICAL_URL).then(async (r) => {
     const raw = (await r.text()).replace(/\r?\n[ \t]/g, "");
     for (const title of ["everymeet probe control", "everymeet probe forged"]) {
       const block = raw.split("BEGIN:VEVENT").find((b) => b.includes(`SUMMARY:${title}`));
       const organizer = block?.split(/\r?\n/).find((l) => l.startsWith("ORGANIZER")) ?? "";
       console.log(title, block ? "present" : "missing", organizer.toLowerCase().endsWith(`:mailto:${process.argv[1].toLowerCase()}`) ? "organizer is the allowed address" : "");
     }
   });' 'alice@example.com'
   ```
   The control must be there; if it is not, the mail client did not send a real invitation, so send both again as a real iMIP message.
   The forged one must be missing or show another organizer.
   If it shows the allowed address as organizer, a stranger can make the bot record a Meet room of their choice in that person's name and email its minutes to that event's invitees.
   Then set "Add invitations to my calendar" in the bot account to "Only if the sender is known", have every organizer email the bot account once, and check again.

### Deploy from podman

Run these in `meet/`:

1. `npm run build:bot`
2. `TAG=$(git rev-parse --short HEAD)`
3. `podman build --platform linux/amd64 -t everymeet-meet-recorder:$TAG .`
4. `WRANGLER_DOCKER_BIN=podman npx wrangler containers push everymeet-meet-recorder:$TAG`
   It prints `registry.cloudflare.com/<account-id>/everymeet-meet-recorder:<tag>`.
5. Write `wrangler.deploy.jsonc` as a copy of `wrangler.jsonc` whose `image` is that registry tag.
   The file is gitignored because it holds the account id.
6. `npx wrangler deploy -c wrangler.deploy.jsonc`

Why the registry tag: with podman, `wrangler deploy` on the Dockerfile fails on `--provenance=false`.
After a push, the rollout can also fail with `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE` because wrangler reads the digest from podman's local store.
A new deploy needs about a minute before containers start ("no container instance available" until then).

### Operating it

- Logs: `npx wrangler tail everymeet-meet-recorder` shows one JSON line per recorder event.
  A failed join leaves `meetings/<id>/debug/failure.png` in R2.
- When the session expires, the starter or organizer gets an email that says so.
  Run setup step 2 again and replace the file on the VPS.
  No restart is needed, because the file is read on every start.
- `failure.png` can show participants' names, faces, and chat.
  The R2 lifecycle rule should delete `meetings/*/debug/` together with `meetings/*/segments/` (about 30 days, PDPA).
- The calendar trigger remembers which occurrences it already handled in `DATA_DIR/calendar-handled.json`; deleting that file could make an occurrence that is still within its 15-minute window start again.
- Login links would appear in the Nginx access log as `/meet/auth?t=...` (they expire after 15 minutes and work once); keep them out of the log with a format without the query string:
  ```nginx
  # in the http block, e.g. /etc/nginx/conf.d/noquery.conf
  log_format noquery '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';
  # in the server block of the playback page
  access_log /var/log/nginx/access.log noquery;
  ```
  Nginx error log lines can still show the query when the upstream fails; they are rare and the link works only once.
- Resend allows 10 API requests per second per team and has a monthly quota (and a daily one on the free plan); a log line `email to ... failed: HTTP 429 daily_quota_exceeded` (or `monthly_quota_exceeded`, `rate_limit_exceeded`) says why mails stopped, and Resend > Logs shows every send.

## HTTP API

The engine has a versioned HTTP API under `/api/v1` that starts, reads, stops, and lists Google Meet recordings for another program, issues playback PINs, and reports with signed webhooks.
It is off unless `API_KEYS` is set.
See [docs/api.md](docs/api.md) for the endpoints, the Recording object, errors, and webhook verification.

- `API_KEYS`: API clients as `name:key` pairs, comma separated; list one name twice with two keys to rotate a key without downtime.
- `API_RATE_LIMIT_PER_MIN`: requests per minute for each API client (default 120).
- `WEBHOOK_SECRET`: the Standard Webhooks signing secret, made with `echo "whsec_$(openssl rand -base64 32)"`.
- `WEBHOOK_URL`: the default webhook URL for API recordings, https (http only on localhost).
- `WEBHOOK_ALLOWED_ORIGINS`: more origins a start request may name in `webhookUrl`, comma separated.

## Things to know
- **Runtime is Node 22, not Bun.** `@discordjs/voice` requires Node ≥ 22.12 for receiving audio and for Discord's voice encryption (DAVE, via the bundled `@snazzah/davey`). Hono is still used for the web page.
- **Discord doesn't officially document receiving audio.** `@discordjs/voice` supports it, but a Discord change could break it; pin versions and test after upgrades.
- **Check the MAI-Transcribe 2 price unit.** OpenRouter lists its price as `0.1` without a clear unit. Run one short meeting and check `usage.cost` in the OpenRouter dashboard. If it turns out to be per request, raise `maxChunk` in `src/pipeline/plan.ts`.
- **Consent / PDPA:** for Discord the bot announces recording in the command channel and the voice channel chat; for Google Meet it posts a notice in the Meet chat. Decide a retention period and set an R2 lifecycle rule accordingly.
- Disk: up to ~170 MB per speaker-hour of temporary raw audio (silence is stored sparsely); removed after posting when `CLEANUP_LOCAL=true`.

## License
Copyright (C) 2026 The everymeet authors.
This program is free software under the GNU Affero General Public License, version 3 only (`LICENSE`).
If you run a modified version for others over a network, section 13 asks you to offer them your modified source; set `SOURCE_CODE_URL` to it (every page links it).
The recorder Worker and container in `meet/` are part of the same program and the same license.
Discord users reach the source through the playback page that every minutes post links, whose footer links `SOURCE_CODE_URL`.
The Docker images include ffmpeg (Debian, GPL) and Chromium (in the Playwright base image) as separate programs under their own licenses.
Programs that only call the HTTP API (`docs/api.md`) are separate works; do not import engine modules into them.
Contributions are accepted under the same license with a DCO sign-off (CONTRIBUTING.md).
