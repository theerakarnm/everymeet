import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { config } from "../config.js";
import { parseMeetUrl } from "../meet/meet-url.js";
import { activeMeets, MAX_MEET_RECORDINGS, MeetRefused, type MeetSession, type StartMeet } from "../meet/session.js";
import { keys } from "../storage/keys.js";
import { loadLocal, loadRemote, saveLocal, saveRemote, type MeetManifest } from "../storage/manifest.js";
import { getText, listKeys, putText } from "../storage/r2.js";
import { pLimit } from "../util/limit.js";
import { logger } from "../util/log.js";
import { generatePin, hashPin, SESSION_ID_RE } from "../util/pin.js";
import { clientIp } from "../web/client-ip.js";
import { forgetManifest } from "../web/manifest-cache.js";
import { RateLimit } from "../web/rate-limit.js";
import { findClient } from "./clients.js";
import { recordingView } from "./events.js";
import { resolveWebhookUrl } from "./webhook-url.js";

const log = logger("api");
const PAGE = 50;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ApiEnv = { Variables: { client: string } };

const startBody = z.strictObject({
  meetUrl: z.string().max(300),
  title: z.string().trim().min(1).max(200).optional(),
  ownerId: z.string().regex(OWNER_RE),
  metadata: z
    .record(z.string().max(40), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 20, "at most 20 entries")
    .default({}),
  delivery: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("email"), starter: z.email(), recipients: z.array(z.email()).max(50).default([]) }),
    z.strictObject({ mode: z.literal("webhook") }),
  ]),
  webhookUrl: z.string().max(2000).optional(),
});

export const fail = (c: Context, status: ContentfulStatusCode, code: string, message: string) => c.json({ error: { code, message } }, status);

/** The caller's own Meet recording: the live session first, else the local, else the R2 manifest. Other clients' and Discord recordings are not found. */
export async function findRecording(client: string, id: string): Promise<{ m: MeetManifest; live?: MeetSession } | undefined> {
  if (!SESSION_ID_RE.test(id)) return undefined;
  const live = [...activeMeets.values()].find((s) => s.id === id);
  const m = live?.manifest ?? loadLocal(id) ?? (await loadRemote(id));
  if (!m?.meet || m.meet.api?.client !== client) return undefined;
  return { m, live };
}

