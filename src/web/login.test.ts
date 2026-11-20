import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { signAccess, signUser, verifyAccess, verifyUser } from "../util/pin.js";
import { consumeLoginLink, createLoginLink, LOGIN_LINK_TTL_MS } from "./login-links.js";
import { RateLimit } from "./rate-limit.js";

const SECRET = "s".repeat(40);
afterEach(() => mock.timers.reset());

test("a login cookie names its email, cannot be changed to another email, and expires", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const cookie = signUser("alice@example.com", SECRET, 60_000);
  assert.equal(verifyUser(cookie, SECRET), "alice@example.com");
  const forged = `${Buffer.from("mallory@example.com").toString("base64url")}${cookie.slice(cookie.indexOf("."))}`;
  assert.equal(verifyUser(forged, SECRET), undefined);
  assert.equal(verifyUser(cookie, "t".repeat(40)), undefined);
  assert.equal(verifyUser(undefined, SECRET), undefined);
  assert.equal(verifyUser("garbage", SECRET), undefined);
  mock.timers.tick(60_001);
  assert.equal(verifyUser(cookie, SECRET), undefined);
});

test("playback cookies and login cookies are not interchangeable", () => {
  const playback = signAccess("AbCdEfGhIjKlMnOp", SECRET, 60_000);
  assert.equal(verifyUser(`${Buffer.from("AbCdEfGhIjKlMnOp").toString("base64url")}.${playback}`, SECRET), undefined);
  const user = signUser("alice@example.com", SECRET, 60_000);
  assert.equal(verifyAccess("AbCdEfGhIjKlMnOp", user.slice(user.indexOf(".") + 1), SECRET), false);
});

test("a login link works once and only for 15 minutes", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const once = createLoginLink("alice@example.com");
  assert.match(once, /^[\w-]{43}$/);
  assert.equal(consumeLoginLink(once), "alice@example.com");
  assert.equal(consumeLoginLink(once), undefined, "single use");
  const late = createLoginLink("alice@example.com");
  mock.timers.tick(LOGIN_LINK_TTL_MS + 1);
  assert.equal(consumeLoginLink(late), undefined, "expired");
  assert.equal(consumeLoginLink("made-up"), undefined);
});

test("the rate limit allows max attempts per key per window", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const limit = new RateLimit(3, 15 * 60_000);
  assert.deepEqual([1, 2, 3, 4].map(() => limit.take("10.0.0.1")), [true, true, true, false]);
  assert.equal(limit.take("10.0.0.2"), true, "other keys are independent");
  mock.timers.tick(15 * 60_000);
  assert.equal(limit.take("10.0.0.1"), true, "a new window");
});
