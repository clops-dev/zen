import type { MiddlewareHandler, Context } from "hono"
import { sql, withDbResilience } from "../lib/db"
import { env } from "../lib/env"
import { getClientIp } from "../lib/client-ip"

export interface RateLimitDecision {
  allowed: boolean
  count: number
  resetAt: number
}

/** Per-replica in-memory limiter used for unit tests or as a safe fallback. */
export class MemoryRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>()
  private streamSlots = new Map<string, Set<string>>() // key -> Set of slotIds

  check(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    const resetAt = Math.floor(now / windowMs) * windowMs + windowMs
    const existing = this.windows.get(key)
    const entry = !existing || existing.resetAt <= now
      ? { count: 0, resetAt }
      : existing
    entry.count++
    this.windows.set(key, entry)

    // Opportunistic cleanup
    if (this.windows.size > 10_000) {
      for (const [oldKey, old] of this.windows) {
        if (old.resetAt <= now) this.windows.delete(oldKey)
      }
    }
    return { allowed: entry.count <= limit, count: entry.count, resetAt: entry.resetAt }
  }

  acquireStreamSlot(key: string, maxConcurrent: number): { acquired: boolean; slotId?: string } {
    let slots = this.streamSlots.get(key)
    if (!slots) {
      slots = new Set()
      this.streamSlots.set(key, slots)
    }
    if (slots.size >= maxConcurrent) {
      return { acquired: false }
    }
    const slotId = `slot-${Math.random().toString(36).slice(2, 9)}`
    slots.add(slotId)
    return { acquired: true, slotId }
  }

  releaseStreamSlot(key: string, slotId: string): void {
    const slots = this.streamSlots.get(key)
    if (slots) slots.delete(slotId)
  }

  clear(): void {
    this.windows.clear()
    this.streamSlots.clear()
  }
}

export const memoryRateLimiter = new MemoryRateLimiter()

/**
 * Checks and increments rate limit for a given key.
 * Uses atomic Postgres upsert across replicas, or in-memory limiter in tests / fallback.
 */
export async function checkKeyRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitDecision> {
  if (env.RATE_LIMIT_BACKEND === "memory") {
    return memoryRateLimiter.check(key, limit, windowMs, now)
  }

  const windowStart = new Date(Math.floor(now / windowMs) * windowMs)
  const resetAt = windowStart.getTime() + windowMs

  try {
    const rows = await withDbResilience(() => sql`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT (key, window_start) DO UPDATE
        SET count = rate_limits.count + 1
      RETURNING count
    `)
    const count = Number(rows[0]?.count ?? 1)
    return { allowed: count <= limit, count, resetAt }
  } catch (err) {
    // Safe default for gateway: fall back to memory limiter rather than crashing
    console.warn("[rate-limit] Postgres error, falling back to local memory limiter:", err)
    return memoryRateLimiter.check(key, limit, windowMs, now)
  }
}

export const MAX_CONCURRENT_STREAMS_PER_USER = Number(process.env.MAX_CONCURRENT_STREAMS_PER_USER ?? 5)

/**
 * Acquire a concurrency slot for streaming requests.
 * Tracked in Postgres (active_stream_slots) across replicas, or memory in tests.
 */
export async function acquireStreamSlot(
  userId: string,
  maxConcurrent: number = MAX_CONCURRENT_STREAMS_PER_USER,
): Promise<{ acquired: boolean; slotId?: string }> {
  const key = `user:${userId}`
  if (env.RATE_LIMIT_BACKEND === "memory") {
    return memoryRateLimiter.acquireStreamSlot(key, maxConcurrent)
  }

  try {
    // 1. Prune expired slots for this key
    await withDbResilience(() => sql`
      DELETE FROM active_stream_slots WHERE key = ${key} AND expires_at < now()
    `).catch(() => {})

    // 2. Count active
    const rows = await withDbResilience(() => sql`
      SELECT count(*)::int AS cnt FROM active_stream_slots WHERE key = ${key} AND expires_at >= now()
    `)
    const current = Number(rows[0]?.cnt ?? 0)
    if (current >= maxConcurrent) {
      return { acquired: false }
    }

    // 3. Insert slot with 5-minute safety expiration
    const slotRows = await withDbResilience(() => sql`
      INSERT INTO active_stream_slots (key, expires_at)
      VALUES (${key}, now() + interval '5 minutes')
      RETURNING id
    `)
    return { acquired: true, slotId: String(slotRows[0]?.id) }
  } catch (err) {
    // Safe default: fall back to memory limiter
    return memoryRateLimiter.acquireStreamSlot(key, maxConcurrent)
  }
}

/**
 * Release a concurrency slot when a streaming request completes or aborts.
 */
export async function releaseStreamSlot(
  userId: string,
  slotId?: string,
): Promise<void> {
  const key = `user:${userId}`
  if (env.RATE_LIMIT_BACKEND === "memory") {
    if (slotId) memoryRateLimiter.releaseStreamSlot(key, slotId)
    return
  }

  if (slotId) {
    try {
      await withDbResilience(() => sql`
        DELETE FROM active_stream_slots WHERE id = ${slotId}
      `)
    } catch {
      memoryRateLimiter.releaseStreamSlot(key, slotId)
    }
  }
}

/**
 * Rate limit middleware checking TWO independent keys:
 * 1. user:${user.id}
 * 2. ip:${ip}
 *
 * A request is rejected if EITHER limit is exceeded.
 */
export const rateLimit = (
  limit: number,
  windowMs: number,
  ipLimit?: number,
): MiddlewareHandler => async (c, next) => {
  const user = c.var.apiUser
  if (!user) return c.json({ error: "unauthorized" }, 401)

  const ip = getClientIp(c)
  const effectiveIpLimit = ipLimit ?? Math.max(limit, 60)
  const now = Date.now()

  // 1. Check user/API-key limit
  const userDecision = await checkKeyRateLimit(`user:${user.id}`, limit, windowMs, now)
  // 2. Check IP limit independently
  const ipDecision = await checkKeyRateLimit(`ip:${ip}`, effectiveIpLimit, windowMs, now)

  const failedDecision = !userDecision.allowed ? userDecision : !ipDecision.allowed ? ipDecision : null

  if (failedDecision) {
    const windowResetAt = Math.floor(failedDecision.resetAt / 1000)
    const retryAfterSec = Math.max(1, windowResetAt - Math.floor(now / 1000))
    const isUserLimit = !userDecision.allowed

    c.header("Retry-After", String(retryAfterSec))
    c.header("X-RateLimit-Limit-Requests", String(isUserLimit ? limit : effectiveIpLimit))
    c.header("X-RateLimit-Remaining-Requests", "0")
    c.header("X-RateLimit-Reset-Requests", String(windowResetAt))

    const errorBody = {
      error: {
        message: `Rate limit exceeded: ${isUserLimit ? limit : effectiveIpLimit} requests per ${Math.round(windowMs / 1000)}s window. Please retry after ${retryAfterSec}s.`,
        type: "rate_limit_exceeded",
        code: "rate_limit_exceeded",
        retry_after: retryAfterSec,
      },
    }

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
}
