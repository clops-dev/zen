import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"
import { auth } from "./auth"
import { setSql } from "../lib/db"
import { canonicalEmail } from "../lib/email"
import { hashPassword } from "../lib/password"
import { issueSession, SESSION_COOKIE, verifySession } from "../lib/session"
import { invalidateActiveUserCache } from "../lib/active-user"
import { issuePasswordResetToken } from "../lib/email-verification"
import { canGrantWelcomeCredit, canonicalEmailAlreadyGranted, recordWelcomeGrant } from "../lib/auth-rate-limit"

describe("Anti-Abuse & Attack Simulation Tests", () => {
  interface MockUser {
    id: string
    email: string
    canonical_email: string
    password_hash: string
    role: "user" | "admin"
    status: string
    email_verified: boolean
  }

  let users: MockUser[] = []
  let welcomeGrants: Array<{ id: string; user_id: string; canonical_email: string; ip_address: string; granted_at: Date }> = []
  let rateLimits: Array<{ key_type: string; key_value: string; endpoint: string; attempt_count: number; locked_until: Date | null; window_start: Date }> = []
  let auditLogs: Array<{ action: string; ip: string | null; metadata: any }> = []
  let sessions: Array<{ id: string; token_hash: string; user_id: string; revoked: boolean; expires_at: Date; last_seen_at: Date }> = []
  let resetTokens: Array<{ id: string; user_id: string; token_hash: string; used: boolean; expires_at: Date }> = []

  const app = new Hono()
  app.route("/auth", auth)

  beforeEach(() => {
    process.env.HIBP_ENABLED = "false"
    users = []
    welcomeGrants = []
    rateLimits = []
    auditLogs = []
    sessions = []
    resetTokens = []
    invalidateActiveUserCache()

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // insert into users (signup)
      if (q.includes("insert into users")) {
        const [em, canEm, pwHash, role, status, ev] = values
        // check canonical uniqueness
        if (users.some(u => u.canonical_email === canEm || u.email === em)) {
          // unique violation / ON CONFLICT DO NOTHING
          return []
        }
        const u: MockUser = {
          id: `u-${Math.random().toString(36).slice(2, 8)}`,
          email: em,
          canonical_email: canEm,
          password_hash: pwHash,
          role: role ?? "user",
          status: status ?? "active",
          email_verified: Boolean(ev),
        }
        users.push(u)
        return [{ id: u.id }]
      }

      // users by lower(email)
      if (q.includes("from users") && q.includes("lower(email) = ?")) {
        const em = String(values[0]).toLowerCase()
        return users.filter(u => u.email.toLowerCase() === em).map(u => ({ ...u }))
      }

      // users by id
      if (q.includes("from users") && q.includes("id = ?")) {
        const uid = values[0]
        return users.filter(u => u.id === uid).map(u => ({ ...u }))
      }

      // users by u.id (getActiveUser)
      if (q.includes("from users") && q.includes("u.id = ?")) {
        const uid = values[0]
        const u = users.find(x => x.id === uid)
        if (!u) return []
        return [{
          id: u.id,
          email: u.email,
          role: u.role,
          user_status: u.status,
          sub_status: "active",
        }]
      }

      // welcome_grants lookup by canonical_email
      if (q.includes("from welcome_grants") && q.includes("canonical_email = ?")) {
        const canEm = values[0]
        return welcomeGrants.filter(g => g.canonical_email === canEm).map(g => ({ ...g }))
      }

      // welcome_grants count by ip
      if (q.includes("from welcome_grants") && q.includes("ip_address = ?")) {
        const ip = values[0]
        const since = values[1]
        const cnt = welcomeGrants.filter(g => g.ip_address === ip && g.granted_at > since).length
        return [{ cnt }]
      }

      // insert into welcome_grants
      if (q.includes("insert into welcome_grants")) {
        const [uid, canEm, ip] = values
        if (welcomeGrants.some(g => g.canonical_email === canEm)) {
          return []
        }
        const row = { id: `g-${Math.random()}`, user_id: uid, canonical_email: canEm, ip_address: ip, granted_at: new Date() }
        welcomeGrants.push(row)
        return [row]
      }

      // auth_rate_limits select
      if (q.includes("from auth_rate_limits") && q.includes("key_type = ?")) {
        const [kt, kv, ep] = values
        return rateLimits.filter(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep).map(r => ({ ...r }))
      }

      // auth_rate_limits upsert on conflict
      if (q.includes("insert into auth_rate_limits")) {
        const [kt, kv, ep, initCount, lockedUntil] = values
        let row = rateLimits.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (!row) {
          row = {
            key_type: kt,
            key_value: kv,
            endpoint: ep,
            attempt_count: initCount ?? 1,
            locked_until: lockedUntil ? new Date(lockedUntil) : null,
            window_start: new Date(),
          }
          rateLimits.push(row)
        } else {
          row.attempt_count += 1
          if (lockedUntil) row.locked_until = new Date(lockedUntil)
        }
        return [row]
      }

      // auth_rate_limits increment
      if (q.includes("update auth_rate_limits") && q.includes("set attempt_count = ?")) {
        const [newCount, lockedUntil, kt, kv, ep] = values
        let row = rateLimits.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (row) {
          row.attempt_count = newCount
          row.locked_until = lockedUntil ? new Date(lockedUntil) : null
        }
        return []
      }

      // auth_rate_limits reset
      if (q.includes("update auth_rate_limits") && q.includes("attempt_count = 0")) {
        const [kt, kv, ep] = values
        const row = rateLimits.find(r => r.key_type === kt && r.key_value === kv && r.endpoint === ep)
        if (row) {
          row.attempt_count = 0
          row.locked_until = null
        }
        return []
      }

      // sessions insert
      if (q.includes("insert into sessions")) {
        const [th, uid, ip_h, ua_h, exp] = values
        const s = {
          id: `sess-${Math.random()}`,
          token_hash: th,
          user_id: uid,
          revoked: false,
          expires_at: new Date(exp),
          last_seen_at: new Date(),
        }
        sessions.push(s)
        return [s]
      }

      // sessions lookup
      if (q.includes("from sessions") && q.includes("token_hash = ?")) {
        const th = values[0]
        return sessions.filter(s => s.token_hash === th).map(s => ({ ...s }))
      }

      // sessions revoke all
      if (q.includes("update sessions") && q.includes("user_id = ?")) {
        const uid = values[0]
        for (const s of sessions) {
          if (s.user_id === uid) s.revoked = true
        }
        return []
      }

      // password_reset_tokens insert
      if (q.includes("insert into password_reset_tokens")) {
        const [uid, th] = values
        const row = { id: `pr-${Math.random()}`, user_id: uid, token_hash: th, used: false, expires_at: new Date(Date.now() + 3600000) }
        resetTokens.push(row)
        return [row]
      }

      // password_reset_tokens update / claim
      if (q.includes("update password_reset_tokens") && q.includes("used = true")) {
        const th = values[0]
        const row = resetTokens.find(t => (t.token_hash === th || t.user_id === th) && !t.used)
        if (row) {
          row.used = true
          return [{ user_id: row.user_id }]
        }
        return []
      }

      // update users password_hash
      if (q.includes("update users") && q.includes("password_hash = ?")) {
        const [pwHash, uid] = values
        const u = users.find(x => x.id === uid)
        if (u) u.password_hash = pwHash
        return []
      }

      // audit insert
      if (q.includes("insert into audit_logs")) {
        auditLogs.push({
          action: values[2],
          ip: values[5] ?? null,
          metadata: values[8] ?? {},
        })
        return []
      }

      // count audit_logs for spikes
      if (q.includes("from audit_logs") && q.includes("count(*)")) {
        return [{ cnt: auditLogs.length }]
      }

      return []
    }

    setSql(mockSql)
  })

  test("Attack scenario 1: 50 variants of user+tag@gmail.com map to same canonical identity and receive at most one welcome grant", async () => {
    // 50 Gmail alias variants
    const baseEmail = "developer@gmail.com"
    const variants: string[] = []
    for (let i = 0; i < 50; i++) {
      const dots = i % 2 === 0 ? "dev.eloper" : "d.e.v.e.l.o.p.e.r"
      variants.push(`${dots}+tag${i}@gmail.com`)
    }

    // All 50 variants MUST canonicalize to the exact same string
    const firstCanonical = canonicalEmail(variants[0])
    expect(firstCanonical).toBe("developer@gmail.com")
    for (const v of variants) {
      expect(canonicalEmail(v)).toBe(firstCanonical)
    }

    // First signup succeeds and creates the user
    const res1 = await app.request("http://localhost:8787/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.1.1.1" },
      body: JSON.stringify({ email: variants[0], password: "ComplexPassword123!" }),
    })
    expect(res1.status).toBe(200)
    expect(users.length).toBe(1)
    const initialUser = users[0]

    // Record welcome grant for the canonical email
    await recordWelcomeGrant(initialUser.id, firstCanonical, "1.1.1.1")
    expect(await canonicalEmailAlreadyGranted(firstCanonical)).toBe(true)

    // Attacker attempts signups across 5 alias variants with rotating IPs
    for (let i = 1; i <= 5; i++) {
      const res = await app.request("http://localhost:8787/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `1.1.1.${i}` },
        body: JSON.stringify({ email: variants[i], password: "ComplexPassword123!" }),
      })
      // Returns non-enumerable 200 without creating a new user row
      expect(res.status).toBe(200)
      // Canonical grant check always confirms already granted
      expect(await canonicalEmailAlreadyGranted(canonicalEmail(variants[i]))).toBe(true)
    }

    // Exactly 1 user row in database (farming blocked)
    expect(users.length).toBe(1)
    // Exactly 1 welcome grant in database
    expect(welcomeGrants.length).toBe(1)
  })

  test("Attack scenario 2: Attacker with disposable-email list and rotating IPs is blocked", async () => {
    const disposableEmails = [
      "bot1@mailinator.com",
      "bot2@tempmail.com",
      "bot3@10minutemail.com",
      "bot4@guerrillamail.com",
      "bot5@trashmail.com",
      "bot6@yopmail.com",
    ]

    for (let i = 0; i < disposableEmails.length; i++) {
      const ip = `198.51.100.${i + 1}` // rotating attacker IP
      const res = await app.request("http://localhost:8787/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ email: disposableEmails[i], password: "StrongPassword123!" }),
      })

      // Must be rejected with 400
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("invalid_request")
    }

    // No users created
    expect(users.length).toBe(0)

    // Abuse audit logs recorded
    const dispLogs = auditLogs.filter(l => l.action.includes("disposable"))
    expect(dispLogs.length).toBeGreaterThanOrEqual(1)
  })

  test("Attack scenario 3: Brute-force simulation triggers lockout without leaking email existence", async () => {
    // Valid registered user
    const pwHash = await hashPassword("realpassword123")
    users.push({
      id: "u-real",
      email: "victim@example.com",
      canonical_email: "victim@example.com",
      password_hash: pwHash,
      role: "user",
      status: "active",
      email_verified: true,
    })

    const targetEmail = "victim@example.com"
    const nonexistentEmail = "nonexistent_victim@example.com"

    // 1. Check identical responses for existing vs non-existing user
    const resExisting = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.99" },
      body: JSON.stringify({ email: targetEmail, password: "wrongpassword" }),
    })
    const bodyExisting = await resExisting.json()

    const resNonExistent = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.99" },
      body: JSON.stringify({ email: nonexistentEmail, password: "wrongpassword" }),
    })
    const bodyNonExistent = await resNonExistent.json()

    // Status code and body must be IDENTICAL (non-enumerable)
    expect(resExisting.status).toBe(401)
    expect(resNonExistent.status).toBe(401)
    expect(bodyExisting).toEqual(bodyNonExistent)

    // 2. Perform repeated failed attempts to trigger lockout
    process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER = "3"
    for (let i = 0; i < 3; i++) {
      await app.request("http://localhost:8787/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.99" },
        body: JSON.stringify({ email: targetEmail, password: "wrongpassword" }),
      })
    }

    // 4th attempt should be locked out with 429
    const resLocked = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.99" },
      body: JSON.stringify({ email: targetEmail, password: "wrongpassword" }),
    })
    expect(resLocked.status).toBe(429)
    const bodyLocked = await resLocked.json()
    expect(bodyLocked.error).toBe("too_many_requests")

    delete process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER
  })

  test("Attack scenario 4: Password reset token single-use enforcement and session revocation", async () => {
    const pwHash = await hashPassword("oldpassword123")
    users.push({
      id: "u-victim",
      email: "victim@example.com",
      canonical_email: "victim@example.com",
      password_hash: pwHash,
      role: "user",
      status: "active",
      email_verified: true,
    })

    // Issue active session for victim
    const sess = await issueSession("u-victim", "user")
    expect(await verifySession(sess.token)).not.toBeNull()

    // Issue reset token
    const rawResetToken = await issuePasswordResetToken("u-victim")

    // First reset succeeds
    const res1 = await app.request("http://localhost:8787/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawResetToken, new_password: "BrandNewPassword123!" }),
    })
    expect(res1.status).toBe(200)

    // Previous session MUST be revoked!
    expect(await verifySession(sess.token)).toBeNull()

    // Second attempt using the same token MUST fail (replay attack)
    const res2 = await app.request("http://localhost:8787/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawResetToken, new_password: "AnotherPassword123!" }),
    })
    expect(res2.status).toBe(400)
    const body2 = await res2.json()
    expect(body2.error).toBe("invalid_or_expired_token")
  })
})
