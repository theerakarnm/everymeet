import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getCookie, setCookie } from "hono/cookie";
import { config, SAMPLE_RATE } from "../config.js";
import { loadRemote, type Manifest } from "../storage/manifest.js";
import { keys, presign } from "../storage/r2.js";
import { SESSION_ID_RE, signAccess, verifyAccess, verifyPin } from "../util/pin.js";
import { bangkokDateTime, durationTh } from "../util/time.js";
import { totalSamples } from "../pipeline/assemble.js";
import { logger } from "../util/log.js";
import { page } from "./templates.js";

const log = logger("web");
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

// ---- small caches ----------------------------------------------------------

const manifestCache = new Map<string, { at: number; m: Manifest | undefined }>();
async function getManifest(id: string): Promise<Manifest | undefined> {
  const hit = manifestCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.m;
  const m = await loadRemote(id);
  // Only finished meetings are cached: the link is posted just before the "done" status is saved.
  if (m?.status === "done") manifestCache.set(id, { at: Date.now(), m });
  return m;
}

const failures = new Map<string, { count: number; resetAt: number }>();
function failKey(id: string, ip: string) {
  return `${id}|${ip}`;
}
function isLocked(key: string): boolean {
  const f = failures.get(key);
  if (!f) return false;
  if (f.resetAt < Date.now()) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILS;
}
function recordFail(key: string): number {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.resetAt < now) {
    failures.set(key, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    return MAX_FAILS - 1;
  }
  f.count++;
  return Math.max(0, MAX_FAILS - f.count);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of failures) if (f.resetAt < now) failures.delete(k);
}, 10 * 60 * 1000).unref();

// ---- helpers ---------------------------------------------------------------

function clientIp(c: Context): string {
  if (config().TRUST_PROXY) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

const cookieName = (id: string) => `ma_${id}`;

function hasAccess(c: Context, id: string): boolean {
  return verifyAccess(id, getCookie(c, cookieName(id)), config().SESSION_SECRET);
}

async function loadReady(id: string): Promise<Manifest | undefined> {
  if (!SESSION_ID_RE.test(id)) return undefined;
  const m = await getManifest(id);
  return m?.status === "done" && m.pin ? m : undefined;
}

// ---- app -------------------------------------------------------------------

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; media-src 'self' https:; form-action 'self'; base-uri 'none'",
    );
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/m/:id", async (c) => {
    const id = c.req.param("id");
    const m = await loadReady(id);
    if (!m) return c.html(page.notFound(), 404);
    if (!hasAccess(c, id)) return c.html(page.pin({ id, title: m.voiceChannelName }));
    const tracks = Object.entries(m.outputs?.tracks ?? {}).map(([userId]) => ({
      userId,
      name: m.participants[userId]?.displayName ?? userId,
    }));
    return c.html(
      page.player({
        id,
        title: m.voiceChannelName,
        guild: m.guildName,
        started: bangkokDateTime(m.startedAt),
        duration: durationTh(totalSamples(m) / SAMPLE_RATE),
        tracks,
      }),
    );
  });

  app.post("/m/:id", async (c) => {
    const id = c.req.param("id");
    const m = await loadReady(id);
    if (!m) return c.html(page.notFound(), 404);
    const key = failKey(id, clientIp(c));
    if (isLocked(key)) {
      return c.html(page.pin({ id, title: m.voiceChannelName, error: "ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ 15 นาที" }), 429);
    }
    const body = await c.req.parseBody();
    const pin = String(body.pin ?? "").trim();
    if (!verifyPin(pin, m.pin!.salt, m.pin!.hash)) {
      const left = recordFail(key);
      log.warn(`wrong PIN for ${id} (${left} attempts left)`);
      return c.html(page.pin({ id, title: m.voiceChannelName, error: `PIN ไม่ถูกต้อง (เหลือ ${left} ครั้ง)` }), 401);
    }
    failures.delete(key);
    setCookie(c, cookieName(id), signAccess(id, config().SESSION_SECRET, ACCESS_TTL_MS), {
      path: `/m/${id}`,
      httpOnly: true,
      secure: config().PUBLIC_BASE_URL.startsWith("https://"),
      sameSite: "Lax",
      maxAge: ACCESS_TTL_MS / 1000,
    });
    return c.redirect(`/m/${id}`, 303);
  });

  /** Files are served straight from R2 through short-lived signed URLs. */
  app.get("/m/:id/file/:kind/:userId?", async (c) => {
    const { id, kind, userId } = c.req.param();
    const m = await loadReady(id);
    if (!m) return c.html(page.notFound(), 404);
    if (!hasAccess(c, id)) return c.redirect(`/m/${id}`, 303);
    const date = new Date(m.startedAt).toISOString().slice(0, 10);
    const download = c.req.query("download") === "1";
    let key: string | undefined;
    let name: string | undefined;
    switch (kind) {
      case "audio":
        key = keys.mixed(id);
        name = download ? `meeting-${date}.mp3` : undefined;
        break;
      case "transcript":
        key = keys.transcript(id);
        name = `transcript-${date}.txt`;
        break;
      case "summary":
        key = keys.summaryFull(id);
        name = `summary-full-${date}.md`;
        break;
      case "track":
        if (userId && m.outputs?.tracks?.[userId]) {
          key = m.outputs.tracks[userId];
          name = `${m.participants[userId]?.displayName ?? userId}-${date}.ogg`;
        }
        break;
    }
    if (!key) return c.html(page.notFound(), 404);
    // Long expiry for streaming so seeking late in a 2-hour meeting still works.
    return c.redirect(await presign(key, name, kind === "audio" && !download ? 4 * 3600 : 600), 302);
  });

  app.notFound((c) => c.html(page.notFound(), 404));
  app.onError((err, c) => {
    log.error("request failed", err);
    return c.text("Internal error", 500);
  });
  return app;
}

export function startWebServer(): void {
  const port = config().WEB_PORT;
  serve({ fetch: createApp().fetch, port });
  log.info(`playback page listening on :${port}`);
}
