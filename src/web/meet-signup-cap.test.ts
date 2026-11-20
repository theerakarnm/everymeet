import { test } from "node:test";
import assert from "node:assert/strict";
import { mockEmail, mockR2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
process.env.TRUST_PROXY = "true";
const { createApp } = await import("./server.js");
const { users } = await import("../users/store.js");

const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
let ip = 0;
const askLink = (email: string) =>
  app.request("/meet/login", {
    method: "POST",
    body: new URLSearchParams({ email }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.2.${Math.floor(++ip / 250)}.${ip % 250}`, origin: "https://meet.example.com" },
  });

test("after 50 links to new addresses in 24 hours, new addresses get the same answer but no email, and existing accounts still get theirs", async () => {
  users().signIn("kept@planthia.test", Date.now());
  for (let i = 0; i < 50; i++) assert.equal((await askLink(`n${i}@nowhere.test`)).status, 200);
  assert.equal(sentEmails.length, 50);
  const capped = await askLink("n50@nowhere.test");
  assert.equal(capped.status, 200);
  assert.match(await capped.text(), /ตรวจอีเมลของคุณ/, "the same answer, so the cap reveals nothing about any address");
  assert.equal(sentEmails.length, 50, "no email to a new address over the cap");
  await askLink("kept@planthia.test");
  assert.equal(sentEmails.at(-1)?.to, "kept@planthia.test", "an existing account can still sign in");
});
