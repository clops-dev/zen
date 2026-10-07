import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import {
  issueSession,
  verifySession,
  revokeSession,
  revokeAllUserSessions,
  SESSION_COOKIE,
  HOST_SESSION_COOKIE,
} from "./session"
import { setSql, resetSql } from "./db"
import { invalidateActiveUserCache } from "./active-user"
import { createHash } from "node:crypto"

describe("Server-side Session Management", () => {
  interface MockSession {
    id: string
    token_hash: string
    user_id: string
    ip_hash: string | null
    ua_hash: string | null
    created_at: Date
    last_seen_at: Date
    expires_at: Date
    revoked: boolean
  }

  interface MockUser {
    id: string
    email: string
    role: "user" | "admin"
    status: string
  }

  let sessions: MockSession[] = []
  let users: MockUser[] = []

  beforeEach(() => {
    sessions = []
    users = []
    invalidateActiveUserCache()

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // INSERT INTO sessions
      if (q.includes("insert into sessions")) {
        const [token_hash, user_id, ip_hash, ua_hash, expires_at] = values
        const session: MockSession = {
          id: `sess-${Math.random().toString(36).slice(2, 10)}`,
          token_hash,
          user_id,
          ip_hash: ip_hash ?? null,
          ua_hash: ua_hash ?? null,
          created_at: new Date(),
          last_seen_at: new Date(),
          expires_at: new Date(expires_at),
          revoked: false,
        }
        sessions.push(session)
        return [session]
      }

      // SELECT ... FROM sessions WHERE token_hash = ?
      if (q.includes("from sessions") && q.includes("token_hash = ?")) {
        const th = values[0]
        const found = sessions.filter((s) => s.token_hash === th)
        return found.map((s) => ({ ...s }))
      }

      // UPDATE sessions SET revoked = true WHERE token_hash = ?
      if (q.includes("update sessions") && q.includes("token_hash = ?")) {
        const th = values[0]
        for (const s of sessions) {
          if (s.token_hash === th) s.revoked = true
        }
        return []
      }

      // UPDATE sessions SET revoked = true WHERE user_id = ?
      if (q.includes("update sessions") && q.includes("user_id = ?")) {
        const uid = values[0]
        for (const s of sessions) {
          if (s.user_id === uid) s.revoked = true
        }
        return []
      }

      // UPDATE sessions SET last_seen_at = now() WHERE id = ?
      if (q.includes("update sessions") && q.includes("last_seen_at = now()")) {
        const sid = values[0]
        const s = sessions.find((x) => x.id === sid)
        if (s) s.last_seen_at = new Date()
        return []
      }

      // active-user lookup: SELECT u.id ... FROM users u
      if (q.includes("from users") && q.includes("u.id = ?")) {
        const uid = values[0]
        const u = users.find((x) => x.id === uid)
        if (!u) return []
        return [
          {
            id: u.id,
            email: u.email,
            role: u.role,
            user_status: u.status,
            sub_status: "active",
          },
        ]
      }

      return []
    }

    setSql(mockSql)
  })

  test("issueSession creates a hashed session in DB and verifySession returns user role from DB", async () => {
    users.push({ id: "user-1", email: "user@example.com", role: "user", status: "active" })

    const issued = await issueSession("user-1", "user")
    expect(issued.token).toBeDefined()
    expect(sessions.length).toBe(1)

    // Token is stored hashed, not plaintext
    expect(sessions[0].token_hash).not.toBe(issued.token)
    const expectedHash = createHash("sha256").update(issued.token).digest("hex")
    expect(sessions[0].token_hash).toBe(expectedHash)

    const verified = await verifySession(issued.token)
    expect(verified).not.toBeNull()
    expect(verified?.userId).toBe("user-1")
    expect(verified?.role).toBe("user")
  })

  test("forged token or altered token is rejected", async () => {
    users.push({ id: "user-1", email: "user@example.com", role: "user", status: "active" })
    const issued = await issueSession("user-1", "user")

    const forged = issued.token + "tampered"
    const verified = await verifySession(forged)
    expect(verified).toBeNull()
  })

  test("role is read from DB: demoted admin immediately returns user role", async () => {
    const adminUser: MockUser = { id: "admin-1", email: "admin@example.com", role: "admin", status: "active" }
    users.push(adminUser)

    const issued = await issueSession("admin-1", "admin")
    const verifiedBefore = await verifySession(issued.token)
    expect(verifiedBefore?.role).toBe("admin")

    // Demote admin in DB
    adminUser.role = "user"
    invalidateActiveUserCache("admin-1")

    const verifiedAfter = await verifySession(issued.token)
    expect(verifiedAfter?.role).toBe("user") // No longer admin!
  })

  test("revoked session on logout returns null on verifySession", async () => {
    users.push({ id: "user-1", email: "user@example.com", role: "user", status: "active" })
    const issued = await issueSession("user-1", "user")

    await revokeSession(issued.token)
    const verified = await verifySession(issued.token)
    expect(verified).toBeNull()
  })

  test("revokeAllUserSessions invalidates all sessions for that user", async () => {
    users.push({ id: "user-1", email: "user@example.com", role: "user", status: "active" })
    const sess1 = await issueSession("user-1", "user")
    const sess2 = await issueSession("user-1", "user")

    await revokeAllUserSessions("user-1")
    expect(await verifySession(sess1.token)).toBeNull()
    expect(await verifySession(sess2.token)).toBeNull()
  })

  test("admin session enforces 30-minute idle timeout", async () => {
    users.push({ id: "admin-1", email: "admin@example.com", role: "admin", status: "active" })
    const issued = await issueSession("admin-1", "admin")

    // Simulate 35 minutes of inactivity
    sessions[0].last_seen_at = new Date(Date.now() - 35 * 60 * 1000)

    const verified = await verifySession(issued.token)
    expect(verified).toBeNull() // Expired due to idle timeout!
  })

  test("admin session max age is 8 hours, user session max age is 30 days", async () => {
    users.push({ id: "admin-1", email: "admin@example.com", role: "admin", status: "active" })
    users.push({ id: "user-1", email: "user@example.com", role: "user", status: "active" })

    const adminSess = await issueSession("admin-1", "admin")
    const userSess = await issueSession("user-1", "user")

    expect(adminSess.maxAgeSec).toBe(8 * 3600)
    expect(userSess.maxAgeSec).toBe(30 * 24 * 3600)
  })

  test("suspended user session verification fails even with unexpired valid session", async () => {
    const user: MockUser = { id: "user-1", email: "user@example.com", role: "user", status: "active" }
    users.push(user)

    const issued = await issueSession("user-1", "user")
    expect(await verifySession(issued.token)).not.toBeNull()

    // Suspend user
    user.status = "suspended"
    invalidateActiveUserCache("user-1")

    expect(await verifySession(issued.token)).toBeNull()
  })

  afterAll(() => {
    resetSql()
    invalidateActiveUserCache()
  })
})
