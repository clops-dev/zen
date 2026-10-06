import { randomBytes, createHash } from "node:crypto"
import { sql, withDbResilience } from "./db"
import { getActiveUser, invalidateActiveUserCache } from "./active-user"
import type { Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"

export const SESSION_COOKIE = "zen_session"
export const HOST_SESSION_COOKIE = "__Host-zen_session"

export const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours max
export const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes idle timeout

export interface SessionResult {
  token: string
  maxAgeSec: number
}

export interface VerifiedSession {
  userId: string
  role: "user" | "admin"
  sessionId: string
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex")
}

function hashOptional(val?: string | null): string | null {
  if (!val) return null
  return createHash("sha256").update(val).digest("hex")
}

/**
 * Issues a new server-side session.
 * Generates a high-entropy 256-bit token, stores its SHA-256 hash in the database,
 * and returns the raw token to be placed in the cookie.
 */
export async function issueSession(
  userId: string,
  role: "user" | "admin",
  opts?: { ip?: string; ua?: string },
): Promise<SessionResult> {
  const rawToken = randomBytes(32).toString("base64url")
  const tokenHash = hashToken(rawToken)
  const ipHash = hashOptional(opts?.ip)
  const uaHash = hashOptional(opts?.ua)

  const ttlMs = role === "admin" ? ADMIN_SESSION_TTL_MS : USER_SESSION_TTL_MS
  const expiresAt = new Date(Date.now() + ttlMs)

  await withDbResilience(() => sql`
    INSERT INTO sessions (token_hash, user_id, ip_hash, ua_hash, expires_at)
    VALUES (${tokenHash}, ${userId}, ${ipHash}, ${uaHash}, ${expiresAt})
  `)

  return {
    token: rawToken,
    maxAgeSec: Math.floor(ttlMs / 1000),
  }
}

/**
 * Verifies a server-side session token.
 * Validates existence, expiry, revocation, admin idle timeout, and confirms
 * user is active via getActiveUser().
 * Role is ALWAYS read freshly from the database (via getActiveUser).
 */
export async function verifySession(
  token: string | undefined,
  opts?: { ip?: string; ua?: string },
): Promise<VerifiedSession | null> {
  if (!token || typeof token !== "string" || token.length < 16) {
    return null
  }

  const tokenHash = hashToken(token)

  try {
    const rows = await withDbResilience(() => sql`
      SELECT id, user_id, last_seen_at, expires_at, revoked
      FROM sessions
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `)

    if (rows.length === 0) {
      return null
    }

    const session = rows[0]
    if (session.revoked) {
      return null
    }

    const expiresAt = new Date(session.expires_at).getTime()
    if (expiresAt <= Date.now()) {
      return null
    }

    // Role and active status are ALWAYS read from DB
    const user = await getActiveUser(session.user_id)
    if (!user) {
      return null
    }

    const lastSeenMs = new Date(session.last_seen_at).getTime()
    const now = Date.now()

    // Admin session idle timeout: 30 minutes
    if (user.role === "admin") {
      if (now - lastSeenMs > ADMIN_IDLE_TIMEOUT_MS) {
        // Idle timeout exceeded: revoke session
        await withDbResilience(() => sql`
          UPDATE sessions SET revoked = true WHERE id = ${session.id}
        `).catch(() => {})
        return null
      }
    }

    // Debounced update of last_seen_at (every 60 seconds)
    if (now - lastSeenMs > 60_000) {
      await withDbResilience(() => sql`
        UPDATE sessions SET last_seen_at = now() WHERE id = ${session.id}
      `).catch(() => {})
    }

    return {
      userId: user.id,
      role: user.role,
      sessionId: String(session.id),
    }
  } catch (err) {
    console.error("[session] verifySession error:", err)
    return null
  }
}

/**
 * Revokes a single session by token.
 */
export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return
  const tokenHash = hashToken(token)
  try {
    await withDbResilience(() => sql`
      UPDATE sessions SET revoked = true WHERE token_hash = ${tokenHash}
    `)
  } catch (err) {
    console.error("[session] revokeSession error:", err)
  }
}

/**
 * "Log out everywhere": revokes all sessions for a user and evicts cache.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  if (!userId) return
  try {
    await withDbResilience(() => sql`
      UPDATE sessions SET revoked = true WHERE user_id = ${userId}
    `)
    invalidateActiveUserCache(userId)
  } catch (err) {
    console.error("[session] revokeAllUserSessions error:", err)
  }
}

/**
 * Helper to get the session token from cookies, checking both __Host-zen_session and zen_session.
 */
export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, HOST_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE)
}

/**
 * Helper to determine if current request context is HTTPS/secure.
 */
export function isSecureContext(c: Context): boolean {
  if (process.env.NODE_ENV === "production") return true
  const proto = c.req.header("x-forwarded-proto") ?? ""
  if (proto.toLowerCase() === "https") return true
  try {
    const url = new URL(c.req.url)
    return url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Sets session cookie with proper flags:
 * - Admin: max 8h, SameSite=Strict, HttpOnly, Secure (when HTTPS/prod)
 * - User: max 30d, SameSite=Lax, HttpOnly, Secure (when HTTPS/prod)
 * - __Host- prefix when secure context
 */
export function setSessionCookie(
  c: Context,
  token: string,
  role: "user" | "admin",
): void {
  const secure = isSecureContext(c)
  const maxAge = role === "admin" ? Math.floor(ADMIN_SESSION_TTL_MS / 1000) : Math.floor(USER_SESSION_TTL_MS / 1000)
  const sameSite = role === "admin" ? ("Strict" as const) : ("Lax" as const)

  const cookieOptions = {
    httpOnly: true,
    sameSite,
    path: "/",
    maxAge,
    secure,
  }

  // Set the primary cookie (__Host-zen_session if secure, else zen_session)
  if (secure) {
    setCookie(c, HOST_SESSION_COOKIE, token, cookieOptions)
    // Also set fallback zen_session for clients expecting that cookie name
    setCookie(c, SESSION_COOKIE, token, cookieOptions)
  } else {
    setCookie(c, SESSION_COOKIE, token, cookieOptions)
  }
}

/**
 * Clears session cookies on logout.
 */
export function clearSessionCookie(c: Context): void {
  try {
    deleteCookie(c, HOST_SESSION_COOKIE, { path: "/", secure: true })
  } catch {}
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}

/**
 * Legacy export for backwards compatibility
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: Math.floor(USER_SESSION_TTL_MS / 1000),
  ...(process.env.NODE_ENV !== "development" ? { secure: true as const } : {}),
}
