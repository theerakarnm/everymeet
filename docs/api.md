# everymeet engine HTTP API (v1)

The HTTP API lets another program record Google Meet calls with this engine and get the minutes back.
Its base path is `/api/v1` on `PUBLIC_BASE_URL`, for example `https://meet.example.com/api/v1`.
Requests and responses are JSON, and every message in them is English.
Times are ISO 8601 in UTC, for example `2026-11-21T03:00:00.000Z`.
The API exists only when `API_KEYS` is set; without it every `/api/v1` path answers like any unknown page.
It serves Google Meet recordings only: Discord `/record` has no API.

## Authentication

Every request sends `Authorization: Bearer <key>`.
`API_KEYS` lists the keys as `name:key` pairs, comma separated, for example `service:<key-1>,ops:<key-2>`.
A name is 1 to 32 of `a-z`, `0-9`, and `-`; a key is at least 32 of `A-Z a-z 0-9 _ -`, and each key may appear only once.
To rotate a key without downtime, list the same name twice with the old and the new key, move the caller to the new key, then remove the old one.
The name is the client, and the client is the tenant boundary: a client sees and stops only the recordings it started.
A recording of another client, a Discord recording, or a recording started on the `/meet` page or by the calendar answers 404 `not_found`, never 403.
A missing or unknown key answers 401 `unauthorized` with a `WWW-Authenticate: Bearer realm="everymeet"` header.
After 30 requests without a valid key from one IP address in a minute, the next ones answer 429 `rate_limited` with `Retry-After: 60`.

## Rate limits

Each client may send `API_RATE_LIMIT_PER_MIN` requests per minute (default 120).
The window is fixed: it starts with the first request and lasts one minute.
A request over the limit answers 429 `rate_limited` with `Retry-After: 60`.
A request body larger than 16 KB answers 413 `body_too_large`.

## Errors

Every error has this shape:

```json
{ "error": { "code": "invalid_meet_url", "message": "meetUrl is not a Google Meet link like https://meet.google.com/abc-defg-hij." } }
```

Programs act on `code`; `message` is for people and may change.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The body or a query parameter does not match this document; the message names the fields. |
| `invalid_meet_url` | 400 | `meetUrl` is not a Google Meet link. |
| `webhook_url_not_allowed` | 400 | `webhookUrl` is not https (http only on localhost) or not on an allowed origin. |
| `webhook_url_required` | 400 | Delivery mode `webhook` without `webhookUrl` and without a configured `WEBHOOK_URL`. |
| `unauthorized` | 401 | The API key is missing or unknown. |
| `not_found` | 404 | No such recording for this API key, or no such endpoint. |
| `already_recording` | 409 | This Meet call is already being recorded; `error.recordingId` is set only for the client that runs it. |
| `not_recording` | 409 | Stop was asked for a recording that has already ended. |
| `not_ready` | 409 | A PIN was asked before the minutes are ready. |
| `body_too_large` | 413 | The request body is larger than 16 KB. |
| `email_not_configured` | 422 | Delivery mode `email`, but this engine has no email sender (`RESEND_API_KEY`, `EMAIL_FROM`). |
| `rate_limited` | 429 | Too many requests; see `Retry-After`. |
| `internal_error` | 500 | Something went wrong in the engine; try again. |
| `busy` | 503 | The engine already runs its maximum of Google Meet recordings; `Retry-After: 60`. |
| `recorder_unavailable` | 503 | The recorder could not be started or reached; try again. |

The 409 `already_recording` tells any client that the Meet code is being recorded by someone.
This is inherent in the rule of one recording per Meet code; only the client that runs the recording learns its id.

## The Recording object

