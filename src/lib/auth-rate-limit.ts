/**
 * Auth-endpoint rate limiting with exponential backoff and per-key lockout.
 *
 * Keyed by (endpoint, key_type, key_value) — e.g. ("login", "ip", "1.2.3.4")
 * or ("signup", "email", "user@example.com").
 *
 * Strategy:
 *  - Uses Postgres as the backend (consistent across replicas).
 *  - Attempts within a rolling window (default: 15 min) are counted.
 *  - After LOCKOUT_AFTER_ATTEMPTS failures, locked_until is set to
 *    now + LOCKOUT_DURATION_MS (default: 15 min, doubles each extra failure).
 *  - Returns a RateLimitResult:
 *      { allowed: true } — proceed
 *      { allowed: false, retryAfterMs: number } — reject with 429
 *
 * All timing is done in Postgres to avoid clock skew across replicas.
 * Cleanup: rows older than 24h can be purged (not done here — use a cron).
 */

import { sql, withDbResilience } from "./db"

export interface RateLimitResult {
  allowed: boolean
  retryAfterMs?: number
  attemptsRemaining?: number
}

export type RateLimitEndpoint = "signup" | "login" | "verify_email" | "password_reset" | "device_start"

const WINDOW_MS = 15 * 60 * 1000 // 15-minute sliding window

/**
 * Per-endpoint thresholds. Values are configurable via env vars at startup.
 * LOCKOUT_AFTER is the failure count that triggers a lockout.
 * LOCKOUT_DURATION_MS is the initial lockout duration (doubles on each extra failure).
 */
function getThreshold(endpoint: RateLimitEndpoint): { lockoutAfter: number; lockoutMs: number } {
  switch (endpoint) {
    case "signup":
      return {
        lockoutAfter: Number(process.env.AUTH_RL_SIGNUP_LOCKOUT_AFTER ?? 10),
        lockoutMs: Number(process.env.AUTH_RL_SIGNUP_LOCKOUT_MS ?? 15 * 60 * 1000),
      }
    case "login":
      return {
        lockoutAfter: Number(process.env.AUTH_RL_LOGIN_LOCKOUT_AFTER ?? 8),
        lockoutMs: Number(process.env.AUTH_RL_LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000),
      }
    case "verify_email":
      return {
        lockoutAfter: Number(process.env.AUTH_RL_VERIFY_LOCKOUT_AFTER ?? 20),
        lockoutMs: Number(process.env.AUTH_RL_VERIFY_LOCKOUT_MS ?? 5 * 60 * 1000),
      }
    case "password_reset":
      return {
        lockoutAfter: Number(process.env.AUTH_RL_RESET_LOCKOUT_AFTER ?? 5),
        lockoutMs: Number(process.env.AUTH_RL_RESET_LOCKOUT_MS ?? 30 * 60 * 1000),
      }
    case "device_start":
      return {
        lockoutAfter: Number(process.env.AUTH_RL_DEVICE_LOCKOUT_AFTER ?? 10),
        lockoutMs: Number(process.env.AUTH_RL_DEVICE_LOCKOUT_MS ?? 15 * 60 * 1000),
      }
  }
}

const IP_WELCOME_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Check if a request is allowed, and if so, record the attempt.
 * keyType: 'ip' | 'email'
 * keyValue: the IP address or normalized email
 * isFailure: true if this attempt represents an authentication failure
 *            (do not call with true on success — successes reset the counter)
 */
