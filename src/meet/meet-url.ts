const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Accepts a Google Meet link or a bare meeting code and returns the canonical link.
 * Anything else is refused, so the recorder only ever opens meet.google.com.
 */
export function parseMeetUrl(input: string): { url: string; code: string } | undefined {
  const text = input.trim().toLowerCase();
  let code = text;
  if (!CODE_RE.test(text)) {
    let url: URL;
    try {
      url = new URL(text.includes("://") ? text : `https://${text}`);
    } catch {
      return undefined;
    }
    if (url.hostname !== "meet.google.com") return undefined;
    code = url.pathname.replace(/^\/+|\/+$/g, "");
  }
  return CODE_RE.test(code) ? { url: `https://meet.google.com/${code}`, code } : undefined;
}
