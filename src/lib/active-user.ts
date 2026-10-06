import { sql, withDbResilience } from "./db"

export interface ActiveUser {
  id: string
  email: string
  role: "user" | "admin"
  status: string
}

interface CacheEntry {
  user: ActiveUser | null
  expiresAt: number
}

const CACHE_TTL_MS = 20_000 // 20s (within required 15-30s range)
const activeUserCache = new Map<string, CacheEntry>()

/**
 * Single function used everywhere to verify that a user exists and is not
 * suspended or deleted. Caches the result in-memory for 20s.
 */
export async function getActiveUser(userId: string): Promise<ActiveUser | null> {
  if (!userId) return null

  const cached = activeUserCache.get(userId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.user
  }

  try {
    const rows = await withDbResilience(() => sql`
      SELECT u.id, u.email, u.role, COALESCE(u.status, 'active') AS user_status, COALESCE(s.status, 'active') AS sub_status
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = ${userId}
      LIMIT 1
    `)

    if (rows.length === 0) {
      activeUserCache.set(userId, { user: null, expiresAt: now + 5000 })
      return null
    }

    const row = rows[0]
    const userStatus = String(row.user_status ?? "active").toLowerCase()
    const subStatus = String(row.sub_status ?? "active").toLowerCase()

    if (userStatus === "suspended" || userStatus === "deleted" || subStatus === "suspended") {
      activeUserCache.set(userId, { user: null, expiresAt: now + 5000 })
      return null
    }

    const activeUser: ActiveUser = {
      id: String(row.id),
      email: String(row.email),
      role: row.role === "admin" ? "admin" : "user",
      status: userStatus,
    }

    activeUserCache.set(userId, { user: activeUser, expiresAt: now + CACHE_TTL_MS })
    return activeUser
  } catch (err) {
    console.error("[active-user] failed to query user:", err)
    return null
  }
}

/**
 * Invalidate the cached user, e.g. on role change, suspension, or deletion.
 */
export function invalidateActiveUserCache(userId?: string): void {
  if (userId) {
    activeUserCache.delete(userId)
  } else {
    activeUserCache.clear()
  }
}
