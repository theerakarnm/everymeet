import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPin(pin: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(pin, salt, 32).toString("base64url");
  return { salt, hash };
}

export function verifyPin(pin: string, salt: string, hash: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  const a = scryptSync(pin, salt, 32);
  const b = Buffer.from(hash, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Unguessable meeting id used in R2 keys and the playback URL. */
export function newSessionId(): string {
  return randomBytes(12).toString("base64url");
}

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** Signed cookie value: "<expiresAt>.<hmac>" bound to one meeting id. */
export function signAccess(sessionId: string, secret: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const mac = createHmac("sha256", secret).update(`${sessionId}.${exp}`).digest("base64url");
  return `${exp}.${mac}`;
}

export function verifyAccess(sessionId: string, value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const [expStr, mac] = value.split(".");
  const exp = Number(expStr);
  if (!mac || !Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac("sha256", secret).update(`${sessionId}.${exp}`).digest();
  const given = Buffer.from(mac, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
