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
