import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../test/setup.js";
import { UserStore } from "./store.js";

const DAY = 24 * 60 * 60_000;
const tempFile = () => join(mkdtempSync(join(tmpdir(), "users-test-")), "users.json");

test("the first sign-in creates an active, non-admin user under the lowercase address, and the file survives a restart", () => {
  const path = tempFile();
  const store = new UserStore(path);
  assert.equal(store.get("ann@example.com"), undefined);
  const ann = store.signIn("Ann@Example.com", 1_000);
  assert.deepEqual(ann, { email: "ann@example.com", status: "active", isAdmin: false, createdAt: 1_000, lastLoginAt: 1_000, recentStarts: [] });
  store.signIn("ANN@example.com", 5_000);
  const reloaded = new UserStore(path);
  assert.equal(reloaded.get("ann@example.com")?.createdAt, 1_000);
  assert.equal(reloaded.get("ann@example.com")?.lastLoginAt, 5_000);
  assert.equal(reloaded.list().length, 1, "one record per address, whatever its case");
  assert.equal(existsSync(`${path}.tmp`), false, "the temp file is renamed into place");
});

test("a disabled user is not active, cannot sign in, and can be enabled again", () => {
  const store = new UserStore(tempFile());
  store.signIn("ben@example.com", 1_000);
  assert.equal(store.setStatus("BEN@example.com", "disabled")?.status, "disabled");
  assert.equal(store.active("ben@example.com"), undefined);
  assert.equal(store.signIn("ben@example.com", 9_000).lastLoginAt, 1_000, "a disabled sign-in changes nothing");
  store.setStatus("ben@example.com", "active");
  assert.ok(store.active("ben@example.com"));
  assert.equal(store.setStatus("nobody@example.com", "disabled"), undefined);
});

test("the seeded admin is created, and seeding again makes an existing user an active admin", () => {
  const store = new UserStore(tempFile());
  store.seedAdmin("Root@Example.com", 1_000);
  assert.deepEqual(store.get("root@example.com"), { email: "root@example.com", status: "active", isAdmin: true, createdAt: 1_000, recentStarts: [] });
  store.signIn("cat@example.com", 2_000);
  store.setStatus("cat@example.com", "disabled");
  store.seedAdmin("cat@example.com", 3_000);
  assert.equal(store.get("cat@example.com")?.isAdmin, true);
  assert.equal(store.get("cat@example.com")?.status, "active");
  assert.equal(store.get("cat@example.com")?.createdAt, 2_000);
});

test("starts are counted over a rolling 24 hours and kept across restarts; a damaged file stops the store without quoting it", () => {
  const path = tempFile();
  const store = new UserStore(path);
  store.signIn("dee@example.com", 0);
  store.recordStart("dee@example.com", 1_000);
  store.recordStart("dee@example.com", 2_000);
  assert.equal(new UserStore(path).startsToday("dee@example.com", 3_000), 2);
  assert.equal(store.startsToday("dee@example.com", 1_000 + DAY), 1, "the first start is more than 24 hours old");
  assert.equal(store.startsToday("nobody@example.com", 0), 0);
  writeFileSync(path, '{"users":[{"email":"secret@example.com"');
  assert.throws(() => new UserStore(path), (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes("secret@"));
  assert.match(readFileSync(path, "utf8"), /secret@/, "the damaged file is left as it was");
  writeFileSync(path, "{}");
  assert.throws(() => new UserStore(path), /not valid JSON/, "valid JSON of the wrong shape is refused the same way");
});

test("the file is readable by the bot user only", () => {
  const path = tempFile();
  new UserStore(path).signIn("eve@example.com", 1_000);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
