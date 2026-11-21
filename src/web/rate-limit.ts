/** At most `max` attempts per key in a fixed window, in memory. */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one attempt; false when the key has used up its attempts in the current window. */
  take(key: string): boolean {
    const now = Date.now();
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
    const hit = this.hits.get(key) ?? { count: 0, resetAt: now + this.windowMs };
    hit.count++;
    this.hits.set(key, hit);
    return hit.count <= this.max;
  }
}
