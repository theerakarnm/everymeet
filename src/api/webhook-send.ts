/** Posts one webhook attempt and returns the HTTP status; throws on a network error or after 10 s. Redirects are not followed. */
export async function postWebhook(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "User-Agent": "everymeet-engine/1.0" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  return res.status;
}
