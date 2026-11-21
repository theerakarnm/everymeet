# Google Meet by Calendar Invite and Web Page, Minutes by Email - Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-11-01-meet-calendar-web-email.md` - the runner that ticks these checkboxes and honours the track/merge layout below.
>
> **For the executing agent:** Implement this plan task by task in one worktree (single sequential track, see Execution).
> Steps use checkbox (`- [ ]`) syntax for tracking; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.
> **Status (revised 2026-11-20):** Tasks 1-4 are done and committed on `feat/meet-recording` (bb746d1, 9706c77, dd61697, f166ecc), followed by the placeholder commit 29a9203.
> The user then replaced the static `ALLOWED_EMAILS` allowlist with registered users and open signup (Decisions 4 and 18-22); Task 4b undoes the allowlist parts of Task 1, and Tasks 4c, 7b, and 11b are new.
> **Rebased 2026-11-21 by docs/plans/2026-11-21-engine-service-split.md:** the user store, signup, admin page, and per-person limits are gone (Tasks 1-3 there); calendar organizers are trusted when `isAllowed(organizer, config().ALLOWED_EMAILS)`, and the only refusal reasons are `already_recording` and `busy`.
> **Order:** Tasks 4b, 4c, 5, 6, 7, 7b, 8, 9, 10, 11, 11b, and 14 need nothing from the user or from Task 0 and can run now, in that order.
> Task 0 is the user's probe (calendar feed and email domain) and runs alongside them.
> Tasks 12-13 (calendar) start only after Task 0's gate says GO; Task 15 needs a Cloudflare login for the live image redeploy; `## End-to-end verification` comes last.
> Code in Steps is a reference implementation written without a compiler.
> When `tsc` or a test rejects it, the tool wins: correct it minimally and record a `> Deviation:` note under the step.

