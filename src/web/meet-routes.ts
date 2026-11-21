import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { config } from "../config.js";
import { loginMail } from "../email/messages.js";
import { sendEmail } from "../email/send.js";
import { parseMeetUrl } from "../meet/meet-url.js";
import { activeMeets, MAX_MEET_RECORDINGS, MeetRefused, type MeetSession, type StartMeet } from "../meet/session.js";
import { isAllowed, normalizeEmail, parseEmailList } from "../util/email.js";
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
const linksPerIp = new RateLimit(5, 15 * 60_000);
const linksPerEmail = new RateLimit(3, 15 * 60_000);

export interface MeetRouteDeps {
  startMeet: StartMeet;
}

const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, "");

/** The signed-in person, while their cookie is valid and their address is on ALLOWED_EMAILS (checked on every request). */
function user(c: Context): string | undefined {
  const email = verifyUser(getCookie(c, USER_COOKIE), config().SESSION_SECRET);
  return email && isAllowed(email, config().ALLOWED_EMAILS) ? email : undefined;
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

/** The Google Meet page: magic-link login for ALLOWED_EMAILS, then start, follow, and stop recordings. */
export function meetRoutes(deps: MeetRouteDeps): Hono {
  const app = new Hono();
  const loginEmails = new RateLimit(config().MEET_LOGIN_MAIL_DAILY_CAP, DAY_MS);
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
    if (!isAllowed(email, config().ALLOWED_EMAILS)) {
      log.warn(`login link not sent to ${email}: not on ALLOWED_EMAILS`);
    } else if (!loginEmails.take("all")) {
      log.error(`login link not sent to ${email}: ${config().MEET_LOGIN_MAIL_DAILY_CAP} login emails were sent in the last 24 hours (MEET_LOGIN_MAIL_DAILY_CAP)`);
    } else {
      // Not awaited: an allowed address must not answer slower than one that is not.
      sendEmail({ to: email, ...loginMail(`${base()}/meet/auth?t=${createLoginLink(email)}`) }).then(
        () => log.info(`login link sent to ${email}`),
        (err) => log.error(`could not send a login link to ${email}`, err),
      );
    }
    // The same answer for every address, so the page does not tell who is on the allowlist.
    return c.html(page.meetLoginSent());
  });

  // Opening the link only shows a button: mail scanners that fetch links must not use up the single-use token.
  app.get("/auth", (c) => c.html(page.meetConfirm({ token: c.req.query("t") ?? "" })));

  app.post("/auth", async (c) => {
    const email = consumeLoginLink(String((await c.req.parseBody()).t ?? ""));
    if (!email) return c.html(page.meetLinkInvalid(), 400);
    // ALLOWED_EMAILS may have changed (restart) since the link was sent.
    if (!isAllowed(email, config().ALLOWED_EMAILS)) return c.html(page.meetLinkInvalid(), 400);
    setCookie(c, USER_COOKIE, signUser(email, config().SESSION_SECRET, USER_TTL_MS), {
      path: "/meet",
      httpOnly: true,
      secure: base().startsWith("https://"),
      sameSite: "Lax",
      maxAge: USER_TTL_MS / 1000,
    });
    log.info(`${email} signed in to the Google Meet page`);
    return c.redirect("/meet", 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, USER_COOKIE, { path: "/meet", secure: base().startsWith("https://") });
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
        switch (err.reason) {
          case "already_recording":
            return again("ห้อง Google Meet นี้กำลังถูกบันทึกอยู่แล้ว", 409);
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