export async function checkAuthRateLimit(
  endpoint: RateLimitEndpoint,
  keyType: "ip" | "email",
  keyValue: string,
  isFailure: boolean,
): Promise<RateLimitResult> {
  if (!keyValue) return { allowed: true }
  const { lockoutAfter, lockoutMs } = getThreshold(endpoint)

  try {
    const rows = await withDbResilience(() => sql`
      SELECT attempt_count, locked_until, window_start
      FROM auth_rate_limits
      WHERE key_type = ${keyType}
        AND key_value = ${keyValue}
        AND endpoint = ${endpoint}
      LIMIT 1
    `)

    const now = Date.now()
    const existing = rows[0]

    // If locked, check if lock has expired
    if (existing?.locked_until) {
      const lockedUntilMs = new Date(existing.locked_until).getTime()
      if (lockedUntilMs > now) {
        return { allowed: false, retryAfterMs: lockedUntilMs - now }
      }
    }

    // Window expired — reset
    const windowStartMs = existing ? new Date(existing.window_start).getTime() : 0
    const windowExpired = now - windowStartMs > WINDOW_MS

    if (!existing || windowExpired) {
      // Insert or reset row with count=1
      await withDbResilience(() => sql`
        INSERT INTO auth_rate_limits (key_type, key_value, endpoint, attempt_count, locked_until, window_start, updated_at)
        VALUES (${keyType}, ${keyValue}, ${endpoint}, 1, NULL, now(), now())
        ON CONFLICT (key_type, key_value, endpoint) DO UPDATE
          SET attempt_count = 1,
              locked_until = NULL,
              window_start = now(),
              updated_at = now()
      `)
      return { allowed: true, attemptsRemaining: lockoutAfter - 1 }
    }

    const currentCount = Number(existing.attempt_count)

    if (!isFailure) {
      // Success — reset count
      await withDbResilience(() => sql`
        UPDATE auth_rate_limits
        SET attempt_count = 0, locked_until = NULL, updated_at = now()
        WHERE key_type = ${keyType} AND key_value = ${keyValue} AND endpoint = ${endpoint}
      `).catch(() => {})
      return { allowed: true }
    }

    const newCount = currentCount + 1

    // Compute lockout duration with exponential backoff
    let lockoutDuration: number | null = null
    if (newCount >= lockoutAfter) {
      const extraFactors = Math.max(0, newCount - lockoutAfter)
      lockoutDuration = lockoutMs * Math.pow(2, Math.min(extraFactors, 4)) // cap at 16x
    }

    const lockedUntilDate = lockoutDuration ? new Date(now + lockoutDuration) : null

    await withDbResilience(() => sql`
      UPDATE auth_rate_limits
      SET attempt_count = ${newCount},
          locked_until = ${lockedUntilDate},
          updated_at = now()
      WHERE key_type = ${keyType} AND key_value = ${keyValue} AND endpoint = ${endpoint}
    `)

    if (lockoutDuration) {
      return { allowed: false, retryAfterMs: lockoutDuration }
    }

    return { allowed: true, attemptsRemaining: Math.max(0, lockoutAfter - newCount) }
  } catch (err) {
    // Fail closed: never fail open on limiter errors for auth endpoints
    console.error("[auth-rate-limit] DB error, failing closed:", err)
    return { allowed: false, retryAfterMs: 30_000 }
  }
}

/**
 * Reset the rate limit counter for a key on successful auth (e.g., successful login).
 */
export async function resetAuthRateLimit(
  endpoint: RateLimitEndpoint,
  keyType: "ip" | "email",
  keyValue: string,
): Promise<void> {
  try {
    await withDbResilience(() => sql`
      UPDATE auth_rate_limits
      SET attempt_count = 0, locked_until = NULL, updated_at = now()
      WHERE key_type = ${keyType} AND key_value = ${keyValue} AND endpoint = ${endpoint}
    `)
  } catch {
    // Non-critical: ignore
  }
}

/**
 * Check if an IP has already been granted the welcome bonus too many times in the
 * last 24 hours. Returns true if a new grant is allowed.
 */
export async function canGrantWelcomeCredit(ip: string): Promise<boolean> {
  const maxGrants = Number(process.env.WELCOME_GRANTS_PER_IP_PER_24H ?? 2)
  try {
    const windowStart = new Date(Date.now() - IP_WELCOME_GRANT_WINDOW_MS)
    const rows = await withDbResilience(() => sql`
      SELECT COUNT(*) AS cnt
      FROM welcome_grants
      WHERE ip_address = ${ip}
        AND granted_at > ${windowStart}
    `)
    const cnt = Number(rows[0]?.cnt ?? 0)
    return cnt < maxGrants
  } catch {
    return false // fail closed
  }
}

/**
 * Record a welcome credit grant for dedup purposes.
 */
export async function recordWelcomeGrant(
  userId: string,
  canonicalEmailKey: string,
  ip: string,
): Promise<void> {
  try {
    await withDbResilience(() => sql`
      INSERT INTO welcome_grants (user_id, canonical_email, ip_address)
      VALUES (${userId}, ${canonicalEmailKey}, ${ip})
      ON CONFLICT (canonical_email) DO NOTHING
    `)
  } catch {
    // Non-critical
  }
}

/**
 * Check if the canonical email has already claimed a welcome grant.
 */
export async function canonicalEmailAlreadyGranted(canonicalEmailKey: string): Promise<boolean> {
  try {
    const rows = await withDbResilience(() => sql`
      SELECT 1 FROM welcome_grants WHERE canonical_email = ${canonicalEmailKey} LIMIT 1
    `)
    return rows.length > 0
  } catch {
    return false // fail open
  }
}
