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
 * is tried, so it is started at most once, also across a crash or restart (a Meet room still recorded for an
 * earlier meeting is the one case that is tried again on later polls).
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
    // The Meet room is still recorded for an earlier meeting:
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
