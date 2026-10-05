/** Fixed-window request counters for abuse protection on the public demo. */
import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { rateLimits } from "../schema";
import { toIsoUtc } from "../time";

export interface RateLimitResult {
  /** False once the window's budget is spent. */
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** When the current window ends and the counter starts again. */
  resetAt: string;
}

/**
 * Counts one hit against `key` and reports whether it is within `limit` hits per window.
 *
 * A window opens at a key's first hit and lasts `windowSeconds`; the first hit after it has
 * ended opens the next one. The whole decision is one upsert, so concurrent requests are
 * counted exactly once each and can never both take the last slot.
 */
export function hitRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  now: Date,
): Promise<RateLimitResult> {
  return dbCall("hitRateLimit", async () => {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer, received ${limit}`);
    }
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new RangeError(`windowSeconds must be a positive number, received ${windowSeconds}`);
    }
    const windowMs = windowSeconds * 1000;
    const nowIso = now.toISOString();
    // A stored window that started at or before this instant has run its full length.
    const expiredBefore = new Date(now.getTime() - windowMs).toISOString();
    const windowExpired = sql`${rateLimits.windowStart} <= ${expiredBefore}::timestamptz`;
    const [row] = await db
      .insert(rateLimits)
      .values({ key, windowStart: nowIso, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        // Both expressions see the row as it was before the update, so they always agree.
        set: {
          count: sql`case when ${windowExpired} then 1 else ${rateLimits.count} + 1 end`,
          windowStart: sql`case when ${windowExpired} then ${nowIso}::timestamptz else ${rateLimits.windowStart} end`,
        },
      })
      .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });
    const windowStartMs = new Date(toIsoUtc(row.windowStart)).getTime();
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      resetAt: new Date(windowStartMs + windowMs).toISOString(),
    };
  });
}
