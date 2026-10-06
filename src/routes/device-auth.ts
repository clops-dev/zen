/**
 * RFC 8628 OAuth 2.0 Device Authorization Grant.
 *
 * Designed to prevent phishing attacks where an attacker tricks a victim into
 * approving a CLI session via an attacker-provided device_code link.
 *
 * Flow:
 * 1. CLI requests: POST /device/start
 *    Server generates:
 *      - device_code (high-entropy secret held only by the CLI)
 *      - user_code   (8-char human code without ambiguous characters)
 *      - verification_uri (points to /device; NEVER contains device_code)
 * 2. User navigates to verification_uri in browser, enters/confirms user_code,
 *    and reviews the explicit consent screen (showing requesting IP, user-agent,
 *    timestamp, and terminal warning). User clicks Authorize (CSRF-protected POST).
 * 3. CLI polls: GET /device/poll?device_code=...
 *    Enforces interval (with slow_down penalty for fast polling), rate limits,
 *    constant-time comparison, 10-minute expiration, and single-use claim.
 *    The API key is minted only at the instant of successful poll.
 */

import { Hono, type Context } from "hono"
import { randomBytes } from "node:crypto"
import { sql } from "../lib/db"
import { generateApiKey } from "../lib/apikeys"
import { getActiveUser } from "../lib/active-user"
import {
  generateUserCode,
  formatUserCode,
  normalizeUserCode,
  constantTimeEqual,
} from "../lib/device-code"

export const deviceAuth = new Hono()

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const DEFAULT_POLL_INTERVAL_SECONDS = 5
export const MAX_PENDING_PER_IP = 5
export const MAX_FAILED_ATTEMPTS = 5

// In-memory rate limiting for polling by IP
const pollIpHits = new Map<string, { count: number; windowStart: number }>()
const POLL_RATE_LIMIT_MAX = 60 // max polls per minute per IP
const POLL_RATE_LIMIT_WINDOW_MS = 60 * 1000

function isPollRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = pollIpHits.get(ip)
  if (!current || now - current.windowStart > POLL_RATE_LIMIT_WINDOW_MS) {
    pollIpHits.set(ip, { count: 1, windowStart: now })
    return false
  }
  current.count++
  return current.count > POLL_RATE_LIMIT_MAX
}

export function getClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "127.0.0.1"
  )
}

function webBaseUrl(requestUrl: string): string {
  if (process.env.WEB_URL) return process.env.WEB_URL.replace(/\/$/, "")
  const u = new URL(requestUrl)
  return `${u.protocol}//${u.host}`
}

/** Opportunistic background cleanup of expired requests. */
export async function cleanupExpiredRequests(): Promise<void> {
  await sql`
    DELETE FROM device_auth_requests
    WHERE expires_at < now() - INTERVAL '5 minutes'
       OR (status = 'claimed' AND created_at < now() - INTERVAL '1 hour')
  `.catch(() => {})
}

// ---------------------------------------------------------------------------
// Step 1: POST /device/start (CLI initiation)
// ---------------------------------------------------------------------------
deviceAuth.post("/device/start", async (c) => {
  const clientIp = getClientIp(c)
  const userAgent = c.req.header("user-agent") ?? "unknown"

  // Clean up stale rows opportunistically
  cleanupExpiredRequests()

  // 1. Limit pending requests per IP to prevent database table flooding
  const [countRow] = await sql`
    SELECT count(*)::int as count
    FROM device_auth_requests
    WHERE ip_address = ${clientIp}
      AND status = 'pending'
      AND expires_at > now()
  `
  if (Number(countRow?.count ?? 0) >= MAX_PENDING_PER_IP) {
    return c.json(
      {
        error: "too_many_pending_requests",
        message:
          "Too many pending device authorization requests. Please complete or wait for existing requests to expire.",
      },
      429,
    )
  }

  // 2. Generate high-entropy device_code and short human user_code
  const deviceCode = randomBytes(32).toString("base64url")
  const rawUserCode = generateUserCode()
  const normalizedUserCode = normalizeUserCode(rawUserCode)
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS)

  await sql`
    INSERT INTO device_auth_requests
      (device_code, user_code, ip_address, user_agent, status, expires_at, poll_interval)
    VALUES
      (${deviceCode}, ${normalizedUserCode}, ${clientIp}, ${userAgent}, 'pending', ${expiresAt}, ${DEFAULT_POLL_INTERVAL_SECONDS})
  `

  const verificationUri = `${webBaseUrl(c.req.url)}/device`

  // RFC 8628 §3.2 response. Note: verification_uri must NOT contain device_code!
  return c.json({
    device_code: deviceCode,
    user_code: formatUserCode(rawUserCode),
    verification_uri: verificationUri,
    expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: DEFAULT_POLL_INTERVAL_SECONDS,
  })
})

