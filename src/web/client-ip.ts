import { type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.js";

export function clientIp(c: Context): string {
  if (config().TRUST_PROXY) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}
