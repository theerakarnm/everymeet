import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrigins, resolveWebhookUrl } from "./webhook-url.js";

test("allowed origins parse to their origin form, and entries that are not URLs are reported", () => {
  assert.deepEqual(parseOrigins("https://a.example.com/x, http://localhost:9999, nope"), {
    origins: ["https://a.example.com", "http://localhost:9999"],
    invalid: ["nope"],
  });
});

test("a requested webhook URL must be https, or http on localhost, on an allowed origin; without one the default is used", () => {
  const c = { WEBHOOK_URL: "https://service.example.com/hooks", WEBHOOK_ALLOWED_ORIGINS: parseOrigins("https://other.example.com, http://127.0.0.1:9999") };
  assert.deepEqual(resolveWebhookUrl(undefined, c), { url: "https://service.example.com/hooks" });
  assert.deepEqual(resolveWebhookUrl("https://service.example.com/t/1", c), { url: "https://service.example.com/t/1" });
  assert.deepEqual(resolveWebhookUrl("https://other.example.com/h", c), { url: "https://other.example.com/h" });
  assert.deepEqual(resolveWebhookUrl("http://127.0.0.1:9999/h", c), { url: "http://127.0.0.1:9999/h" });
  for (const bad of ["https://evil.test/h", "http://other.example.com/h", "ftp://other.example.com/", "not a url"]) {
    assert.deepEqual(resolveWebhookUrl(bad, c), { error: "webhook_url_not_allowed" }, bad);
  }
  assert.deepEqual(resolveWebhookUrl(undefined, { WEBHOOK_ALLOWED_ORIGINS: parseOrigins(undefined) }), { url: undefined });
});
