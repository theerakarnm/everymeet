/** Email address helpers. Pure, so they are unit testable. */

const ADDRESS_RE = /^[^\s@<>()[\]",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

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