// ---------------------------------------------------------------------------
// Step 3: GET/POST /device/poll (CLI polling)
// ---------------------------------------------------------------------------
const pollHandler = async (c: Context) => {
  const clientIp = getClientIp(c)

  // Enforce IP rate limiting
  if (isPollRateLimited(clientIp)) {
    return c.json({ error: "rate_limit_exceeded", message: "Too many polling requests." }, 429)
  }

  // Accept device_code from query param or JSON body
  const body = c.req.method === "POST" ? await c.req.json().catch(() => ({})) : {}
  const code = (c.req.query("device_code") || c.req.query("code") || body.device_code || body.code || "").trim()

  if (!code) {
    return c.json({ error: "invalid_request", message: "Missing device_code" }, 400)
  }

  const rows = await sql`
    SELECT device_code, status, user_id, expires_at, poll_interval, last_polled_at, poll_count
    FROM device_auth_requests
    WHERE device_code = ${code}
  `

  if (rows.length === 0) {
    return c.json({ error: "not_found", status: "not_found" }, 404)
  }

  const row = rows[0]

  // Constant-time compare on device_code
  if (!constantTimeEqual(code, row.device_code)) {
    return c.json({ error: "not_found", status: "not_found" }, 404)
  }

  const now = new Date()

  // 1. Expiration check
  if (new Date(row.expires_at) < now || row.status === "expired") {
    if (row.status === "pending") {
      await sql`UPDATE device_auth_requests SET status = 'expired' WHERE device_code = ${code}`
    }
    return c.json({ error: "expired_token", status: "expired", message: "Device code has expired" }, 400)
  }

  // 2. Check if already claimed (single-use)
  if (row.status === "claimed") {
    return c.json(
      { error: "expired_token", status: "already_claimed", message: "Device code was already claimed" },
      410,
    )
  }

  // 3. Enforce interval and slow_down
  if (row.last_polled_at) {
    const elapsedSeconds = (now.getTime() - new Date(row.last_polled_at).getTime()) / 1000
    const requiredInterval = row.poll_interval || DEFAULT_POLL_INTERVAL_SECONDS

    if (elapsedSeconds < requiredInterval - 0.5) {
      const newInterval = requiredInterval + 5
      await sql`
        UPDATE device_auth_requests
        SET poll_interval = ${newInterval},
            last_polled_at = now(),
            poll_count = poll_count + 1
        WHERE device_code = ${code}
      `
      return c.json(
        {
          error: "slow_down",
          status: "slow_down",
          interval: newInterval,
          message: `Polling too fast. Increase interval to ${newInterval} seconds.`,
        },
        400,
      )
    }
  }

  // 4. Pending authorization
  if (row.status === "pending") {
    await sql`
      UPDATE device_auth_requests
      SET last_polled_at = now(),
          poll_count = poll_count + 1
      WHERE device_code = ${code}
    `
    return c.json({ status: "pending", error: "authorization_pending" })
  }

  // 5. Approved — atomically transition to claimed and mint API key in memory
  if (row.status === "approved") {
    const updated = await sql`
      UPDATE device_auth_requests
      SET status = 'claimed'
      WHERE device_code = ${code} AND status = 'approved'
      RETURNING user_id
    `

    if (updated.length === 0) {
      return c.json(
        { error: "expired_token", status: "already_claimed", message: "Device code was already claimed" },
        410,
      )
    }

    const userId = updated[0].user_id
    const activeUser = await getActiveUser(userId)
    if (!activeUser) {
      return c.json({ error: "account_suspended", message: "Account is suspended" }, 403)
    }

    // Mint long-lived API key at the moment of successful poll
    const { raw, hash, prefix } = generateApiKey()
    await sql`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
      VALUES (${userId}, ${hash}, ${prefix}, 'zen login (device flow)')
    `

    return c.json({
      status: "approved",
      api_key: raw,
      email: activeUser.email,
    })
  }

  return c.json({ error: "invalid_grant", status: row.status }, 400)
}

deviceAuth.get("/device/poll", pollHandler)
deviceAuth.post("/device/poll", pollHandler)

// ---------------------------------------------------------------------------
// Helpers for user-code approval & lockout in browser
// ---------------------------------------------------------------------------

export async function getDeviceRequestByUserCode(rawCode: string) {
  const normalized = normalizeUserCode(rawCode)
  const rows = await sql`
    SELECT device_code, user_code, ip_address, user_agent, status, expires_at, locked, failed_attempts, created_at
    FROM device_auth_requests
    WHERE user_code = ${normalized}
  `
  return rows[0] ?? null
}

export async function recordFailedUserCodeAttempt(rawCode: string): Promise<{ locked: boolean }> {
  const normalized = normalizeUserCode(rawCode)
  const rows = await sql`
    UPDATE device_auth_requests
    SET failed_attempts = failed_attempts + 1,
        locked = (failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS})
    WHERE user_code = ${normalized}
    RETURNING locked, failed_attempts
  `
  if (rows.length === 0) return { locked: false }
  return { locked: Boolean(rows[0].locked) }
}

export async function approveDeviceByUserCode(rawCode: string, userId: string): Promise<boolean> {
  const normalized = normalizeUserCode(rawCode)
  const rows = await sql`
    SELECT status, expires_at, locked
    FROM device_auth_requests
    WHERE user_code = ${normalized}
  `
  if (rows.length === 0) return false
  const row = rows[0]
  if (row.locked || row.status !== "pending" || new Date(row.expires_at) < new Date()) {
    return false
  }

  await sql`
    UPDATE device_auth_requests
    SET status = 'approved',
        user_id = ${userId},
        user_confirmed_at = now()
    WHERE user_code = ${normalized}
  `
  return true
}

/** Legacy helper: maintained for test compatibility, but requires pending status */
export async function approveDeviceCode(deviceCode: string, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT status, expires_at, locked
    FROM device_auth_requests
    WHERE device_code = ${deviceCode}
  `
  if (rows.length === 0) return false
  if (rows[0].locked || rows[0].status !== "pending" || new Date(rows[0].expires_at) < new Date()) {
    return false
  }

  await sql`
    UPDATE device_auth_requests
    SET status = 'approved',
        user_id = ${userId},
        user_confirmed_at = now()
    WHERE device_code = ${deviceCode}
  `
  return true
}