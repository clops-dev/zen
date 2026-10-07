import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"
import { auth, signMfaTicket } from "./auth"
import { setSql } from "../lib/db"
import { issueSession, SESSION_COOKIE, verifySession } from "../lib/session"
import { invalidateActiveUserCache } from "../lib/active-user"
import { hashPassword } from "../lib/password"
import { generateTotpCode, generateTotpSecret, hashRecoveryCode } from "../lib/totp"
import { createHash } from "node:crypto"
import { env } from "../lib/env"

describe("Auth Route Hardening & Attack Tests", () => {
  interface MockUser {
    id: string
    email: string
    password_hash: string
    role: "user" | "admin"
    status: string
  }
  interface MockSub {
    user_id: string
    status: string
  }
  interface MockSession {
    id: string
    token_hash: string
    user_id: string
    expires_at: Date
    last_seen_at: Date
    revoked: boolean
  }
  interface MockMfa {
    user_id: string
    totp_secret: string
    enabled: boolean
  }
  interface MockAudit {
    action: string
    actor_id: string | null
    ip: string | null
    request_id: string | null
  }

  let users: MockUser[] = []
  let subs: MockSub[] = []
  let sessions: MockSession[] = []
  let mfas: MockMfa[] = []
  let recoveryCodes: Array<{ user_id: string; code_hash: string; used: boolean }> = []
  let auditLogs: MockAudit[] = []

  const app = new Hono()
  app.route("/auth", auth)

  beforeEach(() => {
    process.env.HIBP_ENABLED = "false"
    users = []
    subs = []
    sessions = []
    mfas = []
    recoveryCodes = []
    auditLogs = []
    invalidateActiveUserCache()

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // users by lower(email)
      if (q.includes("from users") && q.includes("lower(email) = ?")) {
        const em = String(values[0]).toLowerCase()
        const u = users.filter((x) => x.email.toLowerCase() === em)
        return u.map((x) => ({ ...x }))
      }

      // users by id = ?
      if (q.includes("from users") && q.includes("where id = ?")) {
        const uid = values[0]
        const u = users.find((x) => x.id === uid)
        return u ? [{ ...u }] : []
      }

      // users by u.id = ? (getActiveUser)
      if (q.includes("from users") && q.includes("u.id = ?")) {
        const uid = values[0]
        const u = users.find((x) => x.id === uid)
        if (!u) return []
        const s = subs.find((x) => x.user_id === uid)
        return [
          {
            id: u.id,
            email: u.email,
            role: u.role,
            user_status: u.status,
            sub_status: s ? s.status : "active",
          },
        ]
      }

      // user_mfa lookup
      if (q.includes("from user_mfa") && q.includes("user_id = ?")) {
        const uid = values[0]
        const m = mfas.filter((x) => x.user_id === uid)
        return m.map((x) => ({ ...x }))
      }

      // insert / update sessions
      if (q.includes("insert into sessions")) {
        const [th, uid, ip_h, ua_h, exp] = values
        const s: MockSession = {
          id: `sess-${Math.random().toString(36).slice(2, 8)}`,
          token_hash: th,
          user_id: uid,
          expires_at: new Date(exp),
          last_seen_at: new Date(),
          revoked: false,
        }
        sessions.push(s)
        return [s]
      }

      // select from sessions
      if (q.includes("from sessions") && q.includes("token_hash = ?")) {
        const th = values[0]
        return sessions.filter((s) => s.token_hash === th).map((s) => ({ ...s }))
      }

      // update sessions revoke by token_hash
      if (q.includes("update sessions") && q.includes("token_hash = ?")) {
        const th = values[0]
        for (const s of sessions) {
          if (s.token_hash === th) s.revoked = true
        }
        return []
      }

      // update sessions revoke by user_id
      if (q.includes("update sessions") && q.includes("user_id = ?")) {
        const uid = values[0]
        for (const s of sessions) {
          if (s.user_id === uid) s.revoked = true
        }
        return []
      }

      // update password_hash
      if (q.includes("update users") && q.includes("password_hash = ?")) {
        const [newHash, uid] = values
        const u = users.find((x) => x.id === uid)
        if (u) u.password_hash = newHash
        return []
      }

      // audit insert
      if (q.includes("insert into audit_logs")) {
        auditLogs.push({
          action: values[2],
          actor_id: values[0],
          ip: values[5],
          request_id: values[6],
        })
        return []
      }

      return []
    }

    setSql(mockSql)
  })

  test("attack: suspended user login is rejected (403)", async () => {
    const pwHash = await hashPassword("password123")
    users.push({ id: "user-susp", email: "susp@example.com", password_hash: pwHash, role: "user", status: "suspended" })

    const res = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "susp@example.com", password: "password123" }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe("account_suspended")
  })

  test("login rotates session id (creates new session row, invalidates old token)", async () => {
    const pwHash = await hashPassword("password123")
    users.push({ id: "user-1", email: "user@example.com", password_hash: pwHash, role: "user", status: "active" })

    // Old session before login
    const oldSession = await issueSession("user-1", "user")
    expect(sessions.length).toBe(1)
    expect(sessions[0].revoked).toBe(false)

    // Log in with old session cookie present
    const res = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${oldSession.token}`,
      },
      body: JSON.stringify({ email: "user@example.com", password: "password123" }),
    })

    expect(res.status).toBe(200)
    // Old session should now be revoked!
    expect(sessions[0].revoked).toBe(true)
    // New session created
    expect(sessions.length).toBe(2)
    expect(sessions[1].revoked).toBe(false)
  })

  test("logout revokes session in DB (old cookie -> 401 on protected endpoint)", async () => {
    const pwHash = await hashPassword("password123")
    users.push({ id: "user-1", email: "user@example.com", password_hash: pwHash, role: "user", status: "active" })

    const sess = await issueSession("user-1", "user")
    expect(await verifySession(sess.token)).not.toBeNull()

    // Call logout
    const res = await app.request("http://localhost:8787/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${sess.token}` },
    })
    expect(res.status).toBe(200)

    // Old cookie is now revoked
    expect(await verifySession(sess.token)).toBeNull()
  })

  test("logout-all revokes all sessions for that user", async () => {
    users.push({ id: "user-1", email: "user@example.com", password_hash: "hash", role: "user", status: "active" })

    const sess1 = await issueSession("user-1", "user")
    const sess2 = await issueSession("user-1", "user")

    const res = await app.request("http://localhost:8787/auth/logout-all", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${sess1.token}` },
    })
    expect(res.status).toBe(200)

    expect(await verifySession(sess1.token)).toBeNull()
    expect(await verifySession(sess2.token)).toBeNull()
  })

  test("change-password revokes all sessions and requires new login", async () => {
    const pwHash = await hashPassword("oldpassword123")
    users.push({ id: "user-1", email: "user@example.com", password_hash: pwHash, role: "user", status: "active" })

    const sess1 = await issueSession("user-1", "user")
    const sess2 = await issueSession("user-1", "user")

    const res = await app.request("http://localhost:8787/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${sess1.token}`,
      },
      body: JSON.stringify({ current_password: "oldpassword123", new_password: "newpassword456" }),
    })
    expect(res.status).toBe(200)

    // Both previous sessions must be revoked!
    expect(await verifySession(sess1.token)).toBeNull()
    expect(await verifySession(sess2.token)).toBeNull()
  })

  test("admin accounts require TOTP MFA to complete login", async () => {
    const originalMfaRequired = env.ADMIN_MFA_REQUIRED
    ;(env as { ADMIN_MFA_REQUIRED: boolean }).ADMIN_MFA_REQUIRED = true
    try {
    const pwHash = await hashPassword("adminpass123")
    const secret = generateTotpSecret()
    users.push({ id: "admin-1", email: "admin@example.com", password_hash: pwHash, role: "admin", status: "active" })
    mfas.push({ user_id: "admin-1", totp_secret: secret, enabled: true })

    // Step 1: Login without TOTP code -> returns mfa_required
    const res1 = await app.request("http://localhost:8787/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "adminpass123" }),
    })
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.mfa_required).toBe(true)
    expect(body1.mfa_ticket).toBeDefined()

    // Step 2: Login with wrong TOTP code -> rejected (401)
    const res2 = await app.request("http://localhost:8787/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_ticket: body1.mfa_ticket, totp_code: "000000" }),
    })
    expect(res2.status).toBe(401)

    // Step 3: Login with correct TOTP code -> succeeds, issues session
    const validCode = generateTotpCode(secret)
    const res3 = await app.request("http://localhost:8787/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_ticket: body1.mfa_ticket, totp_code: validCode }),
    })
    expect(res3.status).toBe(200)
    const body3 = await res3.json()
    expect(body3.role).toBe("admin")
    } finally {
      ;(env as { ADMIN_MFA_REQUIRED: boolean }).ADMIN_MFA_REQUIRED = originalMfaRequired
    }
  })

  test("admin login skips enrolled MFA when ADMIN_MFA_REQUIRED is false", async () => {
    const originalMfaRequired = env.ADMIN_MFA_REQUIRED
    ;(env as { ADMIN_MFA_REQUIRED: boolean }).ADMIN_MFA_REQUIRED = false
    try {
      const pwHash = await hashPassword("adminpass123")
      users.push({ id: "admin-1", email: "admin@example.com", password_hash: pwHash, role: "admin", status: "active" })
      mfas.push({ user_id: "admin-1", totp_secret: generateTotpSecret(), enabled: true })
      const res = await app.request("http://localhost:8787/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "adminpass123" }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).role).toBe("admin")
      expect(res.headers.get("set-cookie")).toContain(SESSION_COOKIE)
    } finally {
      ;(env as { ADMIN_MFA_REQUIRED: boolean }).ADMIN_MFA_REQUIRED = originalMfaRequired
    }
  })

  test("admin@zen.com has no special role when it differs from ADMIN_EMAIL", async () => {
    const originalAdminEmail = env.ADMIN_EMAIL
    ;(env as { ADMIN_EMAIL: string }).ADMIN_EMAIL = "configured@example.com"
    try {
      const pwHash = await hashPassword("userpass123")
      users.push({ id: "user-1", email: "admin@zen.com", password_hash: pwHash, role: "user", status: "active" })
      const res = await app.request("http://localhost:8787/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@zen.com", password: "userpass123" }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).role).toBe("user")
    } finally {
      ;(env as { ADMIN_EMAIL: string }).ADMIN_EMAIL = originalAdminEmail
    }
  })
})
