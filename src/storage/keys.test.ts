import { test } from "node:test";
import assert from "node:assert/strict";
import { keys } from "./keys.js";

test("owner index keys sort newest first under the owner's prefix and end in the meeting id", () => {
  const older = keys.ownerIndex("service", "team-1", Date.UTC(2026, 10, 1), "AAAAAAAAAAAAAA-_");
  const newer = keys.ownerIndex("service", "team-1", Date.UTC(2026, 10, 2), "BBBBBBBBBBBBBBBB");
  assert.deepEqual([older, newer].sort(), [newer, older]);
  assert.ok(newer.startsWith(keys.ownerPrefix("service", "team-1")));
  const last = older.slice(older.lastIndexOf("/") + 1);
  assert.equal(last.slice(14), "AAAAAAAAAAAAAA-_");
});