**Goal:** Google Meet recordings start without Discord - from a Google Calendar invitation to the bot account or from a web page on the existing playback server - and the minutes (short summary, playback link, PIN) and all failure notices go out by email.
**Architecture:** The VPS bot keeps driving the already deployed `everymeet-meet-recorder` Worker through its unchanged HTTP API (start, status, stop).
Two new triggers call one function, `MeetSession.start(meet: MeetInfo, onFinished)`: a calendar poller that reads the bot account's secret iCal address every minute, and a `/meet` section of the Hono server with magic-link login and open signup (users live in `DATA_DIR/users.json`; the first confirmed login link creates the account; a seeded admin can disable accounts).
Meet manifests stop carrying Discord fields (the `Manifest` type becomes a union of `DiscordManifest` and `MeetManifest`), and processing emails Meet minutes through the Resend REST API instead of posting to Discord; Discord `/record` is unchanged.
**Tech Stack:** Node 22 + TypeScript 7 + Hono 4.13 + zod 4.6 + node:test (unchanged); new runtime dependency `node-ical` 0.27.6 (pinned) for the iCal feed; Resend REST API (`POST https://api.resend.com/emails`; the user already verified their sending domain in Resend; this plan writes it as `mail.example.com` because the repo is public); the `meet/` container gets one rule change and an image redeploy.
**Spec:** none - planned from the task brief of 2026-11-20 (the user decisions listed under "New goal" in that brief), which builds on `docs/plans/2026-10-28-google-meet-recording.md` (its Decisions and Architecture still hold except where this plan says otherwise).
Research notes used while planning (not committed): Resend API docs (https://resend.com/docs/api-reference/emails/send-email, `/errors`, `/rate-limit`, `/dashboard/emails/idempotency-keys`) and the node-ical 0.27.6 type declarations (https://unpkg.com/node-ical@0.27.6/node-ical.d.ts).
**Base commit:** 478fc65 (branch `feat/meet-recording`, not merged to `main` and never deployed to the VPS); revised for the user-database change at 29a9203, after Tasks 1-4 and the placeholder commit.
**Confidence:** 7/10 - see `## Confidence derivation`; the open unknowns are what Google's secret iCal feed of a personal Gmail account really contains and how fast it reflects a new invitation, which Task 0 measures and which gate Tasks 12 and 13.
**NOT building:**
- The Google Calendar API (OAuth); the calendar trigger reads only the secret iCal address (if Task 0 shows that the feed is too slow or lacks the Meet link, stop and ask; the API is a separate plan).
- Any change to the recorder Worker's code or HTTP API; only the container runner and its end rules change (Task 3), which needs an image redeploy (Task 15).
- Discord notices of any kind for Meet recordings, and email for Discord `/record` recordings (Discord stays exactly as it is).
- Email attachments: the full summary and transcript stay behind the PIN on the playback page, so a forwarded email does not leak them.
- Retrying a calendar start that failed: each occurrence is started at most once; the organizer gets an email and can start the recording on the web page (the one retry is a Meet room still recorded for another meeting, see Decision 11).
- A logout button, or persistence of unused login links and of the in-memory rate limits across a bot restart.
- User management beyond the admin page's list and its disable/enable button: no deleting accounts, no granting admin on the page (only `SEED_ADMIN_EMAIL`), no approval queue for new accounts (Open question 1), and no admin view of other people's recordings.
- A blocklist of disposable email domains (Decision 21, Open question 3).
- A database server or a new storage dependency: users are one JSON file (Decision 18).
- Resend webhooks (bounce, complaint, delivery events); a send that Resend refuses is logged, later bounces are only visible in the Resend dashboard.
- Calendar starts for all-day events.
- Per-speaker audio for Meet (phase 2 of the previous plan).

## Decisions

Each decision states the chosen option and why, briefly.

1. **Email goes out from the VPS bot through the Resend REST API** (`POST https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`), because the user already verified the sending domain `mail.example.com` in Resend (user decision 2026-11-20, replacing the earlier Cloudflare Email Sending idea).
   The VPS is where processing runs and where the login page lives, so sending there needs no Worker route, no `protocol.ts` change, and no Worker redeploy, and it is one mockable `fetch` without the Resend SDK (repo rule: few dependencies).
   Facts from the Resend docs (2026-11-20): the JSON body is `from` (`"Name <address>"`), `to` (string or array, at most 50), `subject`, `html`, `text`; success is `200 { "id": "<uuid>" }`; errors are `{ "statusCode", "message", "name" }` (for example `validation_error` for an unverified domain or a bad key, `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`); every request needs a `User-Agent` header (a request without it gets 403, error 1010); the default rate limit is 10 requests per second per team (429 with `retry-after`); the free plan also has a daily quota.
   Resend's `Idempotency-Key` header (at most 256 characters, kept 24 hours) is not used: processing that is retried after a crash makes a new PIN, so the repeated minutes email is the correct one, and a reused key with a changed body would be refused (409 `invalid_idempotent_request`).
   The API key is created in Resend with "Sending access" only, restricted to `mail.example.com`, so a leaked key can only send from that domain.
2. **One email per recipient.** Recipients never see each other's addresses (web starts can add any address), and one bad address does not block the others.
   Processing fails only when no recipient got the minutes.
   At the default 10 requests per second, sequential sends stay under the rate limit.
3. **Sender and key are config:** `EMAIL_FROM` (any address on the verified domain; the user's choice lives only in their `.env`) and `RESEND_API_KEY`.
4. **Who may use it: registered users, with open signup** (user decision 2026-11-20, replacing the static `ALLOWED_EMAILS` allowlist that Task 1 built).
   Users live in a small database (Decision 18) keyed by lowercase email, each with `status` (`active` or `disabled`), `isAdmin`, `createdAt`, and `lastLoginAt`.
   Anyone may sign up: entering an email on `/meet` sends a login link, and the first confirmed click creates the account, because the link proves the person controls the address.
   Every web request re-checks that the cookie's user exists and is active, so disabling someone takes effect at once.
   A calendar occurrence starts only when its organizer is an existing active user (Decision 6).
   Task 4b removes `ALLOWED_EMAILS` and the domain matching in `src/util/email.ts` (`Allowlist`, `parseAllowlist`, `invalidAllowlistEntries`, `isAllowed`); `normalizeEmail` and `parseEmailList` stay.

5. **Calendar timing:** poll every 60 s; start an occurrence from 60 s before its start (the container needs about a minute to boot and join) until 15 minutes after its start or its end, whichever is first.
   Every occurrence that was due is written to `DATA_DIR/calendar-handled.json` BEFORE anything is attempted, so it is started at most once even across a crash (refused, skipped, failed, or started); the only exception is a refusal because the same Meet room is still recorded, which is retried while the occurrence is due (Decision 11).
   The occurrence key is `<UID>|<original start in UTC ISO>` (RECURRENCE-ID for a moved occurrence), so moving an occurrence never starts it twice.
   Cancelled occurrences (`STATUS:CANCELLED`, EXDATE) and deleted events are simply not due; nothing is scheduled ahead, every poll recomputes from the latest feed.
6. **Calendar trust is the ORGANIZER only:** an occurrence starts only when its organizer is an existing active user (the address is lowercased by `normalizeEmail` and looked up in the user store, so the match is case-insensitive); others, including disabled users, are skipped with a log line and no email (no mail to unknown senders).
   The organizer is the recording's `startedBy`, so the per-person limits of Decision 21 count calendar starts too; what open signup means for this trust is Decision 22.
   The bot account's "Automatically add invitations" must be "From everyone" so invitations from people the account never talked to appear (Task 0).
   Recipients are the organizer (always, even when listed as declined) plus every invitee whose PARTSTAT is not `DECLINED`, minus `MEET_BOT_EMAIL` and `*.calendar.google.com` room resources (user decisions: "organizer and all invitees except the bot account", declined invitees excluded).
   The Meet link comes from `X-GOOGLE-CONFERENCE`, else the first Meet link in DESCRIPTION, else in LOCATION.
7. **Fallback when the export has no Meet link:** organizers paste the Meet link into the event description, which the parser already reads; if Task 0 shows the feed lacks the link AND the user does not accept that instruction, stop: the Calendar API is a separate plan.
8. **iCal parsing uses `node-ical` 0.27.6, pinned exactly.** It is the only option where "parse the feed, expand RRULEs in a window with EXDATE, RECURRENCE-ID overrides, orphan overrides, IANA and Windows TZIDs" is one call (`expandRecurringEvent`); ESM with bundled types and `engines: node >=22`; 2 dependencies (`rrule-temporal`, `temporal-polyfill`).
   Hand-rolling recurrence and timezone math is the bug class the brief lists as must-handle; `ical.js` needs manual exception wiring and has no Windows zones; `rrule` does not parse ICS.
   It is 0.x and changed date semantics before, so the version is pinned without `^`.
9. **Web login by magic link:** `POST /meet/login` answers with the same page and status for a new address, an existing account, and a disabled account (no user enumeration); every valid address except a disabled account gets a link to `GET /meet/auth?t=<token>`, which shows a confirm button that POSTs the token, so mail scanners that prefetch links cannot burn the single-use token.
   Tokens are 32 random bytes, single use, 15 minutes, in memory (a restart only voids unused links).
   `POST /meet/auth` creates the account on the first confirmed link (status `active`, not admin), records `lastLoginAt` on every confirmed link, and shows a Thai "account disabled" page with 403 to a disabled account (only the mailbox owner can get that far, so it reveals nothing to others).
   The session cookie `mu` reuses the playback cookie's HMAC (`signAccess` with `SESSION_SECRET`) over `user:<email>`, `HttpOnly`, `SameSite=Lax` (blocks cross-site POSTs, so the start and stop forms need no CSRF token), `Secure` on https, path `/meet`, 12 h.
   Link requests are limited to 5 per IP and 3 per email address per 15 minutes (counted the same whether or not the account exists), and the login email is sent without awaiting it, so new and existing addresses answer equally fast; Decision 21 adds the signup and total login-email limits.
   `hono/csrf` on all `/meet` routes refuses form posts from other sites, including the cookie-less login and confirm forms (login CSRF).
   Accepted limits: someone who knows a user's address can use up its 3 link requests and delay that person's login by up to 15 minutes; browsers without `Sec-Fetch-Site` (Safari before 16.4) are refused by the CSRF check because `Referrer-Policy: no-referrer` makes them send `Origin: null`.
10. **Web page shows only the recordings the signed-in person started or receives minutes for**, with their state and a stop button; any of those people may stop it (like Discord's "anyone can /end").
    No auto-refresh (a refresh would wipe a half-typed form); a "รีเฟรชสถานะ" link reloads.
11. **Concurrency:** `activeMeets: Map<meetCode, MeetSession>` with `MAX_MEET_RECORDINGS = 2` (the Worker's `max_instances`); `MeetSession.start` checks both rules and registers in the same synchronous block, and throws `MeetRefused("already_recording" | "busy")`.
    Task 7b adds two per-person rules to the same block, keyed by `startedBy` (the web starter or the calendar organizer): at most `MEET_MAX_ACTIVE_PER_USER` running recordings (default 1) and at most `MEET_MAX_DAILY_PER_USER` starts in a rolling 24 hours (default 5); the order is `already_recording`, `user_busy`, `daily_limit`, `busy`.
    The Discord registry `activeSessions` (one per guild) goes back to `src/recorder/session.ts`, and `src/recorder/active.ts` with its shared `ActiveRecording` interface is deleted, because the two sources no longer share a rule.
    A web refusal is shown on the page; a calendar `busy` or `daily_limit` refusal emails the organizer once and is not retried; a calendar `user_busy` refusal (the organizer's earlier recording, which runs until its room empties, has not ended) is retried every poll while the occurrence is due and the organizer is told once, like `already_recording`, so back-to-back meetings of one organizer are not lost.
    A calendar occurrence whose Meet room is still recorded for an earlier meeting (same link back to back, or a web start in that room) is retried every poll while it is due, and its organizer is told once; until the earlier recording ends, the room's audio belongs to the earlier recording and its recipients, and if the window closes before that, no second email follows (user decision 2026-11-20: keep this; a calendar recording does not stop at its event's end).
12. **Manifest:** `Manifest = DiscordManifest | MeetManifest`, discriminated by `meet` (`meet?: undefined` on Discord).
    Discord manifests keep their exact field names, so every existing Discord recording and playback page keeps working; Meet manifests drop `guildId`, `guildName`, `voiceChannelId`, `voiceChannelName`, `commandChannelId`, `startedBy` and gain `meet: MeetInfo` (`url`, `code`, `title`, `trigger`, `startedBy` email, `recipients`).
    No compatibility shim for the old Meet shape: the Meet bot side was never deployed (`feat/meet-recording` is not merged), so only the previous plan's E2E leftovers have it.
    Their playback pages in R2 will answer 500 after this change (accepted: test data), and unfinished ones under `./data` must be moved away before the bot runs (Preflight).
13. **The bot waits up to 15 minutes for people:** `MEET_ADMIT_TIMEOUT_MS` (new shared constant in `src/config.ts`) goes from 5 to 15 minutes (the Worker's cap) and the container's "alone" rule counts `EMPTY_CHANNEL_TIMEOUT_MIN` only after someone else has been in the call; before that it waits `admitTimeoutMs`.
    Without this, a calendar start (the bot arrives at about the start time) would end as "alone" 3 minutes later whenever people are a few minutes late.
    No protocol change: the runner reuses the job's `admitTimeoutMs`; this needs a container image redeploy (Task 15).
14. **Consent:** the Meet chat notice the container posts is the only notice; when it could not be posted (`consentPosted: false`), the starter gets one email asking them to tell the participants (this replaces the Discord fallback sentence).
15. **Failure emails go to the starter only** (web starter or calendar organizer): not admitted, denied, auth expired (with the admin instruction), join failed, recorder start failed, recorder lost, processing failed.
    Meet end reasons become Thai (`describeMeetEnd`) because they now appear only in Thai emails; Discord end reasons stay English.
    When nobody spoke (the transcript has no lines, so the minutes say "ไม่พบเสียงพูด"), the minutes go to the organizer or starter only, not to every recipient (user decision).
16. **Boot order:** Meet recovery (`recoverUnfinished(client, "meet")`) runs at boot before the web server and the poller start, so a re-attached recording counts toward the limits before any new start; Discord recovery stays in `ClientReady`.
17. **Testing:** node:test only, no network: a fake email sender (`mockEmail()` / `sentEmails` in `src/test/setup.ts`), a synthetic Google-shaped fixture `src/calendar/fixture.ics` mirroring the fields Task 0 finds (no real data), and the existing `fakeMeetRecorder()`.
    The user store is real in every test: unit tests build `new UserStore(<temp file>)`, and route, session, and poller tests use the shared `users()` on the temporary `DATA_DIR` that `src/test/setup.ts` creates.
    The repo is public, so tests, fixtures, examples, and this plan use placeholder addresses only (`example.com`, `planthia.test`, `bot@example.com`); real addresses live only in `.env`.
    The real flows are verified once in `## End-to-end verification` on `https://meet.google.com/abc-defg-hij` with real emails.
18. **Users live in one JSON file, `DATA_DIR/users.json`, owned by `src/users/store.ts`** (chosen over `node:sqlite` and an R2 object).
    `node:sqlite` needs the `--experimental-sqlite` flag on Node 22.5 to 22.12 (it is unflagged from 22.13.0), while `package.json` allows `>=22.12.0`, so it would force an `engines` bump; it still prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` on v22.19.0 (checked locally while revising), and an experimental API is a poor home for the only copy of the user list.
    An R2 object would put a network call, and its failures, on every page request and calendar poll, and concurrent updates would need conditional writes.
    The JSON file needs no dependency, reuses the repo's atomic write (temp file plus rename, as `saveLocal` in `src/storage/manifest.ts` and `calendar-handled.json` do), lives on the `meeting-data` volume (`DATA_DIR=/data`), so it survives restarts and redeploys, and stays tiny (tens to hundreds of users, so rewriting it whole on each change costs nothing).
    The bot process is the only writer: `UserStore` loads the file once, keeps the users in memory, and rewrites the file on every change; nobody edits the file while the bot runs (one reason the admin tool is a page, Decision 20).
    A damaged file stops the bot at boot with a clear error instead of silently starting with no users (which would drop the admin flag).
    One record per email: `{ email, status, isAdmin, createdAt, lastLoginAt?, recentStarts }`, where `recentStarts` holds the start times of the last 24 hours for the daily limit, so a restart does not reset it.
19. **Seeding:** `SEED_ADMIN_EMAIL` (empty in `.env.example`, but required by the config check whenever Meet recording is on, because open signup needs someone who can disable accounts) is created as an active admin at every boot, or made an active admin again when it already exists, so the config is also the way back in after a lockout.
    The user sets it to their own address in their own `.env`; the address is never written in source, tests, fixtures, `.env.example`, or this plan.
20. **Admin ability: a tiny admin page at `/meet/admin`, not a CLI script** (Task 11b).
    It lists the users (email, admin flag, status, created, last login) with one disable or enable button each, and nothing else.
    A CLI script would be a second writer of `users.json` while the bot runs (or would need the bot stopped) and needs a shell plus `docker compose exec` on the VPS; the page reuses the login cookie, the CSRF check, the Thai templates, and gives `isAdmin` a meaning.
    Admins cannot change their own status (no self-lockout); the admin URLs answer 404 to everyone who is not a signed-in admin.
    Disabling someone signs them out at once and stops their calendar starts, but does not stop a recording that already runs (it ends by itself, at the latest after `MEET_MAX_DURATION_MIN`).
21. **Abuse and cost limits, because signup is open.**
    Anyone with a mailbox can sign up and make the bot join any Meet link they can reach, which costs about $0.08 per recording hour for the container plus transcription and summary; a recording lasts at most `MEET_MAX_DURATION_MIN` (240 min by default).
    The limits that bound this:
    - At most 2 Meet recordings at once and one per Meet code (Decision 11, unchanged); this caps the container spend at about 2 x 24 h x $0.08 = $3.84 per day whatever the number of accounts, but someone can keep both slots busy (a denial of service; the admin can disable the account, Decision 20).
    - Per person: `MEET_MAX_ACTIVE_PER_USER` (default 1; a calendar meeting refused for it is retried while due, Decision 11) running recordings and `MEET_MAX_DAILY_PER_USER` (default 5) starts per rolling 24 hours, web and calendar together; a start that passed the limits counts even when the recorder then fails, because it may have started a container.
    - Login links: 5 requests per IP and 3 per email per 15 minutes (Decision 9).
    - New accounts: at most 10 per IP per 24 hours, checked when the first link is confirmed (`signupsPerIp`, in memory, so a restart resets it: accepted); 10 leaves room for a team signing up from one office network behind NAT.
    - Links to new addresses: at most 50 per 24 hours in total (`MAX_SIGNUP_EMAILS_PER_DAY`), so a flood of fake signups from many IPs cannot use up the Resend quota that the minutes need; over the cap a new address gets the usual "check your email" page but no email (logged), while existing accounts, the admin included, keep getting their links, so the cap cannot lock anyone out.
    - No user enumeration: `/meet/login` gives the same page, status, and timing for new, existing, and disabled addresses (Decision 9).
    Disposable addresses can sign up; they are not blocked, because a domain blocklist must be maintained and is easy to dodge, and every extra address only buys another per-person allowance inside the same global limit of 2.
    Per-person limits are per address, so one person with many addresses gets many allowances; the global limit of 2 is the real cost bound.
    Minutes recipients are capped at the starter plus 20 per recording on both triggers (`MAX_EXTRA_RECIPIENTS` on the web page, `MAX_CALENDAR_RECIPIENTS` in the poller), so a stranger can mail attacker-controlled minutes to at most 20 addresses per recording; a tighter rule is Open question 6.
22. **Calendar trust with open signup.**
    The organizer must be a registered, active user, so a stranger who merely invites the bot gets nothing, and nothing needs to be forged to be refused.
    But signup is open, so anyone can sign up first and then invite the bot: the calendar trigger then gives no more trust than the web page, and the same per-person limits apply to the organizer.
    A forged ORGANIZER (Task 0 Step 6b) is still worth checking: it would let an outsider use up a real user's per-person limits, send minutes in that user's name to the forger's invitees, and hide who asked.
    If the user later wants the calendar (and the web page) limited to people they trust, the smallest change is admin approval: new accounts start disabled and an admin enables them on the admin page (Open question 1); this plan does not decide it.

## Open questions for the user

These are not decided by this plan; the defaults below ship unless the user says otherwise.

1. **Admin approval for new accounts?** With open signup anyone can register, then start recordings on the web page or by inviting the bot from their calendar (Decisions 21 and 22).
   Admin approval would make new accounts start `disabled` until an admin enables them on the admin page (a few lines in Task 4c and Task 11; new users would then see the "account disabled" page until approved).
   Default: open signup, as the user decided.
2. **Limit values:** 1 running recording and 5 starts per 24 hours per person (config), 10 new accounts per IP per 24 hours, 50 links to new addresses per 24 hours in total, and 20 extra minutes recipients per recording (constants).
   10 accounts per IP still blocks a larger team signing up from one office network on the same day; raise it if that is the first real use.
   The Resend daily quota (Task 0 Step 8 records it) must cover the 50 signup links plus every minutes email (up to 21 per recording) plus failure notices; the free plan's daily quota (100 emails when this was revised) is likely too small for open signup.
3. **Disposable email addresses:** accepted for now (Decision 21); a domain blocklist is possible later.
4. **Forged organizer:** if Task 0 Step 6b shows a forged organizer is accepted, the user chooses between "Only if the sender is known" and accepting the risk (Task 0 Step 9).
5. **Admin reach:** the admin page cannot stop someone else's running recording (Decision 20); say if it should.
6. **Minutes recipients for strangers:** anyone who signs up can have the minutes of a call they control (an attacker-written summary) emailed from the user's sending domain to up to 20 extra addresses per recording, on the web and from the calendar (Task 13 caps calendar recipients at the organizer plus 20 too).
   The 2-recording limit and the per-person daily limit bound it, and silent recordings email only the starter, but every new account brings a new allowance.
   Options for later: extra recipients only for admins, or a per-person daily recipient budget.
7. **Account deletion (PDPA):** `users.json` keeps every address until someone removes it, and there is no delete button (NOT building).
   Deleting an account on request means stopping the bot, removing that record from `users.json`, and starting the bot again; say if a delete button is wanted.

## Architecture

```
Google Calendar (bot account, MEET_BOT_EMAIL)                Browser
   │ secret iCal address, GET every 60 s                         │ /meet  (magic-link login, open signup)
   ▼                                                             ▼
calendar/poller.ts ── due + organizer is user ─┐      web/meet-routes.ts ── POST /meet/start {url, emails}
   handled keys in DATA_DIR/calendar-handled.json │                         │  POST /meet/stop {id}, /meet/admin
   users: users/store.ts ─ DATA_DIR/users.json ───┼─────────────────────────┤  (cookie user must be active)
                                                 ▼                         ▼
                         startMeet(meet: MeetInfo) = MeetSession.start(meet, onFinished)
                           activeMeets (by Meet code, max 2, per person: active + daily caps)
                           MeetRefused("already_recording" | "user_busy" | "daily_limit" | "busy")
                                                 │ unchanged Worker API (Bearer MEET_RECORDER_TOKEN)
                                                 ▼
                     everymeet-meet-recorder Worker ─► Durable Object ─► container (Meet chat consent notice)
                                                 │ poll status every 15 s
                                                 ▼
             failure ─► email the starter        ended ─► processMeeting (unchanged pipeline)
                                                              │ m.meet ?
                                    ┌─────────────────────────┴────────────────────┐
                        email minutes to each recipient               Discord post (unchanged /record)
                        (summary + /m/<id> link + PIN)
                        via the Resend REST API (src/email/send.ts)
```

New files:

```
src/util/email.ts           normalizeEmail, parseEmailList (pure; the allowlist helpers are removed by Task 4b)
src/users/store.ts          UserStore (users.json, atomic writes, the only user I/O) and users()
src/email/send.ts           sendEmail(e: Email): one recipient, Resend REST, the only email I/O
src/email/messages.ts       Thai email builders + describeMeetEnd (pure apart from config())
src/calendar/feed.ts        occurrencesIn (node-ical), isDue, recipientsOf, LEAD_MS, LATE_MS
src/calendar/handled.ts     loadHandled / saveHandled (atomic JSON file in DATA_DIR)
src/calendar/poller.ts      startCalendarPoller, pollCalendar
src/calendar/fixture.ics    synthetic Google-shaped feed for tests
src/web/client-ip.ts        clientIp (moved out of server.ts)
src/web/rate-limit.ts       RateLimit
src/web/login-links.ts      createLoginLink / consumeLoginLink
src/web/meet-routes.ts      /meet pages: login, auth (signup), start, stop, admin
```

Deleted: `src/recorder/active.ts`.

## Global Constraints

- Runtime Node >= 22.12.0 with npm and `package-lock.json`; never Bun APIs or `bun.lock` (AGENTS.md "Hard constraint").
- The only new runtime dependency is `node-ical` at exactly `0.27.6` (no `^`), added in Task 12 with `npm install --save-exact node-ical@0.27.6`.
- Every relative import ends in `.js`; double quotes, semicolons, 2-space indent, trailing commas; match surrounding code (no formatter or linter exists).
- All environment access goes through `src/config.ts`; every new variable is added to the zod schema, `.env.example`, and the test env in `src/test/setup.ts` in the same task.
- Log through `logger(scope)`, never bare `console.log`.
- Never log or put in an error message: `RESEND_API_KEY`, `CALENDAR_ICAL_URL`, login-link tokens, `MEET_RECORDER_TOKEN`, `SESSION_SECRET`, cookie values, or the bot-account session file.
  Email addresses may be logged (they are not secrets; existing logs already carry names).
- Every user-facing string on web pages and in emails is Thai; times are Bangkok time via `src/util/time.ts`.
  Discord command replies stay English as today.
- Pages under `/meet` keep the app-wide security headers and `Cache-Control: no-store` from the `app.use("*")` middleware in `src/web/server.ts`; forms POST to same-origin paths only (`form-action 'self'`); no scripts (CSP `default-src 'none'`).
- One Discord recording per guild (`activeSessions` in `src/recorder/session.ts`); one Meet recording per Meet code and at most `MAX_MEET_RECORDINGS = 2` at once (`activeMeets` in `src/meet/session.ts`), plus the per-person limits of Decision 21.
- Users: `DATA_DIR/users.json` is read and written only through `src/users/store.ts` (`users()`), by the bot process only; emails are keyed lowercase.
- Consent / PDPA: the Meet chat notice posted by the container is the only notice for Meet; the Discord `/record` announcements stay as they are.
- The bot-account session (`authState`) handling is unchanged: read fresh on every start, sent only in the HTTPS start request, never stored or logged.
- Keep both transcription models and both summary models with their fallbacks; Meet processing goes through the unchanged `transcribe()` and `chat()`.
- Tests: `node:test` + `node:assert/strict`, next to the code as `*.test.ts`; nothing talks to real Discord, Google, Cloudflare, or OpenRouter, and no test sends real email.
- Quality gate: root `npm run typecheck` and `npm test`; in `meet/` the same two when `meet/`, `src/meet/protocol.ts`, or `src/storage/keys.ts` changed (Task 3).
- Commits: Conventional Commits (`feat(web): ...`, `refactor(meet): ...`), one per task, explicit `git add <paths>` (never `git add -A`: `.env`, `secrets/`, `meet/auth/`, and untracked `spike/` edits must stay out), no agent co-author line, never edit CHANGELOG files.
- Markdown written by this plan puts each full sentence on its own line and never uses the em dash.
- The repo is public: code, tests, fixtures, `.env.example`, docs, and this plan contain placeholder addresses and ids only (`example.com`, `planthia.test`, `<account-id>`); real addresses (the bot account, the sender, the seeded admin), tokens, and home-directory paths live only in `.env` and `secrets/`.

## Patterns to Mirror

### Config: zod schema in `src/config.ts`, blanks mean unset
<!-- SOURCE: src/config.ts:8-9,52-63 -->
```ts
/** Empty values in .env mean "not set". */
const blank = (v: unknown) => (v === "" ? undefined : v);
...
  /** Origin of the meet-recorder Worker (meet/). /record-meet is off when unset. */
  MEET_RECORDER_URL: z.preprocess(blank, z.url().optional()),
  /** Same value as the Worker secret RECORDER_TOKEN. */
  MEET_RECORDER_TOKEN: z.preprocess(blank, z.string().min(32).optional()),
...
}).refine((c) => !c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, {
  message: "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together",
  path: ["MEET_RECORDER_TOKEN"],
});
```

### Error handling: log and keep going when the failure is not fatal
<!-- SOURCE: src/recorder/segment-uploader.ts:34-44 -->
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
```

### Atomic local JSON write
<!-- SOURCE: src/storage/manifest.ts:59-65 -->
```ts
export function saveLocal(m: Manifest): void {
  const dir = meetingDir(m.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "manifest.json.tmp");
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, join(dir, "manifest.json")); // atomic replace
}
```

### Tests: replace a module before importing the code under test
<!-- SOURCE: src/test/setup.ts:37-45 -->
```ts
/** Replaces the R2 client with an in-memory bucket. Call before importing code that uses it. */
export function mockR2(opts: { failPuts?: () => boolean } = {}): void {
  const put = (key: string, body: Buffer) => {
    if (opts.failPuts?.()) throw new Error("R2 unavailable");
    r2.set(key, body);
  };
  mock.module(new URL("../storage/r2.js", import.meta.url).href, {
    namedExports: {
      putFile: async (key: string, path: string) => put(key, readFileSync(path)),
```
and the caller (`src/meet/session.test.ts:11-13`):
```ts
mockR2();
const worker = fakeMeetRecorder();
const { MeetSession } = await import("./session.js");
```

### Web: security headers for every response, signed cookie
<!-- SOURCE: src/web/server.ts:87-98 and 138-144 -->
```ts
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    ...
  });
...
    setCookie(c, cookieName(id), signAccess(id, config().SESSION_SECRET, ACCESS_TTL_MS), {
      path: `/m/${id}`,
      httpOnly: true,
      secure: config().PUBLIC_BASE_URL.startsWith("https://"),
      sameSite: "Lax",
      maxAge: ACCESS_TTL_MS / 1000,
    });
```

### Web: page templates are functions over `shell()` with `esc()`
<!-- SOURCE: src/web/templates.ts:42-52 -->
```ts
  pin: (o: { id: string; title: string; error?: string }) =>
    shell(
      "ใส่ PIN",
      `<div class="card"><p class="eyebrow">บันทึกการประชุม</p><h1>${esc(o.title)}</h1>
<p class="meta">ใส่ PIN 6 หลักที่บอทส่งไว้ในข้อความ Discord</p>
<form method="post" action="/m/${esc(o.id)}" autocomplete="off">
<label for="pin">PIN</label>
<input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<button type="submit">เปิดบันทึก</button></form></div>`,
    ),
```

### Web tests: `app.request()` with form bodies and `x-forwarded-for`
<!-- SOURCE: src/web/server.test.ts:5-7,33-38 -->
```ts
mockR2();
process.env.TRUST_PROXY = "true"; // as behind Nginx; the tests send X-Forwarded-For
const { createApp } = await import("./server.js");
...
const submitPin = (id: string, pin: string, ip = newIp()) =>
  app.request(`/m/${id}`, {
    method: "POST",
    body: new URLSearchParams({ pin }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
  });
```

### Session registry and the 15 s tick
<!-- SOURCE: src/recorder/session.ts:31-34 (Task 6 puts the Discord registry back right after these lines) -->
```ts
export const CONTINUE_BUTTON_PREFIX = "meeting-continue:";
/** Wait this long past a segment boundary before closing it, so late packets still land. */
const SEGMENT_GRACE_SAMPLES = SAMPLE_RATE * 15;
const TICK_MS = 15_000;
```

### Calendar parsing
No existing pattern in this repo - establishing new convention: all `node-ical` use lives in `src/calendar/feed.ts`, which returns plain `Occurrence` objects; everything after it is plain TypeScript.
API names below were checked against `node-ical@0.27.6/node-ical.d.ts`: `parseICS(body: string): CalendarResponse` (L76, also as `ical.sync.parseICS`), `expandRecurringEvent(event: VEvent, options: { from: Date; to: Date; ... }): EventInstance[]` (L111-114, L142-169), `EventInstance { start, end, isFullDay, isRecurring, isOverride, event: VEvent }` (L174-203), `VEvent.recurrenceid?`, `organizer?`, `attendee?: Attendee[] | Attendee`, `status?: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED'`, `recurrences?` (L296-336, L655), `ParameterValue<T> = T | { val: T; params: P }` (L557-566); X- properties are stored without the `X-` prefix, so `X-GOOGLE-CONFERENCE` is `event["GOOGLE-CONFERENCE"]` typed `unknown`.

## Preflight

### DURABLE - true until the repo itself changes

- npm, no workspaces; `meet/` is a separate npm package - Evidence: root `package.json` has no `workspaces`; `meet/package.json` has its own scripts - Consequence: Task 3 runs `cd meet && npm run typecheck && npm test` too; Task 12 changes only the root lockfile.
- Root tests are `node --import tsx --experimental-test-module-mocks --test 'src/**/*.test.ts'` and `tsconfig.test.json` includes all of `src` - Evidence: `package.json` `scripts.test`, `tsconfig.test.json` - Consequence: new `*.test.ts` files under `src/` run automatically; `src/calendar/fixture.ics` is not compiled and is read with `readFileSync(new URL("./fixture.ics", import.meta.url))`.
- `mock.module` replaces a module only for imports that happen after it, so `mockEmail()` (Task 2) must be called before `await import(...)` of any module that imports `src/email/send.ts` - Evidence: the `mockR2()` pattern and its comment in `src/test/setup.ts:37`.
- Installed versions: hono 4.13.13, zod 4.6.6 (`superRefine` exists, `node_modules/zod/v4/classic/schemas.d.ts:42`; `z.email()` and `z.url()` are top-level) - Evidence: `node -p "require('./node_modules/hono/package.json').version"` printed `4.13.13`, zod printed `4.6.6`.
- `node-ical@0.27.6` exists on npm with `"type": "module"`, `engines.node ">=22"`, dependencies `rrule-temporal ^2.2.8` and `temporal-polyfill ^1.0.6` - Evidence: `npm view node-ical@0.27.6 version dependencies engines type --json`.
- The `meet/` recorder Worker validates `admitTimeoutMs <= 15 min` and computes its hard deadline as `admit + maxDuration + 10 min` - Evidence: `meet/worker/http.ts:62-63`, `meet/worker/core.ts:51` - Consequence: a 15-minute admit timeout needs no Worker change.
- `src/recorder/active.ts` is imported by exactly `src/index.ts`, `src/interactions.ts`, `src/recorder/session.ts`, `src/meet/session.ts`, `src/bot.test.ts`, `src/meet/session.test.ts` - Evidence: `grep -rln 'active.js' src` lists exactly these six files - Consequence: Task 6 edits exactly these.
- Single sequential track, so treehouse is not needed.

### PERISHABLE - recapture before task 1

- Baseline gate is green - Check: `npm run typecheck; npm test 2>&1 | tail -8; (cd meet && npm run typecheck && npm test 2>&1 | tail -8)` - Value at planning (2026-11-20, 478fc65): both typechecks exit 0; root `# tests 50`, `# pass 50`, `# fail 0`; meet `# tests 18`, `# pass 18`, `# fail 0`; value at this revision (29a9203, after Tasks 1-4, run while revising at f166ecc; 29a9203 changed only placeholders): root `# tests 59`, `# pass 59`, `# fail 0`; meet `# tests 20`, `# pass 20`, `# fail 0` - Needed by: every Verify below that states a pass count.
  The counts in later Verify lines are "baseline plus the tests that task adds or removes"; if the baseline differs, shift every count by the same difference.
- Dependencies installed in this checkout - Check: `test -d node_modules && test -d meet/node_modules && echo ok` - Value at planning: `ok` - Needed by: every task.
- Node and ffmpeg - Check: `node --version; which ffmpeg` - Value at planning: `v22.19.0`, `/opt/homebrew/bin/ffmpeg` - Needed by: root `npm test` (the pipeline tests run real ffmpeg).
- npm registry reachable - Check: `npm view node-ical@0.27.6 version` - Value at planning: `0.27.6` - Needed by: Task 12.
- No unfinished Meet manifest of the old shape on local disk (the previous plan's E2E saved some under `./data`; after Task 7 the bot would resume them and `/meet` would fail on their missing `recipients`) - Check: `node -e 'const fs=require("fs"),p="data/meetings";for(const id of fs.existsSync(p)?fs.readdirSync(p):[]){try{const m=JSON.parse(fs.readFileSync(p+"/"+id+"/manifest.json","utf8"));if(m.meet&&!m.meet.title&&(m.status==="recording"||m.status==="processing"))console.log(id,m.status)}catch{}}'` (use `$DATA_DIR` if `.env` sets another folder) - Value at planning: not checked (it would have meant reading local recordings) - Needed by: `## End-to-end verification`; if it prints ids, ask the user, then move those folders out of `data/meetings/`.
- On branch `feat/meet-recording` at or after 29a9203 with no staged changes - Check: `git status --short --branch | head -3; git log --oneline -1` - Needed by: every commit (use explicit `git add` paths).

Live prerequisites (the bot Google account, the secret iCal address, the Resend API key, a Cloudflare login for the image redeploy) were not checked while planning, because reading `.env` and authenticated calls were not allowed then.
They are collected as the Human steps of Task 0 and checked again at the start of Task 15 and of `## End-to-end verification`.

## Execution

**Tracks:** one sequential track in this order: 0, 1-4 (done), 4b, 4c, 5, 6, 7, 7b, 8, 9, 10, 11, 11b, 12, 13, 14, 15, in the current checkout on `feat/meet-recording`, where Tasks 1-4 already landed (the earlier idea of a new branch `feat/meet-calendar-web-email` was dropped when Tasks 1-4 were committed there).
Most tasks touch `src/config.ts`, `src/test/setup.ts`, `src/meet/session.ts`, or `src/web/templates.ts`, so parallel tracks would collide.

**Task 0 is a human-paced probe:** start it first; while waiting for the user's answers, continue with Tasks 4b-11b and then 14, which do not depend on it.
Tasks 12 and 13 (calendar) start only after Task 0's gate says GO; if the gate says STOP, skip them and do the cleanup commit described in Task 0 Step 9.
Task 15 (image redeploy) and `## End-to-end verification` need the user for Cloudflare and Google steps.

**Merge order:** not applicable (one branch); the user decides when to merge `feat/meet-recording`.
**Shared files:** `src/config.ts`, `.env.example`, and the env block of `src/test/setup.ts` are owned by Task 1 and then Task 4b; `src/test/setup.ts` `mockEmail` by Task 2; `src/users/store.ts` by Task 4c; `package.json` + `package-lock.json` by Task 12.

---

### Task 0: Probe the bot calendar's iCal feed and set up the email sender (gate for Tasks 12-13)

This task changes no code.
It answers three unknowns with real data: which fields a personal Gmail account's secret iCal feed carries for invitations (Meet link, organizer, attendees, cancelled and moved occurrences), whether invitations from unknown senders appear, and how quickly a new invitation shows up in the feed.
It also makes one real test send through Resend with the user's API key (the domain `mail.example.com` is already verified there).
Never print, paste, or commit the secret address, real email addresses, event titles other than the probe titles, or UIDs.

**Files:**
- Modify: `docs/plans/2026-11-01-meet-calendar-web-email.md` (fill `#### Probe results (Task 0)` at the end of this task)
- Scratch, never committed: `/tmp/everymeet-probe.ics`

**Rollback:** if the secret address leaks, reset it in Google Calendar (Settings for my calendars > Integrate calendar > Secret address in iCal format > Reset) and update `.env`; if the Resend key leaks, delete it in Resend > API Keys and create a new one.

**Steps:**
- [ ] 👤 Step 1: Verify - Human: sign in to the bot Google account (its address is what you put in `MEET_BOT_EMAIL`), open Google Calendar > Settings > General > Event settings > "Add invitations to my calendar", note the current value, and set it to "From everyone" - Expected: the setting shows "From everyone" (Google applies it to new invitations only) - Proxy: Step 5 shows the probe invitations in the feed.
- [ ] 👤 Step 2: Verify - Human: in the same account open Settings for my calendars > (the bot's calendar) > Integrate calendar, copy "Secret address in iCal format", and add it to the local `.env` as `CALENDAR_ICAL_URL=<address>` without pasting it anywhere else - Expected: the line exists - Proxy: `grep -c '^CALENDAR_ICAL_URL=https://calendar.google.com/calendar/ical/' .env` prints `1` (the agent runs this; it prints a count, not the value).
- [ ] 👤 Step 3: Verify - Human: from a personal Google account whose address will be a user (for example the address you put in `SEED_ADMIN_EMAIL`) and that has never emailed the bot account, create (a) a weekly event titled `everymeet probe weekly` with "Add Google Meet video conferencing", inviting the bot account and one more address you control; then delete one future occurrence ("This event") and move another future occurrence one hour later ("This event"); and (b) a one-off event titled `everymeet probe single` with no video conferencing whose description contains `https://meet.google.com/abc-defg-hij`, inviting the bot account - Expected: both events saved; tell the agent "done" - Proxy: Step 5 reports both events.
      If the user prefers to export a file instead, they may save the bot calendar export (Settings > Import and export > Export, unzip) as `/tmp/everymeet-probe.ics` and skip Step 4.
- [ ] Step 4: Download the feed without printing the address:
      ```bash
      node --env-file=.env -e 'fetch(process.env.CALENDAR_ICAL_URL).then(async (r) => { require("fs").writeFileSync("/tmp/everymeet-probe.ics", await r.text()); console.log("HTTP", r.status); })'
      ```
      Expected: `HTTP 200` and a non-empty `/tmp/everymeet-probe.ics`.
- [ ] Step 5: Verify - Manual: print the field shape of the probe events only (names, flags, and enumerated values, never addresses or descriptions):
      ```bash
      node -e '
      const raw = require("fs").readFileSync("/tmp/everymeet-probe.ics", "utf8").replace(/\r?\n[ \t]/g, "");
      const MEET = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
      const user = (process.argv[1] ?? "").toLowerCase(); // optional: the <USER> address of Step 6b; printed only as true/false
      for (const block of raw.split("BEGIN:VEVENT").slice(1)) {
        const lines = block.split("END:VEVENT")[0].split(/\r?\n/).filter(Boolean);
        const get = (n) => lines.filter((l) => l.split(/[;:]/)[0] === n);
        const summary = (get("SUMMARY")[0] ?? "").replace(/^SUMMARY[^:]*:/, "");
        if (!summary.startsWith("everymeet probe")) continue;
        console.log(JSON.stringify({
          summary,
          props: [...new Set(lines.map((l) => l.split(/[;:]/)[0]))].sort(),
          conferenceIsMeet: get("X-GOOGLE-CONFERENCE").some((l) => MEET.test(l)),
          descriptionHasMeet: get("DESCRIPTION").some((l) => MEET.test(l)),
          locationHasMeet: get("LOCATION").some((l) => MEET.test(l)),
          organizerMailto: get("ORGANIZER").some((l) => /:mailto:/i.test(l)),
          organizerIsUser: user ? get("ORGANIZER").some((l) => l.toLowerCase().endsWith(`:mailto:${user}`)) : undefined,
          attendees: get("ATTENDEE").length,
          partstats: get("ATTENDEE").map((l) => /PARTSTAT=([A-Z-]+)/.exec(l)?.[1]),
          cutypes: get("ATTENDEE").map((l) => /CUTYPE=([A-Z-]+)/.exec(l)?.[1]),
          recurrenceId: get("RECURRENCE-ID").map((l) => l.split(":")[0]),
          exdates: get("EXDATE").length,
          rrule: get("RRULE").length > 0,
          status: get("STATUS")[0]?.split(":")[1],
          dtstart: get("DTSTART")[0]?.split(":")[0],
        }));
      }'
      ```
      Expected: one JSON line per probe VEVENT (the weekly master, one line per moved or cancelled override if Google writes overrides, and the single event).
      Copy the output into `#### Probe results (Task 0)` below (it contains no personal data).
- [ ] Step 6: Verify - Manual: measure how fast a new invitation reaches the feed.
      Start this poller in the background, then ask the user to create, right away, a one-off event titled `everymeet probe fresh` (any time, any Meet link) inviting the bot account, and to say the moment they clicked Save:
      ```bash
      node --env-file=.env -e '
      const want = process.argv[1]; const t0 = Date.now();
      const tick = async () => {
        const text = (await (await fetch(process.env.CALENDAR_ICAL_URL)).text()).replace(/\r?\n[ \t]/g, "");
        if (text.includes(`SUMMARY:${want}`)) { console.log(`seen after ${Math.round((Date.now() - t0) / 1000)} s`); process.exit(0); }
        if (Date.now() - t0 > 30 * 60_000) { console.log("not seen within 30 min"); process.exit(1); }
      };
      setInterval(() => tick().catch((e) => console.log(`fetch failed: ${e.message}`)), 30_000);
      tick().catch(() => {});' 'everymeet probe fresh'
      ```
      Expected: `seen after N s`; record N minus the seconds between starting the poller and the user's Save in the probe results.
- [ ] 👤 Step 6b: Verify - Human: check whether an emailed invitation can claim a registered user as its organizer (calendar trust rests on ORGANIZER alone: the organizer must be an active user, Decisions 6 and 22).
      The agent writes two files, replacing `<BOT>` with the bot account address from `MEET_BOT_EMAIL` in `.env`, `<USER>` with an address the user owns that will be an active user (for example the `SEED_ADMIN_EMAIL` address), `<SENDER>` with the mailbox the user sends from, and `<DAY>` with tomorrow's date as `YYYYMMDD`.
      `<SENDER>` must NOT be (or later become) a user and should be on another domain than `<USER>`.
      `/tmp/everymeet-probe-forged.ics` (the claim to test) and `/tmp/everymeet-probe-control.ics` (the same content with `UID:everymeet-probe-control-1@example.com`, `SUMMARY:everymeet probe control`, and `ORGANIZER;CN=Sender:mailto:<SENDER>`):
      ```text
      BEGIN:VCALENDAR
      PRODID:-//everymeet probe//EN
      VERSION:2.0
      METHOD:REQUEST
      BEGIN:VEVENT
      UID:everymeet-probe-forged-1@example.com
      DTSTAMP:20261120T000000Z
      DTSTART:<DAY>T030000Z
      DTEND:<DAY>T040000Z
      SUMMARY:everymeet probe forged
      ORGANIZER;CN=Registered User:mailto:<USER>
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:<BOT>
      DESCRIPTION:https://meet.google.com/abc-defg-hij
      SEQUENCE:0
      STATUS:CONFIRMED
      END:VEVENT
      END:VCALENDAR
      ```
      The user sends both, the same way and from `<SENDER>`, to the bot account (as attachments with content type `text/calendar; method=REQUEST` if their mail client allows); after 5 minutes the agent repeats Step 4 and runs Step 5 with `<USER>` as its argument (`node -e '...' '<USER>'`) - Expected: `everymeet probe control` appears (the import path works), and `everymeet probe forged` is absent or has `organizerIsUser: false` - Proxy: the Step 5 JSON lines for the two probe events.
      If the control does not appear, the result is INCONCLUSIVE (the mail client did not send a real invitation): STOP and ask the user, who either sends both as a real iMIP message (a `text/calendar; method=REQUEST` body part, for example from a short Python `smtplib` script with their own mailbox) or accepts the risk unproven.
- [ ] 👤 Step 7: Verify - Human: give the bot a Resend API key.
      The sending domain `mail.example.com` is already verified in Resend (user, 2026-11-20).
      In the Resend dashboard > API Keys create a key with permission "Sending access" and the verified sending domain (written `mail.example.com` in this plan; the real domain is only in the user's `.env` and Resend), and add to `.env`: `RESEND_API_KEY=<key>`, `EMAIL_FROM=<sender on that domain>`, `MEET_BOT_EMAIL=<the bot account address>`, `SEED_ADMIN_EMAIL=<your own address>` (it becomes the first admin; it is set only in `.env`, never in the code, tests, or this plan).
      In Resend > Domains > `mail.example.com` check that open and click tracking are off (tracking would rewrite the login and playback links).
      Never paste the key anywhere else - Expected: the user says the key is in `.env`, the domain shows "Verified", and tracking is off - Proxy: Step 8 (`grep -c '^RESEND_API_KEY=re_' .env` prints `1` first; the agent runs it, it prints a count, not the key).
- [ ] Step 8: Verify - Manual: one real send to the user's own address (ask for it), printing no secrets:
      ```bash
      node --env-file=.env -e '
      (async () => {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "User-Agent": "everymeet-bot/1.0" },
          body: JSON.stringify({
            from: `บอทบันทึกการประชุม <${process.env.EMAIL_FROM}>`, to: process.argv[1],
            subject: "ทดสอบการส่งอีเมล", text: "อีเมลทดสอบจากบอทบันทึกการประชุม", html: "<p>อีเมลทดสอบจากบอทบันทึกการประชุม</p>" }),
        });
        const b = await r.json();
        console.log("send", r.status, b.id ? "id ok" : JSON.stringify(b), "monthly quota used", r.headers.get("x-resend-monthly-quota"), "daily", r.headers.get("x-resend-daily-quota"), "rate limit", r.headers.get("ratelimit-limit"));
      })();' '<the user address>'
      ```
      Expected: `send 200 id ok` plus the quota and rate limit headers (record them in the probe results); then 👤 the user confirms the mail arrived in the inbox, not in spam, and that the sender name shows as "บอทบันทึกการประชุม".
      Any status other than 200: STOP and report the printed `name` and `message` to the user (400/401 `validation_error` is a bad key, 401 `missing_api_key` no key, 403 `restricted_api_key` an inactive key, 403 `validation_error` an unverified domain or a key restricted to another domain).
- [ ] Step 9: Gate - write the decision into `#### Probe results (Task 0)`:
      - GO for Tasks 12-13 when all hold: the weekly master has `organizerMailto: true`; it has `conferenceIsMeet: true` or `descriptionHasMeet: true`; the single event has `descriptionHasMeet: true`; the probe events are present although the organizer never wrote to the bot account; the fresh event was seen within 5 minutes.
      - `attendees: 0` on the invitations is still GO: recipients become the organizer only; tell the user.
      - Record how the deleted occurrence appears (EXDATE on the master, or an override with `status: "CANCELLED"`) and whether the moved occurrence is an override with `recurrenceId`; Task 12's fixture must use the same shapes.
      - STOP and ask the user when: `everymeet probe forged` appears with `organizerIsUser: true` (an outsider can claim a registered user as organizer; with open signup this gives them no recording they could not get by signing up, but it uses up that user's per-person limits, sends the minutes and failure emails in that user's name, and hides who asked, Decision 22; options: set "Add invitations to my calendar" to "Only if the sender is known" and have every user who wants calendar starts email the bot account once, then repeat Step 6b; or accept that a forger can only make the bot record a call the forger chose, within the victim's limits, and email its minutes to that event's invitees); no `ORGANIZER` mailto (the organizer cannot be matched to a user); the probe events are missing (the "From everyone" setting did not take effect); the fresh event took more than 5 minutes (calendar starts would only work for events created that long ahead: the user either accepts that or chooses a Calendar API plan); or the conference event has neither `conferenceIsMeet` nor `descriptionHasMeet` (the fallback is that organizers paste the Meet link into the description, which needs the user's agreement).
      - On STOP for the calendar: skip Tasks 12-13 and, in one commit (`refactor: drop the unused calendar trigger settings`), remove `CALENDAR_ICAL_URL` (and its `MEET_BOT_EMAIL` rule) from `src/config.ts`, `.env.example`, and `src/test/setup.ts`, the calendar sentences Task 14 added to README.md and AGENTS.md, and the AGENTS.md `src/calendar/` row; `MEET_BOT_EMAIL` stays only if something else still reads it (otherwise remove it too).
      - Email GO when Step 8 printed `send 200 id ok` and the user saw the mail in the inbox; otherwise Tasks 1-14 still go ahead with the fake sender, and only the End-to-end section waits.
- [ ] Step 10: Commit - `git add docs/plans/2026-11-01-meet-calendar-web-email.md && git commit -m "docs(plan): record calendar feed probe results"`

#### Probe results (Task 0)

(Filled in by Task 0: the Step 5 JSON lines, the Step 6 delay, the Step 6b result (control seen or not, forged absent or `organizerIsUser`), the Step 8 send result and quota headers, and the GO/STOP decision.)

---

### Task 1: Config for allowlist, email, and calendar, plus email address helpers

> **Done:** committed as bb746d1 (`feat(config): add email and calendar settings`).
> Superseded in part: Task 4b removes `ALLOWED_EMAILS` and the allowlist helpers.
> Commit 29a9203 (`chore: replace real identifiers with placeholders`) already replaced the real bot and sender addresses in `.env.example` and `src/test/setup.ts`; the one left, in the `EMAIL_FROM` comment of `src/config.ts`, is fixed by Task 4b (the reference code below already shows placeholders).

**Files:**
- Create: `src/util/email.ts`
- Create: `src/util/email.test.ts`
- Modify: `src/config.ts` (anchor: `MEET_MAX_DURATION_MIN: z.coerce`, ~L59, and the `}).refine(` block ~L60-63)
- Modify: `.env.example` (anchor: `# --- Google Meet recording`, ~L36)
- Modify: `src/test/setup.ts` (anchor: `Object.assign(process.env, {`, ~L19-33)

**Interfaces:**
- Produces: `normalizeEmail(text: string): string | undefined`; `parseEmailList(text: string): { emails: string[]; invalid: string[] }`; `interface Allowlist { emails: string[]; domains: string[] }`; `parseAllowlist(text: string | undefined): Allowlist`; `isAllowed(email: string, a: Allowlist): boolean` (all in `src/util/email.ts`).
- Produces: `Config` gains `ALLOWED_EMAILS: Allowlist`, `RESEND_API_KEY?: string`, `EMAIL_FROM?: string`, `CALENDAR_ICAL_URL?: string`, `MEET_BOT_EMAIL?: string` (lowercase).
- Consumers of `Config` (inferred type, widened only): every `config()` caller; no hand-built `Config` objects exist (`grep -rn "Config = {" src` finds none).

**Gotcha:** `src/test/setup.ts` sets `MEET_RECORDER_URL`, so the new rule "Meet needs email settings" makes every test fail at `config()` unless the test env gets `RESEND_API_KEY`, `EMAIL_FROM`, and `ALLOWED_EMAILS` in this same task.

**Steps:**
- [x] Step 1: Create `src/util/email.ts`:
      ```ts
      /** Email address helpers. Pure, so they are unit testable. */

      const ADDRESS_RE = /^[^\s@<>()[\]",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
      const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

      /** The lowercased address, or undefined when the text is not one plain address. Accepts a "mailto:" prefix (iCal). */
      export function normalizeEmail(text: string): string | undefined {
        const e = text.trim().replace(/^mailto:/i, "").toLowerCase();
        return e.length <= 254 && ADDRESS_RE.test(e) ? e : undefined;
      }

      /** Splits on commas, semicolons, and whitespace; returns unique valid addresses and the entries that are not addresses. */
      export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
        const emails = new Set<string>();
        const invalid: string[] = [];
        for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
          const e = normalizeEmail(part);
          if (e) emails.add(e);
          else invalid.push(part);
        }
        return { emails: [...emails], invalid };
      }

      /** Who may start Google Meet recordings: exact addresses, and whole domains written as "@example.com". */
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
- [x] Step 2: In `src/config.ts` add `import { invalidAllowlistEntries, parseAllowlist } from "./util/email.js";` under the zod import, add these keys after `MEET_MAX_DURATION_MIN`, and replace the `.refine(...)` with `.superRefine(...)`:
      ```ts
        /** A Google Meet recording ends after this many minutes; the Worker refuses more than 6 h. */
        MEET_MAX_DURATION_MIN: z.coerce.number().positive().max(360).default(240),
        /** Who may start Google Meet recordings (web page, calendar organizers): emails and whole domains as "@example.com", comma separated. */
        ALLOWED_EMAILS: z.preprocess(blank, z.string().optional()).transform(parseAllowlist),
        /** The bot Google account people invite; it never gets the minutes. Needed for calendar starts. */
        MEET_BOT_EMAIL: z.preprocess(blank, z.email().optional()).transform((v) => v?.toLowerCase()),
        /** The bot account's "Secret address in iCal format". A secret: never log it. Calendar starts are off when unset. */
        CALENDAR_ICAL_URL: z.preprocess(blank, z.url().optional()),
        /** Resend API key with "Sending access" for the sender's domain. A secret: never log it. */
        RESEND_API_KEY: z.preprocess(blank, z.string().startsWith("re_").optional()),
        /** Sender on a domain verified in Resend, e.g. minutes@mail.example.com. */
        EMAIL_FROM: z.preprocess(blank, z.email().optional()),
      }).superRefine((c, ctx) => {
        const need = (ok: unknown, path: string, message: string) => {
          if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
        };
        need(!c.MEET_RECORDER_URL === !c.MEET_RECORDER_TOKEN, "MEET_RECORDER_TOKEN", "set MEET_RECORDER_URL and MEET_RECORDER_TOKEN together");
        if (c.MEET_RECORDER_URL) {
          // Meet recordings are started on the web page or by calendar invitation and report by email only.
          need(c.RESEND_API_KEY, "RESEND_API_KEY", "Google Meet recording sends its minutes by email: set RESEND_API_KEY");
          need(c.EMAIL_FROM, "EMAIL_FROM", "Google Meet recording sends its minutes by email: set EMAIL_FROM");
          need(c.ALLOWED_EMAILS.emails.length + c.ALLOWED_EMAILS.domains.length > 0, "ALLOWED_EMAILS", "set who may start Google Meet recordings");
        }
        if (c.CALENDAR_ICAL_URL) {
          need(c.MEET_RECORDER_URL, "CALENDAR_ICAL_URL", "calendar starts need MEET_RECORDER_URL and MEET_RECORDER_TOKEN");
          need(c.MEET_BOT_EMAIL, "MEET_BOT_EMAIL", "calendar starts need MEET_BOT_EMAIL");
        }
        for (const bad of invalidAllowlistEntries(c.ALLOWED_EMAILS)) {
          need(false, "ALLOWED_EMAILS", `"${bad}" is neither an email address nor an @domain`);
        }
      });
      ```
      Also change the comment above `MEET_RECORDER_URL` from "/record-meet is off when unset." to "Google Meet recording is off when unset.".
- [x] Step 3: In `.env.example` replace the Meet section header comment and append the new keys:
      ```bash
      # --- Google Meet recording (optional; off when MEET_RECORDER_URL is unset) ---
      # Worker origin printed by the deploy in meet/, e.g. https://everymeet-meet-recorder.<subdomain>.workers.dev
      MEET_RECORDER_URL=
      # Same value as the Worker secret RECORDER_TOKEN: openssl rand -base64 48
      MEET_RECORDER_TOKEN=
      # Bot Google account session from `npm run meet:login` in meet/; on the VPS: /run/secrets/meet/meet-auth.json
      # (docker compose mounts ./secrets there). Leave empty to join as a guest, which Meet refuses more often.
      MEET_AUTH_STATE_FILE=
      MEET_MAX_DURATION_MIN=240
      # Who may start Meet recordings on the web page and as calendar organizers: emails and whole domains, comma separated,
      # e.g. you@example.com,@yourcompany.com (empty = the bot refuses to start while Meet recording is on)
      ALLOWED_EMAILS=
      # The bot Google account that people invite to calendar events; it never gets the minutes
      MEET_BOT_EMAIL=bot@example.com
      # Optional calendar trigger: the bot account's Google Calendar "Secret address in iCal format"
      # (Settings for my calendars > Integrate calendar). Treat it like a password.
      CALENDAR_ICAL_URL=

      # --- Email (Resend; required when Meet recording is on) ---
      # Resend API key with "Sending access" restricted to the sender's domain
      RESEND_API_KEY=
      # Any address on the domain verified in Resend
      EMAIL_FROM=minutes@mail.example.com
      ```
- [x] Step 4: In `src/test/setup.ts` add to the `Object.assign(process.env, {...})` block:
      ```ts
        ALLOWED_EMAILS: "alice@example.com, @planthia.test",
        MEET_BOT_EMAIL: "bot@example.com",
        CALENDAR_ICAL_URL: "https://calendar.example.com/calendar/ical/bot/private-secret/basic.ics",
        RESEND_API_KEY: `re_${"e".repeat(40)}`,
        EMAIL_FROM: "minutes@example.com",
      ```
- [x] Step 5: Create `src/util/email.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { invalidAllowlistEntries, isAllowed, normalizeEmail, parseAllowlist, parseEmailList } from "./email.js";

      test("addresses are lowercased, mailto: is accepted, and anything else is refused", () => {
        assert.equal(normalizeEmail(" Bob@Example.COM "), "bob@example.com");
        assert.equal(normalizeEmail("mailto:carol@planthia.test"), "carol@planthia.test");
        for (const bad of ["", "bob", "bob@", "@example.com", "Bob <bob@example.com>", "a b@example.com", "bob@localhost"]) {
          assert.equal(normalizeEmail(bad), undefined, bad);
        }
      });

      test("a typed list of extra recipients is split, deduplicated, and its bad entries are reported", () => {
        assert.deepEqual(parseEmailList("a@x.com, B@x.com;\nb@x.com  nope"), { emails: ["a@x.com", "b@x.com"], invalid: ["nope"] });
        assert.deepEqual(parseEmailList("   "), { emails: [], invalid: [] });
      });

      test("the allowlist matches exact addresses and whole domains, not subdomains", () => {
        const a = parseAllowlist("Alice@Example.com, @planthia.test");
        assert.deepEqual(a, { emails: ["alice@example.com"], domains: ["planthia.test"] });
        assert.equal(isAllowed("ALICE@example.com", a), true);
        assert.equal(isAllowed("bob@example.com", a), false);
        assert.equal(isAllowed("carol@planthia.test", a), true);
        assert.equal(isAllowed("dave@eu.planthia.test", a), false);
        assert.equal(isAllowed("mallory@planthia.test.evil.com", a), false);
        assert.deepEqual(parseAllowlist(undefined), { emails: [], domains: [] });
        assert.deepEqual(invalidAllowlistEntries(parseAllowlist("ok@x.com, nope, @bad_domain")), ["nope", "@bad_domain"]);
      });
      ```
- [x] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 53`, `# fail 0` (50 + 3).
- [x] Step 7: Commit - `git add src/util/email.ts src/util/email.test.ts src/config.ts .env.example src/test/setup.ts && git commit -m "feat(config): add allowlist, email, and calendar settings"`

---

### Task 2: Email sender (Resend REST API) and the fake sender for tests

> **Done:** committed as 9706c77 (`feat(email): send email through resend api`).

**Files:**
- Create: `src/email/send.ts`
- Create: `src/email/send.test.ts`
- Modify: `src/test/setup.ts` (append `sentEmails` and `mockEmail` after `mockR2`, ~L59)

**Interfaces:**
- Consumes: `config().RESEND_API_KEY`, `config().EMAIL_FROM` (Task 1).
- Produces: `interface Email { to: string; subject: string; text: string; html: string }`; `sendEmail(e: Email): Promise<void>` (throws on failure; the error message names the recipient, the HTTP status, and Resend's error `name` and `message`, never the key).
- Produces (tests): `sentEmails: Email[]`; `mockEmail(opts?: { fail?: (to: string) => boolean }): void` in `src/test/setup.ts`.

**Gotcha:** `send.test.ts` tests the real module, so it must NOT call `mockEmail()`; every other test file that ends up importing `src/email/send.ts` calls `mockEmail()` before its dynamic imports.
Resend rejects requests without a `User-Agent` header (403, error 1010); Node's `fetch` sends one, but the code sets it explicitly so the behaviour does not depend on the runtime.

**Steps:**
- [x] Step 1: Create `src/email/send.ts`:
      ```ts
      import { config } from "../config.js";

      /** One email to one recipient. */
      export interface Email {
        to: string;
        subject: string;
        text: string;
        html: string;
      }

      const FROM_NAME = "บอทบันทึกการประชุม";

      /** Resend's error body. */
      interface ResendError {
        statusCode?: number;
        name?: string;
        message?: string;
      }

      /**
       * Sends one email through the Resend REST API. Callers send one email per recipient, so recipients
       * never see each other's addresses and one bad address does not block the rest.
       * Throws when Resend refuses it; the error never contains the API key.
       */
      export async function sendEmail(e: Email): Promise<void> {
        const c = config();
        if (!c.RESEND_API_KEY || !c.EMAIL_FROM) throw new Error("email is not configured (RESEND_API_KEY, EMAIL_FROM)");
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "User-Agent": "everymeet-bot/1.0",
          },
          body: JSON.stringify({ from: `${FROM_NAME} <${c.EMAIL_FROM}>`, to: e.to, subject: e.subject, text: e.text, html: e.html }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) return;
        const body = (await res.json().catch(() => undefined)) as ResendError | undefined;
        const why = [body?.name, body?.message].filter(Boolean).join(": ");
        throw new Error(`email to ${e.to} failed: HTTP ${res.status}${why ? ` ${why}` : ""}`);
      }
      ```
- [x] Step 2: Append to `src/test/setup.ts` (add `import type { Email } from "../email/send.js";` next to the protocol type import):
      ```ts
      /** Emails "sent" through the fake sender, oldest first. */
      export const sentEmails: Email[] = [];

      /**
       * Replaces the Resend email sender. Call before importing code that sends email.
       * `fail` makes sends to matching addresses throw like a refused send.
       */
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
- [x] Step 3: Create `src/email/send.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import "../test/setup.js";
      import { sendEmail } from "./send.js";

      const KEY = `re_${"e".repeat(40)}`; // the test env value of RESEND_API_KEY
      const mail = { to: "bob@example.com", subject: "สรุปการประชุม", text: "ข้อความ", html: "<p>ข้อความ</p>" };

      function resend(status: number, body: unknown) {
        const calls: { url: string; init: RequestInit }[] = [];
        globalThis.fetch = (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return Response.json(body, { status });
        }) as typeof fetch;
        return calls;
      }

      test("one email goes to the Resend API from the configured sender, with a User-Agent", async () => {
        const calls = resend(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
        await sendEmail(mail);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, "https://api.resend.com/emails");
        const headers = new Headers(calls[0]!.init.headers);
        assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
        assert.equal(headers.get("user-agent"), "everymeet-bot/1.0");
        assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
          from: "บอทบันทึกการประชุม <minutes@example.com>",
          to: "bob@example.com",
          subject: "สรุปการประชุม",
          text: "ข้อความ",
          html: "<p>ข้อความ</p>",
        });
      });

      test("a rate-limited send throws with the status so the log shows why", async () => {
        resend(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." });
        await assert.rejects(sendEmail(mail), /HTTP 429 rate_limit_exceeded/);
      });

      test("a refused send throws with Resend's error name and message and never the key", async () => {
        resend(403, { statusCode: 403, name: "validation_error", message: "The example.com domain is not verified." });
        await assert.rejects(
          sendEmail(mail),
          (err: Error) => /HTTP 403 validation_error: The example.com domain is not verified/.test(err.message) && !err.message.includes(KEY),
        );
      });
      ```
- [x] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 56`, `# fail 0` (53 + 3).
- [x] Step 5: Commit - `git add src/email/send.ts src/email/send.test.ts src/test/setup.ts && git commit -m "feat(email): send email through the Resend API"`

---

### Task 3: The bot waits up to 15 minutes for people (lobby and empty call)

> **Done:** committed as dd61697 (`feat(meet): wait up to 15 min for people`); the container part still needs the Task 15 redeploy.

**Files:**
- Modify: `meet/bot/rules.ts` (anchors: `export interface RuleConfig`, `export interface RuleState`, `s.aloneSince = o.participants === 1`)
- Modify: `meet/bot/rules.test.ts` (anchor: `const config = {`)
- Modify: `meet/bot/runner.ts` (anchor: `const rules = { aloneTimeoutMs: job.aloneTimeoutMs`, ~L44)
- Modify: `src/meet/protocol.ts` (anchors: `admitTimeoutMs: number;`, `| "stopped" // /end in Discord`, `/** True once /end was used in Discord`)
- Modify: `src/config.ts` (anchor: `export const SEGMENT_SAMPLES`, end of file)
- Modify: `src/meet/session.ts` (anchor: `export const ADMIT_TIMEOUT_MS = 5 * 60_000;` ~L14, and its 3 uses)
- Modify: `src/meet/session.test.ts` (anchors: `admitTimeoutMs: 5 * MIN`, `within 5 minutes`, `const giveUp = (5 + 240 + 60) * MIN`)

These seven files are one change: the job's `admitTimeoutMs` gains a second meaning ("how long to wait for people"), and the VPS value that drives it moves to 15 minutes.

**Interfaces:**
- Produces: `MEET_ADMIT_TIMEOUT_MS = 15 * 60_000` exported from `src/config.ts` (replaces `ADMIT_TIMEOUT_MS` in `src/meet/session.ts`; no other file imports the old name).
- Produces: `RuleConfig.waitForOthersMs: number`; `RuleState.othersSeen?: boolean` (container only).
- Contract kept: `RecordingJob` shape is unchanged; the Worker accepts `admitTimeoutMs <= 15 min` (`meet/worker/http.ts:62`).

**Gotcha:** the container change only takes effect after the image redeploy in Task 15; until then a deployed recorder still ends "alone" 3 minutes after it gets in when nobody else is there.

**Steps:**
- [x] Step 1: In `meet/bot/rules.ts`:
      ```ts
      export interface RuleConfig {
        aloneTimeoutMs: number;
        /** Until someone else has been in the call, the bot waits this long for them instead of aloneTimeoutMs. */
        waitForOthersMs: number;
        maxDurationMs: number;
        /** The call UI may vanish briefly while Meet reconnects; only a longer gap ends the recording. */
        lostUiMs: number;
      }

      export interface RuleState {
        recordingSince: number;
        aloneSince?: number;
        outOfCallSince?: number;
        /** Someone besides the bot was in the call at least once. */
        othersSeen?: boolean;
      }
      ```
      and in `nextEnd` replace the two alone lines with:
      ```ts
        // Exactly one tile is the bot itself; 0 or unknown means the count is not trustworthy.
        if ((o.participants ?? 0) >= 2) s.othersSeen = true;
        s.aloneSince = o.participants === 1 ? (s.aloneSince ?? now) : undefined;
        // A bot sent at the scheduled start often arrives before everyone else; it waits longer for the first person.
        const aloneLimit = s.othersSeen ? c.aloneTimeoutMs : Math.max(c.aloneTimeoutMs, c.waitForOthersMs);
        if (s.aloneSince !== undefined && now - s.aloneSince >= aloneLimit) return "alone";
      ```
- [x] Step 2: In `meet/bot/runner.ts` set `const rules = { aloneTimeoutMs: job.aloneTimeoutMs, waitForOthersMs: job.admitTimeoutMs, maxDurationMs: job.maxDurationMs, lostUiMs: LOST_UI_MS };`.
- [x] Step 3: In `meet/bot/rules.test.ts` change the config to `const config = { aloneTimeoutMs: 3 * MIN, waitForOthersMs: 15 * MIN, maxDurationMs: 240 * MIN, lostUiMs: 30_000 };` and add:
      ```ts
      test("before anyone else has joined, the bot waits the longer time for the first person", () => {
        const s = fresh();
        assert.equal(nextEnd(s, inCall(1), 0, false, config), undefined);
        assert.equal(nextEnd(s, inCall(1), 3 * MIN, false, config), undefined, "the 3-minute rule waits for someone to have come");
        assert.equal(nextEnd(s, inCall(1), 15 * MIN - 1, false, config), undefined);
        assert.equal(nextEnd(s, inCall(1), 15 * MIN, false, config), "alone");
      });

      test("once someone came and left, the normal alone time applies", () => {
        const s = fresh();
        assert.equal(nextEnd(s, inCall(1), 0, false, config), undefined);
        assert.equal(nextEnd(s, inCall(2), 10 * MIN, false, config), undefined, "the first person arrives late");
        assert.equal(nextEnd(s, inCall(1), 40 * MIN, false, config), undefined, "they left");
        assert.equal(nextEnd(s, inCall(1), 43 * MIN, false, config), "alone");
      });
      ```
      The existing alone test still passes: someone rejoins at the 3-minute mark, so its later 3-minute window applies.
- [x] Step 4: In `src/meet/protocol.ts` update three comments (no type change):
      `admitTimeoutMs: number;` gets `/** How long the bot waits in the lobby to be let in, and then for anyone else to join the call. */` above it;
      `| "stopped" // /end in Discord` becomes `| "stopped" // someone pressed stop on the web page`;
      `/** True once /end was used in Discord; the container leaves the call. */` becomes `/** True once someone asked to stop; the container leaves the call. */`.
- [x] Step 5: Append to `src/config.ts`:
      ```ts
      /** How long a Google Meet bot waits to be let in, and then for the first person to join (the recorder Worker allows at most 15 min). */
      export const MEET_ADMIT_TIMEOUT_MS = 15 * 60_000;
      ```
      In `src/meet/session.ts` delete `ADMIT_TIMEOUT_MS` and its comment, import `MEET_ADMIT_TIMEOUT_MS` from `../config.js`, and use it in the `giveUpAt` sum, in `admitTimeoutMs:` of the job, and in the `not_admitted` message.
- [x] Step 6: In `src/meet/session.test.ts`: `admitTimeoutMs: 15 * MIN`; the not_admitted pattern becomes `/Nobody let the bot into Google Meet \*\*abc-defg-hij\*\* within 15 minutes/`; `const giveUp = (15 + 240 + 60) * MIN;`.
- [x] Step 7: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && cd meet && npm run typecheck && npm test 2>&1 | tail -8` - Expected: both typechecks exit 0; root `# pass 56`, `# fail 0`; meet `# pass 20`, `# fail 0` (18 + 2).
- [x] Step 8: Commit - `git add meet/bot/rules.ts meet/bot/rules.test.ts meet/bot/runner.ts src/meet/protocol.ts src/config.ts src/meet/session.ts src/meet/session.test.ts && git commit -m "feat(meet): wait up to 15 minutes for people before giving up"`

---

### Task 4: Thai email messages

> **Done:** committed as f166ecc (`feat(email): add thai minutes and notice emails`).
> Task 4b changes the login email wording, and Task 7b extends `calendarRefusedMail` with the per-person refusals.

**Files:**
- Create: `src/email/messages.ts`
- Create: `src/email/messages.test.ts`

**Interfaces:**
- Consumes: `config()`, `MEET_ADMIT_TIMEOUT_MS` (Task 3), `RecordingEnd`, `EndReason` from `src/meet/protocol.ts`, `bangkokDateTime`, `durationTh` from `src/util/time.ts`.
- Produces (all pure apart from reading `config()`):
  - `interface Mail { subject: string; text: string; html: string }`
  - `describeMeetEnd(reason: EndReason | undefined): string` (Thai)
  - `loginMail(link: string): Mail`
  - `minutesMail(o: { id: string; title: string; startedAt: number; seconds: number; startedBy: string; endReason?: string; shortSummary: string; pin: string; note?: string }): Mail`
  - `notRecordedMail(o: { title: string; code: string; end?: RecordingEnd }): Mail`
  - `consentMissingMail(o: { title: string; code: string }): Mail`
  - `processingFailedMail(o: { id: string; title: string; startedAt: number; error: string }): Mail`
  - `calendarRefusedMail(o: { title: string; code: string; reason: "busy" | "start_failed" | "already_recording" }): Mail`

**Steps:**
- [x] Step 1: Create `src/email/messages.ts`:
      ```ts
      import { config, MEET_ADMIT_TIMEOUT_MS } from "../config.js";
      import type { EndReason, RecordingEnd } from "../meet/protocol.js";
      import { bangkokDateTime, durationTh } from "../util/time.js";

      /** One email's content; the caller adds the recipient. */
      export interface Mail {
        subject: string;
        text: string;
        html: string;
      }

      type Part = string | { url: string; label: string };

      const esc = (s: string) =>
        s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
      const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, "");

      /** Plain text and a simple HTML version of the same paragraphs; links become a button in HTML. */
      function mail(subject: string, parts: Part[]): Mail {
        const text = parts.map((p) => (typeof p === "string" ? p : `${p.label}: ${p.url}`)).join("\n\n");
        const body = parts
          .map((p) =>
            typeof p === "string"
              ? // The summary model writes **bold**; keep it bold in HTML.
                `<p style="margin:0 0 16px;white-space:pre-wrap">${esc(p).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`
              : `<p style="margin:0 0 16px"><a href="${esc(p.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#4b54d8;color:#ffffff;text-decoration:none;font-weight:600">${esc(p.label)}</a></p>`,
          )
          .join("");
        const html =
          `<!doctype html><html lang="th"><head><meta charset="utf-8"></head>` +
          `<body style="margin:0;padding:24px;background:#f6f5f2;color:#1c1b19;font-family:'IBM Plex Sans Thai','Noto Sans Thai',system-ui,sans-serif;line-height:1.55">` +
          `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e1da;border-radius:14px;padding:28px">${body}</div></body></html>`;
        return { subject, text, html };
      }

      /** Why a Google Meet recording ended, in Thai (it appears only in Thai emails). */
      export function describeMeetEnd(reason: EndReason | undefined): string {
        switch (reason) {
          case "stopped":
            return "มีคนกดหยุดบันทึก";
          case "alone":
            return "ไม่มีผู้เข้าร่วมคนอื่นอยู่ในห้องแล้ว";
          case "removed":
            return "บอทถูกนำออกจากห้อง Google Meet";
          case "meeting_ended":
            return "การประชุม Google Meet จบแล้ว";
          case "max_duration":
            return `บันทึกครบเวลาสูงสุด ${config().MEET_MAX_DURATION_MIN} นาที`;
          case "not_admitted":
            return "ไม่มีใครรับบอทเข้าห้อง";
          case "denied":
            return "บอทไม่ได้รับอนุญาตให้เข้าห้อง";
          case "auth_expired":
            return "บัญชี Google ของบอทหมดอายุการเข้าสู่ระบบ";
          case "join_failed":
            return "หน้า Google Meet ไม่มีปุ่มเข้าร่วม";
          default:
            return "เครื่องบันทึก Google Meet หยุดทำงานโดยไม่คาดคิด";
        }
      }

      export function loginMail(link: string): Mail {
        return mail("ลิงก์เข้าสู่ระบบบันทึก Google Meet", [
          "กดปุ่มด้านล่างเพื่อเข้าสู่ระบบหน้าบันทึก Google Meet ลิงก์นี้ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว",
          { url: link, label: "เข้าสู่ระบบ" },
          "ถ้าคุณไม่ได้ขอลิงก์นี้ ไม่ต้องทำอะไร",
        ]);
      }

      /** The same content as the Discord minutes post: short summary, playback link, PIN. */
      export function minutesMail(o: {
        id: string;
        title: string;
        startedAt: number;
        seconds: number;
        startedBy: string;
        endReason?: string;
        shortSummary: string;
        pin: string;
        note?: string;
      }): Mail {
        return mail(`สรุปการประชุม - ${o.title}`, [
          `บันทึกการประชุม ${o.title} เสร็จแล้ว\nเริ่มประชุม: ${bangkokDateTime(o.startedAt)}\nระยะเวลา: ${durationTh(o.seconds)}`,
          o.shortSummary,
          `ฟังเสียง อ่านสรุปฉบับเต็ม และ transcript ได้ที่ปุ่มด้านล่าง ใช้ PIN: ${o.pin}`,
          { url: `${base()}/m/${o.id}`, label: "ฟังเสียงบันทึกการประชุม" },
          ...(o.note ? [`⚠️ ${o.note}`] : []),
          `เริ่มบันทึกโดย ${o.startedBy} | จบเพราะ: ${o.endReason ?? "-"}`,
        ]);
      }

      export function notRecordedMail(o: { title: string; code: string; end?: RecordingEnd }): Mail {
        const room = `ห้อง Google Meet ${o.code}`;
        let why: string;
        if (o.end?.detail?.startsWith("container start failed")) {
          why = `เปิดเครื่องบันทึกสำหรับ${room}ไม่ได้ บันทึก Google Meet ได้พร้อมกันสูงสุด 2 ห้อง กรุณาลองใหม่ภายหลัง`;
        } else {
          switch (o.end?.reason) {
            case "auth_expired":
              why =
                `บอทเข้า${room}ไม่ได้ เพราะบัญชี Google ของบอทหมดอายุการเข้าสู่ระบบ ` +
                "กรุณาแจ้งผู้ดูแลบอทให้รัน npm run meet:login ใน meet/ แล้วเปลี่ยนไฟล์ session บนเซิร์ฟเวอร์ (MEET_AUTH_STATE_FILE)";
              break;
            case "not_admitted":
              why = `ไม่มีใครรับบอทเข้า${room}ภายใน ${MEET_ADMIT_TIMEOUT_MS / 60_000} นาที จึงไม่ได้บันทึกอะไร`;
              break;
            case "denied":
              why = `${room}ไม่อนุญาตให้บอทเข้า (ผู้จัดปฏิเสธ หรือ Google Meet ไม่ให้เข้า) จึงไม่ได้บันทึกอะไร`;
              break;
            case "stopped":
              why = `การบันทึก${room}ถูกหยุดก่อนบอทเข้าห้อง จึงไม่ได้บันทึกอะไร`;
              break;
            default:
              why = `บันทึก${room}ไม่ได้ (${describeMeetEnd(o.end?.reason)})`;
          }
        }
        return mail(`บันทึก Google Meet ไม่สำเร็จ - ${o.title}`, [why, { url: `${base()}/meet`, label: "เริ่มบันทึกใหม่" }]);
      }

      export function consentMissingMail(o: { title: string; code: string }): Mail {
        return mail(`กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึก - ${o.title}`, [
          `บอทกำลังบันทึกห้อง Google Meet ${o.code} แต่โพสต์ข้อความแจ้งการบันทึกในแชท Google Meet ไม่สำเร็จ กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึกเสียงการประชุม`,
        ]);
      }

      export function processingFailedMail(o: { id: string; title: string; startedAt: number; error: string }): Mail {
        return mail(`ประมวลผลบันทึกการประชุมไม่สำเร็จ - ${o.title}`, [
          `ประมวลผลการประชุม ${o.title} (${bangkokDateTime(o.startedAt)}) ไม่สำเร็จ ไฟล์เสียงยังเก็บไว้ (meeting id ${o.id})\nสาเหตุ: ${o.error.slice(0, 1500)}`,
        ]);
      }

      export function calendarRefusedMail(o: { title: string; code: string; reason: "busy" | "start_failed" | "already_recording" }): Mail {
        const head = `บอทไม่ได้เข้าห้อง Google Meet ${o.code} ของนัด "${o.title}"`;
        if (o.reason === "already_recording") {
          return mail(`ยังไม่ได้บันทึก Google Meet - ${o.title}`, [
            `${head} เพราะห้องนี้กำลังถูกบันทึกอยู่แล้ว บอทจะลองใหม่ทุกนาทีในช่วงเวลาเริ่มของนัดนี้ ถ้าห้องนี้กำลังบันทึกให้การประชุมอื่น เสียงช่วงนี้จะอยู่ในบันทึกของการประชุมนั้น`,
          ]);
        }
        const why = o.reason === "busy" ? "ตอนนี้บันทึก Google Meet อยู่ 2 ห้องแล้ว ซึ่งเป็นจำนวนสูงสุด" : "เปิดเครื่องบันทึกไม่สำเร็จ";
        return mail(`ไม่ได้บันทึก Google Meet - ${o.title}`, [
          `${head} เพราะ${why} เริ่มบันทึกเองได้ที่หน้าเว็บ`,
          { url: `${base()}/meet`, label: "เริ่มบันทึกเอง" },
        ]);
      }
      ```
- [x] Step 2: Create `src/email/messages.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import "../test/setup.js";
      import { calendarRefusedMail, loginMail, minutesMail, notRecordedMail } from "./messages.js";

      test("the minutes email carries the short summary, the playback link, the PIN, and the note, in text and HTML", () => {
        const m = minutesMail({
          id: "AbCdEfGhIjKlMnOp",
          title: "Weekly <standup>",
          startedAt: Date.UTC(2026, 10, 23, 3, 0),
          seconds: 3720,
          startedBy: "alice@planthia.test",
          endReason: "การประชุม Google Meet จบแล้ว",
          shortSummary: "**ภาพรวม:** วางแผน sprint",
          pin: "042137",
          note: "ถอดเสียงไม่สำเร็จ 1 จาก 4 ช่วง",
        });
        assert.equal(m.subject, "สรุปการประชุม - Weekly <standup>");
        for (const part of ["**ภาพรวม:** วางแผน sprint", "PIN: 042137", "https://meet.example.com/m/AbCdEfGhIjKlMnOp", "1 ชม. 2 นาที", "⚠️ ถอดเสียงไม่สำเร็จ", "alice@planthia.test"]) {
          assert.ok(m.text.includes(part), part);
        }
        assert.match(m.html, /<strong>ภาพรวม:<\/strong> วางแผน sprint/);
        assert.match(m.html, /href="https:\/\/meet\.example\.com\/m\/AbCdEfGhIjKlMnOp"/);
        assert.ok(m.html.includes("Weekly &lt;standup&gt;"), "titles are escaped in HTML");
        assert.ok(!m.html.includes("<standup>"));
      });

      test("failure emails say why in Thai and point to the web page", () => {
        const expired = notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "auth_expired", leftCleanly: true } });
        assert.match(expired.text, /หมดอายุการเข้าสู่ระบบ.*npm run meet:login/);
        assert.match(notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "not_admitted", leftCleanly: true } }).text, /ภายใน 15 นาที/);
        const full = notRecordedMail({ title: "t", code: "abc-defg-hij", end: { reason: "crashed", detail: "container start failed: no instance", leftCleanly: false } });
        assert.match(full.text, /สูงสุด 2 ห้อง/);
        assert.match(notRecordedMail({ title: "t", code: "abc-defg-hij" }).text, /หยุดทำงานโดยไม่คาดคิด/);
        assert.ok(expired.text.includes("https://meet.example.com/meet"));
        assert.match(calendarRefusedMail({ title: "Weekly standup", code: "abc-defg-hij", reason: "busy" }).text, /2 ห้องแล้ว/);
      });

      test("the login email holds the link once and says how long it works", () => {
        const m = loginMail("https://meet.example.com/meet/auth?t=abc");
        assert.equal(m.text.split("https://meet.example.com/meet/auth?t=abc").length, 2);
        assert.match(m.text, /15 นาที/);
      });
      ```
- [x] Step 3: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 59`, `# fail 0` (56 + 3).
- [x] Step 4: Commit - `git add src/email/messages.ts src/email/messages.test.ts && git commit -m "feat(email): add Thai minutes, login, and failure emails"`

