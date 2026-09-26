import type { MiddlewareHandler } from "hono"
import { sql } from "../lib/db"
import { env } from "../lib/env"

export interface RateLimitDecision {
  allowed: boolean
  count: number
  resetAt: number
}

/** Per-replica fixed-window limiter. It deliberately preserves the current
 * user+IP semantics while removing the hot-path Postgres upsert. */
export class MemoryRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>()

  check(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    const resetAt = Math.floor(now / windowMs) * windowMs + windowMs
    const existing = this.windows.get(key)
    const entry = !existing || existing.resetAt <= now
      ? { count: 0, resetAt }
      : existing
    entry.count++
    this.windows.set(key, entry)
    // Opportunistic bounded cleanup avoids a timer and keeps the hot path
    // allocation-free in the normal case.
    if (this.windows.size > 10_000) {
      for (const [oldKey, old] of this.windows) {
        if (old.resetAt <= now) this.windows.delete(oldKey)
      }
    }
    return { allowed: entry.count <= limit, count: entry.count, resetAt: entry.resetAt }
  }

  clear(): void { this.windows.clear() }
}

export const memoryRateLimiter = new MemoryRateLimiter()

export const rateLimit = (limit: number, windowMs: number): MiddlewareHandler => async (c, next) => {
  const user = c.var.apiUser
  if (!user) return c.json({ error: "unauthorized" }, 401)

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"

  const now = Date.now()
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs)
  // Seconds until the current window resets — so clients know exactly when to retry.
  const windowResetAt = Math.floor((windowStart.getTime() + windowMs) / 1000)
  const retryAfterSec = Math.max(1, windowResetAt - Math.floor(now / 1000))

  try {
    const memoryKey = `${user.id}:${ip}`
    const decision = env.RATE_LIMIT_BACKEND === "memory"
      ? memoryRateLimiter.check(memoryKey, limit, windowMs, now)
      : null
    const count = decision
      ? decision.count
      : (await sql`
      INSERT INTO rate_limit_windows (user_id, ip, window_start, count)
      VALUES (${user.id}, ${ip}, ${windowStart}, 1)
      ON CONFLICT (user_id, ip, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count
    `)[0].count
    if (count > limit) {
      // OpenAI-compatible rate-limit error shape so clients can handle it correctly.
      c.header("Retry-After", String(retryAfterSec))
      c.header("X-RateLimit-Limit-Requests", String(limit))
      c.header("X-RateLimit-Remaining-Requests", "0")
      c.header("X-RateLimit-Reset-Requests", String(windowResetAt))

      const errorBody = {
        error: {
          message: `Rate limit exceeded: ${limit} requests per ${Math.round(windowMs / 1000)}s window. Please retry after ${retryAfterSec}s.`,
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
          retry_after: retryAfterSec,
        },
      }

      // For streaming clients (they set Accept: text/event-stream), send an SSE error event.
      const acceptHeader = c.req.header("accept") ?? ""
      if (acceptHeader.includes("text/event-stream")) {
        const sseBody = `data: ${JSON.stringify(errorBody)}\n\ndata: [DONE]\n\n`
        return new Response(sseBody, {
          status: 429,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Retry-After": String(retryAfterSec),
          },
        })
      }

      return c.json(errorBody, 429)
    }
    return next()
  } catch (err) {
    console.error("[rate-limit] error:", err)
    return c.json({ error: "internal server error" }, 500)
  }
}