Every answer about a recording and every webhook body carries the same Recording object.
Fields without a value are left out.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | The recording id, 16 characters of `A-Z a-z 0-9 _ -`. |
| `client` | string | The API client name that started it. |
| `ownerId` | string | The owner given at the start. |
| `metadata` | object | The string pairs given at the start, returned unchanged. |
| `state` | string | Where the recording is; see below. |
| `stopping` | boolean | True once someone asked the recorder to stop and it has not reported the end yet. |
| `meetCode` | string | The Meet code, for example `abc-defg-hij`. |
| `title` | string | The title given at the start, or `Google Meet <code>`. |
| `delivery` | string | `email` or `webhook`; see Delivery modes. |
| `startedAt` | string | When the start was asked; once audio capture began, when capture started. |
| `endedAt` | string | When the recording ended. |
| `endCode` | string | Why it ended, for programs; see below. |
| `endReason` | string | Why it ended, as Thai text for people. |
| `durationSeconds` | number | Length of the recorded audio, once it ended with audio. |
| `playbackUrl` | string | The PIN-protected playback page, once `state` is `done`. |
| `summaryShort` | string | The short Thai summary in Markdown, in `GET /recordings/{id}` and `minutes.ready` once `done`. |
| `error` | string | What went wrong, once `state` is `failed`. |

`state` moves forward in this order: `starting`, `joining`, `waiting`, `recording`, `processing`, then `done` or `failed`.
`starting` means the recorder is starting, `joining` that the bot is joining the call, `waiting` that it waits to be let in or for someone to join, and `recording` that audio is being captured.
`processing` means the call ended and the transcript and summary are being made.
A recording can go to `failed` from any state, for example when the bot was never let in.