---

### Task 4b: Replace the email allowlist with user settings

The user replaced the static allowlist with registered users (Decision 4), so the allowlist parts of Task 1 go, and the settings for the user store and the per-person limits come in.
Nothing outside Task 1's own files reads the allowlist yet (`grep -rn "ALLOWED_EMAILS\|isAllowed\|parseAllowlist" src` at 29a9203 lists only `src/config.ts`, `src/util/email.ts`, `src/util/email.test.ts`, and `src/test/setup.ts`).

**Files:**
- Modify: `src/config.ts` (anchors: `import { invalidAllowlistEntries, parseAllowlist } from "./util/email.js";` L2, `ALLOWED_EMAILS: z.preprocess(` ~L62, the `EMAIL_FROM` doc comment ~L69, the `need(c.ALLOWED_EMAILS` line and the `for (const bad of invalidAllowlistEntries` loop in `superRefine`)
- Modify: `src/util/email.ts` (delete `DOMAIN_RE`, `Allowlist`, `parseAllowlist`, `invalidAllowlistEntries`, `isAllowed`)
- Modify: `src/util/email.test.ts` (delete the test "the allowlist matches exact addresses and whole domains, not subdomains" and the three allowlist names from the import)
- Modify: `.env.example` (anchor: `# Who may start Meet recordings on the web page` ~L45-47)
- Modify: `src/test/setup.ts` (anchor: `ALLOWED_EMAILS: "alice@example.com, @planthia.test",`)
- Modify: `src/email/messages.ts` (anchor: `กดปุ่มด้านล่างเพื่อเข้าสู่ระบบหน้าบันทึก Google Meet` in `loginMail`)

**Interfaces:**
- Removes: `Allowlist`, `parseAllowlist`, `invalidAllowlistEntries`, `isAllowed` from `src/util/email.ts`; `Config.ALLOWED_EMAILS`.
- Keeps: `normalizeEmail(text: string): string | undefined`; `parseEmailList(text: string): { emails: string[]; invalid: string[] }`.
- Produces: `Config` gains `SEED_ADMIN_EMAIL?: string` (lowercase; required when `MEET_RECORDER_URL` is set), `MEET_MAX_ACTIVE_PER_USER: number` (default 1), `MEET_MAX_DAILY_PER_USER: number` (default 5).
- Consumers: `SEED_ADMIN_EMAIL` by `src/index.ts` (Task 4c); the two limits by `src/meet/session.ts` (Task 7b), `src/email/messages.ts` (Task 7b), and `src/web/meet-routes.ts` (Task 11).

**Steps:**
- [ ] Step 1: In `src/util/email.ts` delete `DOMAIN_RE`, the `Allowlist` interface, `parseAllowlist`, `invalidAllowlistEntries`, and `isAllowed`; the file keeps its header comment, `ADDRESS_RE`, `normalizeEmail`, and `parseEmailList` unchanged.
- [ ] Step 2: In `src/util/email.test.ts` delete the third test (the allowlist one) and import only `normalizeEmail, parseEmailList`.
- [ ] Step 3: In `src/config.ts` delete the `./util/email.js` import, the `ALLOWED_EMAILS` key, the `need(c.ALLOWED_EMAILS...)` line, and the `invalidAllowlistEntries` loop; change the `EMAIL_FROM` comment to `/** Sender on a domain verified in Resend, e.g. minutes@mail.example.com. */`; and add after `MEET_MAX_DURATION_MIN`:
      ```ts
        /** Made an active admin of the Google Meet page at every boot; required when Meet recording is on. Set it only in .env, never in the code. */
        SEED_ADMIN_EMAIL: z.preprocess(blank, z.email().optional()).transform((v) => v?.toLowerCase()),
        /** How many Google Meet recordings one person may run at the same time (web and calendar together). */
        MEET_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).default(1),
        /** How many Google Meet recordings one person may start in 24 hours (web and calendar together). */
        MEET_MAX_DAILY_PER_USER: z.coerce.number().int().min(1).default(5),
      ```
      In `superRefine`, in place of the removed `ALLOWED_EMAILS` rule inside `if (c.MEET_RECORDER_URL)`, add `need(c.SEED_ADMIN_EMAIL, "SEED_ADMIN_EMAIL", "anyone can sign up for Google Meet recording, so it needs an admin who can disable accounts: set SEED_ADMIN_EMAIL");`; the recorder pair rule, the two email rules, and the calendar rules stay.
- [ ] Step 4: In `.env.example` replace the three `ALLOWED_EMAILS` lines (two comment lines and the key) with:
      ```bash
      # Required when Google Meet recording is on. Anyone can sign up on <PUBLIC_BASE_URL>/meet with their email; this address
      # becomes an active admin at every boot (admin page: <PUBLIC_BASE_URL>/meet/admin). Put your own address here, never in the code.
      SEED_ADMIN_EMAIL=
      # Per person, web and calendar together: recordings running at once, and recordings started in 24 hours
      MEET_MAX_ACTIVE_PER_USER=1
      MEET_MAX_DAILY_PER_USER=5
      ```
- [ ] Step 5: In `src/test/setup.ts` replace `ALLOWED_EMAILS: "alice@example.com, @planthia.test",` with:
      ```ts
        SEED_ADMIN_EMAIL: "admin@example.com",
        MEET_MAX_ACTIVE_PER_USER: "1",
        MEET_MAX_DAILY_PER_USER: "5",
      ```
- [ ] Step 6: In `src/email/messages.ts` `loginMail`, the first paragraph becomes `"กดปุ่มด้านล่างเพื่อเข้าสู่ระบบหน้าบันทึก Google Meet ถ้ายังไม่มีบัญชี การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้ ลิงก์นี้ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว"` (the same email goes to new and existing addresses, so it covers both).
- [ ] Step 7: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && grep -rn "ALLOWED_EMAILS\|isAllowed\|parseAllowlist\|Allowlist" src .env.example; grep -rnoE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" src .env.example | grep -vE "@([a-z0-9-]+\.)*(example\.com|google\.com|[a-z0-9-]+\.test)$"` - Expected: typecheck exit 0; `# pass 58`, `# fail 0` (59 - 1); both greps print nothing (the second lists every email address that is not on a placeholder domain: `example.com`, `google.com` fixture UIDs and rooms, `*.test`).
- [ ] Step 8: Commit - `git add src/config.ts src/util/email.ts src/util/email.test.ts .env.example src/test/setup.ts src/email/messages.ts && git commit -m "refactor(config): replace the email allowlist with user settings"`

---

### Task 4c: User store (`DATA_DIR/users.json`) and the seeded admin

**Files:**
- Create: `src/users/store.ts`
- Create: `src/users/store.test.ts`
- Modify: `src/index.ts` (anchor: `const c = config(); // fail fast on bad env`)

**Interfaces:**
- Consumes: `config().DATA_DIR`, `config().SEED_ADMIN_EMAIL` (Task 4b).
- Produces in `src/users/store.ts`: `type UserStatus = "active" | "disabled"`; `interface User { email: string; status: UserStatus; isAdmin: boolean; createdAt: number; lastLoginAt?: number; recentStarts: number[] }`; `class UserStore { constructor(path: string); get(email: string): User | undefined; active(email: string): User | undefined; list(): User[]; signIn(email: string, now: number): User; setStatus(email: string, status: UserStatus): User | undefined; seedAdmin(email: string, now: number): void; startsToday(email: string, now: number): number; recordStart(email: string, now: number): void }`; `users(): UserStore` (the shared store on `DATA_DIR/users.json`).
- Consumers: `src/meet/session.ts` (Task 7b), `src/web/meet-routes.ts` (Tasks 11 and 11b), `src/calendar/poller.ts` (Task 13), `src/web/templates.ts` (`User` type, Task 11b), `src/index.ts` (this task).

**Gotcha:** the store is the only code that touches `users.json`, and the bot process is its only writer; it keeps the users in memory and rewrites the file on every change, so an edit made to the file while the bot runs is lost at the next change.
All methods lowercase the email they are given, so callers may pass addresses as typed or as found in iCal (`normalizeEmail` output is already lowercase).

