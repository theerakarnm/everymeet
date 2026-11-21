/** Email address helpers. Pure, so they are unit testable. */

const ADDRESS_RE = /^[^\s@<>()[\]",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The lowercased address, or undefined when the text is not one plain address. Accepts a "mailto:" prefix (iCal). */
export function normalizeEmail(text: string): string | undefined {
  const e = text.trim().replace(/^mailto:/i, "").toLowerCase();
  return e.length <= 254 && ADDRESS_RE.test(e) ? e : undefined;
}

/** Splits on commas, semicolons, and whitespace; returns unique valid addresses and the entries that are not addresses. */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const emails = new Set<string>();
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const e = normalizeEmail(part);
    if (e) emails.add(e);
    else invalid.push(part);
  }
  return { emails: [...emails], invalid };
}

/** Who may use the /meet page and whose calendar events are recorded: exact addresses, and whole domains written as "@example.com". */
export interface Allowlist {
  emails: string[];
  domains: string[];
}

export function parseAllowlist(text: string | undefined): Allowlist {
  const a: Allowlist = { emails: [], domains: [] };
  for (const part of (text ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const p = part.toLowerCase();
    if (p.startsWith("@")) a.domains.push(p.slice(1));
    else a.emails.push(p);
  }
  return a;
}

/** Entries that are neither an address nor an "@domain"; config refuses to start with any. */
export function invalidAllowlistEntries(a: Allowlist): string[] {
  return [...a.emails.filter((e) => !normalizeEmail(e)), ...a.domains.filter((d) => !DOMAIN_RE.test(d)).map((d) => `@${d}`)];
}

/** Exact address match, or the address's domain is listed (subdomains are not). */
export function isAllowed(email: string, a: Allowlist): boolean {
  const e = email.toLowerCase();
  return a.emails.includes(e) || a.domains.includes(e.slice(e.lastIndexOf("@") + 1));
}
