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
  assert.deepEqual(byUid("desc-link@google.com")!.meet, { url: "https://meet.google.com/pqr-stuv-wxy", code: "pqr-stuv-wxy" });
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
