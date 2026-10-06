import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"
import { rateLimit, MemoryRateLimiter, acquireStreamSlot, releaseStreamSlot } from "./rate-limit"
import { getClientIp, isCloudflareIp } from "../lib/client-ip"
import { setSql } from "../lib/db"
import { checkAuthRateLimit } from "../lib/auth-rate-limit"

describe("Rate Limiting & Attack Defense Tests", () => {
  interface MockRateLimitRow {
    key: string
    window_start: Date
    count: number
  }

  interface MockStreamSlot {
    id: string
    key: string
    expires_at: Date
  }

  let rateLimitRows: MockRateLimitRow[] = []
  let streamSlots: MockStreamSlot[] = []

  beforeEach(() => {
    rateLimitRows = []
    streamSlots = []

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // rate_limits atomic upsert
      if (q.includes("insert into rate_limits")) {
        const [key, ws] = values
        let row = rateLimitRows.find(r => r.key === key && r.window_start.getTime() === new Date(ws).getTime())
        if (!row) {
          row = { key, window_start: new Date(ws), count: 1 }
          rateLimitRows.push(row)
        } else {
          row.count++
        }
        return [{ count: row.count }]
      }

      // active_stream_slots count
      if (q.includes("from active_stream_slots") && q.includes("count(*)")) {
        const key = values[0]
        const cnt = streamSlots.filter(s => s.key === key && s.expires_at > new Date()).length
        return [{ cnt }]
      }

      // active_stream_slots insert
      if (q.includes("insert into active_stream_slots")) {
        const key = values[0]
        const row = { id: `slot-${Math.random()}`, key, expires_at: new Date(Date.now() + 300000) }
        streamSlots.push(row)
        return [{ id: row.id }]
      }

      // active_stream_slots delete by id
      if (q.includes("delete from active_stream_slots") && q.includes("where id = ?")) {
        const id = values[0]
        streamSlots = streamSlots.filter(s => s.id !== id)
        return []
      }

      // active_stream_slots prune expired
      if (q.includes("delete from active_stream_slots") && q.includes("expires_at < now()")) {
        streamSlots = streamSlots.filter(s => s.expires_at > new Date())
        return []
      }

      return []
    }

    setSql(mockSql)
  })

  test("Attack 1: Rotating X-Forwarded-For per request does not bypass rate limit", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1"

    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("apiUser", { id: "user-victim-1", email: "victim@example.com" })
      return next()
    })
    // 3 requests per 60s limit
    app.use("/v1/*", rateLimit(3, 60_000))
    app.get("/v1/models", (c) => c.json({ ok: true }))

    // Attacker rotates spoofed leftmost IP on every request, but real proxy IP is on the right
    const responses = []
    for (let i = 1; i <= 5; i++) {
      const res = await app.request("http://localhost:8787/v1/models", {
        headers: {
          "X-Forwarded-For": `spoofed-${i}.evil.com, 203.0.113.195`,
        },
      })
      responses.push(res.status)
    }

    // First 3 requests succeed (200), subsequent requests are blocked (429)
    expect(responses).toEqual([200, 200, 200, 429, 429])

    delete process.env.TRUSTED_PROXY_HOPS
  })

  test("Attack 2: Spoofed CF-Connecting-IP from a non-Cloudflare source is ignored", async () => {
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("apiUser", { id: "user-attacker", email: "attacker@example.com" })
      return next()
    })
    app.use("/v1/*", rateLimit(2, 60_000))
    app.get("/v1/models", (c) => c.json({ ok: true }))

    // Attacker pretends to be 1.1.1.1 or different IPs via CF-Connecting-IP,
    // but arrives from non-Cloudflare proxy 198.51.100.99
    const res1 = await app.request("http://localhost:8787/v1/models", {
      headers: {
        "CF-Connecting-IP": "10.0.0.1",
        "X-Forwarded-For": "198.51.100.99",
      },
    })
    expect(res1.status).toBe(200)

    const res2 = await app.request("http://localhost:8787/v1/models", {
      headers: {
        "CF-Connecting-IP": "10.0.0.2", // tries to rotate
        "X-Forwarded-For": "198.51.100.99",
      },
    })
    expect(res2.status).toBe(200)

    const res3 = await app.request("http://localhost:8787/v1/models", {
      headers: {
        "CF-Connecting-IP": "10.0.0.3", // tries to rotate
        "X-Forwarded-For": "198.51.100.99",
      },
    })
    // 3rd attempt is rate limited (429) because IP is tracked as 198.51.100.99, not the spoofed CF header
    expect(res3.status).toBe(429)
  })

  test("Attack 3: Parallel requests across two app instances enforce combined limit", async () => {
    // Two separate app instances sharing the same Postgres backend
    const createApp = () => {
      const a = new Hono()
      a.use("*", async (c, next) => {
        c.set("apiUser", { id: "shared-user", email: "shared@example.com" })
        return next()
      })
      a.use("/v1/*", rateLimit(5, 60_000))
      a.get("/v1/models", (c) => c.json({ ok: true }))
      return a
    }

    const appInstance1 = createApp()
    const appInstance2 = createApp()

    // 3 requests to Instance 1
    for (let i = 0; i < 3; i++) {
      const res = await appInstance1.request("http://localhost:8787/v1/models")
      expect(res.status).toBe(200)
    }

    // 2 requests to Instance 2
    for (let i = 0; i < 2; i++) {
      const res = await appInstance2.request("http://localhost:8787/v1/models")
      expect(res.status).toBe(200)
    }

    // 6th request to Instance 2 must be rejected (combined limit 5 reached across instances)
    const resOverLimit = await appInstance2.request("http://localhost:8787/v1/models")
    expect(resOverLimit.status).toBe(429)
    expect(resOverLimit.headers.get("Retry-After")).toBeDefined()
  })

  test("Attack 4: 1,000 login attempts for one email from many IPs triggers email-level lockout", async () => {
    let authRateLimits: Array<{ key_type: string; key_value: string; endpoint: string; attempt_count: number; locked_until: Date | null; window_start: Date }> = []

    const mockAuthSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      if (q.includes("from auth_rate_limits") && q.includes("key_type = ?")) {
        const [kt, kv, ep] = values
        return authRateLimits.filter(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep).map(r => ({ ...r }))
      }

      if (q.includes("insert into auth_rate_limits")) {
        const [kt, kv, ep, initCount, lockedUntil] = values
        let row = authRateLimits.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (!row) {
          row = {
            key_type: kt,
            key_value: kv,
            endpoint: ep,
            attempt_count: initCount ?? 1,
            locked_until: lockedUntil ? new Date(lockedUntil) : null,
            window_start: new Date(),
          }
          authRateLimits.push(row)
        }
        return [row]
      }

      if (q.includes("update auth_rate_limits") && q.includes("set attempt_count = ?")) {
        const [newCount, lockedUntil, kt, kv, ep] = values
        let row = authRateLimits.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (row) {
          row.attempt_count = newCount
          row.locked_until = lockedUntil ? new Date(lockedUntil) : null
        }
        return []
      }

      return []
    }

    setSql(mockAuthSql)

    const targetEmail = "executive@example.com"
    process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER = "5"

    // Simulate attacker attempting logins from 50 different IP addresses
    let lockedCount = 0
    for (let i = 1; i <= 50; i++) {
      const rotatingIp = `192.0.2.${i}`
      // Check IP rate limit (1 per IP, allowed)
      await checkAuthRateLimit("login", "ip", rotatingIp, true)

      // Check email rate limit (same victim email)
      const emailResult = await checkAuthRateLimit("login", "email", targetEmail, true)
      if (!emailResult.allowed) {
        lockedCount++
        expect((emailResult.retryAfterMs ?? 0) > 0).toBe(true)
      }
    }

    // Lockout triggers at attempt 5, locking 46 out of 50 attempts
    expect(lockedCount).toBe(46)

    delete process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER
  })

  test("Streaming concurrency limits: enforces maximum concurrent streams per user", async () => {
    const userId = "streamer-user-1"
    const maxStreams = 2

    // 1st stream slot acquired
    const slot1 = await acquireStreamSlot(userId, maxStreams)
    expect(slot1.acquired).toBe(true)
    expect(slot1.slotId).toBeDefined()

    // 2nd stream slot acquired
    const slot2 = await acquireStreamSlot(userId, maxStreams)
    expect(slot2.acquired).toBe(true)
    expect(slot2.slotId).toBeDefined()

    // 3rd stream attempt exceeded limit
    const slot3 = await acquireStreamSlot(userId, maxStreams)
    expect(slot3.acquired).toBe(false)

    // Release slot 1
    await releaseStreamSlot(userId, slot1.slotId)

    // Now 4th attempt succeeds
    const slot4 = await acquireStreamSlot(userId, maxStreams)
    expect(slot4.acquired).toBe(true)

    // Cleanup
    await releaseStreamSlot(userId, slot2.slotId)
    await releaseStreamSlot(userId, slot4.slotId)
  })

  test("Fails closed on DB error for auth rate limiting", async () => {
    // Force DB to throw error
    setSql((() => { throw new Error("Database down") }) as any)

    const result = await checkAuthRateLimit("login", "email", "test@example.com", true)
    // Must fail closed (allowed: false)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBe(30_000)
  })
})