**Steps:**
- [ ] Step 1: Create `src/users/store.ts`:
      ```ts
      import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      import { dirname, join } from "node:path";
      import { config } from "../config.js";

      export type UserStatus = "active" | "disabled";

      /** Someone who signed up on the Google Meet page, or the seeded admin. */
      export interface User {
        /** Lowercase; unique. */
        email: string;
        status: UserStatus;
        isAdmin: boolean;
        createdAt: number;
        lastLoginAt?: number;
        /** When this person's Google Meet recordings started, last 24 hours only (MEET_MAX_DAILY_PER_USER). */
        recentStarts: number[];
      }

      const DAY_MS = 24 * 60 * 60_000;
      const key = (email: string) => email.trim().toLowerCase();

      /**
       * The users, in one JSON file. The bot process is the only writer: the users stay in memory and every change
       * rewrites the file atomically (temp file + rename), so a crash leaves the old or the new file, never a mix.
       */
      export class UserStore {
        private readonly users = new Map<string, User>();

        constructor(private readonly path: string) {
          if (!existsSync(path)) return;
          // Starting with no users over a damaged file would silently drop every account and the admin flag.
          const damaged = new Error(`${path} is not valid JSON: restore it from a backup before starting the bot`);
          let saved: { users?: unknown };
          try {
            saved = JSON.parse(readFileSync(path, "utf8")) as { users?: unknown };
          } catch {
            throw damaged;
          }
          if (!Array.isArray(saved?.users)) throw damaged;
          for (const u of saved.users as User[]) this.users.set(u.email, u);
        }

        get(email: string): User | undefined {
          return this.users.get(key(email));
        }

        /** The user, when they exist and are not disabled. */
        active(email: string): User | undefined {
          const u = this.get(email);
          return u?.status === "active" ? u : undefined;
        }

        /** Oldest account first. */
        list(): User[] {
          return [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt);
        }

        /** A login link was confirmed: the first one creates the account. A disabled user is returned unchanged. */
        signIn(email: string, now: number): User {
          const u = this.get(email) ?? { email: key(email), status: "active", isAdmin: false, createdAt: now, recentStarts: [] };
          if (u.status === "active") u.lastLoginAt = now;
          this.users.set(u.email, u);
          this.save();
          return u;
        }

        setStatus(email: string, status: UserStatus): User | undefined {
          const u = this.get(email);
          if (!u) return undefined;
          u.status = status;
          this.save();
          return u;
        }

        /** SEED_ADMIN_EMAIL at boot: creates that user as an active admin, or makes the existing one an active admin again. */
        seedAdmin(email: string, now: number): void {
          const u = this.get(email) ?? { email: key(email), status: "active", isAdmin: true, createdAt: now, recentStarts: [] };
          u.status = "active";
          u.isAdmin = true;
          this.users.set(u.email, u);
          this.save();
        }

        /** Recordings this person started in the 24 hours before `now`. */
        startsToday(email: string, now: number): number {
          return this.get(email)?.recentStarts.filter((t) => t > now - DAY_MS).length ?? 0;
        }

        /** Counts one start for the daily limit; callers only pass people who exist (web users, calendar organizers). */
        recordStart(email: string, now: number): void {
          const u = this.get(email);
          if (!u) return;
          u.recentStarts = [...u.recentStarts.filter((t) => t > now - DAY_MS), now];
          this.save();
        }

        private save(): void {
          mkdirSync(dirname(this.path), { recursive: true });
          const tmp = `${this.path}.tmp`;
          writeFileSync(tmp, JSON.stringify({ users: this.list() }, null, 2));
          renameSync(tmp, this.path); // atomic replace
        }
      }

      let shared: UserStore | undefined;

      /** The bot's users, in DATA_DIR/users.json (on the meeting-data volume in production). */
      export const users = (): UserStore => (shared ??= new UserStore(join(config().DATA_DIR, "users.json")));
      ```
- [ ] Step 2: In `src/index.ts` import `users` from `./users/store.js` and right after `const c = config(); // fail fast on bad env` add:
      ```ts
      // Also fails fast: a damaged users.json stops the bot here instead of losing every account.
      const people = users();
      if (c.SEED_ADMIN_EMAIL) people.seedAdmin(c.SEED_ADMIN_EMAIL, Date.now());
      ```
- [ ] Step 3: Create `src/users/store.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import "../test/setup.js";
      import { UserStore } from "./store.js";

      const DAY = 24 * 60 * 60_000;
      const tempFile = () => join(mkdtempSync(join(tmpdir(), "users-test-")), "users.json");

      test("the first sign-in creates an active, non-admin user under the lowercase address, and the file survives a restart", () => {
        const path = tempFile();
        const store = new UserStore(path);
        assert.equal(store.get("ann@example.com"), undefined);
        const ann = store.signIn("Ann@Example.com", 1_000);
        assert.deepEqual(ann, { email: "ann@example.com", status: "active", isAdmin: false, createdAt: 1_000, lastLoginAt: 1_000, recentStarts: [] });
        store.signIn("ANN@example.com", 5_000);
        const reloaded = new UserStore(path);
        assert.equal(reloaded.get("ann@example.com")?.createdAt, 1_000);
        assert.equal(reloaded.get("ann@example.com")?.lastLoginAt, 5_000);
        assert.equal(reloaded.list().length, 1, "one record per address, whatever its case");
        assert.equal(existsSync(`${path}.tmp`), false, "the temp file is renamed into place");
      });

      test("a disabled user is not active, cannot sign in, and can be enabled again", () => {
        const store = new UserStore(tempFile());
        store.signIn("ben@example.com", 1_000);
        assert.equal(store.setStatus("BEN@example.com", "disabled")?.status, "disabled");
        assert.equal(store.active("ben@example.com"), undefined);
        assert.equal(store.signIn("ben@example.com", 9_000).lastLoginAt, 1_000, "a disabled sign-in changes nothing");
        store.setStatus("ben@example.com", "active");
        assert.ok(store.active("ben@example.com"));
        assert.equal(store.setStatus("nobody@example.com", "disabled"), undefined);
      });

      test("the seeded admin is created, and seeding again makes an existing user an active admin", () => {
        const store = new UserStore(tempFile());
        store.seedAdmin("Root@Example.com", 1_000);
        assert.deepEqual(store.get("root@example.com"), { email: "root@example.com", status: "active", isAdmin: true, createdAt: 1_000, recentStarts: [] });
        store.signIn("cat@example.com", 2_000);
        store.setStatus("cat@example.com", "disabled");
        store.seedAdmin("cat@example.com", 3_000);
        assert.equal(store.get("cat@example.com")?.isAdmin, true);
        assert.equal(store.get("cat@example.com")?.status, "active");
        assert.equal(store.get("cat@example.com")?.createdAt, 2_000);
      });

      test("starts are counted over a rolling 24 hours and kept across restarts; a damaged file stops the store without quoting it", () => {
        const path = tempFile();
        const store = new UserStore(path);
        store.signIn("dee@example.com", 0);
        store.recordStart("dee@example.com", 1_000);
        store.recordStart("dee@example.com", 2_000);
        assert.equal(new UserStore(path).startsToday("dee@example.com", 3_000), 2);
        assert.equal(store.startsToday("dee@example.com", 1_000 + DAY), 1, "the first start is more than 24 hours old");
        assert.equal(store.startsToday("nobody@example.com", 0), 0);
        writeFileSync(path, '{"users":[{"email":"secret@example.com"');
        assert.throws(() => new UserStore(path), (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes("secret@"));
        assert.match(readFileSync(path, "utf8"), /secret@/, "the damaged file is left as it was");
        writeFileSync(path, "{}");
        assert.throws(() => new UserStore(path), /not valid JSON/, "valid JSON of the wrong shape is refused the same way");
      });
      ```
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 62`, `# fail 0` (58 + 4).
- [ ] Step 5: Commit - `git add src/users/store.ts src/users/store.test.ts src/index.ts && git commit -m "feat(users): store users in DATA_DIR and seed the admin"`

---

### Task 5: Remove the Discord `/record-meet` command

**Files:**
- Modify: `src/commands.ts` (anchor: `.setName("record-meet")`, the third builder)
- Modify: `src/interactions.ts` (anchors: `async function handleRecordMeet` ~L69-110, `else if (interaction.commandName === "record-meet")` ~L131, imports of `MeetSession`, `meetRecorderConfigured`, `parseMeetUrl`)
- Modify: `src/bot.test.ts` (anchors: `// ---- Google Meet ----` ~L457 to the end of the file; `fakeMeetRecorder` in the setup import ~L12; `const meetWorker = fakeMeetRecorder();` ~L16; `const { MeetSession } = await import("./meet/session.js");` ~L63; `"record" | "end" | "record-meet"` ~L124; the afterEach comment ~L211)

**Interfaces:**
- Produces: `commands` has 2 entries (`record`, `end`); `handleInteraction` ignores any other command name.
- `MeetSession` keeps its current Discord-shaped `start` for now (no caller until Task 11 wires the web page; its own tests keep it covered).

**Rollback:** after deploy, `npm run register` (or `docker compose exec meeting-bot node dist/register-commands.js`) removes the command from Discord; registering an older build brings it back.

**Steps:**
- [ ] Step 1: In `src/commands.ts` delete the `record-meet` `SlashCommandBuilder` (from `new SlashCommandBuilder()` with `.setName("record-meet")` through its `.setContexts(InteractionContextType.Guild),`).
- [ ] Step 2: In `src/interactions.ts` delete `handleRecordMeet`, its dispatch line, and the three imports it alone used (`MeetSession`, `meetRecorderConfigured`, `parseMeetUrl`).
- [ ] Step 3: In `src/bot.test.ts` delete everything from `// ---- Google Meet ----` to the end of the file (three tests), the `fakeMeetRecorder` import and `const meetWorker = fakeMeetRecorder();`, the `MeetSession` import, narrow the command name type to `"record" | "end"`, and drop the comment `// Meet sessions wait for their recorder` (keep the `shutdown()` loop line).
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && grep -rn "record-meet" src` - Expected: typecheck exit 0; `# pass 59`, `# fail 0` (62 - 3); grep prints nothing.
- [ ] Step 5: Commit - `git add src/commands.ts src/interactions.ts src/bot.test.ts && git commit -m "feat(discord): remove the /record-meet command"`

---

### Task 6: Separate registries for Discord and Meet, with the Meet limits

**Files:**
- Delete: `src/recorder/active.ts`
- Modify: `src/recorder/session.ts` (anchors: `import { activeSessions, type ActiveRecording } from "./active.js";` ~L27, `const TICK_MS = 15_000;` ~L34, `export class MeetingSession implements ActiveRecording {` ~L38)
- Modify: `src/interactions.ts` (anchors: `import { activeSessions } from "./recorder/active.js";`, `if (!(session instanceof MeetingSession))` in the button branch and in `handleVoiceStateUpdate`)
- Modify: `src/index.ts` (anchors: `import { activeSessions } from "./recorder/active.js";`, `async function shutdown`)
- Modify: `src/meet/session.ts` (anchors: `import { activeSessions, type ActiveRecording } from "../recorder/active.js";`, `export class MeetSession implements ActiveRecording {`, `activeSessions.set(o.guildId, s);` in `start` and `resume`, `activeSessions.delete(` in `start` and `doFinish`)
- Modify: `src/bot.test.ts` (anchor: `const { activeSessions } = await import("./recorder/active.js");` ~L60)
- Modify: `src/meet/session.test.ts` (anchors: `const { activeSessions } = await import("../recorder/active.js");`, `function harness()`, every `activeSessions.get(h.guildId)`)

Every importer of `src/recorder/active.ts` is in this list (`grep -rln 'active.js' src` at 478fc65).

**Interfaces:**
- Produces: `activeSessions: Map<string, MeetingSession>` (by guild id) exported from `src/recorder/session.ts`.
- Produces from `src/meet/session.ts`: `MAX_MEET_RECORDINGS = 2`; `activeMeets: Map<string, MeetSession>` (by Meet code); `class MeetRefused extends Error { readonly reason: "already_recording" | "busy" }`.
- `MeetSession.start` throws `MeetRefused` before any request reaches the Worker; the check and the registration happen in the same synchronous block.

**Steps:**
- [ ] Step 1: `git rm src/recorder/active.ts`.
- [ ] Step 2: In `src/recorder/session.ts` drop the `./active.js` import, change the class line to `export class MeetingSession {`, and after `const TICK_MS = 15_000;` add:
      ```ts
      /** One active recording per guild (a bot can only be in one voice channel per guild). */
      export const activeSessions = new Map<string, MeetingSession>();
      ```
- [ ] Step 3: In `src/interactions.ts` import `activeSessions` together with `CONTINUE_BUTTON_PREFIX, MeetingSession` from `./recorder/session.js`; in the button branch use `if (!session) {` and in `handleVoiceStateUpdate` use `if (!session) return;` (every entry is a `MeetingSession` now).
- [ ] Step 4: In `src/meet/session.ts` drop the `../recorder/active.js` import and `implements ActiveRecording`, and add above the class:
      ```ts
      /** The meet-recorder Worker runs at most this many containers (max_instances in meet/wrangler.jsonc). */
      export const MAX_MEET_RECORDINGS = 2;

      /** Google Meet recordings in progress, by Meet code: one per call, at most MAX_MEET_RECORDINGS at once. */
      export const activeMeets = new Map<string, MeetSession>();

      /** A start that the limits refuse; nothing was sent to the recorder. */
      export class MeetRefused extends Error {
        constructor(readonly reason: "already_recording" | "busy") {
          super(
            reason === "busy"
              ? `at most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once`
              : "this Google Meet call is already being recorded",
          );
        }
      }
      ```
      At the top of `start` (before `const c = config();`):
      ```ts
          if (activeMeets.has(o.meet.code)) throw new MeetRefused("already_recording");
          if (activeMeets.size >= MAX_MEET_RECORDINGS) throw new MeetRefused("busy");
      ```
      and replace `activeSessions.set(o.guildId, s)` with `activeMeets.set(o.meet.code, s)`, the `activeSessions.delete(o.guildId)` in the start error path with `activeMeets.delete(o.meet.code)`, `activeSessions.set(manifest.guildId, s)` in `resume` with `activeMeets.set(manifest.meet!.code, s)`, and `activeSessions.delete(this.manifest.guildId)` in `doFinish` with `activeMeets.delete(this.code)`.
      Keep `async shutdown()` (it stops the poll timer; `index.ts` and the tests call it).
- [ ] Step 5: In `src/index.ts` import `activeSessions` from `./recorder/session.js` and `activeMeets` from `./meet/session.js`; in `shutdown` keep the comment and write:
      ```ts
        await Promise.allSettled([...activeSessions.values()].map((s) => s.shutdown()));
        for (const s of activeMeets.values()) await s.shutdown();
      ```
- [ ] Step 6: In `src/bot.test.ts` import `activeSessions` from `./recorder/session.js`.
- [ ] Step 7: In `src/meet/session.test.ts` import `{ MeetSession, MeetRefused, activeMeets }` from `./session.js` (drop the `recorder/active.js` import); change `harness()` to `harness(meet = MEET)` and pass `meet` to `MeetSession.start`; replace every `activeSessions.get(h.guildId)` with `activeMeets.get(MEET.code)`; in `afterEach` iterate and clear `activeMeets`; and add:
      ```ts
      test("one recording per Meet call and at most two at once; refused starts reach no recorder, and a finished call frees its slot", async () => {
        const first = await harness().start();
        const other = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
        const third = { url: "https://meet.google.com/xyz-abcd-efg", code: "xyz-abcd-efg" };
        const before = worker.requests.length;
        await assert.rejects(harness().start(), (err) => err instanceof MeetRefused && err.reason === "already_recording");
        assert.equal(worker.requests.length, before, "nothing sent for a refused start");
        await harness(other).start();
        await assert.rejects(harness(third).start(), (err) => err instanceof MeetRefused && err.reason === "busy");
        assert.equal(activeMeets.size, 2);
        remote(first.id).status = { state: "ended", segments: [], end: { reason: "denied", leftCleanly: true } };
        await advance(15_000);
        assert.ok(await harness(third).start(), "the slot is free again");
      });
      ```
- [ ] Step 8: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && grep -rn "active.js" src` - Expected: typecheck exit 0; `# pass 60`, `# fail 0` (59 + 1); grep prints nothing.
- [ ] Step 9: Commit - `git add -u src/recorder/active.ts src/recorder/session.ts src/interactions.ts src/index.ts src/meet/session.ts src/bot.test.ts src/meet/session.test.ts && git commit -m "refactor(meet): give Meet its own registry with per-call and total limits"`

---

### Task 7: Meet recordings leave Discord: Meet manifest, email notices, and minutes by email

The `Manifest` type becomes a union, and every module that reads a Discord-only field must narrow in the same commit, so this task touches many files; each edit is small except the `MeetSession` rewrite.

**Files:**
- Modify: `src/storage/manifest.ts` (anchor: `export interface Manifest {` ~L24-55)
- Modify: `src/meet/session.ts` (whole class; anchors `static async start(o: {`, `static resume(client: Client`, `private async recordingStarted`, `private async doFinish`, `private async say`, `function describeEnd`, `function notRecordedMessage`)
- Modify: `src/meet/session.test.ts` (replaced in full, see Step 4)
- Modify: `src/pipeline/run.ts` (anchors: `// 4. PIN + post to Discord.` ~L70, `await notifyFailure(client, m, m.error);` ~L106, `MeetSession.resume(client, m,` ~L117)
- Modify: `src/pipeline/run.test.ts` (anchor: `test("a Google Meet recording stored only in R2` ~L276 to the end; the setup import and `mockR2();` ~L11-13)
- Modify: `src/pipeline/publish.ts` (anchors: `import type { Manifest }`, the `m: Manifest` parameters of `findOutputChannel`, `publishMinutes`, `notifyFailure`)
- Modify: `src/pipeline/transcribe.ts` (anchor: `` `เซิร์ฟเวอร์: ${m.guildName}`, `` in `formatTranscript` ~L84-85)
- Modify: `src/pipeline/summarize.ts` (anchors: `if (m.meet) {` in `meetingContext` ~L17-20; `เขียนสรุปสั้นสำหรับโพสต์ใน Discord` ~L67)
- Modify: `src/pipeline.test.ts` (anchor: `test("a Google Meet transcript names no speakers in its lines"` ~L240, its `m` fixture)
- Modify: `src/recorder/session.ts` (anchors: `type Manifest } from "../storage/manifest.js";` ~L22, `readonly manifest: Manifest;` ~L39)
- Modify: `src/web/server.ts` (anchors: `title: m.voiceChannelName` (3 places), `guild: m.guildName`)
- Modify: `src/web/templates.ts` (anchor: `ใส่ PIN 6 หลักที่บอทส่งไว้ในข้อความ Discord` ~L46)

Consumers of `Manifest` checked at 478fc65 (`grep -rln "Manifest" src`): `storage/manifest.ts`, `recorder/session.ts`, `recorder/segment-uploader.ts` (common fields only, no change), `meet/session.ts`, `meet/speech.ts` (common fields only), `pipeline/run.ts`, `pipeline/publish.ts`, `pipeline/transcribe.ts`, `pipeline/summarize.ts`, `pipeline/assemble.ts` and `pipeline/plan.ts` (common fields only), `web/server.ts`, `recorder/active.ts` (deleted in Task 6).
Hand-built manifests in tests are typed `any` (`pipeline.test.ts`, `run.test.ts` `as any`, `web/server.test.ts` raw JSON), so they compile either way; this task updates the Meet ones so their runtime shape is real.

**Interfaces:**
- Produces in `src/storage/manifest.ts`:
  ```ts
  export interface DiscordManifest extends ManifestBase { meet?: undefined; guildId: string; guildName: string; voiceChannelId: string; voiceChannelName: string; commandChannelId: string; startedBy: { id: string; name: string } }
  export interface MeetInfo { url: string; code: string; title: string; trigger: "calendar" | "web"; startedBy: string; recipients: string[] }
  export interface MeetManifest extends ManifestBase { meet: MeetInfo }
  export type Manifest = DiscordManifest | MeetManifest;
  export const meetingTitle: (m: Manifest) => string;
  ```
- Produces in `src/meet/session.ts`: `type StartMeet = (meet: MeetInfo) => Promise<MeetSession>` (what the web page and the calendar poller are given); `MeetSession.start(meet: MeetInfo, onFinished: (m: MeetManifest) => void): Promise<MeetSession>`; `MeetSession.resume(manifest: MeetManifest, onFinished: (m: MeetManifest) => void): MeetSession`; `session.state: RecordingState`; `session.stopping: boolean`; `session.end(reason: string): Promise<void>` (throws when the recorder cannot be reached); `session.manifest: MeetManifest`.
- Consumes: `sendEmail` (Task 2), `consentMissingMail`, `notRecordedMail`, `describeMeetEnd`, `minutesMail`, `processingFailedMail` (Task 4), `activeMeets`, `MeetRefused`, `MAX_MEET_RECORDINGS` (Task 6), `MEET_ADMIT_TIMEOUT_MS` (Task 3).

**Gotcha:** narrowing works because `DiscordManifest.meet` is declared `meet?: undefined`; write `if (m.meet)` / `m.meet ? ... : ...` and TypeScript narrows both branches.
Do not add `meet?: MeetInfo` to the base type, which would break the narrowing.

**Steps:**
- [ ] Step 1: In `src/storage/manifest.ts` replace `export interface Manifest {...}` with:
      ```ts
      /** What every recording has, whatever started it. */
      interface ManifestBase {
        id: string;
        startedAt: number;
        endedAt?: number;
        endReason?: string;
        /** Last time the recorder was alive; used as the end time after a crash. */
        heartbeatAt: number;
        status: MeetingStatus;
        recovered?: boolean;
        participants: Record<string, Participant>;
        pin?: { salt: string; hash: string };
        outputs?: {
          mixed?: string;
          tracks?: Record<string, string>;
          transcript?: string;
          summaryFull?: string;
          summaryShort?: string;
          postedMessageUrl?: string;
        };
        error?: string;
      }

      /** A Discord voice channel recording; its minutes are posted in Discord. */
      export interface DiscordManifest extends ManifestBase {
        meet?: undefined;
        guildId: string;
        guildName: string;
        voiceChannelId: string;
        voiceChannelName: string;
        /** Text channel where /record was used (fallback output + continue prompts). */
        commandChannelId: string;
        startedBy: { id: string; name: string };
      }

      /** Which Google Meet call is recorded, for whom, and who gets the minutes. */
      export interface MeetInfo {
        url: string;
        code: string;
        /** The calendar event title, or "Google Meet <code>" for a start on the web page. */
        title: string;
        trigger: "calendar" | "web";
        /** Email of the calendar organizer or of the person who pressed start; failure emails go here. */
        startedBy: string;
        /** Who gets the minutes by email: lowercase, unique, includes startedBy, never the bot account. */
        recipients: string[];
      }

      /** A Google Meet recording (one mixed track); its minutes are emailed. */
      export interface MeetManifest extends ManifestBase {
        meet: MeetInfo;
      }

      export type Manifest = DiscordManifest | MeetManifest;

      /** Shown on the playback page and in the transcript header. */
      export const meetingTitle = (m: Manifest): string => (m.meet ? m.meet.title : m.voiceChannelName);
      ```
- [ ] Step 2: Rewrite `src/meet/session.ts` to this (the parts not shown - the `GIVE_UP_GRACE_MS` comment, `poll` apart from one line, `save`, `readAuthState` - stay as they are):
      ```ts
      import { readFileSync, rmSync } from "node:fs";
      import { config, MEET_ADMIT_TIMEOUT_MS, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
      import { consentMissingMail, describeMeetEnd, notRecordedMail, type Mail } from "../email/messages.js";
      import { sendEmail } from "../email/send.js";
      import { meetingDir, saveEverywhere, saveLocal, type MeetInfo, type MeetManifest } from "../storage/manifest.js";
      import { logger } from "../util/log.js";
      import { newSessionId } from "../util/pin.js";
      import { MEET_PARTICIPANT_ID, type RecordingState, type RecordingStatus } from "./protocol.js";
      import { recorder } from "./recorder-client.js";

      // log, TICK_MS, GIVE_UP_GRACE_MS, MEET_SPEAKER_NAME, MAX_MEET_RECORDINGS, activeMeets, MeetRefused: unchanged

      type OnFinished = (manifest: MeetManifest) => void;

      /** How the web page and the calendar poller start a recording (src/index.ts binds the processing callback). */
      export type StartMeet = (meet: MeetInfo) => Promise<MeetSession>;

      /**
       * A Google Meet recording. The meet-recorder Worker's container (meet/) does the recording; this side owns
       * the manifest, polls the recorder, emails the starter about problems, and hands the result to processing.
       */
      export class MeetSession {
        private tick?: NodeJS.Timeout;
        private polling = false;
        private readonly giveUpAt: number;
        private stopReason?: string;
        private finishing?: Promise<void>;
        /** What the recorder reported last; the web page shows it. */
        state: RecordingState = "starting";

        private constructor(
          readonly manifest: MeetManifest,
          private readonly onFinished: OnFinished,
        ) {
          this.giveUpAt = manifest.startedAt + MEET_ADMIT_TIMEOUT_MS + config().MEET_MAX_DURATION_MIN * 60_000 + GIVE_UP_GRACE_MS;
        }

        /** Sends the bot into `meet`. The starter always gets the minutes too. Throws MeetRefused when a limit is reached. */
        static async start(meet: MeetInfo, onFinished: OnFinished): Promise<MeetSession> {
          if (activeMeets.has(meet.code)) throw new MeetRefused("already_recording");
          if (activeMeets.size >= MAX_MEET_RECORDINGS) throw new MeetRefused("busy");
          const c = config();
          const now = Date.now();
          const manifest: MeetManifest = {
            id: newSessionId(),
            meet: { ...meet, recipients: [...new Set([meet.startedBy, ...meet.recipients])] },
            startedAt: now,
            heartbeatAt: now,
            status: "recording",
            participants: {},
          };
          const s = new MeetSession(manifest, onFinished);
          activeMeets.set(meet.code, s);
          try {
            // Saved before the recorder starts, so recoverUnfinished() re-attaches if this process dies right after.
            saveLocal(manifest);
            await recorder.start(manifest.id, {
              meetUrl: meet.url,
              authState: c.MEET_AUTH_STATE_FILE ? readAuthState(c.MEET_AUTH_STATE_FILE) : undefined,
              sampleRate: SAMPLE_RATE,
              segmentSamples: SEGMENT_SAMPLES,
              admitTimeoutMs: MEET_ADMIT_TIMEOUT_MS,
              aloneTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
              maxDurationMs: c.MEET_MAX_DURATION_MIN * 60_000,
            });
          } catch (err) {
            // The request may have reached the Worker even though it failed here (a timeout): make sure no bot joins.
            recorder.stop(manifest.id).catch(() => {});
            activeMeets.delete(meet.code);
            rmSync(meetingDir(manifest.id), { recursive: true, force: true });
            throw err;
          }
          await s.save();
          s.tick = setInterval(() => void s.poll(), TICK_MS);
          log.info(`recording Google Meet ${meet.code} as ${manifest.id} (${meet.trigger}, started by ${meet.startedBy})`);
          return s;
        }

        /** Re-attach to a recording that kept running on Cloudflare while this process restarted. */
        static resume(manifest: MeetManifest, onFinished: OnFinished): MeetSession {
          const s = new MeetSession(manifest, onFinished);
          activeMeets.set(manifest.meet.code, s);
          s.tick = setInterval(() => void s.poll(), TICK_MS);
          void s.poll();
          log.info(`re-attached to Google Meet recording ${manifest.id}`);
          return s;
        }

        get id(): string {
          return this.manifest.id;
        }

        private get code(): string {
          return this.manifest.meet.code;
        }

        /** True once someone asked the recorder to stop. */
        get stopping(): boolean {
          return this.stopReason !== undefined;
        }

        /**
         * Asks the recorder to leave the call; processing starts when it reports the end.
         * Throws when the recorder cannot be reached (it still stops by itself when the call empties or hits the limit).
         */
        async end(reason: string): Promise<void> {
          if (this.finishing) return;
          await recorder.stop(this.id);
          this.stopReason ??= reason;
        }

        /** The recording goes on in the cloud; boot re-attaches to it. */
        async shutdown(): Promise<void> {
          clearInterval(this.tick);
        }
      ```
      In `poll`, right after the `try { status = await recorder.status(this.id); } catch {...}` block, add `if (status) this.state = status.state;`.
      `recordingStarted` keeps its participant and `save()` lines and replaces the Discord announcement with:
      ```ts
          // The Meet chat notice is the only consent notice; if it failed, the starter has to tell people.
          if (!status.consentPosted) await this.email(consentMissingMail({ title: this.manifest.meet.title, code: this.code }));
      ```
      In `doFinish`: `activeMeets.delete(this.code);` (from Task 6), `m.endReason = this.stopReason ?? describeMeetEnd(end?.reason);`, and in the nothing-recorded branch replace `await this.say(notRecordedMessage(this.code, end));` with `await this.email(notRecordedMail({ title: m.meet.title, code: this.code, end }));`.
      Replace `say` with:
      ```ts
        /** Emails the person who started the recording; a failed email is logged, never fatal. */
        private async email(mail: Mail): Promise<void> {
          const to = this.manifest.meet.startedBy;
          try {
            await sendEmail({ to, ...mail });
          } catch (err) {
            log.error(`could not email ${to} about Google Meet recording ${this.id}`, err);
          }
        }
      ```
      Delete `describeEnd` and `notRecordedMessage` (now `describeMeetEnd` and `notRecordedMail` in `src/email/messages.ts`) and the `Client` import.
- [ ] Step 3: Narrow the readers:
      - `src/recorder/session.ts`: import `type DiscordManifest` with `Manifest`; `readonly manifest: DiscordManifest;` (the object literal in the constructor already matches it).
      - `src/pipeline/publish.ts`: import `type DiscordManifest` instead of `Manifest`; the `m` parameter of `findOutputChannel`, `publishMinutes`, and `notifyFailure` becomes `m: DiscordManifest`.
      - `src/pipeline/transcribe.ts` `formatTranscript`: replace the two lines `เซิร์ฟเวอร์: ...` and `ห้องเสียง: ...` with `...(m.meet ? [`การประชุม: ${m.meet.title} (Google Meet ${m.meet.code})`] : [`เซิร์ฟเวอร์: ${m.guildName}`, `ห้องเสียง: ${m.voiceChannelName}`]),`.
      - `src/pipeline/summarize.ts` `meetingContext`: the Meet branch returns
        ```ts
            return `ข้อมูลการประชุม: Google Meet "${m.meet.title}" (${m.meet.code}) เริ่ม ${bangkokDateTime(m.startedAt)}
        เสียงทั้งหมดถูกบันทึกเป็นแทร็กเดียว transcript จึงไม่ได้ระบุว่าใครพูด ห้ามเดาชื่อผู้พูด ให้ระบุชื่อเฉพาะเมื่อมีการเอ่ยชื่อในบทสนทนา`;
        ```
        and in `shortSummary` the line `จากสรุปฉบับเต็มด้านล่าง เขียนสรุปสั้นสำหรับโพสต์ใน Discord ความยาว...` becomes `จากสรุปฉบับเต็มด้านล่าง เขียนสรุปสั้น${m.meet ? "สำหรับส่งทางอีเมล" : "สำหรับโพสต์ใน Discord"} ความยาว...` (rest unchanged).
      - `src/web/server.ts`: import `meetingTitle`; the three `title: m.voiceChannelName` become `title: meetingTitle(m)` and `guild: m.guildName` becomes `guild: m.meet ? "Google Meet" : m.guildName`.
      - `src/web/templates.ts` `pin`: `ใส่ PIN 6 หลักที่บอทส่งไว้ในข้อความ Discord` becomes `ใส่ PIN 6 หลักที่บอทส่งมาพร้อมลิงก์นี้`.
- [ ] Step 4: In `src/pipeline/run.ts`:
      ```ts
      import { sendEmail } from "../email/send.js";
      import { minutesMail, processingFailedMail } from "../email/messages.js";
      import { meetingDir, saveEverywhere, saveLocal, unfinishedLocal, type Manifest, type MeetManifest } from "../storage/manifest.js";
      import { buildRawTracks, encodeTracks, mixTracks, totalSamples } from "./assemble.js";
      ```
      Replace step 4's `m.outputs.postedMessageUrl = await publishMinutes(...)` call with:
      ```ts
          const note = notes.join(" / ") || undefined;
          if (m.meet) {
            // Nobody spoke (the meeting did not happen): only the organizer or starter is told.
            await emailMinutes(m, t.lines.length > 0 ? m.meet.recipients : [m.meet.startedBy], { pin, shortSummary: short, note });
          } else {
            m.outputs.postedMessageUrl = await publishMinutes(client, m, {
              pin,
              shortSummary: short,
              fullSummary: full,
              transcript: t.text,
              note,
            });
          }
      ```
      (and rename the comment to `// 4. PIN, then the minutes: by email for Google Meet, in Discord otherwise. Only the hash is stored.`).
      In the `catch`, replace `await notifyFailure(client, m, m.error);` with:
      ```ts
          if (m.meet) {
            await sendEmail({ to: m.meet.startedBy, ...processingFailedMail({ id: m.id, title: m.meet.title, startedAt: m.startedAt, error: m.error }) })
              .catch((e) => log.error(`could not email the failure of ${m.id}`, e));
          } else {
            await notifyFailure(client, m, m.error);
          }
      ```
      In `recoverUnfinished` the resume call becomes `MeetSession.resume(m, (done) => void processMeeting(client, done));`.
      Add below `run`:
      ```ts
      /**
       * Emails the minutes to each recipient on their own; fails only when nobody got them.
       * No idempotency key: processing that is retried after a crash makes a new PIN, so a second email is the correct one.
       */
      async function emailMinutes(m: MeetManifest, recipients: string[], o: { pin: string; shortSummary: string; note?: string }): Promise<void> {
        const mail = minutesMail({
          id: m.id,
          title: m.meet.title,
          startedAt: m.startedAt,
          seconds: totalSamples(m) / SAMPLE_RATE,
          startedBy: m.meet.startedBy,
          endReason: m.endReason,
          ...o,
        });
        let sent = 0;
        for (const to of recipients) {
          try {
            await sendEmail({ to, ...mail });
            sent++;
          } catch (err) {
            log.error(`minutes email for ${m.id} not sent`, err);
          }
        }
        if (sent === 0) throw new Error("the minutes email could not be sent to anyone");
        log.info(`${m.id}: minutes emailed to ${sent} of ${recipients.length}`);
      }
      ```
