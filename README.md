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
3. Recommended: a lifecycle rule to delete `meetings/*/segments/` after 30 days (they are only crash backups).

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

One recording per server at a time.

## Files in R2
```
meetings/<id>/manifest.json         state + PIN hash (never the PIN)
meetings/<id>/segments/<user>/*.flac  5-min crash backups
meetings/<id>/tracks/<user>.ogg      per-speaker audio (Opus 32 kbps)
meetings/<id>/meeting.mp3            mixed audio (64 kbps, ~29 MB/hour)
meetings/<id>/transcript.txt
meetings/<id>/summary-full.md, summary-short.md
```

## Things to know
- **Runtime is Node 22, not Bun.** `@discordjs/voice` requires Node ≥ 22.12 for receiving audio and for Discord's voice encryption (DAVE, via the bundled `@snazzah/davey`). Hono is still used for the web page.
- **Discord doesn't officially document receiving audio.** `@discordjs/voice` supports it, but a Discord change could break it; pin versions and test after upgrades.
- **Check the MAI-Transcribe 2 price unit.** OpenRouter lists its price as `0.1` without a clear unit. Run one short meeting and check `usage.cost` in the OpenRouter dashboard. If it turns out to be per request, raise `maxChunk` in `src/pipeline/plan.ts`.
- **Consent / PDPA:** the bot announces recording in the command channel and the voice channel chat. Decide a retention period and set an R2 lifecycle rule accordingly.
- Disk: up to ~170 MB per speaker-hour of temporary raw audio (silence is stored sparsely); removed after posting when `CLEANUP_LOCAL=true`.
