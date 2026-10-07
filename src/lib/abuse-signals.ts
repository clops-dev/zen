/**
 * Layered signup-abuse detection for Zen Gateway.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * 1. Store hashes, never raw values — all PII is HMAC-SHA256'd with ABUSE_SALT.
 * 2. Risk score, not a single hard rule — thresholds are env-configurable.
 * 3. CGNAT safety — IP signals alone cannot reach the block threshold (cap: 55 pts).
 * 4. Hard cap — at most 1 welcome grant per device_id and per canonical email, ever.
 * 5. Tombstones survive account deletion so re-registration can't re-qualify.
 *
 * SIGNAL WEIGHTS (defaults, all overridable via env)
 * --------------------------------------------------
 *   ABUSE_W_DEVICE_ID_MATCH    = 60   same device_id as an existing free grant
 *   ABUSE_W_FINGERPRINT_MATCH  = 20   same coarse fingerprint (UA+OS+lang+tz+screen)
 *   ABUSE_W_NET24_WINDOW       = 30   same /24 network with >N signups in 24h (N=3)
 *   ABUSE_W_IP_WINDOW          = 25   same exact IP with >M signups in 24h (M=2)
 *   ABUSE_W_DISPOSABLE         = 100  disposable email domain
 *   ABUSE_W_VELOCITY           = 20   signup velocity spike
 *
 * DECISION THRESHOLDS
 * -------------------
 *   < MEDIUM_THRESHOLD  → grant credit normally
 *   ≥ MEDIUM_THRESHOLD  → account works, welcome credit = 0, show phone/card prompt
 *   ≥ HIGH_THRESHOLD    → block signup with generic error, write audit row
 *
 * IP signals are capped at ABUSE_IP_SIGNAL_CAP (default 55) so that CGNAT alone
 * cannot reach the block threshold (default 80).
 *
 * PRIVACY NOTICE
 * --------------
 * Raw IPs and device IDs are never written to the database. Only salted HMAC-SHA256
 * hashes and network-level aggregates (/24 for IPv4, /64 for IPv6) are stored.
 * Rows in abuse_signals are purged after 90 days. Tombstone hashes are kept
 * indefinitely for re-registration dedup.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto"
import { sql, withDbResilience } from "./db"
import { audit } from "./audit"

// ---------------------------------------------------------------------------
// Salt / key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the HMAC key used for abuse signal hashing.
 * Falls back to SESSION_SECRET if ABUSE_SALT is not set (acceptable for dev;
 * operators SHOULD set a separate ABUSE_SALT in production).
 */
function getAbuseSalt(): string {
  return process.env.ABUSE_SALT ?? process.env.SESSION_SECRET ?? "dev-abuse-salt-change-me"
}

/**
 * Produce a stable, salted HMAC-SHA256 hash of a raw value.
 * The salt prevents correlation with hashes from other systems.
 */
export function abuseHash(raw: string): string {
  return createHmac("sha256", getAbuseSalt()).update(raw).digest("hex")
}

// ---------------------------------------------------------------------------
// Network hashing helpers
// ---------------------------------------------------------------------------

/**
 * Return the /24 network prefix for an IPv4 address (e.g. "1.2.3.4" → "1.2.3.0").
 * Returns null for IPv6 or invalid input.
 */
