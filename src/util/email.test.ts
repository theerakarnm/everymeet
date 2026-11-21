import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidAllowlistEntries, isAllowed, normalizeEmail, parseAllowlist, parseEmailList } from "./email.js";

test("addresses are lowercased, mailto: is accepted, and anything else is refused", () => {
  assert.equal(normalizeEmail(" Bob@Example.COM "), "bob@example.com");
  assert.equal(normalizeEmail("mailto:carol@planthia.test"), "carol@planthia.test");
  for (const bad of ["", "bob", "bob@", "@example.com", "Bob <bob@example.com>", "a b@example.com", "bob@localhost"]) {
    assert.equal(normalizeEmail(bad), undefined, bad);
  }
});

test("a typed list of extra recipients is split, deduplicated, and its bad entries are reported", () => {
  assert.deepEqual(parseEmailList("a@example.com, B@example.com;\nb@example.com  nope"), { emails: ["a@example.com", "b@example.com"], invalid: ["nope"] });
  assert.deepEqual(parseEmailList("   "), { emails: [], invalid: [] });
});

test("the allowlist matches exact addresses and whole domains, not subdomains", () => {
  const a = parseAllowlist("Alice@Example.com, @planthia.test");
  assert.deepEqual(a, { emails: ["alice@example.com"], domains: ["planthia.test"] });
  assert.equal(isAllowed("ALICE@example.com", a), true);
  assert.equal(isAllowed("bob@example.com", a), false);
  assert.equal(isAllowed("carol@planthia.test", a), true);
  assert.equal(isAllowed("dave@eu.planthia.test", a), false);
  assert.equal(isAllowed("mallory@planthia.test.evil.test", a), false);
  assert.deepEqual(parseAllowlist(undefined), { emails: [], domains: [] });
  assert.deepEqual(invalidAllowlistEntries(parseAllowlist("ok@example.com, nope, @bad_domain")), ["nope", "@bad_domain"]);
});
