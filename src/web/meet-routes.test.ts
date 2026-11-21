import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeMeetRecorder, mockEmail, mockR2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
const worker = fakeMeetRecorder();
process.env.TRUST_PROXY = "true"; // as behind Nginx; the tests send X-Forwarded-For
const { createApp } = await import("./server.js");
const { MeetSession, activeMeets } = await import("../meet/session.js");
const { config } = await import("../config.js");

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

/** Requests a link, takes it from the fake inbox, confirms it, and returns the cookie header value. */
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

test("an allowed address gets a single-use link by email, the link only asks to confirm, and confirming signs in", async () => {
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

  const opened = await get(`/meet/auth?t=${token}`);
  assert.match(await opened.text(), new RegExp(`name="t" value="${token}"`));
  assert.equal(opened.headers.get("set-cookie"), null, "opening the link signs nobody in");

  const confirmed = await post("/meet/auth", { t: token });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get("location"), "/meet");
  const cookie = confirmed.headers.get("set-cookie")!;
  for (const part of [/^mu=/, /HttpOnly/i, /Secure/i, /Path=\/meet/, /SameSite=Lax/i]) assert.match(cookie, part);
  assert.equal((await post("/meet/auth", { t: token })).status, 400, "the link works once");

  const signedIn = await get("/meet", cookie.split(";")[0]);
  assert.match(await signedIn.text(), /name="url"/);
});

test("allowed and other addresses get the same answer, only allowed ones get a link, and a form from another site is refused", async () => {
  await signIn("old@planthia.test");
  sentEmails.length = 0;
  const answers = [];
  for (const email of ["stranger@nowhere.test", "old@planthia.test"]) {
    const res = await post("/meet/login", { email });
    answers.push([res.status, await res.text()]);
  }
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(sentEmails.map((e) => e.to), ["old@planthia.test"]);
  const crossSite = await app.request("/meet/login", {
    method: "POST",
    body: new URLSearchParams({ email: "old@planthia.test" }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": newIp(), origin: "https://evil.test" },
  });
  assert.equal(crossSite.status, 403, "a form posted from another site is refused");
  assert.equal(sentEmails.length, 1);
});

test("link requests are limited per email and per IP, whether or not the address is allowed", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post("/meet/login", { email: "dave@planthia.test" })).status, 200);
  assert.equal((await post("/meet/login", { email: "dave@planthia.test" })).status, 429);
  const ip = newIp();
  for (let i = 0; i < 5; i++) assert.equal((await post("/meet/login", { email: `x${i}@nowhere.test` }, { ip })).status, 200);
  assert.equal((await post("/meet/login", { email: "x9@nowhere.test" }, { ip })).status, 429);
});

test("a signed-in person starts a recording with extra recipients, sees its state, and stops it", async () => {
  const cookie = await signIn("gina@planthia.test");
  const started = await post("/meet/start", { url: JKU, emails: "Bob@example.com,\ncarol@planthia.test" }, { cookie });
  assert.equal(started.status, 303);
  assert.equal(started.headers.get("location"), "/meet", "a refresh after starting does not post the form again");
  const s = activeMeets.get("abc-defg-hij")!;
  assert.equal(s.state, "starting");
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
  assert.match(listed, /<meta http-equiv="refresh" content="5">/, "the page follows the bot into the room by itself");
  assert.match(listed, /ขั้นที่ 1 จาก 3: กำลังเตรียมบอท \(ประมาณ 1 นาที\)<\/p><small>abc-defg-hij · จากหน้าเว็บ/);
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
  assert.equal((await post("/meet/start", { url: "https://meet.google.com/pqr-stuv-wxy", emails: "" }, { cookie })).status, 303, "one person may run both slots");
  const lee = await signIn("lee@planthia.test");
  const third = await post("/meet/start", { url: "https://meet.google.com/xyz-abcd-efg", emails: "" }, { cookie: lee });
  assert.equal(third.status, 503);
  assert.match(await third.text(), /2 ห้องแล้ว/);
});

test("people see and stop only recordings that are theirs, and nothing works without a valid cookie", async () => {
  const ivy = await signIn("ivy@planthia.test");
  const carol = await signIn("carol@planthia.test");
  const jack = await signIn("jack@planthia.test");
  await post("/meet/start", { url: JKU, emails: "" }, { cookie: ivy });
  await post("/meet/start", { url: "https://meet.google.com/pqr-stuv-wxy", emails: "carol@planthia.test" }, { cookie: jack });
  const own = activeMeets.get("abc-defg-hij")!;
  const shared = activeMeets.get("pqr-stuv-wxy")!;
  const carolPage = await (await get("/meet", carol)).text();
  assert.doesNotMatch(carolPage, /<div>Google Meet abc-defg-hij/, "the placeholder shows the fixture code too");
  assert.match(carolPage, /<li class="rec"><div>Google Meet pqr-stuv-wxy/, "a recipient sees the recording");
  assert.equal((await post("/meet/stop", { id: own.id }, { cookie: carol })).status, 404);
  assert.equal(worker.recordings.get(own.id)!.stopped, false);
  assert.equal((await post("/meet/stop", { id: shared.id }, { cookie: carol })).status, 303);

  const anonymous = await post("/meet/start", { url: "https://meet.google.com/xyz-abcd-efg", emails: "" });
  assert.equal(anonymous.status, 303);
  assert.equal(activeMeets.get("xyz-abcd-efg"), undefined);
  assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie: tampered(ivy) })).status, 303, "a tampered cookie counts as signed out");
});

test("an address taken off the allowlist is signed out at once, and a link sent before that no longer signs it in", async () => {
  const allow = config().ALLOWED_EMAILS.emails;
  allow.push("nora@nowhere.test"); // as if ALLOWED_EMAILS listed her before a restart
  const nora = await signIn("nora@nowhere.test");
  await post("/meet/login", { email: "nora@nowhere.test" });
  const token = tokenIn(sentEmails.at(-1)!.text)!;
  allow.splice(allow.indexOf("nora@nowhere.test"), 1);
  assert.match(await (await get("/meet", nora)).text(), /name="email"/, "the cookie no longer works");
  assert.equal((await post("/meet/start", { url: JKU, emails: "" }, { cookie: nora })).status, 303);
  assert.equal(activeMeets.size, 0);
  const late = await post("/meet/auth", { t: token });
  assert.equal(late.status, 400);
  assert.equal(late.headers.get("set-cookie"), null);
});

test("logging out clears the cookie and goes back to the login page; the logout form is on the recorder page and refused from other sites", async () => {
  const cookie = await signIn("lou@example.com");
  assert.match(await (await get("/meet", cookie)).text(), /<form[^>]*method="post" action="\/meet\/logout"/);
  const crossSite = await app.request("/meet/logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: "https://evil.test" },
  });
  assert.equal(crossSite.status, 403);
  const out = await post("/meet/logout", {}, { cookie });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/meet");
  const cleared = out.headers.get("set-cookie") ?? "";
  for (const part of [/^mu=;/, /Max-Age=0/i, /Path=\/meet/]) assert.match(cleared, part);
});
