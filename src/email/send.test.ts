import { test } from "node:test";
import assert from "node:assert/strict";
import "../test/setup.js";
import { sendEmail } from "./send.js";

const KEY = `re_${"e".repeat(40)}`; // the test env value of RESEND_API_KEY
const mail = { to: "bob@example.com", subject: "สรุปการประชุม", text: "ข้อความ", html: "<p>ข้อความ</p>" };

function resend(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  }) as typeof fetch;
  return calls;
}

test("one email goes to the Resend API from the configured sender, with a User-Agent", async () => {
  const calls = resend(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  await sendEmail(mail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(headers.get("user-agent"), "everymeet-bot/1.0");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    from: "บอทบันทึกการประชุม <minutes@example.com>",
    to: "bob@example.com",
    subject: "สรุปการประชุม",
    text: "ข้อความ",
    html: "<p>ข้อความ</p>",
  });
});

test("a rate-limited send throws with the status so the log shows why", async () => {
  resend(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." });
  await assert.rejects(sendEmail(mail), /HTTP 429 rate_limit_exceeded/);
});

test("a refused send throws with Resend's error name and message and never the key", async () => {
  resend(403, { statusCode: 403, name: "validation_error", message: "The example.com domain is not verified." });
  await assert.rejects(
    sendEmail(mail),
    (err: Error) => /HTTP 403 validation_error: The example.com domain is not verified/.test(err.message) && !err.message.includes(KEY),
  );
});
