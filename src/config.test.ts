import { test } from "node:test";
import assert from "node:assert/strict";
import { apiEnabled, meetPageEnabled, parseConfig } from "./config.js";

const base = {
  R2_ACCOUNT_ID: "x", R2_ACCESS_KEY_ID: "x", R2_SECRET_ACCESS_KEY: "x", R2_BUCKET: "x",
  OPENROUTER_API_KEY: "x", PUBLIC_BASE_URL: "https://meet.example.com", SESSION_SECRET: "s".repeat(40),
};
const recorder = { MEET_RECORDER_URL: "https://meet-recorder.example.com", MEET_RECORDER_TOKEN: "m".repeat(40) };
const KEY = "k".repeat(40);
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const errorOf = (env: Record<string, string>) => {
  try {
    parseConfig(env);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

test("an engine with only the API needs no Discord app, no email sender, and no allowlist; the /meet page needs both", () => {
  const apiOnly = parseConfig({ ...base, ...recorder, API_KEYS: `service:${KEY}` });
  assert.equal(meetPageEnabled(apiOnly), false);
  assert.equal(apiEnabled(apiOnly), true);
  assert.match(errorOf({ ...base, ...recorder }), /ALLOWED_EMAILS \(the \/meet page\) or API_KEYS/);
  assert.match(errorOf({ ...base, ...recorder, ALLOWED_EMAILS: "@example.com" }), /RESEND_API_KEY/);
  assert.match(errorOf({ ...base, API_KEYS: `service:${KEY}` }), /API_KEYS: the API starts Google Meet recordings/);
  assert.match(errorOf(base), /nothing to run/);
  assert.equal(errorOf({ ...base, DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "x" }), "", "a Discord-only engine is fine");
  assert.match(errorOf({ ...base, DISCORD_TOKEN: "x" }), /set DISCORD_TOKEN and DISCORD_CLIENT_ID together/);
});

test("bad API keys and webhook settings are refused, and the message never contains a key", () => {
  const msg = errorOf({ ...base, ...recorder, API_KEYS: `service:${KEY},oops:tooshort` });
  assert.match(msg, /API_KEYS: entry 2 is not <name>:<key>/);
  assert.ok(!msg.includes("tooshort") && !msg.includes(KEY));
  const withApi = { ...base, ...recorder, API_KEYS: `service:${KEY}` };
  assert.match(errorOf({ ...withApi, WEBHOOK_URL: "https://service.example.com/h" }), /WEBHOOK_SECRET: webhooks are signed/);
  assert.match(errorOf({ ...withApi, WEBHOOK_URL: "http://service.example.com/h", WEBHOOK_SECRET: SECRET }), /WEBHOOK_URL: must be https/);
  const typo = errorOf({ ...withApi, WEBHOOK_URL: "not a url/secret-token", WEBHOOK_SECRET: SECRET });
  assert.match(typo, /Invalid environment configuration[\s\S]*WEBHOOK_URL/, "a listed problem, not a crash");
  assert.ok(!typo.includes("secret-token"), "the value is never echoed");
  assert.equal(errorOf({ ...withApi, WEBHOOK_URL: "http://localhost:9999/h", WEBHOOK_SECRET: SECRET }), "");
});