- [ ] Step 5: Replace `src/meet/session.test.ts` with the file in `#### Task 7 reference: src/meet/session.test.ts` below.
- [ ] Step 6: In `src/pipeline/run.test.ts`:
      - import `mockEmail`, `sentEmails` from the setup; add `let failEmailTo = (_to: string) => false;` and `mockEmail({ fail: (to) => failEmailTo(to) });` right after `mockR2();` (before the dynamic imports).
      - In the Meet test replace the manifest fixture's Discord fields (`guildId` through `commandChannelId`, `meet`, `startedBy`) with
        ```ts
            meet: {
              url: "https://meet.google.com/abc-defg-hij",
              code: "abc-defg-hij",
              title: "Weekly standup",
              trigger: "calendar" as const,
              startedBy: "alice@planthia.test",
              recipients: ["alice@planthia.test", "bob@example.com"],
            },
        ```
        and `endReason: "การประชุม Google Meet จบแล้ว"`; set `sentEmails.length = 0;` at the top of the test.
      - Replace its last three lines (the `readPost` block) with:
        ```ts
          assert.equal(posts.length, 0, "a Meet recording posts nothing in Discord");
          assert.deepEqual(sentEmails.map((e) => e.to), ["alice@planthia.test", "bob@example.com"]);
          const mail = sentEmails[0]!;
          assert.equal(mail.subject, "สรุปการประชุม - Weekly standup");
          assert.ok(mail.text.includes(SHORT));
          assert.ok(mail.text.includes(`https://meet.example.com/m/${id}`));
          const pin = mail.text.match(/PIN: (\d{6})/)?.[1];
          assert.ok(pin && verifyPin(pin, saved.pin.salt, saved.pin.hash), "the emailed PIN opens the page");
          assert.match(fullPrompt, /Google Meet "Weekly standup"/);
        ```
      - Add after it (reusing the same audio setup through a small helper `meetRecording(o: { silent?: boolean } = {})` that you extract from the Meet test: it writes the FLAC segment to the in-memory R2, leaves the two tones out when `silent` is set, and returns the manifest):
        ```ts
        test("a Meet minutes email that one recipient cannot get still reaches the others", async () => {
          const m = meetRecording();
          sentEmails.length = 0;
          failEmailTo = (to) => to === "bob@example.com";
          try {
            mockOpenRouter((call) =>
              call.path === "/audio/transcriptions"
                ? Response.json({ text: "", segments: [{ start: 0.3, end: 3, text: "สวัสดีครับ" }] })
                : chatReply(call.body.max_tokens <= 2_000 ? SHORT : FULL),
            );
            await processMeeting(discord([]).client, m as any);
          } finally {
            failEmailTo = () => false;
          }
          assert.deepEqual(sentEmails.map((e) => e.to), ["alice@planthia.test"]);
          assert.equal(manifestIn(m.id).status, "done");
        });

        test("a Meet recording where nobody spoke emails only the organizer", async () => {
          const m = meetRecording({ silent: true });
          sentEmails.length = 0;
          const calls = mockOpenRouter(() => chatReply("unused"));
          await processMeeting(discord([]).client, m as any);
          assert.equal(calls.length, 0, "nothing to transcribe or summarize");
          assert.deepEqual(sentEmails.map((e) => e.to), ["alice@planthia.test"]);
          assert.match(sentEmails[0]!.text, /ไม่พบเสียงพูด/);
          assert.equal(manifestIn(m.id).status, "done");
        });
        ```
- [ ] Step 7: In `src/pipeline.test.ts` the Meet fixture of "a Google Meet transcript names no speakers in its lines" becomes `meet: { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij", title: "Weekly standup", trigger: "web", startedBy: "alice@example.com", recipients: ["alice@example.com"] }` without `guildName` and `voiceChannelName`, and the test also asserts `assert.match(t, /การประชุม: Weekly standup \(Google Meet abc-defg-hij\)/);`.
- [ ] Step 8: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && grep -n "guildId\|voiceChannel\|commandChannelId\|Client" src/meet/session.ts` - Expected: typecheck exit 0; `# pass 63`, `# fail 0` (60 + 1 in `session.test.ts` + 2 in `run.test.ts`); grep prints nothing.
- [ ] Step 9: Commit - `git add src/storage/manifest.ts src/meet/session.ts src/meet/session.test.ts src/pipeline/run.ts src/pipeline/run.test.ts src/pipeline/publish.ts src/pipeline/transcribe.ts src/pipeline/summarize.ts src/pipeline.test.ts src/recorder/session.ts src/web/server.ts src/web/templates.ts && git commit -m "feat(meet): email Meet minutes and notices instead of using Discord"`

#### Task 7 reference: src/meet/session.test.ts

```ts
/**
 * The bot side of a Google Meet recording, driven through a scripted meet-recorder Worker
 * with the clock under test control. R2 is in memory; emails go to the fake sender.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, FAKE_MEET_AUTH, fakeMeetRecorder, flush, mockEmail, mockR2, r2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
const worker = fakeMeetRecorder();
const { MeetSession, MeetRefused, activeMeets } = await import("./session.js");
const { keys } = await import("../storage/keys.js");
const { SAMPLE_RATE, SEGMENT_SAMPLES } = await import("../config.js");

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 12, 3, 0, 0);
const MEET = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
const ALICE = "alice@example.com";

function harness(meet = MEET, startedBy = ALICE) {
  const finished: any[] = [];
  const onFinished = (m: any) => void finished.push(structuredClone(m));
  const info = { ...meet, title: "Weekly standup", trigger: "web" as const, startedBy, recipients: ["bob@example.com", startedBy] };
  const start = () => MeetSession.start(info, onFinished);
  return { finished, onFinished, start };
}
const remote = (id: string) => worker.recordings.get(id)!;
const stored = (id: string) => JSON.parse(r2.get(keys.manifest(id))!.toString());
const mailsTo = (to: string) => sentEmails.filter((e) => e.to === to);
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await flush(20); // a poll goes through fetch, Response.json() and the R2 mock
};

beforeEach(() => {
  worker.down = false;
  worker.failStart = false;
  sentEmails.length = 0;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
});
afterEach(async () => {
  for (const s of activeMeets.values()) await s.shutdown();
  activeMeets.clear();
  mock.timers.reset();
});

test("starting sends the link, the session file and the timings to the recorder, and stores a Meet manifest without Discord fields or the session", async () => {
  const s = await harness().start();
  assert.deepEqual(remote(s.id).job, {
    meetUrl: MEET.url,
    authState: FAKE_MEET_AUTH,
    sampleRate: SAMPLE_RATE,
    segmentSamples: SEGMENT_SAMPLES,
    admitTimeoutMs: 15 * MIN,
    aloneTimeoutMs: 3 * MIN,
    maxDurationMs: 240 * MIN,
  });
  assert.equal(worker.authorizations.at(-1), `Bearer ${"m".repeat(40)}`);
  assert.equal(activeMeets.get(MEET.code), s);
  assert.equal(s.state, "starting");
  const raw = r2.get(keys.manifest(s.id))!.toString();
  assert.deepEqual(JSON.parse(raw).meet, {
    ...MEET,
    title: "Weekly standup",
    trigger: "web",
    startedBy: ALICE,
    recipients: [ALICE, "bob@example.com"],
  });
  assert.equal(JSON.parse(raw).guildId, undefined);
  assert.ok(!raw.includes("fake-session-cookie"), "the bot account session never reaches R2");
});

test("the recorder's state is followed quietly, and when everyone left the meeting goes to processing", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "waiting", segments: [] };
  await advance(15_000);
  assert.equal(s.state, "waiting");
  rec.status = { state: "recording", captureStartedAt: NOW + 40_000, consentPosted: true, segments: [] };
  await advance(15_000);
  assert.equal(s.state, "recording");
  assert.equal(sentEmails.length, 0, "no email while things go well");

  rec.status = {
    ...rec.status,
    state: "ended",
    segments: [{ index: 0, samples: SEGMENT_SAMPLES }, { index: 1, samples: 10 * SAMPLE_RATE }],
    end: { reason: "alone", leftCleanly: true },
  };
  await advance(15_000);
  assert.equal(activeMeets.get(MEET.code), undefined);
  assert.equal(stored(s.id).status, "processing");
  const m = h.finished.at(-1);
  assert.equal(m.status, "processing");
  assert.equal(m.startedAt, NOW + 40_000);
  assert.equal(m.endedAt, NOW + 40_000 + 310_000, "5 min + 10 s of audio");
  assert.equal(m.endReason, "ไม่มีผู้เข้าร่วมคนอื่นอยู่ในห้องแล้ว");
  assert.deepEqual(m.participants.meet, {
    displayName: "เสียงรวมจาก Google Meet",
    utterances: [],
    segments: [0, 1],
    uploaded: [0, 1],
  });
});

test("if the notice could not be posted in the Meet chat, the starter gets one email asking them to tell the participants", async () => {
  const s = await harness().start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: false, segments: [] };
  await advance(15_000);
  await advance(15_000);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]!.to, ALICE);
  assert.match(sentEmails[0]!.subject, /กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึก/);
});

test("stop asks the recorder to leave and keeps its reason once the recorder reports the end", async () => {
  const h = harness();
  const s = await h.start();
  const rec = remote(s.id);
  rec.status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.end("หยุดโดย dave@example.com จากหน้าเว็บ");
  assert.equal(rec.stopped, true);
  assert.equal(s.stopping, true);
  assert.equal(activeMeets.get(MEET.code), s, "still active until the recorder confirms");
  rec.status = { ...rec.status, state: "ended", segments: [{ index: 0, samples: 60 * SAMPLE_RATE }], end: { reason: "stopped", leftCleanly: true } };
  await advance(15_000);
  assert.equal(h.finished.at(-1).endReason, "หยุดโดย dave@example.com จากหน้าเว็บ");
  assert.equal(h.finished.at(-1).endedAt, NOW + 60_000);
});

test("a stop that cannot reach the recorder throws, and the recording goes on", async () => {
  const s = await harness().start();
  worker.down = true;
  await assert.rejects(s.end("หยุดโดย dave@example.com จากหน้าเว็บ"));
  assert.equal(s.stopping, false);
  assert.equal(activeMeets.get(MEET.code), s);
});

test("a call the bot never got into is marked failed, is not processed, and the starter gets a reason-specific email", async () => {
  for (const [reason, expected] of [
    ["denied", /ไม่อนุญาตให้บอทเข้า/],
    ["not_admitted", /ภายใน 15 นาที/],
    ["auth_expired", /หมดอายุการเข้าสู่ระบบ.*npm run meet:login/],
    ["stopped", /ถูกหยุดก่อนบอทเข้าห้อง/],
    ["join_failed", /หน้า Google Meet ไม่มีปุ่มเข้าร่วม/],
  ] as const) {
    const h = harness();
    const s = await h.start();
    remote(s.id).status = { state: "ended", segments: [], end: { reason, leftCleanly: true } };
    await advance(15_000);
    const mail = mailsTo(ALICE).at(-1)!;
    assert.match(mail.text, expected, reason);
    assert.match(mail.subject, /บันทึก Google Meet ไม่สำเร็จ - Weekly standup/, reason);
    assert.equal(mailsTo("bob@example.com").length, 0, "failures go to the starter only");
    assert.equal(h.finished.length, 0, reason);
    assert.equal(stored(s.id).status, "failed", reason);
    assert.equal(activeMeets.get(MEET.code), undefined, reason);
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
  assert.equal(m.endReason, "เครื่องบันทึก Google Meet หยุดทำงานโดยไม่คาดคิด");
});

test("a network outage does not end the meeting: the bot keeps following the recorder and processes it when it is back", async () => {
  const h = harness();
  const s = await h.start();
  worker.down = true;
  await advance(30 * MIN);
  assert.equal(activeMeets.get(MEET.code), s, "still following");
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

test("the bot gives up only after the recorder's own deadline has passed, and emails the starter", async () => {
  await harness().start();
  worker.down = true;
  const giveUp = (15 + 240 + 60) * MIN; // admit timeout + MEET_MAX_DURATION_MIN + GIVE_UP_GRACE_MS
  await advance(giveUp - 15_000);
  assert.ok(activeMeets.get(MEET.code), "still following");
  await advance(15_000);
  assert.equal(activeMeets.get(MEET.code), undefined);
  assert.match(mailsTo(ALICE).at(-1)!.text, /หยุดทำงานโดยไม่คาดคิด/);
});

test("after a bot restart a Meet recording is re-attached by its Meet code and nobody is emailed again", async () => {
  const h = harness();
  const s = await h.start();
  remote(s.id).status = { state: "recording", captureStartedAt: NOW, consentPosted: true, segments: [] };
  await advance(15_000);
  await s.shutdown();
  activeMeets.clear();

  MeetSession.resume(structuredClone(s.manifest), h.onFinished);
  await flush();
  assert.ok(activeMeets.get(MEET.code), "re-registered");
  remote(s.id).status = { ...remote(s.id).status, state: "ended", segments: [{ index: 0, samples: SEGMENT_SAMPLES }], end: { reason: "meeting_ended", leftCleanly: true } };
  await advance(15_000);
  assert.equal(sentEmails.length, 0);
  assert.equal(h.finished.at(-1).id, s.id);
  assert.equal(h.finished.at(-1).recovered, undefined);
});

test("if the recorder cannot start, a stop is still sent, the error reaches the caller, and nothing blocks the next try", async () => {
  const h = harness();
  worker.failStart = true;
  await assert.rejects(h.start(), /HTTP 500/);
  await flush(20);
  assert.match(worker.requests.at(-1)!, /^POST \/recordings\/[\w-]+\/stop$/, "a start that timed out on our side must not leave a bot joining");
  assert.equal(activeMeets.get(MEET.code), undefined);
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

test("one recording per Meet call and at most two at once; refused starts reach no recorder, and a finished call frees its slot", async () => {
  const first = await harness().start();
  const other = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
  const third = { url: "https://meet.google.com/xyz-abcd-efg", code: "xyz-abcd-efg" };
  const before = worker.requests.length;
  await assert.rejects(harness().start(), (err) => err instanceof MeetRefused && err.reason === "already_recording");
  assert.equal(worker.requests.length, before, "nothing sent for a refused start");
  // Different starters, so the per-person limit of Task 7b is not what refuses here.
  await harness(other, "carol@example.com").start();
  await assert.rejects(harness(third, "dave@example.com").start(), (err) => err instanceof MeetRefused && err.reason === "busy");
  assert.equal(activeMeets.size, 2);
  remote(first.id).status = { state: "ended", segments: [], end: { reason: "denied", leftCleanly: true } };
  await advance(15_000);
  assert.ok(await harness(third, "dave@example.com").start(), "the slot is free again");
});
```

---

### Task 7b: Per-person recording limits

Open signup lets anyone start recordings (Decision 21), so one person may run at most `MEET_MAX_ACTIVE_PER_USER` recordings at once and start at most `MEET_MAX_DAILY_PER_USER` in 24 hours, on the web page and by calendar together.
The rules join the existing ones in the synchronous block at the top of `MeetSession.start`, so two starts at the same moment cannot both pass.

**Files:**
- Modify: `src/meet/session.ts` (anchors: `export class MeetRefused extends Error {` from Task 6, and the first lines of `static async start(meet: MeetInfo, onFinished: OnFinished)` from Task 7, through `const now = Date.now();`)
- Modify: `src/meet/session.test.ts` (imports at the top; add one test at the end)
- Modify: `src/email/messages.ts` (anchor: `export function calendarRefusedMail(`)
- Modify: `src/email/messages.test.ts` (anchor: `calendarRefusedMail({ title: "Weekly standup", code: "abc-defg-hij", reason: "busy" })`)

**Interfaces:**
- Consumes: `users().startsToday`, `users().recordStart` (Task 4c); `config().MEET_MAX_ACTIVE_PER_USER`, `config().MEET_MAX_DAILY_PER_USER` (Task 4b).
- Produces in `src/meet/session.ts`: `type RefusalReason = "already_recording" | "user_busy" | "daily_limit" | "busy"`; `class MeetRefused extends Error { readonly reason: RefusalReason }` (widened from Task 6).
- Produces in `src/email/messages.ts`: `calendarRefusedMail(o: { title: string; code: string; reason: RefusalReason | "start_failed" }): Mail` (widened).
- Consumers of `MeetRefused.reason`: `src/web/meet-routes.ts` (Task 11 maps every reason to a Thai message), `src/calendar/poller.ts` (Task 13 retries `already_recording` and `user_busy` while the occurrence is due and tells the organizer once; `busy` and `daily_limit` are told once and not retried).

**Gotcha:** `src/email/messages.ts` imports `RefusalReason` with `import type`, which is erased at runtime, so the cycle `meet/session.ts` -> `email/messages.ts` -> `meet/session.ts` does not exist in the emitted JavaScript.
`MeetSession.resume` does not count a start: re-attaching after a restart is not a new recording.
Caller contract: `startedBy` must be an active user (the web routes check the cookie's account, the poller checks the organizer); for an address without an account `startsToday` is 0 and `recordStart` does nothing, so the daily limit would not apply (the session tests rely on this for ALICE, who has no account).

**Steps:**
- [ ] Step 1: In `src/meet/session.ts` import `users` from `../users/store.js` and replace `MeetRefused` with:
      ```ts
      /** Why a start was refused before anything reached the recorder. */
      export type RefusalReason = "already_recording" | "user_busy" | "daily_limit" | "busy";

      const REFUSALS: Record<RefusalReason, string> = {
        already_recording: "this Google Meet call is already being recorded",
        user_busy: "this person already runs as many Google Meet recordings as allowed at once",
        daily_limit: "this person already started as many Google Meet recordings as allowed in 24 hours",
        busy: `at most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once`,
      };

      /** A start that the limits refuse; nothing was sent to the recorder. */
      export class MeetRefused extends Error {
        constructor(readonly reason: RefusalReason) {
          super(REFUSALS[reason]);
        }
      }
      ```
- [ ] Step 2: In `MeetSession.start` replace everything from `if (activeMeets.has(meet.code))` through `const now = Date.now();` with:
      ```ts
          const c = config();
          const now = Date.now();
          // Checked and registered in one synchronous block, so two starts at the same moment cannot both pass.
          if (activeMeets.has(meet.code)) throw new MeetRefused("already_recording");
          const running = [...activeMeets.values()].filter((s) => s.manifest.meet.startedBy === meet.startedBy).length;
          if (running >= c.MEET_MAX_ACTIVE_PER_USER) throw new MeetRefused("user_busy");
          if (users().startsToday(meet.startedBy, now) >= c.MEET_MAX_DAILY_PER_USER) throw new MeetRefused("daily_limit");
          if (activeMeets.size >= MAX_MEET_RECORDINGS) throw new MeetRefused("busy");
          // Counted before the recorder is asked: a start that then fails may still have started a container.
          users().recordStart(meet.startedBy, now);
      ```
      The rest of `start` (the manifest, `activeMeets.set`, the recorder request) stays as Task 7 wrote it.
- [ ] Step 3: In `src/email/messages.ts` add `import type { RefusalReason } from "../meet/session.js";` and replace `calendarRefusedMail` with:
      ```ts
      export function calendarRefusedMail(o: { title: string; code: string; reason: RefusalReason | "start_failed" }): Mail {
        const head = `บอทไม่ได้เข้าห้อง Google Meet ${o.code} ของนัด "${o.title}"`;
        if (o.reason === "already_recording") {
          return mail(`ยังไม่ได้บันทึก Google Meet - ${o.title}`, [
            `${head} เพราะห้องนี้กำลังถูกบันทึกอยู่แล้ว บอทจะลองใหม่ทุกนาทีในช่วงเวลาเริ่มของนัดนี้ ถ้าห้องนี้กำลังบันทึกให้การประชุมอื่น เสียงช่วงนี้จะอยู่ในบันทึกของการประชุมนั้น`,
          ]);
        }
        const c = config();
        const why = {
          busy: "ตอนนี้บันทึก Google Meet อยู่ 2 ห้องแล้ว ซึ่งเป็นจำนวนสูงสุด",
          start_failed: "เปิดเครื่องบันทึกไม่สำเร็จ",
          user_busy: `คุณกำลังบันทึก Google Meet อยู่ ${c.MEET_MAX_ACTIVE_PER_USER} ห้อง ซึ่งเป็นจำนวนสูงสุดต่อคน บอทจะลองใหม่ทุกนาทีในช่วงเวลาเริ่มของนัดนี้ เมื่อการบันทึกก่อนหน้าจบ`,
          daily_limit: `คุณเริ่มบันทึกครบ ${c.MEET_MAX_DAILY_PER_USER} ครั้งใน 24 ชั่วโมงแล้ว ซึ่งเป็นจำนวนสูงสุดต่อคน`,
        }[o.reason];
        // Starting by hand on the web page helps only when the limit was the recorder's, not the person's (user_busy is retried by the poller).
        if (o.reason === "user_busy" || o.reason === "daily_limit") {
          return mail(`ไม่ได้บันทึก Google Meet - ${o.title}`, [`${head} เพราะ${why}`]);
        }
        return mail(`ไม่ได้บันทึก Google Meet - ${o.title}`, [
          `${head} เพราะ${why} เริ่มบันทึกเองได้ที่หน้าเว็บ`,
          { url: `${base()}/meet`, label: "เริ่มบันทึกเอง" },
        ]);
      }
      ```
- [ ] Step 4: In `src/email/messages.test.ts`, in "failure emails say why in Thai and point to the web page", after the `busy` assertion add:
      ```ts
        const daily = calendarRefusedMail({ title: "Weekly standup", code: "abc-defg-hij", reason: "daily_limit" });
        assert.match(daily.text, /ครบ 5 ครั้งใน 24 ชั่วโมง/);
        assert.ok(!daily.text.includes("/meet"), "no web-page button when the person's own limit refused it");
        assert.match(calendarRefusedMail({ title: "t", code: "abc-defg-hij", reason: "user_busy" }).text, /อยู่ 1 ห้อง ซึ่งเป็นจำนวนสูงสุดต่อคน/);
      ```
- [ ] Step 5: In `src/meet/session.test.ts` add `const { users } = await import("../users/store.js");` after the `./session.js` import, and append:
      ```ts
      test("one person runs one recording at a time and starts at most 5 in 24 hours; refused starts reach no recorder", async () => {
        const pat = "pat@example.com";
        users().signIn(pat, NOW);
        const other = { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" };
        const first = await harness(MEET, pat).start();
        const before = worker.requests.length;
        await assert.rejects(harness(other, pat).start(), (err) => err instanceof MeetRefused && err.reason === "user_busy");
        assert.equal(worker.requests.length, before, "nothing sent for a refused start");
        const end = async (id: string) => {
          remote(id).status = { state: "ended", segments: [], end: { reason: "denied", leftCleanly: true } };
          await advance(15_000);
        };
        await end(first.id);
        for (let i = 2; i <= 5; i++) await end((await harness(MEET, pat).start()).id);
        assert.equal(users().startsToday(pat, Date.now()), 5);
        await assert.rejects(harness(MEET, pat).start(), (err) => err instanceof MeetRefused && err.reason === "daily_limit");
        await advance(24 * 60 * MIN);
        assert.ok(await harness(MEET, pat).start(), "allowed again a day after the first start");
      });
      ```
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 64`, `# fail 0` (63 + 1).
- [ ] Step 7: Commit - `git add src/meet/session.ts src/meet/session.test.ts src/email/messages.ts src/email/messages.test.ts && git commit -m "feat(meet): limit Google Meet recordings per person"`

---

### Task 8: Re-attach Meet recordings at boot, before anything can start a new one

**Files:**
- Modify: `src/pipeline/run.ts` (anchor: `export async function recoverUnfinished(client: Client): Promise<void> {` ~L113)
- Modify: `src/index.ts` (anchors: `await recoverUnfinished(client);` in the `ClientReady` handler, `startWebServer();` near the end)
- Modify: `src/pipeline/run.test.ts` (anchor: `await recoverUnfinished(client);` in "after a crash mid-meeting..." ~L253)

**Interfaces:**
- Produces: `recoverUnfinished(client: Client, source: "meet" | "discord"): Promise<void>` - `"meet"` re-attaches Meet recordings and retries Meet processing (no Discord login needed); `"discord"` closes Discord recordings at their heartbeat and retries Discord processing.

**Steps:**
- [ ] Step 1: In `src/pipeline/run.ts`:
      ```ts
      /**
       * After a crash or restart. Google Meet recordings ran on in the cloud and are re-attached; Discord recordings
       * are closed at their last heartbeat. Meetings that were mid-processing are retried. Meet needs no Discord login,
       * so boot runs "meet" first and "discord" once the client is ready.
       */
      export async function recoverUnfinished(client: Client, source: "meet" | "discord"): Promise<void> {
        for (const m of unfinishedLocal()) {
          if ((source === "meet") !== !!m.meet) continue;
          if (m.meet && m.status === "recording") {
            MeetSession.resume(m, (done) => void processMeeting(client, done));
            continue;
          }
          // ...the Discord "recording" branch and the final `void processMeeting(client, m);` stay as they are
        }
      }
      ```
- [ ] Step 2: In `src/index.ts` the `ClientReady` handler calls `await recoverUnfinished(client, "discord");`, and just before `startWebServer();` add:
      ```ts
      // Google Meet recordings run on Cloudflare and need no Discord login: re-attach them before anything can start a new one.
      await recoverUnfinished(client, "meet");
      ```
- [ ] Step 3: In `src/pipeline/run.test.ts` import `loadLocal` with `saveLocal, meetingDir`, and in "after a crash mid-meeting..." replace `await recoverUnfinished(client);` with:
      ```ts
        await recoverUnfinished(client, "meet");
        assert.equal(loadLocal(m.id)?.status, "recording", "Meet recovery leaves Discord meetings to the Discord login");
        await recoverUnfinished(client, "discord");
      ```
- [ ] Step 4: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 64`, `# fail 0` (unchanged after Task 7b).
- [ ] Step 5: Commit - `git add src/pipeline/run.ts src/index.ts src/pipeline/run.test.ts && git commit -m "feat(meet): re-attach Meet recordings at boot without waiting for Discord"`

---

### Task 9: Login building blocks: user cookie, single-use login links, rate limit

**Files:**
- Modify: `src/util/pin.ts` (append after `verifyAccess`, end of file)
- Create: `src/web/login-links.ts`
- Create: `src/web/rate-limit.ts`
- Create: `src/web/login.test.ts`

**Interfaces:**
- Produces: `signUser(email: string, secret: string, ttlMs: number): string`; `verifyUser(value: string | undefined, secret: string): string | undefined` (in `src/util/pin.ts`).
- Produces: `LOGIN_LINK_TTL_MS = 15 * 60_000`; `createLoginLink(email: string): string` (returns the token); `consumeLoginLink(token: string): string | undefined` (in `src/web/login-links.ts`).
- Produces: `class RateLimit { constructor(max: number, windowMs: number); take(key: string): boolean }` (in `src/web/rate-limit.ts`).

**Steps:**
- [ ] Step 1: Append to `src/util/pin.ts`:
      ```ts
      /**
       * Signed login cookie for the Google Meet page: "<email base64url>.<expiresAt>.<hmac>". The HMAC covers
       * "user:<email>", which can never equal a meeting id, so a playback cookie never works here and vice versa.
       */
      export function signUser(email: string, secret: string, ttlMs: number): string {
        return `${Buffer.from(email, "utf8").toString("base64url")}.${signAccess(`user:${email}`, secret, ttlMs)}`;
      }

      /** The email in a valid, unexpired login cookie. */
      export function verifyUser(value: string | undefined, secret: string): string | undefined {
        const dot = value?.indexOf(".") ?? -1;
        if (!value || dot <= 0) return undefined;
        const email = Buffer.from(value.slice(0, dot), "base64url").toString("utf8");
        return verifyAccess(`user:${email}`, value.slice(dot + 1), secret) ? email : undefined;
      }
      ```
- [ ] Step 2: Create `src/web/login-links.ts`:
      ```ts
      import { randomBytes } from "node:crypto";

      export const LOGIN_LINK_TTL_MS = 15 * 60_000;

      /** Unused login links by token. In memory: a restart only voids links nobody used yet. */
      const pending = new Map<string, { email: string; expiresAt: number }>();

      /** A new single-use token for `email`; the caller puts it in the emailed link and never logs it. */
      export function createLoginLink(email: string): string {
        const now = Date.now();
        for (const [token, link] of pending) if (link.expiresAt < now) pending.delete(token);
        const token = randomBytes(32).toString("base64url");
        pending.set(token, { email, expiresAt: now + LOGIN_LINK_TTL_MS });
        return token;
      }

      /** The email the link was made for, exactly once; an unknown, used, or expired token gives undefined. */
      export function consumeLoginLink(token: string): string | undefined {
        const link = pending.get(token);
        pending.delete(token);
        return link && link.expiresAt >= Date.now() ? link.email : undefined;
      }
      ```
- [ ] Step 3: Create `src/web/rate-limit.ts`:
      ```ts
      /** At most `max` attempts per key in a fixed window, in memory. */
      export class RateLimit {
        private readonly hits = new Map<string, { count: number; resetAt: number }>();

        constructor(
          private readonly max: number,
          private readonly windowMs: number,
        ) {}

        /** Counts one attempt; false when the key has used up its attempts in the current window. */
        take(key: string): boolean {
          const now = Date.now();
          for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
          const hit = this.hits.get(key) ?? { count: 0, resetAt: now + this.windowMs };
          hit.count++;
          this.hits.set(key, hit);
          return hit.count <= this.max;
        }
      }
      ```
- [ ] Step 4: Create `src/web/login.test.ts`:
      ```ts
      import { afterEach, test, mock } from "node:test";
      import assert from "node:assert/strict";
      import { signAccess, signUser, verifyAccess, verifyUser } from "../util/pin.js";
      import { consumeLoginLink, createLoginLink, LOGIN_LINK_TTL_MS } from "./login-links.js";
      import { RateLimit } from "./rate-limit.js";

      const SECRET = "s".repeat(40);
      afterEach(() => mock.timers.reset());

      test("a login cookie names its email, cannot be changed to another email, and expires", () => {
        mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
        const cookie = signUser("alice@example.com", SECRET, 60_000);
        assert.equal(verifyUser(cookie, SECRET), "alice@example.com");
        const forged = `${Buffer.from("mallory@example.com").toString("base64url")}${cookie.slice(cookie.indexOf("."))}`;
        assert.equal(verifyUser(forged, SECRET), undefined);
        assert.equal(verifyUser(cookie, "t".repeat(40)), undefined);
        assert.equal(verifyUser(undefined, SECRET), undefined);
        assert.equal(verifyUser("garbage", SECRET), undefined);
        mock.timers.tick(60_001);
        assert.equal(verifyUser(cookie, SECRET), undefined);
      });

      test("playback cookies and login cookies are not interchangeable", () => {
        const playback = signAccess("AbCdEfGhIjKlMnOp", SECRET, 60_000);
        assert.equal(verifyUser(`${Buffer.from("AbCdEfGhIjKlMnOp").toString("base64url")}.${playback}`, SECRET), undefined);
        const user = signUser("alice@example.com", SECRET, 60_000);
        assert.equal(verifyAccess("AbCdEfGhIjKlMnOp", user.slice(user.indexOf(".") + 1), SECRET), false);
      });

      test("a login link works once and only for 15 minutes", () => {
        mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
        const once = createLoginLink("alice@example.com");
        assert.match(once, /^[\w-]{43}$/);
        assert.equal(consumeLoginLink(once), "alice@example.com");
        assert.equal(consumeLoginLink(once), undefined, "single use");
        const late = createLoginLink("alice@example.com");
        mock.timers.tick(LOGIN_LINK_TTL_MS + 1);
        assert.equal(consumeLoginLink(late), undefined, "expired");
        assert.equal(consumeLoginLink("made-up"), undefined);
      });

      test("the rate limit allows max attempts per key per window", () => {
        mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
        const limit = new RateLimit(3, 15 * 60_000);
        assert.deepEqual([1, 2, 3, 4].map(() => limit.take("10.0.0.1")), [true, true, true, false]);
        assert.equal(limit.take("10.0.0.2"), true, "other keys are independent");
        mock.timers.tick(15 * 60_000);
        assert.equal(limit.take("10.0.0.1"), true, "a new window");
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 68`, `# fail 0` (64 + 4).
- [ ] Step 6: Commit - `git add src/util/pin.ts src/web/login-links.ts src/web/rate-limit.ts src/web/login.test.ts && git commit -m "feat(web): add login cookie, single-use login links, and a rate limit"`

---

### Task 10: Thai pages for login and the recorder page

**Files:**
- Modify: `src/web/templates.ts` (anchors: `input{width:100%;font:inherit;font-size:28px` ~L15, `input:focus{` ~L16, `<input id="pin"` in `pin`, end of the `page` object)
- Create: `src/web/templates.test.ts`
- Create: `src/web/client-ip.ts`
- Modify: `src/web/server.ts` (anchor: `function clientIp(c: Context): string {` ~L62-68; move it out)

**Interfaces:**
- Produces in `src/web/templates.ts`: `interface MeetRecordingView { id: string; title: string; code: string; state: RecordingState; trigger: "calendar" | "web"; startedBy: string; stopping: boolean }`; `page.meetLogin(o: { error?: string; email?: string }): string`; `page.meetLoginSent(): string` (one text for new, existing, and disabled addresses); `page.meetAccountDisabled(): string`; `page.meetConfirm(o: { token: string }): string`; `page.meetLinkInvalid(): string`; `page.meetRecorder(o: { email: string; recordings: MeetRecordingView[]; error?: string; values?: { url: string; emails: string } }): string`.
- Produces: `clientIp(c: Context): string` exported from `src/web/client-ip.ts` (body unchanged from `server.ts`).

**Steps:**
- [ ] Step 1: Create `src/web/client-ip.ts` with the `clientIp` function moved verbatim from `src/web/server.ts` (imports `type Context` from `hono`, `getConnInfo` from `@hono/node-server/conninfo`, `config` from `../config.js`), export it, and import it in `server.ts` (drop the now unused `getConnInfo` import there).
- [ ] Step 2: In `STYLE` of `src/web/templates.ts` replace the two `input` rules with:
      ```css
      input,textarea{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
      input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
      input.pin{font-size:28px;letter-spacing:.4em;text-align:center}
      textarea{resize:vertical}
      label.next{margin-top:16px}
      .hint{color:var(--muted);font-size:13px;margin:6px 0 0}
      .meta a,.refresh{color:var(--accent)}
      .refresh{display:inline-block;margin-top:12px;font-size:14px}
      li.rec{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 2px}
      li.rec small{display:block;color:var(--muted);font-size:13px}
      li.rec form{flex:none}
      button.stop{width:auto;margin:0;padding:8px 14px;background:transparent;color:var(--err);border:1px solid var(--err)}
      ```
      and give the PIN input `class="pin"` (`<input id="pin" class="pin" name="pin" ...>`), so the PIN page looks exactly as before.
- [ ] Step 3: Add `import type { RecordingState } from "../meet/protocol.js";` at the top of `src/web/templates.ts`, and above `export const page`:
      ```ts
      /** One Google Meet recording as the recorder page lists it. */
      export interface MeetRecordingView {
        id: string;
        title: string;
        code: string;
        state: RecordingState;
        trigger: "calendar" | "web";
        startedBy: string;
        stopping: boolean;
      }

      const STATE: Record<RecordingState, string> = {
        starting: "กำลังเปิดเครื่องบันทึก",
        joining: "กำลังเข้าห้อง",
        waiting: "รอผู้จัดรับเข้าห้อง",
        recording: "กำลังบันทึก",
        ended: "กำลังจบการบันทึก",
      };

      const meetCard = (title: string, body: string) =>
        shell(title, `<div class="card"><p class="eyebrow">บันทึก Google Meet</p>${body}</div>`);
      ```
      and add to `page`:
      ```ts
        meetLogin: (o: { error?: string; email?: string }) =>
          meetCard(
            "เข้าสู่ระบบ",
            `<h1>เข้าสู่ระบบ</h1>
      <p class="meta">ใส่อีเมลของคุณ แล้วบอทจะส่งลิงก์เข้าสู่ระบบไปให้ ลิงก์ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว ยังไม่มีบัญชีก็ใส่อีเมลได้เลย การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้</p>
      <form method="post" action="/meet/login">
      <label for="email">อีเมล</label>
      <input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(o.email ?? "")}">
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
      <button type="submit">ส่งลิงก์เข้าสู่ระบบ</button></form>`,
          ),

        meetLoginSent: () =>
          meetCard(
            "ตรวจอีเมลของคุณ",
            `<h1>ตรวจอีเมลของคุณ</h1><p class="meta">ถ้าอีเมลนี้ใช้งานได้ ลิงก์เข้าสู่ระบบจะไปถึงภายในไม่กี่นาที ลิงก์ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว</p>`,
          ),

        meetAccountDisabled: () =>
          meetCard(
            "บัญชีถูกปิดการใช้งาน",
            `<h1>บัญชีถูกปิดการใช้งาน</h1><p class="meta">บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ</p>`,
          ),

        meetConfirm: (o: { token: string }) =>
          meetCard(
            "ยืนยันการเข้าสู่ระบบ",
            `<h1>ยืนยันการเข้าสู่ระบบ</h1><p class="meta">กดปุ่มด้านล่างเพื่อเข้าสู่ระบบในเบราว์เซอร์นี้</p>
      <form method="post" action="/meet/auth"><input type="hidden" name="t" value="${esc(o.token)}">
      <button type="submit">เข้าสู่ระบบ</button></form>`,
          ),

        meetLinkInvalid: () =>
          meetCard(
            "ลิงก์ใช้ไม่ได้",
            `<h1>ลิงก์ใช้ไม่ได้</h1><p class="meta">ลิงก์หมดอายุหรือถูกใช้ไปแล้ว <a href="/meet">ขอลิงก์ใหม่</a></p>`,
          ),

        meetRecorder: (o: { email: string; recordings: MeetRecordingView[]; error?: string; values?: { url: string; emails: string } }) => {
          const items = o.recordings
            .map(
              (r) => `<li class="rec"><div>${esc(r.title)}<small>${esc(r.code)} · ${r.stopping ? "กำลังหยุด" : STATE[r.state]} · ${
                r.trigger === "calendar" ? "จากปฏิทิน" : "จากหน้าเว็บ"
              } · เริ่มโดย ${esc(r.startedBy)}</small></div>${
                r.stopping
                  ? ""
                  : `<form method="post" action="/meet/stop"><input type="hidden" name="id" value="${esc(r.id)}"><button class="stop" type="submit">หยุดบันทึก</button></form>`
              }</li>`,
            )
            .join("");
          return meetCard(
            "บันทึก Google Meet",
            `<h1>บันทึก Google Meet</h1>
      <p class="meta">เข้าสู่ระบบเป็น ${esc(o.email)} วางลิงก์ Google Meet แล้วกดเริ่มบันทึก บอทจะเข้าห้องและส่งบันทึกการประชุมทางอีเมลเมื่อการประชุมจบ</p>
      <form method="post" action="/meet/start" autocomplete="off">
      <label for="url">ลิงก์ Google Meet</label>
      <input id="url" name="url" type="text" inputmode="url" placeholder="https://meet.google.com/abc-defg-hij" required value="${esc(o.values?.url ?? "")}">
      <label for="emails" class="next">ส่งบันทึกให้อีเมลเพิ่มเติม (ไม่บังคับ)</label>
      <textarea id="emails" name="emails" rows="3" placeholder="name@example.com">${esc(o.values?.emails ?? "")}</textarea>
      <p class="hint">คั่นด้วยจุลภาคหรือขึ้นบรรทัดใหม่ บันทึกจะส่งถึงคุณเสมอ</p>
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
      <button type="submit">เริ่มบันทึก</button></form>
      <h2>การบันทึกของคุณ</h2>
      ${items ? `<ul>${items}</ul>` : `<p class="meta">ยังไม่มีการบันทึกที่กำลังทำงาน</p>`}
      <a class="refresh" href="/meet">รีเฟรชสถานะ</a>`,
          );
        },
      ```
- [ ] Step 4: Create `src/web/templates.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { page, type MeetRecordingView } from "./templates.js";

      const rec = (o: Partial<MeetRecordingView> = {}): MeetRecordingView => ({
        id: "AbCdEfGhIjKlMnOp",
        title: "Weekly <standup>",
        code: "abc-defg-hij",
        state: "waiting",
        trigger: "calendar",
        startedBy: "alice@planthia.test",
        stopping: false,
        ...o,
      });

      test("the recorder page lists recordings with a Thai state and a stop button, and escapes what people typed", () => {
        const html = page.meetRecorder({
          email: "alice@example.com",
          recordings: [rec(), rec({ id: "QrStUvWxYz012345", title: "Google Meet abc-defg-hij", trigger: "web", stopping: true })],
          error: "ลิงก์นี้ไม่ใช่ลิงก์ Google Meet",
          values: { url: '"><script>', emails: "bob@example.com" },
        });
        assert.match(html, /Weekly &lt;standup&gt;/);
        assert.match(html, /รอผู้จัดรับเข้าห้อง · จากปฏิทิน/);
        assert.match(html, /name="id" value="AbCdEfGhIjKlMnOp"/);
        assert.match(html, /กำลังหยุด · จากหน้าเว็บ/);
        assert.doesNotMatch(html, /value="QrStUvWxYz012345"/, "no second stop button once stopping");
        assert.match(html, /value="&quot;&gt;&lt;script&gt;"/);
        assert.match(html, /<textarea[^>]*>bob@example.com<\/textarea>/);
        assert.match(html, /class="err">ลิงก์นี้ไม่ใช่ลิงก์ Google Meet/);
        assert.match(page.meetRecorder({ email: "a@b.co", recordings: [] }), /ยังไม่มีการบันทึกที่กำลังทำงาน/);
      });

      test("the login pages post to /meet and the confirm page carries the token only in a form", () => {
        assert.match(page.meetLogin({}), /action="\/meet\/login"/);
        assert.match(page.meetLogin({}), /การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้/, "the same form signs people up");
        assert.doesNotMatch(page.meetLoginSent(), /สิทธิ์/, "the answer does not hint whether the address has an account");
        assert.match(page.meetAccountDisabled(), /ถูกปิดการใช้งาน/);
        const confirm = page.meetConfirm({ token: "tok<en>" });
        assert.match(confirm, /action="\/meet\/auth"/);
        assert.match(confirm, /type="hidden" name="t" value="tok&lt;en&gt;"/);
      });

      test("the PIN page keeps its big centered input and no longer mentions Discord", () => {
        const html = page.pin({ id: "AbCdEfGhIjKlMnOp", title: "daily-standup" });
        assert.match(html, /<input id="pin" class="pin"/);
        assert.doesNotMatch(html, /Discord/);
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 71`, `# fail 0` (68 + 3).
- [ ] Step 6: Commit - `git add src/web/templates.ts src/web/templates.test.ts src/web/client-ip.ts src/web/server.ts && git commit -m "feat(web): add Thai login and recorder pages"`

---

### Task 11: `/meet` routes: magic-link login with signup, start, status, stop

**Files:**
- Create: `src/web/meet-routes.ts`
- Create: `src/web/meet-routes.test.ts`
- Create: `src/web/meet-signup-cap.test.ts`
- Modify: `src/web/server.ts` (anchors: `export function createApp(): Hono {`, `app.notFound(`, `export function startWebServer(): void {`)
- Modify: `src/web/server.test.ts` (anchor: `const app = createApp();` ~L30)
- Modify: `src/index.ts` (anchors: imports, `const client = new Client(`, `startWebServer();`)

**Interfaces:**
- Consumes: `StartMeet`, `MeetSession`, `activeMeets`, `MeetRefused` (Tasks 6-7, reasons widened in Task 7b), `sendEmail` (Task 2), `loginMail` (Task 4), `normalizeEmail`, `parseEmailList` (Task 1), `users()` (Task 4c), `MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER` (Task 4b), `signUser`, `verifyUser`, `createLoginLink`, `consumeLoginLink`, `RateLimit` (Task 9), `page.meet*`, `MeetRecordingView`, `clientIp` (Task 10), `parseMeetUrl`, `meetRecorderConfigured` (unchanged).
- Produces: `interface MeetRouteDeps { startMeet: StartMeet }`; `meetRoutes(deps: MeetRouteDeps): Hono`; `createApp(deps: MeetRouteDeps): Hono`; `startWebServer(deps: MeetRouteDeps): void`.
- Produces in `src/index.ts`: `const startMeet: StartMeet` (Task 13 hands it to the calendar poller too).
- Routes (all under the app-wide security headers and `no-store`): `GET /meet`, `POST /meet/login`, `GET /meet/auth?t=`, `POST /meet/auth`, `POST /meet/start`, `POST /meet/stop`; mounted only when `meetRecorderConfigured()`.

**Gotcha:** the cookie is `SameSite=Lax`, which keeps it off cross-site POSTs to `/meet/start` and `/meet/stop`; do not loosen it to `None`.
`hono/csrf` adds the same protection for the cookie-less `POST /meet/login` and `POST /meet/auth` (login CSRF); it passes when `Sec-Fetch-Site` is `same-origin` or `Origin` equals `PUBLIC_BASE_URL`, and refuses with 403 otherwise (checked with hono 4.13.13: no Origin 403, matching Origin 200, other Origin 403).
Behind Nginx, `PUBLIC_BASE_URL` must be exactly the origin people type, or the forms are refused.
The user store is checked again on every request, so the cookie of someone who was disabled stops working at once.
The rate limits are module-level and span a whole test file: each test signs in its own addresses from fresh IPs (`newIp()`).

**Steps:**
- [ ] Step 1: Create `src/web/meet-routes.ts`:
      ```ts
      import { Hono, type Context } from "hono";
      import { getCookie, setCookie } from "hono/cookie";
      import { csrf } from "hono/csrf";
      import { config } from "../config.js";
      import { loginMail } from "../email/messages.js";
      import { sendEmail } from "../email/send.js";
      import { parseMeetUrl } from "../meet/meet-url.js";
      import { activeMeets, MAX_MEET_RECORDINGS, MeetRefused, type MeetSession, type StartMeet } from "../meet/session.js";
      import { users } from "../users/store.js";
      import { normalizeEmail, parseEmailList } from "../util/email.js";
      import { logger } from "../util/log.js";
      import { signUser, verifyUser } from "../util/pin.js";
      import { clientIp } from "./client-ip.js";
      import { consumeLoginLink, createLoginLink } from "./login-links.js";
      import { RateLimit } from "./rate-limit.js";
      import { page, type MeetRecordingView } from "./templates.js";

      const log = logger("web");
      const USER_COOKIE = "mu";
      const USER_TTL_MS = 12 * 60 * 60 * 1000;
      const MAX_EXTRA_RECIPIENTS = 20;
      const DAY_MS = 24 * 60 * 60_000;
      /** Links to addresses without an account, all together, so a flood of fake signups cannot use up the Resend quota the minutes need. */
      const MAX_SIGNUP_EMAILS_PER_DAY = 50;
      const linksPerIp = new RateLimit(5, 15 * 60_000);
      const linksPerEmail = new RateLimit(3, 15 * 60_000);
      const signupEmails = new RateLimit(MAX_SIGNUP_EMAILS_PER_DAY, DAY_MS);
      /** New accounts per IP; counted when the first link is confirmed. Room for a team behind one office NAT. */
      const signupsPerIp = new RateLimit(10, DAY_MS);

      export interface MeetRouteDeps {
        startMeet: StartMeet;
      }

      const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, "");

      /** The signed-in person, while their cookie is valid and their account exists and is active. */
      function user(c: Context): string | undefined {
        const email = verifyUser(getCookie(c, USER_COOKIE), config().SESSION_SECRET);
        return email && users().active(email) ? email : undefined;
      }

      /** Recordings this person started or gets the minutes of. */
      const visibleTo = (email: string) => [...activeMeets.values()].filter((s) => s.manifest.meet.recipients.includes(email));

      const view = (s: MeetSession): MeetRecordingView => ({
        id: s.id,
        title: s.manifest.meet.title,
        code: s.manifest.meet.code,
        state: s.state,
        trigger: s.manifest.meet.trigger,
        startedBy: s.manifest.meet.startedBy,
        stopping: s.stopping,
      });

      /** The Google Meet page: magic-link login (the first confirmed link creates the account), then start, follow, and stop recordings. */
      export function meetRoutes(deps: MeetRouteDeps): Hono {
        const app = new Hono();
        // Forms from other sites are refused. Browsers send Sec-Fetch-Site: same-origin for our own forms; the page's
        // Referrer-Policy no-referrer can make them send Origin: null, so both checks stay (either one passing is enough).
        app.use("*", csrf({ origin: base() }));
        const recorderPage = (email: string, extra: { error?: string; values?: { url: string; emails: string } } = {}) =>
          page.meetRecorder({ email, recordings: visibleTo(email).map(view), ...extra });

        app.get("/", (c) => {
          const email = user(c);
          return c.html(email ? recorderPage(email) : page.meetLogin({}));
        });

        app.post("/login", async (c) => {
          const typed = String((await c.req.parseBody()).email ?? "");
          const email = normalizeEmail(typed);
          if (!email) return c.html(page.meetLogin({ email: typed, error: "อีเมลไม่ถูกต้อง" }), 400);
          if (!linksPerIp.take(clientIp(c)) || !linksPerEmail.take(email)) {
            return c.html(page.meetLogin({ email: typed, error: "ขอลิงก์บ่อยเกินไป กรุณารอ 15 นาที" }), 429);
          }
          const account = users().get(email);
          if (account?.status === "disabled") {
            log.warn(`login link not sent to ${email}: the account is disabled`);
          } else if (!account && !signupEmails.take("all")) {
            // Only new addresses are capped, so existing accounts (the admin too) can always sign in.
            log.error(`login link not sent to ${email}: ${MAX_SIGNUP_EMAILS_PER_DAY} links to new addresses were sent in the last 24 hours`);
          } else {
            // Not awaited: an existing account must not answer slower than a new address.
            sendEmail({ to: email, ...loginMail(`${base()}/meet/auth?t=${createLoginLink(email)}`) }).then(
              () => log.info(`login link sent to ${email}`),
              (err) => log.error(`could not send a login link to ${email}`, err),
            );
          }
          // The same answer for new, existing, and disabled addresses, so the page does not tell who has an account.
          return c.html(page.meetLoginSent());
        });

        // Opening the link only shows a button: mail scanners that fetch links must not use up the single-use token.
        app.get("/auth", (c) => c.html(page.meetConfirm({ token: c.req.query("t") ?? "" })));

        app.post("/auth", async (c) => {
          const email = consumeLoginLink(String((await c.req.parseBody()).t ?? ""));
          if (!email) return c.html(page.meetLinkInvalid(), 400);
          // The first confirmed link creates the account (the link proved the address); new accounts are limited per IP.
          const isNew = !users().get(email);
          if (isNew && !signupsPerIp.take(clientIp(c))) {
            log.warn(`new account for ${email} refused: too many new accounts from one IP`);
            return c.html(page.meetLogin({ error: "สร้างบัญชีใหม่จากเครือข่ายนี้ครบจำนวนของวันนี้แล้ว กรุณาลองใหม่พรุ่งนี้" }), 429);
          }
          if (users().signIn(email, Date.now()).status !== "active") return c.html(page.meetAccountDisabled(), 403);
          setCookie(c, USER_COOKIE, signUser(email, config().SESSION_SECRET, USER_TTL_MS), {
            path: "/meet",
            httpOnly: true,
            secure: base().startsWith("https://"),
            sameSite: "Lax",
            maxAge: USER_TTL_MS / 1000,
          });
          log.info(`${email} signed in to the Google Meet page${isNew ? " (new account)" : ""}`);
          return c.redirect("/meet", 303);
        });

        app.post("/start", async (c) => {
          const email = user(c);
          if (!email) return c.redirect("/meet", 303);
          const body = await c.req.parseBody();
          const values = { url: String(body.url ?? ""), emails: String(body.emails ?? "") };
          const again = (error: string, status: 400 | 409 | 429 | 503) => c.html(recorderPage(email, { error, values }), status);
          const meet = parseMeetUrl(values.url);
          if (!meet) return again("ลิงก์นี้ไม่ใช่ลิงก์ Google Meet ใช้ลิงก์แบบ https://meet.google.com/abc-defg-hij", 400);
          const { emails, invalid } = parseEmailList(values.emails);
          if (invalid.length) return again(`อีเมลเหล่านี้ไม่ถูกต้อง: ${invalid.join(", ")}`, 400);
          if (emails.length > MAX_EXTRA_RECIPIENTS) return again(`ส่งบันทึกให้อีเมลเพิ่มเติมได้สูงสุด ${MAX_EXTRA_RECIPIENTS} อีเมล`, 400);
          try {
            await deps.startMeet({ ...meet, title: `Google Meet ${meet.code}`, trigger: "web", startedBy: email, recipients: emails });
          } catch (err) {
            if (err instanceof MeetRefused) {
              const limits = config();
              switch (err.reason) {
                case "already_recording":
                  return again("ห้อง Google Meet นี้กำลังถูกบันทึกอยู่แล้ว", 409);
                case "user_busy":
                  return again(`คุณกำลังบันทึกอยู่ ${limits.MEET_MAX_ACTIVE_PER_USER} ห้อง ซึ่งเป็นจำนวนสูงสุดต่อคน กรุณาหยุดหรือรอให้ห้องเดิมจบก่อน`, 409);
                case "daily_limit":
                  return again(`คุณเริ่มบันทึกครบ ${limits.MEET_MAX_DAILY_PER_USER} ครั้งใน 24 ชั่วโมงแล้ว ซึ่งเป็นจำนวนสูงสุดต่อคน กรุณาลองใหม่ภายหลัง`, 429);
                case "busy":
                  return again(`ตอนนี้บันทึก Google Meet อยู่ ${MAX_MEET_RECORDINGS} ห้องแล้ว ซึ่งเป็นจำนวนสูงสุด กรุณาลองใหม่เมื่อห้องใดห้องหนึ่งจบ`, 503);
              }
            }
            log.error(`could not start a Google Meet recording for ${email}`, err);
            return again("เริ่มเครื่องบันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", 503);
          }
          return c.redirect("/meet", 303);
        });

        app.post("/stop", async (c) => {
          const email = user(c);
          if (!email) return c.redirect("/meet", 303);
          const id = String((await c.req.parseBody()).id ?? "");
          const session = visibleTo(email).find((s) => s.id === id);
          if (!session) return c.html(page.notFound(), 404);
          try {
            await session.end(`หยุดโดย ${email} จากหน้าเว็บ`);
          } catch (err) {
            log.warn(`could not ask the Google Meet recorder to stop ${id}`, err);
            return c.html(
              recorderPage(email, { error: "ติดต่อเครื่องบันทึกเพื่อหยุดไม่ได้ เครื่องจะหยุดเองเมื่อทุกคนออกจากห้องหรือครบเวลาสูงสุด" }),
              503,
            );
          }
          return c.redirect("/meet", 303);
        });

        return app;
      }
      ```
- [ ] Step 2: In `src/web/server.ts` import `HTTPException` from `hono/http-exception`, `meetRecorderConfigured` from `../meet/recorder-client.js`, and `meetRoutes, type MeetRouteDeps` from `./meet-routes.js`; make the first line of `app.onError` `if (err instanceof HTTPException) return err.getResponse();` (the CSRF middleware refuses with an `HTTPException` 403, which would otherwise become a logged 500); change the signatures to `export function createApp(deps: MeetRouteDeps): Hono` and `export function startWebServer(deps: MeetRouteDeps): void` (it calls `createApp(deps)`), and just before `app.notFound(` add:
      ```ts
        // Google Meet recording page; its routes run after the security-header middleware above.
        if (meetRecorderConfigured()) app.route("/meet", meetRoutes(deps));
      ```
- [ ] Step 3: In `src/web/server.test.ts` change `const app = createApp();` to `const app = createApp({ startMeet: async () => { throw new Error("not used by the PIN tests"); } });`.
- [ ] Step 4: In `src/index.ts` import `MeetSession, type StartMeet` (with `activeMeets`) from `./meet/session.js` and `processMeeting` (with `recoverUnfinished`) from `./pipeline/run.js`; after `const client = new Client(...)` add:
      ```ts
      /** Both Google Meet triggers (the web page and the calendar) start recordings through this. */
      const startMeet: StartMeet = (meet) => MeetSession.start(meet, (m) => void processMeeting(client, m));
      ```
      and call `startWebServer({ startMeet });`.
- [ ] Step 5: Create `src/web/meet-routes.test.ts`:
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
      const { users } = await import("../users/store.js");

      const app = createApp({ startMeet: (meet) => MeetSession.start(meet, () => {}) });
      const JKU = "https://meet.google.com/abc-defg-hij";
      let ipCounter = 0;
      const newIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
      const post = (path: string, fields: Record<string, string>, o: { cookie?: string; ip?: string } = {}) =>
        app.request(path, {
          method: "POST",
          body: new URLSearchParams(fields),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": o.ip ?? newIp(),
            origin: "https://meet.example.com", // what a browser sends for a same-origin form post (PUBLIC_BASE_URL in the test env)
            ...(o.cookie ? { cookie: o.cookie } : {}),
          },
        });
      const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} });
      const tokenIn = (text: string) => /\/meet\/auth\?t=([\w-]+)/.exec(text)?.[1];
      /** Changes one character in the middle of the HMAC (the last base64url character carries padding bits, so changing it may decode to the same bytes). */
      const tampered = (cookie: string) => {
        const i = cookie.length - 10;
        return cookie.slice(0, i) + (cookie[i] === "A" ? "B" : "A") + cookie.slice(i + 1);
      };

      /** Requests a link, takes it from the fake inbox, confirms it (which signs a new address up), and returns the cookie header value. */
      async function signIn(email: string, ip = newIp()): Promise<string> {
        await post("/meet/login", { email });
        const res = await post("/meet/auth", { t: tokenIn(sentEmails.at(-1)!.text)! }, { ip });
        return res.headers.get("set-cookie")!.split(";")[0]!;
      }

      beforeEach(() => {
        sentEmails.length = 0;
        worker.down = false;
        worker.failStart = false;
      });
      afterEach(async () => {
        for (const s of activeMeets.values()) await s.shutdown();
        activeMeets.clear();
      });

      test("anyone gets a single-use link by email, the link only asks to confirm, and the first confirmation creates the account and signs in", async () => {
        const first = await get("/meet");
        assert.match(await first.text(), /name="email"/);
        assert.equal(first.headers.get("cache-control"), "no-store");
        assert.match(first.headers.get("content-security-policy") ?? "", /default-src 'none'/);

        const asked = await post("/meet/login", { email: " Alice@Example.com " });
        assert.equal(asked.status, 200);
        assert.match(await asked.text(), /ตรวจอีเมลของคุณ/);
        assert.equal(sentEmails.length, 1);
        assert.equal(sentEmails[0]!.to, "alice@example.com");
        const token = tokenIn(sentEmails[0]!.text)!;
        assert.ok(sentEmails[0]!.text.includes(`https://meet.example.com/meet/auth?t=${token}`));
        assert.equal(users().get("alice@example.com"), undefined, "asking for a link creates no account");

        const opened = await get(`/meet/auth?t=${token}`);
        assert.match(await opened.text(), new RegExp(`name="t" value="${token}"`));
        assert.equal(opened.headers.get("set-cookie"), null, "opening the link signs nobody in");
        assert.equal(users().get("alice@example.com"), undefined, "opening the link creates no account");

        const confirmed = await post("/meet/auth", { t: token });
        assert.equal(confirmed.status, 303);
        assert.equal(confirmed.headers.get("location"), "/meet");
        const cookie = confirmed.headers.get("set-cookie")!;
        for (const part of [/^mu=/, /HttpOnly/i, /Secure/i, /Path=\/meet/, /SameSite=Lax/i]) assert.match(cookie, part);
        const alice = users().get("alice@example.com")!;
        assert.equal(alice.status, "active");
        assert.equal(alice.isAdmin, false);
        assert.ok(alice.lastLoginAt);
        assert.equal((await post("/meet/auth", { t: token })).status, 400, "the link works once");

        const signedIn = await get("/meet", cookie.split(";")[0]);
        assert.match(await signedIn.text(), /name="url"/);
      });

      test("new, existing, and disabled addresses get the same answer; a disabled account gets no link; a form from another site is refused", async () => {
        await signIn("old@planthia.test");
        users().signIn("off@planthia.test", Date.now());
        users().setStatus("off@planthia.test", "disabled");
        sentEmails.length = 0;
        const answers = [];
        for (const email of ["brand-new@nowhere.test", "old@planthia.test", "off@planthia.test"]) {
          const res = await post("/meet/login", { email });
          answers.push([res.status, await res.text()]);
        }
        assert.deepEqual(answers[1], answers[0]);
        assert.deepEqual(answers[2], answers[0]);
        assert.deepEqual(sentEmails.map((e) => e.to), ["brand-new@nowhere.test", "old@planthia.test"]);
        const crossSite = await app.request("/meet/login", {
          method: "POST",
          body: new URLSearchParams({ email: "old@planthia.test" }),
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": newIp(), origin: "https://evil.test" },
        });
        assert.equal(crossSite.status, 403, "a form posted from another site is refused");
        assert.equal(sentEmails.length, 2);
      });

      test("link requests are limited per email and per IP, and new accounts per IP; an existing account can still sign in from that IP", async () => {
        for (let i = 0; i < 3; i++) assert.equal((await post("/meet/login", { email: "dave@planthia.test" })).status, 200);
        assert.equal((await post("/meet/login", { email: "dave@planthia.test" })).status, 429);
        const ip = newIp();
        for (let i = 0; i < 5; i++) assert.equal((await post("/meet/login", { email: `x${i}@nowhere.test` }, { ip })).status, 200);
        assert.equal((await post("/meet/login", { email: "x9@nowhere.test" }, { ip })).status, 429);

        const home = newIp();
        await signIn("old2@planthia.test", newIp());
        for (let i = 0; i < 10; i++) await signIn(`new${i}@nowhere.test`, home);
        await post("/meet/login", { email: "new10@nowhere.test" });
        const refused = await post("/meet/auth", { t: tokenIn(sentEmails.at(-1)!.text)! }, { ip: home });
        assert.equal(refused.status, 429);
        assert.match(await refused.text(), /สร้างบัญชีใหม่จากเครือข่ายนี้ครบจำนวน/);
        assert.equal(users().get("new10@nowhere.test"), undefined);
        assert.match(await signIn("old2@planthia.test", home), /^mu=/, "the limit is for new accounts only");
      });

      test("a signed-in person starts a recording with extra recipients, sees its state, and stops it", async () => {
        const cookie = await signIn("gina@planthia.test");
        const started = await post("/meet/start", { url: JKU, emails: "Bob@example.com,\ncarol@planthia.test" }, { cookie });
        assert.equal(started.status, 303);
        const s = activeMeets.get("abc-defg-hij")!;
        assert.deepEqual(s.manifest.meet, {
          url: JKU,
          code: "abc-defg-hij",
          title: "Google Meet abc-defg-hij",
          trigger: "web",
          startedBy: "gina@planthia.test",
          recipients: ["gina@planthia.test", "bob@example.com", "carol@planthia.test"],
        });
        const listed = await (await get("/meet", cookie)).text();
        assert.match(listed, /Google Meet abc-defg-hij/);
        assert.match(listed, /กำลังเปิดเครื่องบันทึก · จากหน้าเว็บ/);
        assert.equal((await post("/meet/stop", { id: s.id }, { cookie })).status, 303);
        assert.equal(worker.recordings.get(s.id)!.stopped, true);
        assert.match(await (await get("/meet", cookie)).text(), /กำลังหยุด/);
      });

      test("bad input, a recorder error, and the limits are explained on the page", async () => {
        const cookie = await signIn("hank@planthia.test");
        const badLink = await post("/meet/start", { url: "https://zoom.us/j/1", emails: "" }, { cookie });
        assert.equal(badLink.status, 400);
        const badLinkHtml = await badLink.text();
        assert.match(badLinkHtml, /ไม่ใช่ลิงก์ Google Meet/);
        assert.match(badLinkHtml, /value="https:\/\/zoom.us\/j\/1"/, "what was typed stays in the form");
        const badEmail = await post("/meet/start", { url: JKU, emails: "nope" }, { cookie });
        assert.equal(badEmail.status, 400);
        assert.match(await badEmail.text(), /อีเมลเหล่านี้ไม่ถูกต้อง: nope/);

        worker.failStart = true;
        const failed = await post("/meet/start", { url: JKU, emails: "" }, { cookie });
        assert.equal(failed.status, 503);
        assert.match(await failed.text(), /เริ่มเครื่องบันทึกไม่สำเร็จ/);
        worker.failStart = false;

        assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie })).status, 303);
        const twice = await post("/meet/start", { url: "abc-defg-hij", emails: "" }, { cookie });
        assert.equal(twice.status, 409);
        assert.match(await twice.text(), /กำลังถูกบันทึกอยู่แล้ว/);
        const mine = await post("/meet/start", { url: "https://meet.google.com/abc-defg-hij", emails: "" }, { cookie });
        assert.equal(mine.status, 409);
        assert.match(await mine.text(), /อยู่ 1 ห้อง ซึ่งเป็นจำนวนสูงสุดต่อคน/);
        const ken = await signIn("ken@planthia.test");
        assert.equal((await post("/meet/start", { url: "https://meet.google.com/abc-defg-hij", emails: "" }, { cookie: ken })).status, 303);
        const lee = await signIn("lee@planthia.test");
        const third = await post("/meet/start", { url: "https://meet.google.com/xyz-abcd-efg", emails: "" }, { cookie: lee });
        assert.equal(third.status, 503);
        assert.match(await third.text(), /2 ห้องแล้ว/);
      });

      test("a person who used up the daily limit is told so and nothing is started", async () => {
        const cookie = await signIn("mia@planthia.test");
        for (let i = 0; i < 5; i++) users().recordStart("mia@planthia.test", Date.now());
        const res = await post("/meet/start", { url: JKU, emails: "" }, { cookie });
        assert.equal(res.status, 429);
        assert.match(await res.text(), /ครบ 5 ครั้งใน 24 ชั่วโมง/);
        assert.equal(activeMeets.size, 0);
      });

      test("people see and stop only recordings that are theirs, and nothing works without a valid cookie", async () => {
        const ivy = await signIn("ivy@planthia.test");
        const carol = await signIn("carol@planthia.test");
        const jack = await signIn("jack@planthia.test");
        await post("/meet/start", { url: JKU, emails: "" }, { cookie: ivy });
        await post("/meet/start", { url: "https://meet.google.com/abc-defg-hij", emails: "carol@planthia.test" }, { cookie: jack });
        const own = activeMeets.get("abc-defg-hij")!;
        const shared = activeMeets.get("abc-defg-hij")!;
        const carolPage = await (await get("/meet", carol)).text();
        assert.doesNotMatch(carolPage, /abc-defg-hij/);
        assert.match(carolPage, /<li class="rec"><div>Google Meet abc-defg-hij/, "a recipient sees the recording");
        assert.equal((await post("/meet/stop", { id: own.id }, { cookie: carol })).status, 404);
        assert.equal(worker.recordings.get(own.id)!.stopped, false);
        assert.equal((await post("/meet/stop", { id: shared.id }, { cookie: carol })).status, 303);

        const anonymous = await post("/meet/start", { url: "https://meet.google.com/xyz-abcd-efg", emails: "" });
        assert.equal(anonymous.status, 303);
        assert.equal(activeMeets.get("xyz-abcd-efg"), undefined);
        assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie: tampered(ivy) })).status, 303, "a tampered cookie counts as signed out");
      });

      test("disabling an account signs it out at once, and a link made before that no longer signs it in", async () => {
        const nora = await signIn("nora@planthia.test");
        await post("/meet/login", { email: "nora@planthia.test" });
        const token = tokenIn(sentEmails.at(-1)!.text)!;
        users().setStatus("nora@planthia.test", "disabled");
        assert.match(await (await get("/meet", nora)).text(), /name="email"/, "the cookie no longer works");
        assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie: nora })).status, 303);
        assert.equal(activeMeets.size, 0);
        const late = await post("/meet/auth", { t: token });
        assert.equal(late.status, 403);
        assert.match(await late.text(), /ถูกปิดการใช้งาน/);
        assert.equal(late.headers.get("set-cookie"), null);
      });
      ```
- [ ] Step 5b: Create `src/web/meet-signup-cap.test.ts` (its own file, so its rate limiters start empty; `meet-routes.test.ts` shares them across its tests):
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { mockEmail, mockR2, sentEmails } from "../test/setup.js";

      mockR2();
      mockEmail();
      process.env.TRUST_PROXY = "true";
      const { createApp } = await import("./server.js");
      const { users } = await import("../users/store.js");

      const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
      let ip = 0;
      const askLink = (email: string) =>
        app.request("/meet/login", {
          method: "POST",
          body: new URLSearchParams({ email }),
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.2.${Math.floor(++ip / 250)}.${ip % 250}`, origin: "https://meet.example.com" },
        });

      test("after 50 links to new addresses in 24 hours, new addresses get the same answer but no email, and existing accounts still get theirs", async () => {
        users().signIn("kept@planthia.test", Date.now());
        for (let i = 0; i < 50; i++) assert.equal((await askLink(`n${i}@nowhere.test`)).status, 200);
        assert.equal(sentEmails.length, 50);
        const capped = await askLink("n50@nowhere.test");
        assert.equal(capped.status, 200);
        assert.match(await capped.text(), /ตรวจอีเมลของคุณ/, "the same answer, so the cap reveals nothing about any address");
        assert.equal(sentEmails.length, 50, "no email to a new address over the cap");
        await askLink("kept@planthia.test");
        assert.equal(sentEmails.at(-1)?.to, "kept@planthia.test", "an existing account can still sign in");
      });
      ```
- [ ] Step 6: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 80`, `# fail 0` (71 + 8 + 1).
- [ ] Step 7: Commit - `git add src/web/meet-routes.ts src/web/meet-routes.test.ts src/web/meet-signup-cap.test.ts src/web/server.ts src/web/server.test.ts src/index.ts && git commit -m "feat(web): start and stop Google Meet recordings from the web page"`

