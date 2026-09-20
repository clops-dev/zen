import type { MiddlewareHandler } from "hono"
import { sql } from "../lib/db"

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
    const updated = await sql`
      INSERT INTO rate_limit_windows (user_id, ip, window_start, count)
      VALUES (${user.id}, ${ip}, ${windowStart}, 1)
      ON CONFLICT (user_id, ip, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count
    `
    if (updated[0].count > limit) {
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
