# Meeting Minutes Bot

Discord bot that records a voice channel per speaker, uploads the audio to Cloudflare R2, transcribes it with OpenRouter, writes Thai meeting minutes, and posts them to `#meeting-of-minutes` (or `#general`).

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

## Setup

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
It stays off unless `MEET_RECORDER_URL` and `MEET_RECORDER_TOKEN` are both set, and it then also needs `RESEND_API_KEY` and `EMAIL_FROM`.
It does not use Discord at all.

Two ways to start a recording:

- **Web page:** open `<PUBLIC_BASE_URL>/meet`, enter your email, and open the single-use login link the bot emails (valid 15 minutes).
  Anyone can sign up this way: the first confirmed link creates the account.
  Paste the Meet link, add extra recipient emails if you like, and press เริ่มบันทึก.
  The page lists your recordings with their state and a stop button.
- **Calendar invitation:** invite the bot Google account (`MEET_BOT_EMAIL`) to a Google Calendar event that has a Meet link.
  The bot reads its calendar every minute and joins from one minute before the start until 15 minutes after it, but only when the event organizer has an active account (signed up on `/meet`; addresses are compared without case).
  Every occurrence of a recurring event is started at most once; deleted, cancelled, and moved occurrences are followed.
  New invitations show up only after Google refreshes the calendar feed, which can take a few minutes, so invite the bot well before the meeting.

Accounts live in `DATA_DIR/users.json` (status active or disabled, admin flag, created and last-login times).
`SEED_ADMIN_EMAIL` becomes an active admin at every boot and is the only admin (after a change of that address the old one loses the admin flag at the next boot); admins open `<PUBLIC_BASE_URL>/meet/admin` to disable or enable accounts.
Because signup is open, each person may run `MEET_MAX_ACTIVE_PER_USER` recordings at once (default 1) and start `MEET_MAX_DAILY_PER_USER` in 24 hours (default 5), web and calendar together; link requests and new accounts are rate limited.
Login links to addresses without an account are capped at 50 per 24 hours in total, to protect the Resend quota the minutes need.
This is a deliberate trade-off: someone who requests links for many made-up addresses can use up that cap and block new signups for 24 hours, while existing accounts can still sign in.
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
   Also set `SEED_ADMIN_EMAIL` (your own address), `MEET_BOT_EMAIL`, `RESEND_API_KEY`, `EMAIL_FROM`, optionally the per-person limits, and optionally `CALENDAR_ICAL_URL` (see .env.example).
   Run `docker compose up -d --build`.
6. Run `npm run register` once after the deploy so Discord drops the old `/record-meet` command (in the container: `docker compose exec meeting-bot node dist/register-commands.js`).
7. Email goes out through Resend from a domain you verified there (for example `mail.example.com`).
   In Resend > API Keys create a key with "Sending access" restricted to that domain for `RESEND_API_KEY`, and set `EMAIL_FROM` to an address on it (for example `minutes@mail.example.com`).
8. Calendar (optional): in the bot Google account set Google Calendar > Settings > Event settings > "Add invitations to my calendar" to "From everyone".
   Copy Settings for my calendars > Integrate calendar > "Secret address in iCal format" into `CALENDAR_ICAL_URL`.
   Treat that address like a password; if it leaks, reset it there and update `.env`.

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
- The calendar trigger remembers which occurrences it already handled in `DATA_DIR/calendar-handled.json`; deleting that file can make an occurrence that is still within its 15-minute window start again.
- Login links would appear in the Nginx access log as `/meet/auth?t=...` (they expire after 15 minutes and work once); keep them out of the log with a format without the query string:
  ```nginx
  # in the http block, e.g. /etc/nginx/conf.d/noquery.conf
  log_format noquery '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';
  # in the server block of the playback page
  access_log /var/log/nginx/access.log noquery;
  ```
  Nginx error log lines can still show the query when the upstream fails; they are rare and the link works only once.
- `DATA_DIR/users.json` holds every account; back it up with the volume, and edit it by hand only while the bot is stopped (the bot keeps it in memory and rewrites it on every change).
  A damaged file stops the bot at boot with `users.json is not valid JSON` or `users.json is not a valid users file (<field>)`.
- Resend allows 10 API requests per second per team and has a monthly quota (and a daily one on the free plan); a log line `email to ... failed: HTTP 429 daily_quota_exceeded` (or `monthly_quota_exceeded`, `rate_limit_exceeded`) says why mails stopped, and Resend > Logs shows every send.

## Things to know
- **Runtime is Node 22, not Bun.** `@discordjs/voice` requires Node ≥ 22.12 for receiving audio and for Discord's voice encryption (DAVE, via the bundled `@snazzah/davey`). Hono is still used for the web page.
- **Discord doesn't officially document receiving audio.** `@discordjs/voice` supports it, but a Discord change could break it; pin versions and test after upgrades.
- **Check the MAI-Transcribe 2 price unit.** OpenRouter lists its price as `0.1` without a clear unit. Run one short meeting and check `usage.cost` in the OpenRouter dashboard. If it turns out to be per request, raise `maxChunk` in `src/pipeline/plan.ts`.
- **Consent / PDPA:** for Discord the bot announces recording in the command channel and the voice channel chat; for Google Meet it posts a notice in the Meet chat. Decide a retention period and set an R2 lifecycle rule accordingly.
- Disk: up to ~170 MB per speaker-hour of temporary raw audio (silence is stored sparsely); removed after posting when `CLEANUP_LOCAL=true`.
