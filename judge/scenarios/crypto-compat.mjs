/**
 * Compatibility scenarios 12-13: golden crypto vectors recorded once from Node
 * (PIN scrypt hash, signed access cookies and their malformed cousins), and the
 * fixed-input time formatting tables. Each implementation must verify the good
 * vectors, reject the bad ones, and print identical time strings.
 */
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";

const PIN = "123456";
const WRONG_PIN = "654321";
/** A far-future expiry: signAccess takes a TTL in ms, so this is ~10^12 s away. */
const FAR_FUTURE_TTL_MS = "32503680000000";
const EXPIRED_TTL_MS = "-60000";

export async function goldenVectors(open) {
  const ctx = await open();
  let vectors;
  if (ctx.recordGolden) {
    // Same construction as src/util/pin.ts hashPin (Node scrypt defaults N=16384, r=8, p=1, 32-byte key).
    const salt = randomBytes(16).toString("base64url");
    const hash = scryptSync(PIN, salt, 32).toString("base64url");
    const good = (await ctx.judgeCli(["sign-access", ctx.id, ctx.env.SESSION_SECRET, FAR_FUTURE_TTL_MS])).stdout.trim();
    const expired = (await ctx.judgeCli(["sign-access", ctx.id, ctx.env.SESSION_SECRET, EXPIRED_TTL_MS])).stdout.trim();
    vectors = {
      id: ctx.id,
      secret: ctx.env.SESSION_SECRET,
      pin: { pin: PIN, salt, hash },
      wrongPin: WRONG_PIN,
      cookie: {
        good,
        expired,
        badExpiry: `12345.${good.split(".")[1] ?? "abc"}`,
        badBase64: `${good.split(".")[0]}.%%%not-base64`,
        noDot: "onlyonepart",
      },
    };
    ctx.writeGolden("crypto.json", `${JSON.stringify(vectors, null, 2)}\n`);
  } else {
    vectors = JSON.parse(ctx.readGolden("crypto.json"));
  }

  assert.equal((await ctx.judgeCli(["verify-pin", vectors.pin.pin, vectors.pin.salt, vectors.pin.hash])).code, 0,
    "the golden PIN verifies");
  assert.notEqual((await ctx.judgeCli(["verify-pin", vectors.wrongPin, vectors.pin.salt, vectors.pin.hash])).code, 0,
    "the wrong PIN is rejected");

  const ok = await ctx.judgeCli(["verify-access", vectors.id, vectors.cookie.good, vectors.secret]);
  assert.equal(ok.code, 0, "the golden cookie verifies");
  for (const [name, value] of Object.entries(vectors.cookie).filter(([k]) => k !== "good")) {
    assert.notEqual((await ctx.judgeCli(["verify-access", vectors.id, value, vectors.secret])).code, 0,
      `${name} cookie is rejected`);
  }
  assert.notEqual((await ctx.judgeCli(["verify-access", "AAAAAAAAAAAAAAAA", vectors.cookie.good, vectors.secret])).code, 0,
    "a cookie is bound to the meeting it was issued for");
  assert.notEqual((await ctx.judgeCli(["verify-access", vectors.id, vectors.cookie.good, `${vectors.secret}x`])).code, 0,
    "a cookie is bound to the signing secret");
  assert.notEqual((await ctx.judgeCli(["verify-pin", "12ab56", vectors.pin.salt, vectors.pin.hash])).code, 0,
    "a PIN with non-digits is rejected");
}

/** 20 fixed instants and 20 fixed durations, including the plan's required edges. */
const BANGKOK_INPUTS_MS = [
  0,
  1,
  86_400_000,
  Date.UTC(1999, 11, 31, 16, 30, 0), // millennium boundary at Bangkok midnight
  Date.UTC(2024, 3, 13, 4, 0, 0), // Songkran eve
  Date.UTC(2026, 9, 12, 3, 0, 0), // the old test suite's date
  Date.UTC(2026, 11, 25, 18, 15, 20),
  Date.UTC(2026, 11, 31, 4, 59, 59), // 11:59:59 Bangkok
  Date.UTC(2026, 11, 31, 5, 0, 0), // 12 h boundary (noon Bangkok)
  Date.UTC(2026, 11, 31, 5, 30, 0),
  Date.UTC(2026, 11, 31, 16, 59, 59, 999), // last ms before Bangkok midnight
  Date.UTC(2026, 11, 31, 17, 0, 0), // 00:00 Bangkok on New Year: year boundary
  Date.UTC(2026, 11, 31, 17, 30, 0), // FIXTURE_STARTED_AT
  Date.UTC(2026, 11, 31, 17, 30, 1),
  Date.UTC(2026, 11, 31, 23, 30, 0),
  Date.UTC(2027, 0, 1, 0, 0, 0),
  Date.UTC(2027, 2, 14, 7, 30, 0),
  Date.UTC(2028, 1, 29, 12, 0, 0), // leap day
  Date.UTC(2100, 0, 1, 0, 0, 0),
  Date.UTC(2030, 5, 15, 3, 45, 10),
];

const DURATION_INPUTS_S = [
  0, 0.4, 0.49, 45, 59, 59.49, 59.5, 60, 61, 119.49, 3599, 3600, 3661, 3725, 7200, 86_399, 86_400, 86_460, 356_400,
  3_156_000,
];

export async function timeFormat(open) {
  const ctx = await open();
  const bangkok = {};
  for (const ms of BANGKOK_INPUTS_MS) {
    const run = await ctx.judgeCli(["bangkok", String(ms)]);
    assert.equal(run.code, 0, `judge-cli bangkok ${ms} failed: ${run.stderr}`);
    bangkok[ms] = run.stdout.trim();
  }
  const duration = {};
  for (const s of DURATION_INPUTS_S) {
    const run = await ctx.judgeCli(["duration", String(s)]);
    assert.equal(run.code, 0, `judge-cli duration ${s} failed: ${run.stderr}`);
    duration[s] = run.stdout.trim();
  }
  assert.equal(Object.keys(bangkok).length + Object.keys(duration).length, 40);
  if (ctx.recordGolden) {
    ctx.writeGolden("time.json", `${JSON.stringify({ bangkok, duration }, null, 2)}\n`);
    return;
  }
  assert.deepEqual({ bangkok, duration }, JSON.parse(ctx.readGolden("time.json")), "time formatting differs from golden");
}
