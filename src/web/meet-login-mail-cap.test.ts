import { test } from "node:test";
import assert from "node:assert/strict";
import { mockEmail, mockR2, sentEmails } from "../test/setup.js";

mockR2();
mockEmail();
process.env.TRUST_PROXY = "true";
process.env.MEET_LOGIN_MAIL_DAILY_CAP = "4";
const { createApp } = await import("./server.js");
const { users } = await import("../users/store.js");

const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
let ip = 0;
const askLink = (email: string) =>
  app.request("/meet/login", {
    method: "POST",
    body: new URLSearchParams({ email }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.3.0.${++ip}`, origin: "https://meet.example.com" },
  });

test("after MEET_LOGIN_MAIL_DAILY_CAP login emails in 24 hours, nobody gets a link, existing accounts included, and the answer stays the same", async () => {
  users().signIn("kim@example.com", Date.now());
  users().signIn("lee@example.com", Date.now());
  const normal = await askLink("new1@example.com");
  const normalText = await normal.text();
  for (const email of ["kim@example.com", "new2@example.com", "lee@example.com"]) assert.equal((await askLink(email)).status, 200);
  assert.equal(sentEmails.length, 4);
  for (const email of ["kim@example.com", "new3@example.com"]) {
    const capped = await askLink(email);
    assert.equal(capped.status, normal.status, email);
    assert.equal(await capped.text(), normalText, `${email}: the same answer, so the cap reveals nothing`);
  }
  assert.equal(sentEmails.length, 4, "no email over the cap");
});