/** /api/v1: Bearer API keys, per-client rate limits, JSON in and out (docs/api.md). */
export function apiRoutes(deps: { startMeet: StartMeet }): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const perClient = new RateLimit(config().API_RATE_LIMIT_PER_MIN, 60_000);
  const badKeysPerIp = new RateLimit(30, 60_000);

  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => fail(c, 413, "body_too_large", "The request body is larger than 16 KB.") }));
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    const client = auth?.startsWith("Bearer ") ? findClient(auth.slice(7), config().API_KEYS.keys) : undefined;
    if (!client) {
      if (!badKeysPerIp.take(clientIp(c))) {
        c.header("Retry-After", "60");
        return fail(c, 429, "rate_limited", "Too many requests without a valid API key.");
      }
      c.header("WWW-Authenticate", 'Bearer realm="everymeet"');
      return fail(c, 401, "unauthorized", "A valid API key is required.");
    }
    if (!perClient.take(client)) {
      c.header("Retry-After", "60");
      return fail(c, 429, "rate_limited", `More than ${config().API_RATE_LIMIT_PER_MIN} requests in a minute.`);
    }
    c.set("client", client);
    await next();
  });

  app.post("/recordings", async (c) => {
    const client = c.get("client");
    const parsed = startBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return fail(c, 400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    const b = parsed.data;
    const meet = parseMeetUrl(b.meetUrl);
    if (!meet) return fail(c, 400, "invalid_meet_url", "meetUrl is not a Google Meet link like https://meet.google.com/abc-defg-hij.");
    const cfg = config();
    if (b.delivery.mode === "email" && !(cfg.RESEND_API_KEY && cfg.EMAIL_FROM)) {
      return fail(c, 422, "email_not_configured", "This engine has no email sender; use delivery mode webhook.");
    }
    const hook = resolveWebhookUrl(b.webhookUrl, cfg);
    if ("error" in hook) {
      return fail(c, 400, hook.error, "webhookUrl must be https (http only on localhost) on WEBHOOK_URL's origin or one in WEBHOOK_ALLOWED_ORIGINS.");
    }
    if (b.delivery.mode === "webhook" && !hook.url) {
      return fail(c, 400, "webhook_url_required", "Delivery mode webhook needs webhookUrl or a configured WEBHOOK_URL.");
    }
    const email = b.delivery.mode === "email" ? b.delivery : undefined;
    let s: MeetSession;
    try {
      s = await deps.startMeet({
        ...meet,
        title: b.title ?? `Google Meet ${meet.code}`,
        trigger: "api",
        startedBy: email?.starter.toLowerCase(),
        recipients: email?.recipients.map((r) => r.toLowerCase()) ?? [],
        api: { client, ownerId: b.ownerId, metadata: b.metadata, delivery: b.delivery.mode, webhookUrl: hook.url },
      });
    } catch (err) {
      if (err instanceof MeetRefused && err.reason === "already_recording") {
        // Only the client that runs it learns its id.
        const running = activeMeets.get(meet.code);
        const own = running?.manifest.meet.api?.client === client ? running.id : undefined;
        return c.json({ error: { code: "already_recording", message: "This Google Meet call is already being recorded.", ...(own ? { recordingId: own } : {}) } }, 409);
      }
      if (err instanceof MeetRefused) {
        c.header("Retry-After", "60");
        return fail(c, 503, "busy", `At most ${MAX_MEET_RECORDINGS} Google Meet recordings run at once.`);
      }
      log.error(`API client ${client} could not start a recording`, err);
      return fail(c, 503, "recorder_unavailable", "The recorder could not be started; try again.");
    }
    try {
      await putText(keys.ownerIndex(client, b.ownerId, s.manifest.startedAt, s.id), "", "text/plain");
    } catch (err) {
      // Not fatal: the recording runs and is reachable by id; only the owner list misses it.
      log.warn(`recording ${s.id} is not in the owner list of ${client}/${b.ownerId}`, err);
    }
    log.info(`API client ${client} started ${s.id} for owner ${b.ownerId}`);
    c.header("Location", `/api/v1/recordings/${s.id}`);
    return c.json(recordingView(s.manifest, s), 201);
  });

  app.get("/recordings/:id", async (c) => {
    const r = await findRecording(c.get("client"), c.req.param("id"));
    if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
    const summary = r.m.status === "done" ? await getText(keys.summaryShort(r.m.id)) : undefined;
    return c.json(recordingView(r.m, r.live, summary));
  });

  app.post("/recordings/:id/stop", async (c) => {
    const r = await findRecording(c.get("client"), c.req.param("id"));
    if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
    if (!r.live) return fail(c, 409, "not_recording", "The recording has already ended.");
    try {
      await r.live.end("หยุดผ่าน API");
    } catch (err) {
      log.warn(`API client ${c.get("client")} could not stop ${r.m.id}`, err);
      return fail(c, 503, "recorder_unavailable", "The recorder could not be reached; it stops by itself when the call empties or reaches its time limit.");
    }
    return c.json(recordingView(r.m, r.live), 202);
  });

  app.get("/recordings", async (c) => {
    const client = c.get("client");
    const ownerId = c.req.query("ownerId") ?? "";
    if (!OWNER_RE.test(ownerId)) return fail(c, 400, "invalid_request", "ownerId is required: 1-128 of A-Z a-z 0-9 . _ -, starting with a letter or digit.");
    const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? PAGE) || PAGE, PAGE));
    const page = await listKeys(keys.ownerPrefix(client, ownerId), limit, c.req.query("cursor"));
    const ids = page.keys.map((k) => k.slice(k.lastIndexOf("/") + 1).slice(14));
    const load = pLimit(8);
    const found = await Promise.all(ids.map((id) => load(() => findRecording(client, id))));
    const items = found.filter((r) => r !== undefined).map((r) => recordingView(r.m, r.live));
    return c.json({ items, ...(page.cursor ? { nextCursor: page.cursor } : {}) });
  });

  /** A new PIN for the playback page, returned once; only its hash is stored, and the previous PIN stops working. */
  app.post("/recordings/:id/pin", async (c) => {
    const client = c.get("client");
    const r = await findRecording(client, c.req.param("id"));
    if (!r) return fail(c, 404, "not_found", "No such recording for this API key.");
    if (r.m.status !== "done") return fail(c, 409, "not_ready", "The minutes are not ready yet; wait for minutes.ready.");
    const pin = generatePin();
    r.m.pin = hashPin(pin);
    await saveRemote(r.m);
    if (loadLocal(r.m.id)) saveLocal(r.m); // only when CLEANUP_LOCAL=false kept the folder
    forgetManifest(r.m.id);
    log.info(`API client ${client} issued a new PIN for ${r.m.id}`);
    return c.json({ pin, playbackUrl: `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${r.m.id}` });
  });

  app.all("*", (c) => fail(c, 404, "not_found", "No such endpoint."));
  // A mounted sub-app's onError handles its own routes, so API failures keep the JSON error shape.
  app.onError((err, c) => {
    log.error("API request failed", err);
    return fail(c, 500, "internal_error", "Something went wrong; try again.");
  });
  return app;
}
