import { randomBytes } from "node:crypto";

export const LOGIN_LINK_TTL_MS = 15 * 60_000;

/** Unused login links by token. In memory: a restart only voids links nobody used yet. */
const pending = new Map<string, { email: string; expiresAt: number }>();

/** A new single-use token for `email`; the caller puts it in the emailed link and never logs it. */
export function createLoginLink(email: string): string {
  const now = Date.now();
  for (const [token, link] of pending) if (link.expiresAt < now) pending.delete(token);
  const token = randomBytes(32).toString("base64url");
  pending.set(token, { email, expiresAt: now + LOGIN_LINK_TTL_MS });
  return token;
}

/** The email the link was made for, exactly once; an unknown, used, or expired token gives undefined. */
export function consumeLoginLink(token: string): string | undefined {
  const link = pending.get(token);
  pending.delete(token);
  return link && link.expiresAt >= Date.now() ? link.email : undefined;
}
