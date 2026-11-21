const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https anywhere; plain http only on this machine, for development. */
export function webhookProtocolOk(u: URL): boolean {
  return u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname));
}

/** Comma-separated URLs reduced to their origins; entries that are not URLs are reported. */
export function parseOrigins(text: string | undefined): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const part of (text ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    try {
      origins.push(new URL(part).origin);
    } catch {
      invalid.push(part);
    }
  }
  return { origins, invalid };
}

/**
 * Where one recording's webhooks go: the requested URL when its origin is allowed (WEBHOOK_ALLOWED_ORIGINS or the
 * origin of WEBHOOK_URL), else WEBHOOK_URL. An API key must not be able to make the engine post to any host it likes.
 */
export function resolveWebhookUrl(
  requested: string | undefined,
  c: { WEBHOOK_URL?: string; WEBHOOK_ALLOWED_ORIGINS: { origins: string[] } },
): { url: string | undefined } | { error: "webhook_url_not_allowed" } {
  if (requested === undefined) return { url: c.WEBHOOK_URL };
  let u: URL;
  try {
    u = new URL(requested);
  } catch {
    return { error: "webhook_url_not_allowed" };
  }
  const allowed = new Set(c.WEBHOOK_ALLOWED_ORIGINS.origins);
  if (c.WEBHOOK_URL) allowed.add(new URL(c.WEBHOOK_URL).origin);
  return webhookProtocolOk(u) && allowed.has(u.origin) ? { url: u.href } : { error: "webhook_url_not_allowed" };
}