`endCode` is one of `stopped`, `alone`, `removed`, `meeting_ended`, `max_duration`, `not_admitted`, `denied`, `auth_expired`, `join_failed`, `container_lost`, `crashed` (the recorder's end reasons in `src/meet/protocol.ts`), or `recorder_lost` when the engine lost track of the recorder.
`stopped` covers a stop over the API and on the `/meet` page.
`endReason` is free Thai text for people; for an email-mode recording stopped on the `/meet` page it names the address that pressed stop.

A Recording never includes the PIN, the transcript, the full summary, links to the audio, or the recipient addresses.

## POST /recordings

Starts a recording: the bot joins the Meet call and records it until it ends or is stopped.

| Field | Required | Meaning |
| --- | --- | --- |
| `meetUrl` | yes | The Google Meet link, for example `https://meet.google.com/abc-defg-hij`. |
| `title` | no | 1 to 200 characters; default `Google Meet <code>`. |
| `ownerId` | yes | Who the recording belongs to in the calling program: 1 to 128 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. |
| `metadata` | no | Up to 20 string pairs, keys up to 40 and values up to 500 characters; returned unchanged in every Recording. Do not put personal data in it. |
| `delivery` | yes | `{ "mode": "email", "starter": "<email>", "recipients": ["<email>"] }` or `{ "mode": "webhook" }`; see Delivery modes. |
| `webhookUrl` | no | Where this recording's webhooks go. |

`recipients` holds up to 50 addresses; the starter always gets the minutes too.
Without `webhookUrl` the webhooks go to `WEBHOOK_URL`, if set.
A `webhookUrl` must be https (plain http only on `localhost`, `127.0.0.1`, or `[::1]`) and its origin must be the origin of `WEBHOOK_URL` or one listed in `WEBHOOK_ALLOWED_ORIGINS`.
Unknown fields are refused with `invalid_request`.

Request:

```http
POST /api/v1/recordings
Authorization: Bearer <key>
Content-Type: application/json

{
  "meetUrl": "https://meet.google.com/abc-defg-hij",
  "title": "Weekly sync",
  "ownerId": "team-1",
  "metadata": { "plan": "pro" },
  "delivery": { "mode": "email", "starter": "ann@example.com", "recipients": ["bob@example.com"] }
}
```

Response `201 Created` with `Location: /api/v1/recordings/q3Vx8mZ0aB1cD2eF`:

```json
{
  "id": "q3Vx8mZ0aB1cD2eF",
  "client": "service",
  "ownerId": "team-1",
  "metadata": { "plan": "pro" },
  "state": "starting",
  "stopping": false,
  "meetCode": "abc-defg-hij",
  "title": "Weekly sync",
  "delivery": "email",
  "startedAt": "2026-11-21T03:00:00.000Z"
}
```

The engine records one call per Meet code and at most 2 calls at once.
Both limits count every recording, including those started on the `/meet` page and by the calendar.
A second start for the same code answers 409 `already_recording`; a start over the limit answers 503 `busy`.

## GET /recordings/{id}

Answers `200` with the Recording.
Once `state` is `done` it includes `summaryShort`.
Poll it for live state: there is no webhook for the start or for progress.

## POST /recordings/{id}/stop

Asks the bot to leave the call and answers `202 Accepted` with the Recording, whose `stopping` is `true`.
Processing starts when the recorder reports the end, which can take up to about a minute.
A recording that already ended answers 409 `not_recording`.
If the recorder cannot be reached the answer is 503 `recorder_unavailable`; the recorder still stops by itself when the call empties or reaches its time limit.

## GET /recordings?ownerId=&limit=&cursor=

Lists the recordings of one owner, newest first.
`ownerId` is required and follows the same pattern as in `POST /recordings`.
`limit` is 1 to 50 (default 50).
The answer is `{ "items": [Recording, ...], "nextCursor": "<cursor>" }`; pass `nextCursor` as `cursor` for the next page, and when it is missing there are no more pages.
A recording whose entry in the owner list could not be written at the start is still reachable by id but missing here.

## POST /recordings/{id}/pin

Makes a new PIN for the playback page and answers `200 { "pin": "123456", "playbackUrl": "https://meet.example.com/m/<id>" }`.
It works only once `state` is `done`; before that it answers 409 `not_ready`.
The engine stores only a hash of the PIN, so the PIN is shown only in this answer.
Every call makes a new PIN and voids the previous one, including the PIN emailed in email mode.
Store the PIN, or call once per delivery.

## Webhooks

Recordings started over the API report what happened by webhook when a webhook URL resolved at the start.

| Type | When |
| --- | --- |
| `recording.notice_failed` | The bot could not post the recording notice in the Meet chat. The caller MUST tell the participants that the call is recorded. |
| `recording.ended` | Audio capture ended and processing starts. |
| `recording.failed` | Nothing was recorded, or processing failed; `data.error` says why. |
| `minutes.ready` | The minutes are ready; `data.summaryShort` holds the short summary. |

Each delivery is a `POST` with this body:

```json
{ "type": "minutes.ready", "timestamp": "2026-11-21T04:05:00.000Z", "data": { "id": "q3Vx8mZ0aB1cD2eF", "state": "done" } }
```

`data` is the full Recording object (shortened above).
Webhooks follow [Standard Webhooks](https://www.standardwebhooks.com/) and carry three headers:

- `webhook-id`: the message id, the same on every retry of one event.
- `webhook-timestamp`: the attempt's time in Unix seconds.
- `webhook-signature`: `v1,` and the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the base64-decoded part of `WEBHOOK_SECRET` after `whsec_`.

Verify the signature over the raw body before parsing it, and refuse a timestamp more than 5 minutes from your clock.
In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(secret, h, body, nowSec) {
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key).update(`${h.id}.${ts}.${body}`).digest("base64");
  const expected = Buffer.from(`v1,${mac}`);
  return h.signature.split(" ").some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
// verifyWebhook(process.env.WEBHOOK_SECRET, { id: req.headers["webhook-id"], timestamp: req.headers["webhook-timestamp"],
//   signature: req.headers["webhook-signature"] }, rawBody, Math.floor(Date.now() / 1000))
```

Answer with any 2xx status within 10 seconds.
Any other status, a timeout, or a network error is retried after 30 s, 2 min, 10 min, 1 h, 3 h, 6 h, and 12 h.
After the last attempt the event moves to `DATA_DIR/webhooks/failed/` on the engine, where its operator can look at it.
Redirects are not followed.
Events go out within about 15 seconds.

Delivery is at least once and unordered: dedupe deliveries by `webhook-id`, and trust `data.state` over the order of arrival.
When processing is retried after an engine restart, `minutes.ready` can arrive again with a new `webhook-id`, so dedupe side effects such as customer emails on `data.id` plus `type`.

## Delivery modes

- `email`: the engine emails the starter and the recipients as for a start on the `/meet` page: the minutes with the playback link and PIN, and the problems (the bot was not let in, the notice failed, the recorder failed) to the starter.
  It also sends webhooks when a webhook URL resolved.
- `webhook`: the engine sends no email at all; the calling program tells its users.

Recordings started on the `/meet` page or by the calendar never send webhooks.

## Using the API from another program

Talk to the engine over HTTP only.
Do not import engine modules or copy engine code into a closed program, so the AGPL does not extend to it (see "License" in the README).
