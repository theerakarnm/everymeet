import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
  const loginEmails = new RateLimit(config().MEET_LOGIN_MAIL_DAILY_CAP, DAY_MS);
  // Forms from other sites are refused. Browsers send Sec-Fetch-Site: same-origin for our own forms; the page's
  // Referrer-Policy no-referrer can make them send Origin: null, so both checks stay (either one passing is enough).
  app.use("*", csrf({ origin: base() }));
  const recorderPage = (email: string, extra: { error?: string; values?: { url: string; emails: string } } = {}) =>
    page.meetRecorder({ email, recordings: visibleTo(email).map(view), isAdmin: !!users().get(email)?.isAdmin, ...extra });

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
      // Checked before the cap on all login emails, so made-up addresses cannot use that one up.
      log.error(`login link not sent to ${email}: ${MAX_SIGNUP_EMAILS_PER_DAY} links to new addresses were sent in the last 24 hours`);
    } else if (!loginEmails.take("all")) {
      log.error(`login link not sent to ${email}: ${config().MEET_LOGIN_MAIL_DAILY_CAP} login emails were sent in the last 24 hours (MEET_LOGIN_MAIL_DAILY_CAP)`);
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

  return app;
}