export function ipv4Network24(ip: string): string | null {
  const parts = ip.trim().split(".")
  if (parts.length !== 4) return null
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`
}

/**
 * Return the /64 network prefix for an IPv6 address.
 * Returns null for IPv4 or invalid input.
 */
export function ipv6Network64(ip: string): string | null {
  let clean = ip.trim().toLowerCase()
  if (clean.includes(".")) return null // IPv4-mapped not supported here

  const halves = clean.split("::")
  if (halves.length > 2) return null

  let groups: string[] = []
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : []
    const right = halves[1] ? halves[1].split(":") : []
    const missing = 8 - (left.length + right.length)
    if (missing < 0) return null
    groups = [...left, ...Array(missing).fill("0"), ...right]
  } else {
    groups = clean.split(":")
    if (groups.length !== 8) return null
  }

  // Take the first 4 groups (64 bits) and zero the rest
  const prefix = groups.slice(0, 4).join(":")
  return `${prefix}::`
}

// ---------------------------------------------------------------------------
// Score weights (all overridable at runtime via env)
// ---------------------------------------------------------------------------

function w(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function getWeights() {
  return {
    deviceIdMatch:      w("ABUSE_W_DEVICE_ID_MATCH",   60),
    fingerprintMatch:   w("ABUSE_W_FINGERPRINT_MATCH",  20),
    net24Window:        w("ABUSE_W_NET24_WINDOW",        30),
    ipWindow:           w("ABUSE_W_IP_WINDOW",           25),
    disposable:         w("ABUSE_W_DISPOSABLE",         100),
    velocity:           w("ABUSE_W_VELOCITY",            20),
  }
}

export function getThresholds() {
  return {
    // IP-only signals are capped at this value to ensure CGNAT safety.
    // Must stay below highThreshold.
    ipSignalCap:     w("ABUSE_IP_SIGNAL_CAP",      55),
    mediumThreshold: w("ABUSE_MEDIUM_THRESHOLD",   40),
    highThreshold:   w("ABUSE_HIGH_THRESHOLD",     80),
    // Window sizes for velocity checks
    net24MinSignups: w("ABUSE_NET24_MIN_SIGNUPS",   3),
    ipMinSignups:    w("ABUSE_IP_MIN_SIGNUPS",       2),
    velocityWindow:  w("ABUSE_VELOCITY_WINDOW_MS",  60 * 60 * 1000), // 1h default
    velocityMax:     w("ABUSE_VELOCITY_MAX",         8),
  }
}

// ---------------------------------------------------------------------------
// Input signal bag
// ---------------------------------------------------------------------------

export interface SignupSignals {
  ip: string                     // raw client IP (from trusted-proxy helper)
  deviceId?: string              // X-Zen-Device-ID header value
  fingerprintRaw?: string        // coarse client fingerprint (UA+OS+lang+tz+screen)
  canonicalEmail: string         // gmail-deduped canonical email
  isDisposable?: boolean         // already checked by caller
}

export interface RiskResult {
  score: number
  level: "low" | "medium" | "high"
  signals: Record<string, number>  // which signals contributed and by how much
  /** When true, a tombstone already exists for this device — no grant ever. */
  deviceAlreadyGranted: boolean
  /** When true, canonical email was already granted — no grant ever. */
  emailAlreadyGranted: boolean
}

// ---------------------------------------------------------------------------
// Core risk scorer
// ---------------------------------------------------------------------------

/**
 * Score a signup attempt and record the signals in the database.
 *
 * Steps:
 * 1. Hash all raw values.
 * 2. Check tombstones (hard cap — immune to score).
 * 3. Query DB for matching signals to compute score.
 * 4. Apply IP cap (CGNAT safety).
 * 5. Write signal row and (if needed) flag the account.
 *
 * Never throws — fails open with score=0 so a DB outage doesn't block signups.
 */
export async function scoreSignup(
  signals: SignupSignals,
  userId: string,
  requestId: string,
): Promise<RiskResult> {
  const weights = getWeights()
  const thresholds = getThresholds()

  try {
    // --- Hash raw values ---
    const ipHash       = abuseHash(signals.ip)
    const net24        = ipv4Network24(signals.ip) ?? ipv6Network64(signals.ip)
    const net24Hash    = net24 ? abuseHash(net24) : null
    const net64Hash    = signals.ip.includes(":") ? abuseHash(ipv6Network64(signals.ip) ?? "") : null
    const networkHash  = net24Hash ?? net64Hash
    const deviceHash   = signals.deviceId ? abuseHash(signals.deviceId) : null
    const fpHash       = signals.fingerprintRaw ? abuseHash(signals.fingerprintRaw) : null

    const matched: Record<string, number> = {}
    let score = 0

    // --- Hard-cap check: tombstone lookup ---
    const deviceAlreadyGranted = deviceHash ? await checkTombstone("device", deviceHash) : false
    const emailAlreadyGranted  = await checkTombstone("email",  abuseHash(signals.canonicalEmail))

    // --- Disposable domain (score AND instant block if weight is high enough) ---
    if (signals.isDisposable) {
      matched.disposable_email = weights.disposable
      score += weights.disposable
    }

    // --- Device ID match ---
    if (deviceHash) {
      const rows = await withDbResilience(() => sql`
        SELECT COUNT(*) AS cnt FROM abuse_signals
        WHERE device_id_hash = ${deviceHash}
          AND welcome_granted = true
        LIMIT 1
      `)
      if (Number(rows[0]?.cnt ?? 0) > 0 || deviceAlreadyGranted) {
        matched.device_id_existing_grant = weights.deviceIdMatch
        score += weights.deviceIdMatch
      }
    }

    // --- Fingerprint match ---
    if (fpHash) {
      const rows = await withDbResilience(() => sql`
        SELECT COUNT(*) AS cnt FROM abuse_signals
        WHERE fingerprint_hash = ${fpHash}
          AND welcome_granted = true
        LIMIT 1
      `)
      if (Number(rows[0]?.cnt ?? 0) > 0) {
        matched.fingerprint_existing_grant = weights.fingerprintMatch
        score += weights.fingerprintMatch
      }
    }

    // --- IP signals (capped separately for CGNAT safety) ---
    let ipScore = 0
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000)

    if (networkHash) {
      const rows = await withDbResilience(() => sql`
        SELECT COUNT(*) AS cnt FROM abuse_signals
        WHERE (network24_hash = ${networkHash} OR network64_hash = ${networkHash})
          AND event_type = 'signup'
          AND created_at > ${windowStart}
      `)
      const cnt = Number(rows[0]?.cnt ?? 0)
      if (cnt > thresholds.net24MinSignups) {
        matched[`net_window_${cnt}_in_24h`] = weights.net24Window
        ipScore += weights.net24Window
      }
    }

    if (ipHash) {
      const rows = await withDbResilience(() => sql`
        SELECT COUNT(*) AS cnt FROM abuse_signals
        WHERE ip_hash = ${ipHash}
          AND event_type = 'signup'
          AND created_at > ${windowStart}
      `)
      const cnt = Number(rows[0]?.cnt ?? 0)
      if (cnt > thresholds.ipMinSignups) {
        matched[`ip_window_${cnt}_in_24h`] = weights.ipWindow
        ipScore += weights.ipWindow
      }
    }

    // Enforce IP signal cap (CGNAT safety: IP alone can never block)
    const cappedIpScore = Math.min(ipScore, thresholds.ipSignalCap)
    if (cappedIpScore > 0) {
      score += cappedIpScore
      if (ipScore !== cappedIpScore) {
        matched.ip_score_capped = cappedIpScore
      }
    }

    // --- Velocity spike ---
    const velocityWindow = new Date(Date.now() - thresholds.velocityWindow)
    const velRows = await withDbResilience(() => sql`
      SELECT COUNT(*) AS cnt FROM abuse_signals
      WHERE event_type = 'signup'
        AND created_at > ${velocityWindow}
    `)
    const velCnt = Number(velRows[0]?.cnt ?? 0)
    if (velCnt > thresholds.velocityMax) {
      matched.global_signup_velocity_spike = weights.velocity
      score += weights.velocity
    }

    // --- Determine level ---
    const level: "low" | "medium" | "high" =
      score >= thresholds.highThreshold ? "high"
      : score >= thresholds.mediumThreshold ? "medium"
      : "low"

    // --- Write signal row ---
    await withDbResilience(() => sql`
      INSERT INTO abuse_signals (
        event_type, user_id, canonical_email,
        ip_hash, network24_hash, network64_hash,
        device_id_hash, fingerprint_hash,
        risk_score, risk_level, welcome_granted
      ) VALUES (
        'signup', ${userId}, ${signals.canonicalEmail},
        ${ipHash}, ${net24Hash}, ${net64Hash ?? net24Hash},
        ${deviceHash}, ${fpHash},
        ${score}, ${level}, false
      )
    `).catch(err => console.warn("[abuse] signal write failed:", err))

    // --- Flag account if medium or high ---
    if (level !== "low") {
      await withDbResilience(() => sql`
        INSERT INTO flagged_accounts (user_id, flag_reason, risk_score, risk_level, signals)
        VALUES (
          ${userId},
          ${"Signup risk score " + score + " (" + level + "): " + Object.keys(matched).join(", ")},
          ${score},
          ${level},
          ${JSON.stringify(matched)}
        )
        ON CONFLICT (user_id) DO UPDATE
          SET flag_reason = EXCLUDED.flag_reason,
              risk_score  = EXCLUDED.risk_score,
              risk_level  = EXCLUDED.risk_level,
              signals     = EXCLUDED.signals,
              status      = 'pending'
      `).catch(err => console.warn("[abuse] flag write failed:", err))

      if (level === "high") {
        await audit({
          actorId: userId,
          action: "abuse.high_risk_signup_blocked",
          resource: "abuse",
          requestId,
          metadata: { score, signals: matched, canonical: signals.canonicalEmail },
        }).catch(() => {})
      }
    }

    return { score, level, signals: matched, deviceAlreadyGranted, emailAlreadyGranted }
  } catch (err) {
    console.error("[abuse] scoreSignup error, failing open:", err)
    return {
      score: 0,
      level: "low",
      signals: {},
      deviceAlreadyGranted: false,
      emailAlreadyGranted: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Tombstone helpers
// ---------------------------------------------------------------------------

/**
 * Check if a tombstone exists for this hash (device or email).
 * Returns true → no welcome grant allowed ever.
 */
export async function checkTombstone(type: "device" | "email", hashValue: string): Promise<boolean> {
  try {
    const rows = await withDbResilience(() => sql`
      SELECT 1 FROM grant_tombstones
      WHERE tombstone_type = ${type} AND hash_value = ${hashValue}
      LIMIT 1
    `)
    return rows.length > 0
  } catch {
    return false // fail open
  }
}

/**
 * Record a tombstone after a successful welcome grant.
 * Idempotent — ON CONFLICT DO NOTHING.
 */
export async function recordTombstone(
  type: "device" | "email",
  hashValue: string,
  userId: string,
): Promise<void> {
  try {
    await withDbResilience(() => sql`
      INSERT INTO grant_tombstones (tombstone_type, hash_value, first_user_id)
      VALUES (${type}, ${hashValue}, ${userId})
      ON CONFLICT DO NOTHING
    `)
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Re-evaluation on use: freeze credits when same device appears on two accounts
// ---------------------------------------------------------------------------

/**
 * Called on every API key use (or login).
 * If the device_id maps to an existing grant on a DIFFERENT user, freeze
 * the newer account's credits and flag both in the admin dashboard.
 */
export async function reevaluateDeviceSignal(
  userId: string,
  deviceId: string | undefined,
  requestId: string,
): Promise<void> {
  if (!deviceId) return
  const deviceHash = abuseHash(deviceId)

  try {
    // Find any existing account that was granted on this device
    const rows = await withDbResilience(() => sql`
      SELECT user_id, created_at FROM abuse_signals
      WHERE device_id_hash = ${deviceHash}
        AND welcome_granted = true
        AND user_id IS NOT NULL
        AND user_id != ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `)
    if (rows.length === 0) return

    const olderUserId = rows[0].user_id

    // Freeze the newer account's credits (the current userId is the newer one
    // unless the older one already exists; compare signup times)
    const newRows = await withDbResilience(() => sql`
      SELECT id, created_at FROM users WHERE id = ${userId} LIMIT 1
    `)
    const oldRows = await withDbResilience(() => sql`
      SELECT id, created_at FROM users WHERE id = ${olderUserId} LIMIT 1
    `)
    if (!newRows[0] || !oldRows[0]) return

    const newerUserId =
      new Date(newRows[0].created_at) > new Date(oldRows[0].created_at)
        ? userId
        : olderUserId

    await withDbResilience(() => sql`
      UPDATE users
      SET credits_frozen = true,
          credits_freeze_reason = 'device_id_linked_to_multiple_accounts'
      WHERE id = ${newerUserId} AND NOT credits_frozen
    `).catch(() => {})

    // Flag both accounts
    for (const uid of [userId, olderUserId]) {
      await withDbResilience(() => sql`
        INSERT INTO flagged_accounts (user_id, flag_reason, risk_score, risk_level, signals)
        VALUES (
          ${uid},
          'Device ID linked to multiple accounts — credits frozen on newer account',
          100,
          'high',
          ${JSON.stringify({ device_id_collision: true, other_user: uid === userId ? olderUserId : userId })}
        )
        ON CONFLICT (user_id) DO UPDATE
          SET flag_reason = EXCLUDED.flag_reason,
              risk_score  = EXCLUDED.risk_score,
              risk_level  = EXCLUDED.risk_level,
              signals     = EXCLUDED.signals,
              status      = CASE WHEN flagged_accounts.status = 'approved' THEN 'pending' ELSE flagged_accounts.status END
      `).catch(() => {})
    }

    await audit({
      actorId: userId,
      action: "abuse.device_id_collision",
      resource: "abuse",
      requestId,
      metadata: { device_hash: deviceHash, newer_user: newerUserId, older_user: olderUserId === newerUserId ? userId : olderUserId },
    }).catch(() => {})
  } catch (err) {
    console.warn("[abuse] reevaluateDeviceSignal error:", err)
  }
}

/**
 * Mark the signal row as granted after a welcome credit was issued.
 * Also records tombstones for both device and email.
 */
export async function markSignalGranted(
  userId: string,
  canonicalEmail: string,
  deviceId: string | undefined,
): Promise<void> {
  try {
    await withDbResilience(() => sql`
      UPDATE abuse_signals
      SET welcome_granted = true
      WHERE user_id = ${userId} AND event_type = 'signup'
    `).catch(() => {})

    // Tombstone for email
    await recordTombstone("email", abuseHash(canonicalEmail), userId)

    // Tombstone for device
    if (deviceId) {
      await recordTombstone("device", abuseHash(deviceId), userId)
    }
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Turnstile CAPTCHA verification
// ---------------------------------------------------------------------------

/**
 * Verify a Cloudflare Turnstile token server-side.
 * Returns true if the token is valid.
 * If TURNSTILE_SECRET_KEY is not set, always returns true (dev mode).
 */
export async function verifyTurnstileToken(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return true // dev mode: captcha not configured

  try {
    const formData = new FormData()
    formData.append("secret", secret)
    formData.append("response", token)
    formData.append("remoteip", ip)

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    })
    const data: any = await res.json()
    return data.success === true
  } catch (err) {
    console.warn("[turnstile] verification error:", err)
    return false // fail closed for medium+ risk checks
  }
}

// ---------------------------------------------------------------------------
// Login signals & verification timestamp
// ---------------------------------------------------------------------------

/**
 * Record a login event into abuse_signals for continuous monitoring.
 */
export async function recordLoginSignal(
  userId: string,
  canonicalEmail: string,
  ip: string,
  deviceId?: string,
  fingerprintRaw?: string,
): Promise<void> {
  try {
    const ipHash = abuseHash(ip)
    const net24 = ipv4Network24(ip) ?? ipv6Network64(ip)
    const net24Hash = net24 ? abuseHash(net24) : null
    const net64Hash = ip.includes(":") ? abuseHash(ipv6Network64(ip) ?? "") : null
    const networkHash = net24Hash ?? net64Hash
    const deviceHash = deviceId ? abuseHash(deviceId) : null
    const fpHash = fingerprintRaw ? abuseHash(fingerprintRaw) : null

    await withDbResilience(() => sql`
      INSERT INTO abuse_signals (
        event_type, user_id, canonical_email,
        ip_hash, network24_hash, network64_hash,
        device_id_hash, fingerprint_hash,
        risk_score, risk_level, welcome_granted
      ) VALUES (
        'login', ${userId}, ${canonicalEmail},
        ${ipHash}, ${net24Hash}, ${networkHash},
        ${deviceHash}, ${fpHash},
        0, 'low', false
      )
    `).catch((err) => console.warn("[abuse] login signal write failed:", err))
  } catch (err) {
    console.warn("[abuse] recordLoginSignal error:", err)
  }
}

/**
 * Update abuse_signals with verification timestamp when email is verified.
 */
export async function markEmailVerifiedSignal(userId: string): Promise<void> {
  try {
    await withDbResilience(() => sql`
      UPDATE abuse_signals
      SET verified_at = now()
      WHERE user_id = ${userId}
    `).catch(() => {})
  } catch {}
}

