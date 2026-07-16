import type { MiddlewareHandler } from "hono"
import { sql } from "../lib/db"

export const rateLimit = (limit: number, windowMs: number): MiddlewareHandler => async (c, next) => {
  const user = c.var.apiUser
  if (!user) return c.json({ error: "unauthorized" }, 401)

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"

  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs)

  try {
    const updated = await sql`
      INSERT INTO rate_limit_windows (user_id, ip, window_start, count)
      VALUES (${user.id}, ${ip}, ${windowStart}, 1)
      ON CONFLICT (user_id, ip, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count
    `
    if (updated[0].count > limit) {
      c.header("Retry-After", String(Math.ceil(windowMs / 1000)))
      return c.json({ error: "too many requests" }, 429)
    }
    return next()
  } catch (err) {
    console.error("[rate-limit] error:", err)
    return c.json({ error: "internal server error" }, 500)
  }
}