---

### Task 11b: Admin page: list users, disable and enable them

The smallest admin ability that fits (Decision 20): one page for signed-in admins, in the same process as the user store, so `users.json` keeps a single writer.

**Files:**
- Modify: `src/web/templates.ts` (anchors: the `meetRecorder` signature and its closing `<a class="refresh" href="/meet">รีเฟรชสถานะ</a>`, end of the `page` object, imports at the top)
- Modify: `src/web/templates.test.ts` (append one test)
- Modify: `src/web/meet-routes.ts` (anchors: `const recorderPage = (email: string,`, `return app;` at the end of `meetRoutes`)
- Modify: `src/web/meet-routes.test.ts` (append two tests)

**Interfaces:**
- Consumes: `users()`, `User` (Task 4c); `user(c)`, `recorderPage`, `meetCard`, the CSRF middleware (Tasks 10-11).
- Produces in `src/web/templates.ts`: `page.meetAdmin(o: { email: string; users: User[]; error?: string }): string`; `page.meetRecorder` gains `isAdmin?: boolean` (shows a link to the admin page).
- Routes: `GET /meet/admin`, `POST /meet/admin/status` (`email`, `status` = `active` | `disabled`); both answer 404 to anyone who is not a signed-in active admin.

**Gotcha:** an admin may not change their own status (no self-lockout); `SEED_ADMIN_EMAIL` also re-activates the seeded admin at every boot.
Disabling does not stop a recording that already runs (Decision 20).

