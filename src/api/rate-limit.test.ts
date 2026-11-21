import { test } from "node:test";
import assert from "node:assert/strict";
import { mockEmail, mockR2 } from "../test/setup.js";

mockR2();
mockEmail();
process.env.API_RATE_LIMIT_PER_MIN = "3";
const { createApp } = await import("../web/server.js");
const app = createApp({ startMeet: async () => { throw new Error("not used"); } });
const list = (key: string) => app.request("/api/v1/recordings?ownerId=team-1", { headers: { authorization: `Bearer ${key}` } });

test("each API client has its own requests-per-minute limit", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await list("k".repeat(40))).status, 200);
  const limited = await list("k".repeat(40));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal((await list("o".repeat(40))).status, 200, "the other client is not limited");
});
