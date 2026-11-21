import { createHash, timingSafeEqual } from "node:crypto";

/** One entry of API_KEYS. The name is the client: the tenant boundary of the API. */
export interface ApiKey {
  name: string;
  key: string;
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * "name:key,name:key". A name may appear twice (key rotation); a key may not. Bad entries are reported by
 * their 1-based position only, so a config error never prints a key.
 */
export function parseApiKeys(text: string | undefined): { keys: ApiKey[]; invalid: number[] } {
  const keys: ApiKey[] = [];
  const invalid: number[] = [];
  const parts = (text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  parts.forEach((part, i) => {
    const at = part.indexOf(":");
    const name = part.slice(0, at);
    const key = part.slice(at + 1);
    if (at > 0 && NAME_RE.test(name) && KEY_RE.test(key) && !keys.some((k) => k.key === key)) keys.push({ name, key });
    else invalid.push(i + 1);
  });
  return { keys, invalid };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The client of a valid key. Every key is compared on equal-length digests, so timing tells neither which key nor its length. */
export function findClient(token: string | undefined, keys: ApiKey[]): string | undefined {
  if (!token) return undefined;
  const given = digest(token);
  let found: string | undefined;
  for (const k of keys) if (timingSafeEqual(given, digest(k.key)) && found === undefined) found = k.name;
  return found;
}