**Steps:**
- [ ] Step 1: In `STYLE` of `src/web/templates.ts` add, after the `button.stop` rule from Task 10, `button.enable{width:auto;margin:0;padding:8px 14px;background:transparent;color:var(--accent);border:1px solid var(--accent)}` (enabling is not destructive, so it is not red).
      In the same file add `import type { User } from "../users/store.js";` and `import { bangkokDateTime } from "../util/time.js";` at the top; give `meetRecorder` the option `isAdmin?: boolean` and, after the `รีเฟรชสถานะ` link, append `${o.isAdmin ? ` · <a class="refresh" href="/meet/admin">จัดการผู้ใช้</a>` : ""}`; and add to `page`:
      ```ts
        meetAdmin: (o: { email: string; users: User[]; error?: string }) => {
          const items = o.users
            .map((u) => {
              const next = u.status === "active" ? "disabled" : "active";
              const button =
                u.email === o.email
                  ? ""
                  : `<form method="post" action="/meet/admin/status"><input type="hidden" name="email" value="${esc(u.email)}"><input type="hidden" name="status" value="${next}"><button class="${next === "disabled" ? "stop" : "enable"}" type="submit">${
                      next === "disabled" ? "ปิดการใช้งาน" : "เปิดการใช้งาน"
                    }</button></form>`;
              return `<li class="rec"><div>${esc(u.email)}<small>${u.isAdmin ? "ผู้ดูแล · " : ""}${
                u.status === "active" ? "ใช้งานได้" : "ปิดการใช้งาน"
              } · สมัครเมื่อ ${bangkokDateTime(u.createdAt)} · เข้าล่าสุด ${u.lastLoginAt ? bangkokDateTime(u.lastLoginAt) : "-"}</small></div>${button}</li>`;
            })
            .join("");
          return meetCard(
            "จัดการผู้ใช้",
            `<h1>จัดการผู้ใช้</h1><p class="meta">${o.users.length} บัญชี · <a href="/meet">กลับหน้าบันทึก</a></p>
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}<ul>${items}</ul>`,
          );
        },
      ```
- [ ] Step 2: In `src/web/meet-routes.ts`, `recorderPage` passes `isAdmin: !!users().get(email)?.isAdmin` to `page.meetRecorder`, and before `return app;` add:
      ```ts
        /** The signed-in person when they are an active admin; everyone else gets 404, so the admin pages do not reveal themselves. */
        const admin = (c: Context) => {
          const email = user(c);
          return email && users().get(email)?.isAdmin ? email : undefined;
        };

        app.get("/admin", (c) => {
          const email = admin(c);
          return email ? c.html(page.meetAdmin({ email, users: users().list() })) : c.html(page.notFound(), 404);
        });

        app.post("/admin/status", async (c) => {
          const email = admin(c);
          if (!email) return c.html(page.notFound(), 404);
          const body = await c.req.parseBody();
          const target = normalizeEmail(String(body.email ?? ""));
          const status = body.status;
          if (!target || target === email || (status !== "active" && status !== "disabled") || !users().setStatus(target, status)) {
            return c.html(page.meetAdmin({ email, users: users().list(), error: "เปลี่ยนสถานะบัญชีนี้ไม่ได้" }), 400);
          }
          log.info(`${email} set the account ${target} to ${status}`);
          return c.redirect("/meet/admin", 303);
        });
      ```
- [ ] Step 3: Append to `src/web/templates.test.ts`:
      ```ts
      test("the admin page lists accounts with their state, escapes addresses, and has no button for the admin's own account", () => {
        const html = page.meetAdmin({
          email: "root@example.com",
          users: [
            { email: "root@example.com", status: "active", isAdmin: true, createdAt: Date.UTC(2026, 10, 20, 3), recentStarts: [] },
            { email: "x<y@example.com", status: "disabled", isAdmin: false, createdAt: Date.UTC(2026, 10, 21, 3), lastLoginAt: Date.UTC(2026, 10, 21, 4), recentStarts: [] },
          ],
        });
        assert.match(html, /2 บัญชี/);
        assert.match(html, /root@example\.com<small>ผู้ดูแล · ใช้งานได้/);
        assert.match(html, /x&lt;y@example\.com<small>ปิดการใช้งาน/);
        assert.equal(html.match(/<form /g)?.length, 1, "only the other account has a button");
        assert.match(html, /name="status" value="active"><button class="enable" type="submit">เปิดการใช้งาน/);
      });
      ```
- [ ] Step 4: Append to `src/web/meet-routes.test.ts`:
      ```ts
      test("an admin lists accounts and disables and enables them; the disabled person is signed out at once; an admin cannot change their own status", async () => {
        users().seedAdmin("root@planthia.test", Date.now());
        const root = await signIn("root@planthia.test");
        const nina = await signIn("nina@planthia.test");
        assert.match(await (await get("/meet", root)).text(), /href="\/meet\/admin"/);
        assert.doesNotMatch(await (await get("/meet", nina)).text(), /\/meet\/admin/);
        assert.match(await (await get("/meet/admin", root)).text(), /nina@planthia\.test/);
        assert.equal((await post("/meet/admin/status", { email: "Nina@planthia.test", status: "disabled" }, { cookie: root })).status, 303);
        assert.equal(users().get("nina@planthia.test")?.status, "disabled");
        assert.match(await (await get("/meet", nina)).text(), /name="email"/, "nina's cookie no longer works");
        assert.equal((await post("/meet/admin/status", { email: "nina@planthia.test", status: "active" }, { cookie: root })).status, 303);
        assert.match(await (await get("/meet", nina)).text(), /name="url"/);
        assert.equal((await post("/meet/admin/status", { email: "root@planthia.test", status: "disabled" }, { cookie: root })).status, 400);
        assert.equal(users().get("root@planthia.test")?.status, "active");
      });

      test("the admin pages answer 404 to people who are not admins and to signed-out visitors", async () => {
        const olga = await signIn("olga@planthia.test");
        assert.equal((await get("/meet/admin", olga)).status, 404);
        assert.equal((await get("/meet/admin")).status, 404);
        assert.equal((await post("/meet/admin/status", { email: "olga@planthia.test", status: "disabled" }, { cookie: olga })).status, 404);
        assert.equal(users().get("olga@planthia.test")?.status, "active");
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; `# pass 83`, `# fail 0` (80 + 3).
- [ ] Step 6: Commit - `git add src/web/templates.ts src/web/templates.test.ts src/web/meet-routes.ts src/web/meet-routes.test.ts && git commit -m "feat(web): add an admin page to disable and enable accounts"`

---

