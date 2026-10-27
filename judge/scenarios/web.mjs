/**
 * Web scenarios 1-5: the PIN gate, login and file redirects, IP lockout,
 * security headers, and the byte-level HTML snapshots against the goldens
 * recorded from the Node implementation. Each scenario asserts the same
 * expected values against either implementation.
 */
import assert from "node:assert/strict";
import { FIRST_SPEAKER, SECOND_SPEAKER } from "../fixtures.mjs";

/** Frozen by the plan's Global Constraints (src/web/server.ts middleware). */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; media-src 'self' https:; form-action 'self'; base-uri 'none'";

const audioManifestKey = (id) => `meetings/${id}/meeting.mp3`;

/** The cookie value differs per login; compare only the name and the attribute list. */
function cookieParts(setCookie) {
  const parts = setCookie.split(";").map((s) => s.trim());
  const [name, value] = parts[0].split("=");
  // Attribute names are case-insensitive; values (like the Path's meeting id) are not.
  const attrs = parts.slice(1).map((a) => {
    const eq = a.indexOf("=");
    return eq === -1 ? a.toLowerCase() : `${a.slice(0, eq).toLowerCase()}=${a.slice(eq + 1)}`;
  });
  return { name, value, cookie: parts[0], attrs };
}

export async function pinGate(open) {
  const ctx = await open();
  ctx.seedFixture();
  await ctx.processMeeting();
  const page = await ctx.get(`/m/${ctx.id}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="pin"/);
  assert.doesNotMatch(html, /<audio/, "the PIN page must not leak the player");

  const file = await ctx.get(`/m/${ctx.id}/file/audio`);
  assert.equal(file.status, 303, "files need the PIN too");
  assert.equal(file.headers.get("location"), `/m/${ctx.id}`);
}

export async function loginAndFiles(open) {
  const ctx = await open();
  ctx.seedFixture();
  await ctx.processMeeting();
  const login = await ctx.postForm(`/m/${ctx.id}`, { pin: ctx.pin }, { ip: "10.1.1.1" });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), `/m/${ctx.id}`);

  const { name, value, cookie, attrs } = cookieParts(login.headers.get("set-cookie"));
  assert.equal(name, `ma_${ctx.id}`);
  assert.match(value, /^\d+\.[A-Za-z0-9_-]+$/, `cookie value is "<expiry ms>.<base64url hmac>"`);
  const hasFlag = (flag) => attrs.some((a) => a.toLowerCase() === flag);
  const hasAttr = (attrName, attrValue, caseInsensitiveValue = false) =>
    attrs.some((a) => {
      const eq = a.indexOf("=");
      if (eq === -1) return false;
      if (a.slice(0, eq).toLowerCase() !== attrName) return false;
      const got = a.slice(eq + 1);
      return caseInsensitiveValue ? got.toLowerCase() === attrValue.toLowerCase() : got === attrValue;
    });
  assert.ok(hasFlag("httponly"), `HttpOnly in [${attrs.join(", ")}]`);
  assert.ok(hasFlag("secure"), `Secure in [${attrs.join(", ")}]`);
  assert.ok(hasAttr("samesite", "Lax", true), `SameSite=Lax in [${attrs.join(", ")}]`);
  assert.ok(hasAttr("path", `/m/${ctx.id}`), `Path=/m/${ctx.id} in [${attrs.join(", ")}]`);
  assert.ok(hasAttr("max-age", "43200"), `Max-Age=43200 in [${attrs.join(", ")}]`);

  const player = await ctx.get(`/m/${ctx.id}`, { cookie });
  assert.equal(player.status, 200);
  const html = await player.text();
  for (const fragment of ["<audio", "/file/audio", "/file/summary", "/file/transcript"]) {
    assert.ok(html.includes(fragment), `player page contains ${fragment}`);
  }
  const first = html.indexOf(`/file/track/${FIRST_SPEAKER}`);
  const second = html.indexOf(`/file/track/${SECOND_SPEAKER}`);
  assert.ok(first !== -1 && second !== -1, "both per-speaker tracks are linked");
  assert.ok(first < second, "tracks are listed in join order (900000000000000002 first)");

  const stream = await ctx.get(`/m/${ctx.id}/file/audio`, { cookie });
  assert.equal(stream.status, 302);
  const loc = new URL(stream.headers.get("location"));
  assert.equal(`${loc.origin}${loc.pathname}`, `${ctx.s3Url}/${ctx.env.R2_BUCKET}/${audioManifestKey(ctx.id)}`);

  const download = await ctx.get(`/m/${ctx.id}/file/audio?download=1`, { cookie });
  assert.equal(download.status, 302);
  const dlLoc = new URL(download.headers.get("location"));
  assert.equal(
    dlLoc.searchParams.get("response-content-disposition"),
    "attachment; filename*=UTF-8''meeting-2026-12-31.mp3",
    dlLoc.search,
  );

  const unknownTrack = await ctx.get(`/m/${ctx.id}/file/track/someone-else`, { cookie });
  assert.equal(unknownTrack.status, 404, "a track for a user not in the manifest is not served");

  const otherId = "BBBBAAAAAAAAAAAA";
  const done = JSON.parse(ctx.s3Text(`meetings/${ctx.id}/manifest.json`));
  ctx.s3objects.set(`meetings/${otherId}/manifest.json`, Buffer.from(JSON.stringify({ ...done, id: otherId })));
  const cross = await ctx.get(`/m/${otherId}`, { cookie });
  assert.equal(cross.status, 200);
  assert.match(await cross.text(), /name="pin"/, "a cookie only opens the meeting it was issued for");
}

export async function lockout(open) {
  const ctx = await open();
  ctx.seedFixture();
  await ctx.processMeeting();
  const wrong = ctx.pin === "000000" ? "111111" : "000000";
  const ip = "10.2.0.1";
  for (let left = 4; left >= 0; left--) {
    const res = await ctx.postForm(`/m/${ctx.id}`, { pin: wrong }, { ip });
    assert.equal(res.status, 401);
    assert.match(await res.text(), new RegExp(`PIN ไม่ถูกต้อง \\(เหลือ ${left} ครั้ง\\)`));
  }
  const locked = await ctx.postForm(`/m/${ctx.id}`, { pin: ctx.pin }, { ip });
  assert.equal(locked.status, 429, "even the correct PIN is refused while locked");
  assert.match(await locked.text(), /ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ 15 นาที/);

  const other = await ctx.postForm(`/m/${ctx.id}`, { pin: ctx.pin }, { ip: "10.2.0.2" });
  assert.equal(other.status, 303, "a different IP is not locked");

  // TRUST_PROXY=true: only the first X-Forwarded-For entry counts.
  for (let i = 0; i < 5; i++) {
    const res = await ctx.postForm(`/m/${ctx.id}`, { pin: wrong }, { ip: "10.2.0.3, 10.2.0.4" });
    assert.equal(res.status, 401);
  }
  const secondEntry = await ctx.postForm(`/m/${ctx.id}`, { pin: ctx.pin }, { ip: "10.2.0.4" });
  assert.equal(secondEntry.status, 303, "the second X-Forwarded-For entry is not the lock key");
}

function assertSecurityHeaders(res, label) {
  assert.equal(res.headers.get("cache-control"), "no-store", `${label}: cache-control`);
  assert.equal(res.headers.get("x-frame-options"), "DENY", `${label}: x-frame-options`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${label}: x-content-type-options`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}: referrer-policy`);
  assert.equal(res.headers.get("content-security-policy"), CSP, `${label}: content-security-policy`);
}

export async function securityHeaders(open) {
  const ctx = await open();
  // The fixture manifest is still "processing": unreachable, but headers must be applied.
  const { manifest } = ctx.seedFixture();
  ctx.seedR2Manifest(manifest);
  const processing = await ctx.get(`/m/${ctx.id}`);
  assert.equal(processing.status, 404);
  assertSecurityHeaders(processing, "404 processing");

  await ctx.processMeeting();

  const ok = await ctx.get(`/m/${ctx.id}`);
  assert.equal(ok.status, 200);
  assertSecurityHeaders(ok, "200 pin page");

  const gate = await ctx.get(`/m/${ctx.id}/file/audio`);
  assert.equal(gate.status, 303);
  assertSecurityHeaders(gate, "303 pin gate");

  const missing = await ctx.get("/m/short");
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing, "404 invalid id");
}

const normalizeHtml = (html) => html.replace(/\s+/g, " ").trim();

export async function htmlSnapshot(open) {
  const ctx = await open();
  ctx.seedFixture();
  await ctx.processMeeting();
  const pinPage = await (await ctx.get(`/m/${ctx.id}`)).text();
  const login = await ctx.postForm(`/m/${ctx.id}`, { pin: ctx.pin }, { ip: "10.3.0.1" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const playerPage = await (await ctx.get(`/m/${ctx.id}`, { cookie })).text();

  if (ctx.recordGolden) {
    ctx.writeGolden("pin-page.html", pinPage);
    ctx.writeGolden("player-page.html", playerPage);
    return "recorded";
  }
  assert.equal(normalizeHtml(pinPage), normalizeHtml(ctx.readGolden("pin-page.html")), "PIN page HTML changed");
  assert.equal(normalizeHtml(playerPage), normalizeHtml(ctx.readGolden("player-page.html")), "player page HTML changed");
}
