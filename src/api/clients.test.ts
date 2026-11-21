import { test } from "node:test";
import assert from "node:assert/strict";
import { findClient, parseApiKeys } from "./clients.js";

const K1 = "a".repeat(32);
const K2 = "b".repeat(40);
const K3 = "c".repeat(32);

test("API keys parse as name:key pairs, a name may hold two keys, and bad entries are reported by position only", () => {
  const p = parseApiKeys(`service:${K1}, service:${K2},ops:${K3}, Bad Name:${K1}x, short:abc, dup:${K1}`);
  assert.deepEqual(p.keys, [
    { name: "service", key: K1 },
    { name: "service", key: K2 },
    { name: "ops", key: K3 },
  ]);
  assert.deepEqual(p.invalid, [4, 5, 6]);
  assert.deepEqual(parseApiKeys(undefined), { keys: [], invalid: [] });
});

test("a token finds its client; unknown, empty, shortened, and extended tokens find none", () => {
  const { keys } = parseApiKeys(`service:${K1},service:${K2},ops:${K3}`);
  assert.equal(findClient(K2, keys), "service");
  assert.equal(findClient(K3, keys), "ops");
  for (const t of [undefined, "", K1.slice(0, 31), `${K1}x`]) assert.equal(findClient(t, keys), undefined, String(t));
});