### Task 12: Read calendar occurrences from the iCal feed (gated on Task 0 GO)

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install --save-exact node-ical@0.27.6`)
- Create: `src/calendar/feed.ts`
- Create: `src/calendar/fixture.ics`
- Create: `src/calendar/feed.test.ts`

**Interfaces:**
- Consumes: `normalizeEmail` (Task 1), `parseMeetUrl` (`src/meet/meet-url.ts`, unchanged).
- Produces: `interface Occurrence { key: string; start: Date; end: Date; title?: string; organizer?: string; attendees: string[]; meet?: { url: string; code: string } }`; `occurrencesIn(ics: string, from: Date, to: Date): Occurrence[]`; `isDue(o: Occurrence, now: number): boolean`; `recipientsOf(o: Occurrence, botEmail: string): string[]`; `LEAD_MS = 60_000`; `LATE_MS = 15 * 60_000`.

**Gotcha:** `X-GOOGLE-CONFERENCE` arrives as `event["GOOGLE-CONFERENCE"]` (node-ical strips `X-`), typed `unknown`; `expandRecurringEvent` does not drop `STATUS:CANCELLED` overrides, the code below does.
The reference code and the fixture were run while planning against `node-ical@0.27.6` in a scratch folder (outside the repo) with the repo's `tsc` (strict, NodeNext: no errors) and `tsx`: they produced exactly the occurrences the tests below expect.

**Steps:**
- [ ] Step 1: Run `npm install --save-exact node-ical@0.27.6` - Expected: `package.json` lists `"node-ical": "0.27.6"` (no caret) and `package-lock.json` changed; nothing else in `package.json` changed.
- [ ] Step 2: Create `src/calendar/feed.ts` (imports adjusted to the repo: `../meet/meet-url.js`, `../util/email.js`):
      ```ts
      import ical, { type VEvent } from "node-ical";
      import { parseMeetUrl } from "../meet/meet-url.js";
      import { normalizeEmail } from "../util/email.js";

      /** Start the recorder this long before the event starts (the container needs about a minute to boot and join). */
      export const LEAD_MS = 60_000;
      /** An occurrence is still started this long after its start (missed polls, a bot restart). */
      export const LATE_MS = 15 * 60_000;

      /** One occurrence of a calendar event as the bot account's calendar shows it. */
      export interface Occurrence {
        /** "<UID>|<original start, UTC ISO>"; stays the same when the occurrence is moved. */
        key: string;
        start: Date;
        end: Date;
        title?: string;
        organizer?: string;
        /** Invitee addresses that did not decline, lowercase (may include the bot account and rooms). */
        attendees: string[];
        meet?: { url: string; code: string };
      }

      /** node-ical gives a plain string, or { val, params } when the iCal line has parameters. */
      const text = (p: unknown): string | undefined =>
        typeof p === "string"
          ? p
          : p && typeof p === "object" && "val" in p && typeof (p as { val: unknown }).val === "string"
            ? (p as { val: string }).val
            : undefined;
      const MEET_RE = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
      const meetIn = (s: string | undefined) => {
        const found = s ? MEET_RE.exec(s) : null;
        return found ? parseMeetUrl(found[0]) : undefined;
      };

      /**
       * Occurrences that start inside [from, to] (both inclusive). RRULEs are expanded with EXDATEs removed and
       * RECURRENCE-ID overrides applied; cancelled and all-day occurrences are left out.
       */
      export function occurrencesIn(ics: string, from: Date, to: Date): Occurrence[] {
        const out: Occurrence[] = [];
        for (const c of Object.values(ical.sync.parseICS(ics))) {
          if (!c || c.type !== "VEVENT") continue;
          const entry = c as VEvent;
          // A UID with only overrides (the bot was invited to single occurrences of someone else's series): node-ical keeps
          // the first as the entry and all of them in `recurrences` (date and ISO keys point to the same objects).
          const sources =
            entry.recurrenceid && !entry.rrule && entry.recurrences
              ? ([...new Set(Object.values(entry.recurrences))] as VEvent[])
              : [entry];
          for (const source of sources) {
            for (const inst of ical.expandRecurringEvent(source, { from, to })) {
              const e = inst.event;
              if (e.status === "CANCELLED" || inst.isFullDay) continue;
              const listed = e.attendee === undefined ? [] : Array.isArray(e.attendee) ? e.attendee : [e.attendee];
              // Invitees who declined get no minutes (user decision); recipientsOf adds the organizer back in any case.
              const attendees = listed.filter((a) => !(typeof a === "object" && a.params?.PARTSTAT === "DECLINED"));
              out.push({
                key: `${e.uid}|${(e.recurrenceid ?? inst.start).toISOString()}`,
                start: inst.start,
                end: inst.end,
                title: text(e.summary)?.trim() || undefined,
                organizer: normalizeEmail(text(e.organizer) ?? ""),
                attendees: attendees.map((a) => normalizeEmail(text(a) ?? "")).filter((a): a is string => !!a),
                meet: meetIn(text(e["GOOGLE-CONFERENCE"])) ?? meetIn(text(e.description)) ?? meetIn(text(e.location)),
              });
            }
          }
        }
        return out;
      }

      /** Due from LEAD_MS before the start until LATE_MS after it, but never after the event's end. */
      export function isDue(o: Occurrence, now: number): boolean {
        const start = o.start.getTime();
        return now >= start - LEAD_MS && now <= Math.min(start + LATE_MS, o.end.getTime());
      }

      /** Who gets the minutes: the organizer (always) and every invitee who did not decline, without the bot account and room resources. */
      export function recipientsOf(o: Occurrence, botEmail: string): string[] {
        return [...new Set([o.organizer, ...o.attendees])].filter(
          (e): e is string => !!e && e !== botEmail && !e.endsWith(".calendar.google.com"),
        );
      }
      ```
- [ ] Step 3: Create `src/calendar/fixture.ics`.
      It is synthetic (no real people) and mirrors Google's feed: a weekly series with a declined invitee, a deleted week (EXDATE), a moved week (override with RECURRENCE-ID), a cancelled week (override with `STATUS:CANCELLED`), an organizer who declined as an attendee, an organizer who is not a user, an event without a Meet link, an event whose Meet link is only in the description, and an all-day event.
      If Task 0 recorded a shape this file does not have (for example `RECURRENCE-ID;VALUE=DATE`, overrides without ATTENDEE lines, or no `X-GOOGLE-CONFERENCE` at all), add one VEVENT of that shape and one matching assertion in Step 4.
      ```text
      BEGIN:VCALENDAR
      PRODID:-//Google Inc//Google Calendar 70.9054//EN
      VERSION:2.0
      CALSCALE:GREGORIAN
      METHOD:PUBLISH
      X-WR-CALNAME:bot@example.com
      X-WR-TIMEZONE:Asia/Bangkok
      BEGIN:VTIMEZONE
      TZID:Asia/Bangkok
      X-LIC-LOCATION:Asia/Bangkok
      BEGIN:STANDARD
      TZOFFSETFROM:+0700
      TZOFFSETTO:+0700
      TZNAME:GMT+7
      DTSTART:19700101T000000
      END:STANDARD
      END:VTIMEZONE
      BEGIN:VEVENT
      DTSTART;TZID=Asia/Bangkok:20261123T100000
      DTEND;TZID=Asia/Bangkok:20261123T110000
      RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
      EXDATE;TZID=Asia/Bangkok:20261130T100000
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Alice:mailto:alice@planthia.test
      UID:weekly-standup@google.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alice;X-NUM-GUESTS=0:mailto:alice@planthia.test
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Bob;X-NUM-GUESTS=0:mailto:Bob@Example.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bot@example.com;X-NUM-GUESTS=0:mailto:bot@example.com
      ATTENDEE;CUTYPE=RESOURCE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Room 1;X-NUM-GUESTS=0:mailto:c_room1@resource.calendar.google.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=Dan;X-NUM-GUESTS=0:mailto:dan@example.com
      X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
      CREATED:20261101T000000Z
      DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij\nLearn more about Meet at: https://support.google.com/a/users/answer/9282720
      LAST-MODIFIED:20261101T000000Z
      SEQUENCE:0
      STATUS:CONFIRMED
      SUMMARY:Weekly standup
      TRANSP:OPAQUE
      END:VEVENT
      BEGIN:VEVENT
      DTSTART;TZID=Asia/Bangkok:20261207T130000
      DTEND;TZID=Asia/Bangkok:20261207T140000
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Alice:mailto:alice@planthia.test
      UID:weekly-standup@google.com
      RECURRENCE-ID;TZID=Asia/Bangkok:20261207T100000
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alice;X-NUM-GUESTS=0:mailto:alice@planthia.test
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Bob;X-NUM-GUESTS=0:mailto:Bob@Example.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bot@example.com;X-NUM-GUESTS=0:mailto:bot@example.com
      X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
      CREATED:20261101T000000Z
      LAST-MODIFIED:20261110T000000Z
      SEQUENCE:1
      STATUS:CONFIRMED
      SUMMARY:Weekly standup (moved)
      TRANSP:OPAQUE
      END:VEVENT
      BEGIN:VEVENT
      DTSTART;TZID=Asia/Bangkok:20261214T100000
      DTEND;TZID=Asia/Bangkok:20261214T110000
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Alice:mailto:alice@planthia.test
      UID:weekly-standup@google.com
      RECURRENCE-ID;TZID=Asia/Bangkok:20261214T100000
      CREATED:20261101T000000Z
      LAST-MODIFIED:20261110T000000Z
      SEQUENCE:1
      STATUS:CANCELLED
      SUMMARY:Weekly standup
      TRANSP:OPAQUE
      END:VEVENT
      BEGIN:VEVENT
      DTSTART;TZID=Asia/Bangkok:20261123T100000
      DTEND;TZID=Asia/Bangkok:20261123T110000
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Mallory:mailto:mallory@evil.test
      UID:stranger@google.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bot@example.com;X-NUM-GUESTS=0:mailto:bot@example.com
      X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
      SEQUENCE:0
      STATUS:CONFIRMED
      SUMMARY:Free recording please
      END:VEVENT
      BEGIN:VEVENT
      DTSTART;TZID=Asia/Bangkok:20261123T100000
      DTEND;TZID=Asia/Bangkok:20261123T103000
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Alice:mailto:alice@planthia.test
      UID:no-link@google.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bot@example.com;X-NUM-GUESTS=0:mailto:bot@example.com
      DESCRIPTION:Room 3\, no video call
      SEQUENCE:0
      STATUS:CONFIRMED
      SUMMARY:In-person sync
      END:VEVENT
      BEGIN:VEVENT
      DTSTART:20261123T030000Z
      DTEND:20261123T040000Z
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=carol@planthia.test:mailto:carol@planthia.test
      UID:desc-link@google.com
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=carol@planthia.test;X-NUM-GUESTS=0:mailto:carol@planthia.test
      ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bot@example.com;X-NUM-GUESTS=0:mailto:bot@example.com
      DESCRIPTION:Agenda: budget\nLink: https://meet.google.com/xyz-abcd-efg
      SEQUENCE:0
      STATUS:CONFIRMED
      SUMMARY:Budget review
      END:VEVENT
      BEGIN:VEVENT
      DTSTART;VALUE=DATE:20261123
      DTEND;VALUE=DATE:20261124
      DTSTAMP:20261120T000000Z
      ORGANIZER;CN=Alice:mailto:alice@planthia.test
      UID:all-day@google.com
      X-GOOGLE-CONFERENCE:https://meet.google.com/qqq-wwww-eee
      SEQUENCE:0
      STATUS:CONFIRMED
      SUMMARY:Offsite
      END:VEVENT
      END:VCALENDAR
      ```
- [ ] Step 4: Create `src/calendar/feed.test.ts`:
      ```ts
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { isDue, LATE_MS, LEAD_MS, occurrencesIn, recipientsOf, type Occurrence } from "./feed.js";

      const ICS = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
      const all = occurrencesIn(ICS, new Date("2026-11-22T00:00:00Z"), new Date("2026-12-31T00:00:00Z"));
      const byUid = (uid: string) => all.find((o) => o.key.startsWith(`${uid}|`));

      test("a weekly series gives its weeks without the deleted and the cancelled one, and a moved week keeps its original key", () => {
        const weekly = all.filter((o) => o.key.startsWith("weekly-standup@google.com|"));
        assert.deepEqual(
          weekly.map((o) => [o.key, o.start.toISOString(), o.title]),
          [
            ["weekly-standup@google.com|2026-11-23T03:00:00.000Z", "2026-11-23T03:00:00.000Z", "Weekly standup"],
            ["weekly-standup@google.com|2026-12-07T03:00:00.000Z", "2026-12-07T06:00:00.000Z", "Weekly standup (moved)"],
          ],
        );
      });

      test("organizer, invitees, and the Meet link are read and normalized; all-day events are left out", () => {
        const first = byUid("weekly-standup@google.com")!;
        assert.equal(first.organizer, "alice@planthia.test");
        assert.deepEqual(first.meet, { url: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij" });
        assert.deepEqual(recipientsOf(first, "bot@example.com"), ["alice@planthia.test", "bob@example.com"]);
        assert.deepEqual(byUid("desc-link@google.com")!.meet, { url: "https://meet.google.com/xyz-abcd-efg", code: "xyz-abcd-efg" });
        assert.equal(byUid("no-link@google.com")!.meet, undefined);
        assert.equal(byUid("stranger@google.com")!.organizer, "mallory@evil.test");
        assert.equal(byUid("all-day@google.com"), undefined);
      });

      test("invitees who declined get no minutes, but the organizer always does", () => {
        const weekly = byUid("weekly-standup@google.com")!;
        assert.ok(!weekly.attendees.includes("dan@example.com"), "dan declined");
        assert.deepEqual(recipientsOf(weekly, "bot@example.com"), ["alice@planthia.test", "bob@example.com"]);
        const desc = byUid("desc-link@google.com")!;
        assert.ok(!desc.attendees.includes("carol@planthia.test"), "the organizer declined as an attendee");
        assert.deepEqual(recipientsOf(desc, "bot@example.com"), ["carol@planthia.test"], "the organizer is still a recipient");
      });

      test("an occurrence is due from one minute before its start until 15 minutes after, but never after its end", () => {
        const start = Date.UTC(2026, 10, 23, 3, 0);
        const o: Occurrence = { key: "k", start: new Date(start), end: new Date(start + 60 * 60_000), attendees: [] };
        assert.equal(isDue(o, start - LEAD_MS - 1), false);
        assert.equal(isDue(o, start - LEAD_MS), true);
        assert.equal(isDue(o, start + LATE_MS), true);
        assert.equal(isDue(o, start + LATE_MS + 1), false);
        assert.equal(isDue({ ...o, end: new Date(start + 10 * 60_000) }, start + 11 * 60_000), false, "a 10-minute meeting is over");
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8 && npm ls node-ical` - Expected: typecheck exit 0; `# pass` is the root count before Task 12 plus 4, `# fail 0`; `node-ical@0.27.6`.
- [ ] Step 6: Commit - `git add package.json package-lock.json src/calendar/feed.ts src/calendar/fixture.ics src/calendar/feed.test.ts && git commit -m "feat(calendar): read due Meet occurrences from an iCal feed"`

---

### Task 13: Calendar poller: start each due occurrence at most once (gated on Task 0 GO)

**Files:**
- Create: `src/calendar/handled.ts`
- Create: `src/calendar/poller.ts`
- Create: `src/calendar/poller.test.ts`
- Modify: `src/index.ts` (anchors: imports; `await recoverUnfinished(client, "meet");` from Task 8; `const startMeet: StartMeet` from Task 11)

**Interfaces:**
- Consumes: `occurrencesIn`, `isDue`, `recipientsOf`, `LEAD_MS`, `LATE_MS`, `Occurrence` (Task 12); `MeetRefused` (Task 6); `StartMeet` (Task 7); `startMeet` in `src/index.ts` (Task 11); `sendEmail` (Task 2); `calendarRefusedMail` (Task 4, widened in Task 7b); `RefusalReason` (Task 7b); `isAllowed` (Task 2 of docs/plans/2026-11-21-engine-service-split.md).
- Produces: `startCalendarPoller(startMeet: StartMeet): void`; `pollCalendar(startMeet: StartMeet, now: number): Promise<void>`; `loadHandled(): Map<string, number>`; `saveHandled(handled: Map<string, number>, now: number): void`.

**Steps:**
- [ ] Step 1: Create `src/calendar/handled.ts`:
      ```ts
      import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { config } from "../config.js";

      /** Keys are kept this long after their occurrence started, far longer than an occurrence stays due. */
      const KEEP_MS = 7 * 24 * 60 * 60_000;
      const file = () => join(config().DATA_DIR, "calendar-handled.json");

      /** Calendar occurrences the bot already acted on (started, refused, or skipped), by key, with their start time. */
      export function loadHandled(): Map<string, number> {
        if (!existsSync(file())) return new Map();
        return new Map(Object.entries(JSON.parse(readFileSync(file(), "utf8")) as Record<string, number>));
      }

      export function saveHandled(handled: Map<string, number>, now: number): void {
        for (const [key, start] of handled) if (start < now - KEEP_MS) handled.delete(key);
        mkdirSync(config().DATA_DIR, { recursive: true });
        const tmp = `${file()}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(handled)));
        renameSync(tmp, file()); // atomic replace
      }
      ```
- [ ] Step 2: Create `src/calendar/poller.ts`:
      ```ts
      import { config } from "../config.js";
      import { calendarRefusedMail } from "../email/messages.js";
      import { sendEmail } from "../email/send.js";
      import { MeetRefused, type RefusalReason, type StartMeet } from "../meet/session.js";
      import { isAllowed } from "../util/email.js";
      import { logger } from "../util/log.js";
      import { isDue, LATE_MS, LEAD_MS, occurrencesIn, recipientsOf, type Occurrence } from "./feed.js";
      import { loadHandled, saveHandled } from "./handled.js";

      const log = logger("calendar");
      const POLL_MS = 60_000;
      let polling = false;

      /** Reads the bot account's calendar every minute and starts the Google Meet recordings that are due. */
      export function startCalendarPoller(startMeet: StartMeet): void {
        const run = () =>
          pollCalendar(startMeet, Date.now()).catch((err) => log.error(`calendar poll failed: ${(err as Error).message}`));
        void run();
        setInterval(run, POLL_MS);
        log.info("reading the bot calendar every minute");
      }

      /**
       * One poll; skipped while the previous one still runs. Every due occurrence is written down before anything
       * is tried, so it is started at most once, also across a crash or restart (a room or an organizer still busy with
       * an earlier recording is the one case that is tried again on later polls).
       */
      export async function pollCalendar(startMeet: StartMeet, now: number): Promise<void> {
        // A slow feed or recorder can make a poll outlast the 60 s tick; overlapping polls would each act on a due occurrence.
        if (polling) return;
        polling = true;
        try {
          await poll(startMeet, now);
        } finally {
          polling = false;
        }
      }

      async function poll(startMeet: StartMeet, now: number): Promise<void> {
        // The address is a secret: errors name the HTTP status only, never the address.
        const res = await fetch(config().CALENDAR_ICAL_URL!, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
        if (!res?.ok) throw new Error(`the calendar feed is unavailable${res ? ` (HTTP ${res.status})` : ""}`);
        const due = occurrencesIn(await res.text(), new Date(now - LATE_MS), new Date(now + LEAD_MS)).filter((o) => isDue(o, now));
        const handled = loadHandled();
        for (const o of due) {
          if (handled.has(o.key)) continue;
          handled.set(o.key, o.start.getTime());
          saveHandled(handled, now);
          const waitNotice = `${o.key}|waiting`;
          if (await startOccurrence(o, startMeet, !handled.has(waitNotice))) continue;
          // The Meet room, or the organizer's own recording slot, is still taken by an earlier meeting:
          // try again on later polls while this one is due, and tell its organizer only once.
          handled.delete(o.key);
          handled.set(waitNotice, o.start.getTime());
          saveHandled(handled, now);
        }
      }

      /** The organizer plus 20, like the web page (the organizer comes first in recipientsOf). */
      const MAX_CALENDAR_RECIPIENTS = 21;

      /**
       * Acts on one due occurrence; false when it should be tried again on the next poll: its Meet room is still recorded
       * for another meeting.
       */
      async function startOccurrence(o: Occurrence, startMeet: StartMeet, tellIfWaiting: boolean): Promise<boolean> {
        const c = config();
        if (!o.meet) {
          log.info(`calendar event ${o.key} has no Google Meet link, skipped`);
          return true;
        }
        // Only organizers on ALLOWED_EMAILS have the bot record their events.
        if (!o.organizer || !isAllowed(o.organizer, c.ALLOWED_EMAILS)) {
          log.warn(`calendar event ${o.key} skipped: organizer ${o.organizer ?? "unknown"} is not on ALLOWED_EMAILS`);
          return true;
        }
        const organizer = o.organizer;
        const title = o.title ?? `Google Meet ${o.meet.code}`;
        const tell = (reason: RefusalReason | "start_failed") =>
          sendEmail({ to: organizer, ...calendarRefusedMail({ title, code: o.meet!.code, reason }) }).catch((e) =>
            log.error(`could not email ${organizer} about calendar event ${o.key}`, e),
          );
        const recipients = recipientsOf(o, c.MEET_BOT_EMAIL!);
        if (recipients.length > MAX_CALENDAR_RECIPIENTS) {
          log.warn(`calendar event ${o.key}: ${recipients.length} recipients, only the first ${MAX_CALENDAR_RECIPIENTS} get the minutes`);
        }
        try {
          await startMeet({ ...o.meet, title, trigger: "calendar", startedBy: organizer, recipients: recipients.slice(0, MAX_CALENDAR_RECIPIENTS) });
          log.info(`calendar event ${o.key} started recording ${o.meet.code}`);
        } catch (err) {
          // A calendar recording runs until its room empties, so back-to-back meetings often wait for the earlier one.
          if (err instanceof MeetRefused && err.reason === "already_recording") {
            log.info(`calendar event ${o.key}: ${err.message}, will retry`);
            if (tellIfWaiting) await tell(err.reason);
            return false;
          }
          log.error(`calendar event ${o.key} could not start a recording`, err);
          // busy or a recorder error: told once, not retried.
          await tell(err instanceof MeetRefused ? err.reason : "start_failed");
        }
        return true;
      }
      ```
- [ ] Step 3: In `src/index.ts` import `startCalendarPoller` from `./calendar/poller.js`, and right after `await recoverUnfinished(client, "meet");` add:
      ```ts
      if (c.CALENDAR_ICAL_URL) startCalendarPoller(startMeet);
      ```
- [ ] Step 4: Create `src/calendar/poller.test.ts`:
      ```ts
      import { beforeEach, test } from "node:test";
      import assert from "node:assert/strict";
      import { readFileSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { dataDir, mockEmail, sentEmails } from "../test/setup.js";

      mockEmail();
      const { pollCalendar } = await import("./poller.js");
      const { MeetRefused } = await import("../meet/session.js");
      const { config } = await import("../config.js");

      const ICS = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
      const handledFile = join(dataDir, "calendar-handled.json");
      let feedStatus = 200;
      globalThis.fetch = (async (url: string) => {
        assert.equal(url, process.env.CALENDAR_ICAL_URL);
        return new Response(feedStatus === 200 ? ICS : "error", { status: feedStatus });
      }) as typeof fetch;

      let started: { code: string; title: string; trigger: string; startedBy: string; recipients: string[] }[] = [];
      let refuse: Error | undefined;
      const startMeet = async (meet: any) => {
        if (refuse) throw refuse;
        started.push({ code: meet.code, title: meet.title, trigger: meet.trigger, startedBy: meet.startedBy, recipients: meet.recipients });
        return {} as any;
      };
      const at = (iso: string) => Date.parse(iso);

      beforeEach(() => {
        started = [];
        refuse = undefined;
        feedStatus = 200;
        sentEmails.length = 0;
        rmSync(handledFile, { force: true });
      });

      test("from one minute before the start, occurrences of allowed organizers with a Meet link start once; strangers and events without a link do not", async () => {
        await pollCalendar(startMeet, at("2026-11-23T02:58:59Z"));
        assert.deepEqual(started, [], "too early");
        await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
        assert.deepEqual(
          started.sort((a, b) => a.code.localeCompare(b.code)),
          [
            { code: "abc-defg-hij", title: "Weekly standup", trigger: "calendar", startedBy: "alice@planthia.test", recipients: ["alice@planthia.test", "bob@example.com"] },
            { code: "xyz-abcd-efg", title: "Budget review", trigger: "calendar", startedBy: "carol@planthia.test", recipients: ["carol@planthia.test"] },
          ],
        );
        await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
        assert.equal(started.length, 2, "never twice");
        assert.equal(sentEmails.length, 0, "nobody is emailed about skipped events");
        assert.deepEqual(Object.keys(JSON.parse(readFileSync(handledFile, "utf8"))).sort(), [
          "desc-link@google.com|2026-11-23T03:00:00.000Z",
          "no-link@google.com|2026-11-23T03:00:00.000Z",
          "stranger@google.com|2026-11-23T03:00:00.000Z",
          "weekly-standup@google.com|2026-11-23T03:00:00.000Z",
        ]);
      });

      test("a deleted week and a cancelled week never start, and a moved week starts at its new time", async () => {
        for (const iso of ["2026-11-30T02:59:30Z", "2026-12-07T02:59:30Z", "2026-12-14T02:59:30Z"]) await pollCalendar(startMeet, at(iso));
        assert.deepEqual(started, []);
        await pollCalendar(startMeet, at("2026-12-07T05:59:30Z"));
        assert.deepEqual(started.map((s) => [s.code, s.title]), [["abc-defg-hij", "Weekly standup (moved)"]]);
        assert.ok("weekly-standup@google.com|2026-12-07T03:00:00.000Z" in JSON.parse(readFileSync(handledFile, "utf8")));
      });

      test("a bot that was down at the start still starts up to 15 minutes late, and not later", async () => {
        await pollCalendar(startMeet, at("2026-11-23T03:15:01Z"));
        assert.deepEqual(started, []);
        await pollCalendar(startMeet, at("2026-11-23T03:15:00Z"));
        assert.equal(started.length, 2);
      });

      test("when two recordings already run, each organizer is emailed once and nothing is retried", async () => {
        refuse = new MeetRefused("busy");
        await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
        await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
        assert.deepEqual(sentEmails.map((e) => [e.to, e.subject]).sort(), [
          ["alice@planthia.test", "ไม่ได้บันทึก Google Meet - Weekly standup"],
          ["carol@planthia.test", "ไม่ได้บันทึก Google Meet - Budget review"],
        ]);
      });

      test("a Meet room still recorded for an earlier meeting is retried, its organizer is told once, and a recorder error emails the organizer", async () => {
        refuse = new MeetRefused("already_recording");
        await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
        await pollCalendar(startMeet, at("2026-11-23T03:00:00Z"));
        assert.deepEqual(started, []);
        assert.deepEqual(sentEmails.map((e) => e.to).sort(), ["alice@planthia.test", "carol@planthia.test"], "each organizer told once");
        assert.match(sentEmails[0]!.text, /กำลังถูกบันทึกอยู่แล้ว/);
        refuse = undefined;
        await pollCalendar(startMeet, at("2026-11-23T03:01:00Z"));
        assert.equal(started.length, 2, "started once the room is free");
        started = [];
        sentEmails.length = 0;
        rmSync(handledFile, { force: true });
        refuse = new Error("starting the Google Meet recorder failed: HTTP 500");
        await pollCalendar(startMeet, at("2026-11-23T02:59:00Z"));
        assert.equal(sentEmails.length, 2);
        assert.match(sentEmails[0]!.text, /เปิดเครื่องบันทึกไม่สำเร็จ/);
      });

      test("a poll that starts while the previous one is still busy does nothing", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slow = async (meet: any) => {
          await gate;
          return startMeet(meet);
        };
        const first = pollCalendar(slow, at("2026-11-23T02:59:00Z"));
        await pollCalendar(slow, at("2026-11-23T03:00:00Z"));
        release();
        await first;
        assert.deepEqual(started.map((s) => s.code).sort(), ["abc-defg-hij", "xyz-abcd-efg"], "each occurrence once");
      });

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

      test("a feed error names the HTTP status but never the secret address", async () => {
        feedStatus = 500;
        await assert.rejects(pollCalendar(startMeet, at("2026-11-23T02:59:00Z")), (err: Error) => /HTTP 500/.test(err.message) && !err.message.includes("private-secret"));
        assert.deepEqual(started, []);
      });
      ```
- [ ] Step 5: Verify - Run: `npm run typecheck && npm test 2>&1 | tail -8` - Expected: typecheck exit 0; the root count before Task 13 plus 8, `# fail 0`.
- [ ] Step 6: Commit - `git add src/calendar/handled.ts src/calendar/poller.ts src/calendar/poller.test.ts src/index.ts && git commit -m "feat(calendar): start Meet recordings from calendar invitations"`

---

### Task 14: Documentation for the new triggers, email, and setup

**Files:**
- Modify: `README.md` (anchors: the `/record-meet url:<link>` row of `## Commands` ~L71; `## Google Meet recording` ~L88 through `### Operating it` ~L141; the Consent bullet under `## Things to know` ~L148)
- Modify: `AGENTS.md` (anchors: `` `/record-meet` records a Google Meet call instead`` ~L15; `## Architecture map` rows `src/meet/` and `src/recorder/active.ts`; `## Testing instructions` third bullet; `## Security considerations` last bullet; `## Deployment steps`; `## Gotchas` last bullet)
- Modify: `docker-compose.yml` (anchor: `# Bot Google account session for /record-meet`)

Every sentence on its own line, no em dash.
This task does not wait for Task 0: it documents the calendar trigger as planned (if Task 0 later says STOP, its gate step removes those sentences).

**Steps:**
- [ ] Step 1: `README.md`:
      - Delete the `/record-meet` row from `## Commands`, and add under the table: `Google Meet calls are recorded from the web page or a calendar invitation, not from Discord (see below).`
      - Replace the text of `## Google Meet recording` before `### Setup` with:
        ```markdown
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
        `SEED_ADMIN_EMAIL` becomes an active admin at every boot; admins open `<PUBLIC_BASE_URL>/meet/admin` to disable or enable accounts.
        Because signup is open, each person may run `MEET_MAX_ACTIVE_PER_USER` recordings at once (default 1) and start `MEET_MAX_DAILY_PER_USER` in 24 hours (default 5), web and calendar together; link requests and new accounts are rate limited.
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
        ```
      - In `### Setup` replace step 6 with `6. Run \`npm run register\` once after the deploy so Discord drops the old \`/record-meet\` command (in the container: \`docker compose exec meeting-bot node dist/register-commands.js\`).`, extend step 5 with `Also set \`SEED_ADMIN_EMAIL\` (your own address), \`MEET_BOT_EMAIL\`, \`RESEND_API_KEY\`, \`EMAIL_FROM\`, optionally the per-person limits, and optionally \`CALENDAR_ICAL_URL\` (see .env.example).`, and add:
        ```markdown
        7. Email goes out through Resend from a domain you verified there (for example `mail.example.com`).
           In Resend > API Keys create a key with "Sending access" restricted to that domain for `RESEND_API_KEY`, and set `EMAIL_FROM` to an address on it (for example `minutes@mail.example.com`).
        8. Calendar (optional): in the bot Google account set Google Calendar > Settings > Event settings > "Add invitations to my calendar" to "From everyone".
           Copy Settings for my calendars > Integrate calendar > "Secret address in iCal format" into `CALENDAR_ICAL_URL`.
           Treat that address like a password; if it leaks, reset it there and update `.env`.
        ```
      - In `### Operating it`: "When the session expires, the bot says so in Discord." becomes "When the session expires, the starter or organizer gets an email that says so."; "because the file is read on every `/record-meet`" becomes "because the file is read on every start"; and add the bullets:
        ````markdown
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
          A damaged file stops the bot at boot with `users.json is not valid JSON`.
        - Resend allows 10 API requests per second per team and has a monthly quota (and a daily one on the free plan); a log line `email to ... failed: HTTP 429 daily_quota_exceeded` (or `monthly_quota_exceeded`, `rate_limit_exceeded`) says why mails stopped, and Resend > Logs shows every send.
        ````
      - The Consent bullet under `## Things to know` becomes: `**Consent / PDPA:** for Discord the bot announces recording in the command channel and the voice channel chat; for Google Meet it posts a notice in the Meet chat. Decide a retention period and set an R2 lifecycle rule accordingly.`
- [ ] Step 2: `AGENTS.md`:
      - Replace the `/record-meet` paragraph in `## Project overview` with:
        ```markdown
        Google Meet calls are recorded without Discord: anyone who signs up starts one on the `/meet` web page (magic-link login, open signup), or invites the bot Google account to a calendar event, which the bot finds by reading its secret iCal feed every minute.
        The recorder runs on Cloudflare Containers (`meet/`), uploads 5-minute FLAC segments to R2 through its Durable Object, and the bot polls it and feeds the same pipeline with one mixed pseudo-participant `meet`; the minutes and failure notices go out by email (Resend REST API, one email per recipient).
        Meet recording is optional and stays off unless `MEET_RECORDER_URL` and `MEET_RECORDER_TOKEN` are both set.
        ```
      - `## Architecture map`: the `src/meet/` row becomes `Google Meet side of the bot: MeetSession (poll, email notices, manifest, activeMeets and per-person limits), recorder client, VAD, link parsing, shared protocol.ts`; delete the `src/recorder/active.ts` row; the `src/web/` row becomes `Hono playback server, PIN flow, signed cookies, /meet magic-link login with open signup, recorder page, and admin page (meet-routes.ts), Thai HTML templates`; add rows `` | `src/calendar/` | Secret iCal feed reader (node-ical), due-occurrence rules, handled-occurrence store, poller | `` `` | `src/email/` | Resend client (send.ts, the only email I/O) and Thai email builders (messages.ts) | ``, and `` | `src/users/` | User store: `DATA_DIR/users.json`, atomic writes, the bot is its only writer (store.ts) | ``; the `src/test/setup.ts` row gains `, fake email sender (mockEmail, sentEmails), fake meet recorder`.
      - `## Testing instructions`: the third bullet gains `, a fake email sender (\`mockEmail()\`, \`sentEmails\`), and a scripted meet-recorder Worker (\`fakeMeetRecorder()\`)`; add `- Call \`mockEmail()\` before dynamically importing any module that sends email; no test may send real email.`
      - `## Security considerations`: the last bullet becomes `- A Meet recording is announced in the Meet chat (Thai/English notice); if the notice fails, the starter is emailed to tell the participants. Keep both.`; add:
        ```markdown
        - Signup is open: anyone who confirms a login link gets an account in `DATA_DIR/users.json`, and only active accounts can use `/meet` or have a calendar event recorded as its organizer; the account is re-checked on every request.
        - Open signup means anyone can make the bot join a Meet call at about $0.08 per recording hour: keep `MAX_MEET_RECORDINGS` (2), the per-person limits (`MEET_MAX_ACTIVE_PER_USER`, `MEET_MAX_DAILY_PER_USER`), the signup and login-email limits, and the admin page's disable button.
        - Login links are 32 random bytes, single use, 15 minutes, kept in memory; `/meet/login` answers the same for new, existing, and disabled addresses (no user enumeration) and is rate limited per IP and per email, and links to new addresses are capped per day in total (existing accounts are never capped).
        - `SEED_ADMIN_EMAIL` and every other real address live only in `.env`; the repo is public, so code, tests, and docs use placeholders.
        - The `/meet` cookie is HMAC-signed over `user:<email>` with `SESSION_SECRET`, `HttpOnly`, `SameSite=Lax`, 12 h; `hono/csrf` on `/meet/*` refuses form posts from other sites. Keep both.
        - `CALENDAR_ICAL_URL` and `RESEND_API_KEY` are secrets: never log them or put them in error messages.
        - Resend keeps the sent emails, including the minutes PIN and the login links: limit who has access to the Resend team, and keep open and click tracking off for the sending domain (click tracking would rewrite the login and playback links through Resend).
        ```
      - `## Deployment steps`: add `- After this change, run the register command once so Discord drops the removed \`/record-meet\` command.`
      - `## Gotchas`: replace the last bullet with:
        ```markdown
        - A stop on the web page returns at once, but the minutes arrive only after the recorder reports the end (up to about a minute later).
        - One Discord recording per server and one Google Meet recording per Meet call, at most 2 Meet recordings in total (`MAX_MEET_RECORDINGS`, the Worker's `max_instances`); a start right after a recording ended can still fail for up to 30 s while the old container shuts down.
        - Google's secret iCal feed is not instant; an invitation made shortly before the meeting may be missed (start it on the web page instead).
        - A recording covers whatever happens in its Meet room until it ends; a calendar event whose room, or whose organizer's own recording slot, is still taken is retried for 15 minutes and its organizer is told once.
        - `users.json` is written only by the running bot (`src/users/store.ts`); do not add a second writer (a CLI, a cron job) without moving the store to something with real locking.
        - Each person may run `MEET_MAX_ACTIVE_PER_USER` recordings and start `MEET_MAX_DAILY_PER_USER` per 24 hours; the 24-hour start times live in `users.json`, so a restart does not reset them.
        ```
- [ ] Step 3: `docker-compose.yml`: the comment becomes `# Bot Google account session for Google Meet recordings (MEET_AUTH_STATE_FILE=/run/secrets/meet/meet-auth.json).`
- [ ] Step 4: Verify - Run: `grep -rn "record-meet" README.md AGENTS.md docker-compose.yml .env.example src; node -e 'for (const f of ["README.md", "AGENTS.md"]) console.log(f, (require("fs").readFileSync(f, "utf8").match(/\u2014/g) ?? []).length)'` - Expected: the grep prints only the README `### Setup` step 6 and the AGENTS.md deployment bullet (both about dropping the old command); the node line prints `README.md 0` and `AGENTS.md 0` (no em dash).
      Then run `grep -rn "ALLOWED_EMAILS\|allowlist" README.md AGENTS.md docker-compose.yml .env.example src; grep -rnoE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" README.md AGENTS.md docker-compose.yml .env.example src | grep -vE "@([a-z0-9-]+\.)*(example\.com|google\.com|[a-z0-9-]+\.test)$"` - Expected: both print nothing (no allowlist left, no real address in the public repo).
- [ ] Step 5: Commit - `git add README.md AGENTS.md docker-compose.yml && git commit -m "docs: document Meet recording by web page, calendar, and email"`

---

### Task 15: Redeploy the recorder image with the new waiting rule

The container change from Task 3 only takes effect after this; the Worker code is unchanged.
This needs a Cloudflare login and podman, so it follows README `### Deploy from podman`.

**Files:**
- Scratch, gitignored: `meet/wrangler.deploy.jsonc` (its `image` changes to the new tag)

**Rollback:** redeploy the previous image: put the previous tag (recorded in Step 1) back into `meet/wrangler.deploy.jsonc` and run `npx wrangler deploy -c wrangler.deploy.jsonc` in `meet/`.

**Steps:**
- [ ] Step 1: Verify - Manual: in `meet/`, `npx wrangler whoami | head -5` shows a logged-in account (if not, 👤 the user runs `npx wrangler login`), `podman info >/dev/null && echo up` prints `up`, and `grep '"image"' wrangler.deploy.jsonc` prints the currently deployed tag - Expected: logged in, `up`, and a `registry.cloudflare.com/.../everymeet-meet-recorder:<old tag>` line; write the old tag into this step as a `> Deviation:` note for the rollback.
- [ ] Step 2: Run, in `meet/`: `npm run build:bot && TAG=$(git rev-parse --short HEAD) && podman build --platform linux/amd64 -t everymeet-meet-recorder:$TAG . && WRANGLER_DOCKER_BIN=podman npx wrangler containers push everymeet-meet-recorder:$TAG` - Expected: the push prints `registry.cloudflare.com/<account-id>/everymeet-meet-recorder:<TAG>`.
- [ ] Step 3: Put that tag into `image` of `meet/wrangler.deploy.jsonc` and run `npx wrangler deploy -c wrangler.deploy.jsonc` - Expected: the deploy succeeds and lists the container application with the new image.
- [ ] Step 4: Verify - Manual: `node --env-file=../.env -e 'fetch(process.env.MEET_RECORDER_URL + "/recordings/doesnotexist123", { headers: { Authorization: "Bearer " + process.env.MEET_RECORDER_TOKEN } }).then((r) => console.log(r.status))'` - Expected: `404` (the Worker answers and accepts the token); the new rule itself is checked in End-to-end Scenario B.
- [ ] Step 5: No commit (only the gitignored deploy file changed).

## Failure handling summary

- **The iCal feed lacks the organizer or the Meet link, or is slow** - Detect: Task 0 Step 5 or Step 6. Respond: follow the Task 0 gate (STOP and ask); build and ship the web trigger (Tasks 1-11b, 14 without calendar sentences, 15) either way.
- **Resend refuses email** - Detect: Task 0 Step 8 or a log line `email to ... failed: HTTP 400|401|403 <name>: ...` (bad or deleted key, key restricted to another domain, `mail.example.com` not verified) or `HTTP 429 daily_quota_exceeded|monthly_quota_exceeded|rate_limit_exceeded`. Respond: STOP the live checks, report the name and message to the user, do not switch providers or add an SDK or SMTP without asking; unit tests are unaffected (fake sender).
- **Mail lands in spam** - Detect: 👤 the user finds the Task 0 test mail or a login mail in spam. Respond: ask the user to check in Resend > Domains that `mail.example.com` shows its SPF and DKIM records as verified and that a DMARC record exists for it; do not change the code.
- **`wrangler containers push` or rollout fails on podman** - Detect: `--provenance` errors or `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`. Respond: use the registry-tag procedure exactly as in README `### Deploy from podman`; if the image did not change, `npx wrangler deploy -c wrangler.deploy.jsonc --containers-rollout=none` deploys the Worker only.
- **A start right after another recording ended fails with "container start failed"** - Detect: the starter gets the "สูงสุด 2 ห้อง" email while only one recording shows on the page. Respond: expected for up to 30 s while the old container shuts down (`DESTROY_AFTER_END_MS`); not a bug, do not raise the limit.
- **`users.json` is damaged** - Detect: the bot stops at boot with `<path> is not valid JSON: restore it from a backup before starting the bot`. Respond: do not delete the file (that would drop every account and the admin flag); ask the user to restore it from a volume backup, or, with their agreement, move it aside so the seeded admin is recreated and everyone else signs up again.
- **Someone abuses open signup** (many accounts, both recording slots kept busy, many login emails) - Detect: the bot log (`signed in ... (new account)`, `login link not sent ...: 50 links to new addresses`, refusals) and the admin page. Respond: disable the accounts on the admin page and report to the user; raising or lowering limits and admin approval are the user's call (Open questions 1 and 2), do not change them without asking.
- **A second Discord client on the same bot token during E2E** - Detect: every slash command is answered twice or fails with "already acknowledged". Respond: stop and ask the user which process to stop; never stop the production VPS bot without asking.

## End-to-end verification

Run after Tasks 0-15.
The bot runs locally with `npm run dev` against the deployed recorder Worker and real email; the Meet test room is `https://meet.google.com/abc-defg-hij` (free to use at any time).

Prerequisites:
- [ ] Run: `npm run typecheck && npm test 2>&1 | tail -8 && (cd meet && npm run typecheck && npm test 2>&1 | tail -8)` - Expected: both typechecks exit 0; root `# pass 118`, `# fail 0` (106 + 4 + 8); meet `# pass 20`, `# fail 0` (root `# pass 106` if Tasks 12-13 were skipped).
- [ ] Manual: `for k in MEET_RECORDER_URL MEET_RECORDER_TOKEN MEET_AUTH_STATE_FILE SEED_ADMIN_EMAIL MEET_BOT_EMAIL CALENDAR_ICAL_URL RESEND_API_KEY EMAIL_FROM PUBLIC_BASE_URL; do grep -q "^$k=." .env && echo "$k set" || echo "$k MISSING"; done` - Expected: every key `set` (prints names only, never values).
- [ ] 👤 Human: confirm that the Discord bot token in `.env` is not running anywhere else right now, that `PUBLIC_BASE_URL` in `.env` is an address your browser reaches for this run (for a local run `http://localhost:8787`), and that `SEED_ADMIN_EMAIL` in `.env` is your own address - Expected: a yes for each - Proxy: none needed (confirmations, not product checks).
- [ ] Manual: `npm run build && npm run register` - Expected: `Registered 2 commands` (the old `/record-meet` is gone).
- [ ] Manual: start `npm run dev` (keep its log) and, in `meet/`, `npx wrangler tail everymeet-meet-recorder --format json` - Expected: the bot logs `playback page listening on :8787`, `reading the bot calendar every minute`, and `logged in as`.

Scenario A - web page start and stop, minutes by email:
- [ ] 👤 Human: open `<PUBLIC_BASE_URL>/meet`, enter your own address (the `SEED_ADMIN_EMAIL` one), open the "ลิงก์เข้าสู่ระบบบันทึก Google Meet" email, press "เข้าสู่ระบบ" on the email, then on the confirm page - Expected: the email arrives in the inbox (not spam) within 2 minutes; the recorder page shows "เข้าสู่ระบบเป็น <your address>"; all three pages look like the PIN page (same card, font, button, dark mode) with no clipped Thai text - Proxy: `src/web/meet-routes.test.ts` "anyone gets a single-use link..." and `src/web/templates.test.ts`.
- [ ] 👤 Human: paste `https://meet.google.com/abc-defg-hij`, put a second address you control in the extra emails, press เริ่มบันทึก, then press "รีเฟรชสถานะ" now and then; join the Meet from another device and admit the bot if asked; check the Meet chat shows the Thai/English recording notice; read Thai text aloud for about 3 minutes; press หยุดบันทึก - Expected: the list shows "Google Meet abc-defg-hij · กำลังเปิดเครื่องบันทึก · จากหน้าเว็บ", later "กำลังบันทึก", and after stop "กำลังหยุด"; the bot leaves the call within about 20 s; within about 5 minutes both addresses get "สรุปการประชุม - Google Meet abc-defg-hij" with a Thai summary, a "ฟังเสียงบันทึกการประชุม" button and a PIN; the link with the PIN plays the audio and the page eyebrow says "Google Meet" - Proxy: `meet-routes.test.ts` "a signed-in person starts a recording..." and `run.test.ts` "a Google Meet recording stored only in R2...".
- [ ] Manual: from the bot log take the id in `recording Google Meet abc-defg-hij as <id> (web, started by ...)`; the log has `<id>: minutes emailed to 2 of 2`; the tail shows `stop requested`, `ended` with `reason: "stopped"`, then `destroy`; `npx wrangler r2 object get meeting-recordings/meetings/<id>/manifest.json --remote --pipe | jq '{status, trigger: .meet.trigger, recipients: (.meet.recipients | length), endReason, guildId}'` - Expected: `"status": "done"`, `"trigger": "web"`, `"recipients": 2`, `endReason` starting with `หยุดโดย`, `"guildId": null`.

Scenario A2 - signup by email and the admin page:
- [ ] 👤 Human: in a private browser window open `<PUBLIC_BASE_URL>/meet`, enter a second address you control that has never signed in, and confirm the emailed link - Expected: the "ตรวจอีเมลของคุณ" page looks exactly like the one for your own address; the login email arrives; after confirming, the recorder page shows "เข้าสู่ระบบเป็น <second address>" and no "จัดการผู้ใช้" link - Proxy: `meet-routes.test.ts` "anyone gets a single-use link..." and "new, existing, and disabled addresses get the same answer...".
- [ ] 👤 Human: in the first window (signed in as the seeded admin) press "จัดการผู้ใช้", find the second address, press "ปิดการใช้งาน", then reload the private window - Expected: the admin page lists both accounts with Bangkok times and has no button on your own row; after disabling, the private window shows the login form again; asking for a new link there shows the same "ตรวจอีเมลของคุณ" page but no email arrives; pressing "เปิดการใช้งาน" restores access after a new login - Proxy: `meet-routes.test.ts` admin tests.
- [ ] Manual: `node --env-file=.env -e 'const u=JSON.parse(require("fs").readFileSync((process.env.DATA_DIR||"data")+"/users.json","utf8")).users;console.log(u.length, u.filter((x)=>x.isAdmin).length, u.map((x)=>x.status).join(","))'` - Expected: `2 1 active,active` (prints counts and states only, no addresses).

Scenario B - calendar invitation, a late organizer, and a bot restart (skip if Tasks 12-13 were skipped):
- [ ] 👤 Human: from an account whose address has an active account (for example the seeded admin) create an event titled `everymeet e2e calendar` starting at least (the Task 0 feed delay + 3 minutes) from now, with "Add Google Meet video conferencing", inviting the bot account and a second address you control; join the call only 5 minutes after the start - Expected: from about one minute before the start the bot is in the call (or in the lobby, if Meet makes invited guests ask to join) and it is still there when you join 5 minutes after the start; admit it if asked; its notice is in the chat once it is in - Proxy: `src/calendar/poller.test.ts` "from one minute before the start..." and `meet/bot/rules.test.ts` "before anyone else has joined...".
- [ ] Manual: the bot log shows `calendar event <key> started recording <code>` once; the tail shows `waiting` or `recording` with heartbeats of `participants: 1` until the user joins, then `2`, and no `ended` in between.
- [ ] Manual: about 2 minutes after the user joined, stop `npm run dev` with Ctrl-C and start it again within 30 s - Expected: the log shows `re-attached to Google Meet recording <id>` and no second `calendar event ... started` line for that key; `cat data/calendar-handled.json` (or `$DATA_DIR`) contains the key.
- [ ] 👤 Human: talk for about 2 more minutes, then everyone leaves - Expected: about 3 minutes later the bot leaves; the organizer and the second address get the minutes email titled "สรุปการประชุม - everymeet e2e calendar"; the bot account's inbox gets no minutes email - Proxy: `poller.test.ts` recipient assertions and `run.test.ts` email assertions.
- [ ] Manual: the manifest of that id has `"trigger": "calendar"`, `startedBy` = the organizer, 2 recipients, and `endReason` = `ไม่มีผู้เข้าร่วมคนอื่นอยู่ในห้องแล้ว`.
- [ ] 👤 Human: create a second event starting a few minutes after the feed delay, with no video conferencing and `https://meet.google.com/abc-defg-hij` in its description, inviting the bot; once the bot is in, sign in on `/meet` as the organizer - Expected: the bot joins the test room; the page lists it as "... · จากปฏิทิน" and pressing หยุดบันทึก stops it - Proxy: `feed.test.ts` "a link pasted in the description" and `meet-routes.test.ts` stop test.
- [ ] 👤 Human: from a Google account whose address is not on `ALLOWED_EMAILS`, invite the bot to an event with Meet starting a few minutes after the feed delay - Expected: the bot never joins and that account gets no email - Proxy: `poller.test.ts` (stranger skipped, nobody emailed); Manual: the bot log shows `skipped: organizer <address> is not on ALLOWED_EMAILS`.

Cleanup:
- [ ] Manual: the tail shows a `destroy` line for every recording started above, and for each id `node --env-file=.env -e 'fetch(process.env.MEET_RECORDER_URL + "/recordings/" + process.argv[1], { headers: { Authorization: "Bearer " + process.env.MEET_RECORDER_TOKEN } }).then((r) => r.json()).then((s) => console.log(s.state))' <id>` prints `ended` - Expected: no recording left in another state (no container left running).

## Confidence derivation

Start at 10 and subtract per the writing-plans rubric, counted in this file:
- Consumes entries without a full signature: 0 (single track; every consumed name is produced with its full signature in an earlier task's Interfaces).
- Patterns-to-Mirror SOURCEs not verified against the real file: 0 (all were read at 478fc65; the node-ical names were checked in its published `.d.ts`).
- Verify - Human with no paired proxy: 0 (the End-to-end confirmations and the Task 15 login are confirmations, not product checks).
- NOT-building entries that cut a requirement on an unproven codebase claim: 0 ("Worker unchanged" rests on `meet/worker/http.ts:62-63` and `meet/worker/core.ts:51`).
- Tasks touching a shared or inferred type without consumers listed: 0 (`Config` in Tasks 1 and 4b, `User` and `users()` in Task 4c, `MeetRefused` in Task 7b, `Manifest` in Task 7, the registries in Task 6 list theirs).
- Preflight checks written but never run: 0 (live checks were moved into Task 0, Task 15, and End-to-end because reading `.env` and authenticated calls were not allowed while planning).
- Parallel tracks below the cost floor: 0 (one track).
- Judgement: -2 because what Google's secret feed of a personal account contains and how fast it updates is known only from third-party samples, so Tasks 12-13 may be stopped or reshaped by Task 0; -1 because the user's Resend key and plan quota are first exercised in Task 0 Step 8.
The user-database revision adds no deduction: the store reuses the repo's atomic-write pattern, its reference code was written against the current `src/config.ts` and `src/test/setup.ts` (read at 29a9203), and the pass counts were rebased on a measured baseline (59 root, 20 meet).
Result: 7/10.
