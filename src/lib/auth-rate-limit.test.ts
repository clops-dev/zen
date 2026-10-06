import { describe, test, expect, beforeEach } from "bun:test"
import {
  checkAuthRateLimit,
  resetAuthRateLimit,
  canGrantWelcomeCredit,
  canonicalEmailAlreadyGranted,
  recordWelcomeGrant,
} from "./auth-rate-limit"
import { setSql } from "./db"

describe("Auth Rate Limiter", () => {
  // In-memory table for auth_rate_limits and welcome_grants
  interface RlRow {
    key_type: string
    key_value: string
    endpoint: string
    attempt_count: number
    locked_until: Date | null
    window_start: Date
  }

  interface WelcomeGrantRow {
    user_id: string
    canonical_email: string
    ip_address: string
    granted_at: Date
  }

  let rlRows: RlRow[] = []
  let wgRows: WelcomeGrantRow[] = []

  beforeEach(() => {
    rlRows = []
    wgRows = []

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // SELECT auth_rate_limits
      if (q.includes("from auth_rate_limits")) {
        const [kt, kv, ep] = values
        const row = rlRows.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        return row ? [{ attempt_count: row.attempt_count, locked_until: row.locked_until, window_start: row.window_start }] : []
      }

      // INSERT or ON CONFLICT reset
      if (q.includes("insert into auth_rate_limits")) {
        const [kt, kv, ep] = values
        const existing = rlRows.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (existing) {
          existing.attempt_count = 1
          existing.locked_until = null
          existing.window_start = new Date()
        } else {
          rlRows.push({ key_type: kt, key_value: kv, endpoint: ep, attempt_count: 1, locked_until: null, window_start: new Date() })
        }
        return []
      }

      // UPDATE attempt_count (on failure increment)
      if (q.includes("update auth_rate_limits") && q.includes("attempt_count = ?")) {
        const [newCount, lockedUntil, kt, kv, ep] = values
        const row = rlRows.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (row) {
          row.attempt_count = newCount
          row.locked_until = lockedUntil ?? null
        }
        return []
      }

      // UPDATE attempt_count = 0 (reset on success)
      if (q.includes("update auth_rate_limits") && q.includes("attempt_count = 0")) {
        const [kt, kv, ep] = values
        const row = rlRows.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (row) { row.attempt_count = 0; row.locked_until = null }
        return []
      }

      // Welcome grants
      if (q.includes("from welcome_grants") && q.includes("ip_address = ?")) {
        const [ip, since] = values
        const cnt = wgRows.filter(r => r.ip_address === ip && r.granted_at > since).length
        return [{ cnt }]
      }
      if (q.includes("from welcome_grants") && q.includes("canonical_email = ?")) {
        const [ce] = values
        return wgRows.filter(r => r.canonical_email === ce)
      }
      if (q.includes("insert into welcome_grants")) {
        const [uid, ce, ip] = values
        if (!wgRows.find(r => r.canonical_email === ce)) {
          wgRows.push({ user_id: uid, canonical_email: ce, ip_address: ip, granted_at: new Date() })
        }
        return []
      }

      return []
    }

    setSql(mockSql)
    // Force higher lockout threshold so tests can increment freely
    delete process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER
    delete process.env.AUTH_RL_SIGNUP_LOCKOUT_AFTER
  })

  test("first request is always allowed", async () => {
    const result = await checkAuthRateLimit("login", "ip", "1.2.3.4", true)
    expect(result.allowed).toBe(true)
  })

  test("resets counter on success (resetAuthRateLimit)", async () => {
    // Push some failures
    for (let i = 0; i < 3; i++) {
      await checkAuthRateLimit("login", "ip", "1.2.3.4", true)
    }
    await resetAuthRateLimit("login", "ip", "1.2.3.4")
    const row = rlRows.find(r => r.key_value === "1.2.3.4" && r.endpoint === "login")
    expect(row?.attempt_count).toBe(0)
    expect(row?.locked_until).toBeNull()
  })

  test("enforces lockout after threshold failures", async () => {
    process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER = "3"
    process.env.AUTH_RL_LOGIN_LOCKOUT_MS = String(15 * 60 * 1000)

    for (let i = 0; i < 3; i++) {
      await checkAuthRateLimit("login", "ip", "10.0.0.1", true)
    }
    // 4th attempt should be locked
    const result = await checkAuthRateLimit("login", "ip", "10.0.0.1", true)
    expect(result.allowed).toBe(false)
    expect((result.retryAfterMs ?? 0) > 0).toBe(true)

    delete process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER
    delete process.env.AUTH_RL_LOGIN_LOCKOUT_MS
  })

  test("welcome grant: allowed on first IP request", async () => {
    const ok = await canGrantWelcomeCredit("5.5.5.5")
    expect(ok).toBe(true)
  })

  test("welcome grant: blocked after per-IP limit reached", async () => {
    process.env.WELCOME_GRANTS_PER_IP_PER_24H = "2"
    // Simulate 2 previous grants from this IP
    wgRows.push({ user_id: "u1", canonical_email: "a@x.com", ip_address: "6.6.6.6", granted_at: new Date() })
    wgRows.push({ user_id: "u2", canonical_email: "b@x.com", ip_address: "6.6.6.6", granted_at: new Date() })

    const ok = await canGrantWelcomeCredit("6.6.6.6")
    expect(ok).toBe(false)
    delete process.env.WELCOME_GRANTS_PER_IP_PER_24H
  })

  test("canonicalEmailAlreadyGranted: false for new canonical", async () => {
    const res = await canonicalEmailAlreadyGranted("foo@gmail.com")
    expect(res).toBe(false)
  })

  test("canonicalEmailAlreadyGranted: true after recording a grant", async () => {
    await recordWelcomeGrant("user-1", "foo@gmail.com", "1.2.3.4")
    const res = await canonicalEmailAlreadyGranted("foo@gmail.com")
    expect(res).toBe(true)
  })

  test("recordWelcomeGrant is idempotent for same canonical (ON CONFLICT DO NOTHING)", async () => {
    await recordWelcomeGrant("u1", "bar@gmail.com", "1.1.1.1")
    await recordWelcomeGrant("u2", "bar@gmail.com", "2.2.2.2") // should be a no-op
    expect(wgRows.filter(r => r.canonical_email === "bar@gmail.com").length).toBe(1)
  })
})
