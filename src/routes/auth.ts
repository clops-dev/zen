import { Hono, type Context } from "hono"
import { z } from "zod"
import { createHmac, timingSafeEqual } from "node:crypto"
import { sql, withDbResilience } from "../lib/db"
import { hashPassword, isLegacyBcryptHash, verifyDummyPassword, verifyPassword, checkPasswordStrength } from "../lib/password"
import {
  issueSession,
  verifySession,
  revokeSession,
  revokeAllUserSessions,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from "../lib/session"
import { generateApiKey } from "../lib/apikeys"
import { requireSession } from "../middleware/session-auth"
import { csrfProtection } from "../middleware/csrf"
import { env } from "../lib/env"
import { addCredits, WELCOME_CREDITS_DT, WELCOME_DISPLAY_USD } from "../lib/credits"
import { normalizeEmail, canonicalEmail, isDisposableDomain } from "../lib/email"
import { getActiveUser, invalidateActiveUserCache } from "../lib/active-user"
import {
  generateTotpSecret,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  generateOtpAuthUri,
} from "../lib/totp"
import { audit, actorEmailFor } from "../lib/audit"
import {
  issueEmailVerificationToken,
  verifyEmailToken,
  issuePasswordResetToken,
  verifyPasswordResetToken,
} from "../lib/email-verification"
import {
  checkAuthRateLimit,
  resetAuthRateLimit,
  canGrantWelcomeCredit,
  canonicalEmailAlreadyGranted,
  recordWelcomeGrant,
} from "../lib/auth-rate-limit"
import {
  scoreSignup,
  markSignalGranted,
  checkTombstone,
  abuseHash,
  verifyTurnstileToken,
  recordLoginSignal,
  markEmailVerifiedSignal,
  reevaluateDeviceSignal,
} from "../lib/abuse-signals"

export const auth = new Hono()

// Apply CSRF protection to state-changing routes
auth.use("*", csrfProtection())

import { getClientIp } from "../lib/client-ip"

function getRequestId(c: Context): string {
  return c.get("requestId") ?? c.req.header("x-request-id") ?? `req-${Date.now()}`
}

export function signMfaTicket(userId: string): string {
  const expiresAt = Date.now() + 5 * 60 * 1000 // 5 minutes validity
  const payload = `${userId}|${expiresAt}`
  const sig = createHmac("sha256", env.SESSION_SECRET).update(payload).digest("hex")
  return `${Buffer.from(payload).toString("base64url")}.${sig}`
}

export function verifyMfaTicket(ticket: string | undefined): string | null {
  if (!ticket || typeof ticket !== "string" || !ticket.includes(".")) return null
  const idx = ticket.lastIndexOf(".")
  const b64 = ticket.slice(0, idx)
  const sig = ticket.slice(idx + 1)
  const payload = Buffer.from(b64, "base64url").toString("utf8")
  const expectedSig = createHmac("sha256", env.SESSION_SECRET).update(payload).digest("hex")

  const a = Buffer.from(sig, "hex")
  const b = Buffer.from(expectedSig, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const [userId, expStr] = payload.split("|")
  if (Number(expStr) < Date.now()) return null
  return userId
}

const signupSchema = z.object({
  email: z.string().email(),
  // min 10 enforced here and by checkPasswordStrength; max 256 to avoid DoS
  password: z.string().min(10).max(256),
})

auth.post("/signup", async (c) => {
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  // --- IP rate limit (check before parsing body to save work) ---
  const ipRl = await checkAuthRateLimit("signup", "ip", ip, true)
  if (!ipRl.allowed) {
    return c.json(
      { error: "too_many_requests", message: "Too many signup attempts from this IP. Please try again later.",
        retry_after_ms: ipRl.retryAfterMs },
      429,
    )
  }

  const body = await c.req.json().catch(() => null)
  const parsed = signupSchema.safeParse(body)
  // Same response for invalid payload — don't reveal specifics
  if (!parsed.success) {
    return c.json({ error: "invalid_request", message: "Email or password requirements not met" }, 400)
  }

  const email = normalizeEmail(parsed.data.email)
  const { password } = parsed.data

  // --- Disposable email block (also handled by risk scorer, but reject immediately) ---
  if (isDisposableDomain(email)) {
    await audit({
      action: "abuse.disposable_email_attempt",
      resource: "abuse",
      ip,
      requestId: reqId,
      metadata: { email, domain: email.split("@")[1] },
      result: "denied",
    })
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000)
    const recentDisp = await withDbResilience(() => sql`
      SELECT COUNT(*) AS cnt FROM audit_logs
      WHERE action = 'abuse.disposable_email_attempt' AND created_at > ${fifteenMinAgo}
    `).catch(() => [{ cnt: 0 }])
    if (Number(recentDisp[0]?.cnt ?? 0) >= 5) {
      console.warn(`[abuse-alert] Spike in disposable email signup attempts: ${recentDisp[0]?.cnt} in last 15 min`)
      await audit({
        action: "abuse.disposable_email_spike",
        resource: "abuse",
        ip,
        requestId: reqId,
        metadata: { count: recentDisp[0]?.cnt },
      })
    }
    return c.json({ error: "invalid_request", message: "Email or password requirements not met" }, 400)
  }

  // --- Password strength: min 10 chars + HIBP breach check ---
  const strength = await checkPasswordStrength(password)
  if (!strength.ok) {
    const msg = strength.reason === "pwned"
      ? "This password has appeared in a data breach. Please choose a different password."
      : "Password must be at least 10 characters."
    return c.json({ error: "weak_password", message: msg }, 400)
  }

  // --- Canonical-email dedup (Gmail-style dots/+tags) ---
  const canonical = canonicalEmail(email)

  // --- Email-level rate limit ---
  const emailRl = await checkAuthRateLimit("signup", "email", email, false)
  if (!emailRl.allowed) {
    return c.json(
      { error: "too_many_requests", message: "Too many signup attempts. Please try again later.",
        retry_after_ms: emailRl.retryAfterMs },
      429,
    )
  }

  // --- Duplicate check (existing normalized OR canonical email) ---
  // Use a single query that catches both the exact normalized form and the
  // canonical form stored in canonical_email.
  let newUser: { id: string } | undefined
  try {
    const pwHash = await hashPassword(password)
    const rows = await withDbResilience(() => sql`
      INSERT INTO users (email, canonical_email, password_hash, role, status, email_verified)
      VALUES (${email}, ${canonical}, ${pwHash}, 'user', 'active', false)
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
    newUser = rows[0] as { id: string } | undefined
  } catch (err: any) {
    // Unique index violation on canonical_email means a duplicate exists
    if (err?.code === "23505") newUser = undefined
    else throw err
  }

  // If insert was a no-op (duplicate), return same shape as success (non-enumerable)
  if (!newUser) {
    // Record attempt for rate limiting
    await checkAuthRateLimit("signup", "ip", ip, false)
    return c.json({ message: "account created", email_verification_required: true })
  }

  // --- Supporting records ---
  await withDbResilience(() => sql`
    INSERT INTO user_credits (user_id, balance_dt) VALUES (${newUser!.id}, 0)
    ON CONFLICT (user_id) DO NOTHING
  `)
  await withDbResilience(() => sql`
    INSERT INTO subscriptions (user_id, tier, status) VALUES (${newUser!.id}, 'free', 'active')
    ON CONFLICT (user_id) DO NOTHING
  `)

  // --- Risk scoring (layered abuse detection) ---
  const deviceId = c.req.header("x-zen-device-id") ?? undefined
  const fingerprintRaw = c.req.header("x-zen-fingerprint") ?? undefined

  const risk = await scoreSignup(
    { ip, deviceId, fingerprintRaw, canonicalEmail: canonical, isDisposable: false },
    newUser.id,
    reqId,
  )

  // High risk → block signup with generic error (never reveal which signal matched)
  if (risk.level === "high") {
    // Rollback: delete the just-created user row (best-effort)
    await withDbResilience(() => sql`DELETE FROM users WHERE id = ${newUser!.id}`).catch(() => {})
    await audit({
      actorId: newUser.id,
      actorEmail: email,
      action: "abuse.high_risk_signup_blocked",
      resource: "abuse",
      ip,
      requestId: reqId,
      result: "denied",
      metadata: { score: risk.score, signals: risk.signals, canonical },
    })
    // Generic error — never say which signal matched
    return c.json({ error: "invalid_request", message: "Unable to create account. Please contact support if you believe this is an error." }, 400)
  }

  // Medium risk → Turnstile CAPTCHA required
  if (risk.level === "medium") {
    const turnstileToken = typeof body?.turnstile_token === "string" ? body.turnstile_token : ""
    if (turnstileToken) {
      const captchaOk = await verifyTurnstileToken(turnstileToken, ip)
      if (!captchaOk) {
        return c.json({ error: "captcha_required", message: "Please complete the security challenge.", captcha_required: true }, 400)
      }
    } else if (process.env.TURNSTILE_SECRET_KEY) {
      // CAPTCHA required and not provided
      return c.json({ error: "captcha_required", message: "Please complete the security challenge.", captcha_required: true }, 400)
    }
  }

  // --- Anomaly flag: many signups from one IP ---
  const grantOk = await canGrantWelcomeCredit(ip)
  const canonicalAlreadyGranted = await canonicalEmailAlreadyGranted(canonical)
  // Also check tombstones (survives account deletion)
  const deviceTombstone = risk.deviceAlreadyGranted
  const emailTombstone = risk.emailAlreadyGranted
  const willGrantWelcome = grantOk && !canonicalAlreadyGranted && !deviceTombstone && !emailTombstone && risk.level === "low"

  // --- Issue email verification token and "send" it ---
  const verifyToken = await issueEmailVerificationToken(newUser.id)
  const verifyUrl = `${env.APP_URL}/verify-email?token=${encodeURIComponent(verifyToken)}`

  // NOTE: In production, send an actual email here.
  // For now, log to server console only (never returned to client).
  console.info(`[auth] email verification link for ${email}: ${verifyUrl}`)

  // --- Issue session (but no welcome credits yet — granted on email verify) ---
  const session = await issueSession(newUser.id, "user", { ip, ua: c.req.header("user-agent") })
  setSessionCookie(c, session.token, "user")

  // Reset IP rate limit on successful signup
  await resetAuthRateLimit("signup", "ip", ip)

  await audit({
    actorId: newUser.id,
    actorEmail: email,
    action: "auth.signup",
    resource: "auth",
    ip,
    requestId: reqId,
    metadata: { canonical, will_grant_welcome: willGrantWelcome, risk_level: risk.level, risk_score: risk.score },
  })

  // Abuse check: >5 signups from same IP in 1 h
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const recentSignups = await withDbResilience(() => sql`
    SELECT COUNT(*) AS cnt FROM audit_logs
    WHERE action = 'auth.signup' AND ip = ${ip} AND created_at > ${oneHourAgo}
  `).catch(() => [{ cnt: 0 }])
  if (Number(recentSignups[0]?.cnt ?? 0) > 5) {
    console.warn(`[abuse-alert] >5 signups from IP ${ip} in last 1 hour`)
    await audit({
      action: "abuse.signup_spike",
      resource: "abuse",
      ip,
      requestId: reqId,
      metadata: { ip, count: recentSignups[0]?.cnt },
    })
  }

  const response: Record<string, unknown> = {
    message: "account created",
    email_verification_required: true,
  }
  // Medium risk: tell the user they can unlock the free trial
  if (risk.level === "medium") {
    response.welcome_credit_pending = true
    response.message = "account created — verify your phone or add a payment method to unlock the free trial."
  }

  return c.json(response)
})

// ---------------------------------------------------------------------------
// POST /verify-email  — claim email verification token
// ---------------------------------------------------------------------------

auth.post("/verify-email", async (c) => {
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  // Rate limit verify-email endpoint per IP
  const ipRl = await checkAuthRateLimit("verify_email", "ip", ip, true)
  if (!ipRl.allowed) {
    return c.json({ error: "too_many_requests", retry_after_ms: ipRl.retryAfterMs }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const token = typeof body?.token === "string" ? body.token.trim() : ""
  if (!token) return c.json({ error: "invalid_request", message: "Token required" }, 400)

  const result = await verifyEmailToken(token)
  if (!result.ok) {
    // Don't reveal reason to prevent oracle attacks
    return c.json({ error: "invalid_or_expired_token", message: "The verification link is invalid or has expired." }, 400)
  }

  const userId = result.userId

  // Mark user as email-verified
  await withDbResilience(() => sql`
    UPDATE users SET email_verified = true WHERE id = ${userId}
  `)
  await markEmailVerifiedSignal(userId)

  // Grant welcome credits now — but only if dedup checks pass
  const userRows = await withDbResilience(() => sql`
    SELECT email, canonical_email FROM users WHERE id = ${userId} LIMIT 1
  `)
  if (userRows.length > 0) {
    const { email, canonical_email } = userRows[0]
    const normalizedCanonical = canonical_email ?? canonicalEmail(email)
    const grantOk = await canGrantWelcomeCredit(ip)
    const canonicalAlreadyGranted = await canonicalEmailAlreadyGranted(normalizedCanonical)
    // Hard cap: check tombstones (survive account deletion)
    const emailTombstone = await checkTombstone("email", abuseHash(normalizedCanonical))
    const deviceId = c.req.header("x-zen-device-id") ?? undefined
    const deviceTombstone = deviceId ? await checkTombstone("device", abuseHash(deviceId)) : false

    if (grantOk && !canonicalAlreadyGranted && !emailTombstone && !deviceTombstone) {
      await addCredits(userId, WELCOME_CREDITS_DT, "admin_grant", "completed", {
        adminNote: `Welcome bonus: ${WELCOME_CREDITS_DT} DT granted after email verification`,
      })
      await recordWelcomeGrant(userId, normalizedCanonical, ip)
      // Record tombstones so future re-registration cannot re-qualify
      await markSignalGranted(userId, normalizedCanonical, deviceId)

      await audit({
        actorId: userId,
        actorEmail: email,
        action: "auth.welcome_grant",
        resource: "auth",
        ip,
        requestId: reqId,
        metadata: { canonical: normalizedCanonical },
      })
    } else {
      // Anomaly: multi-account farming attempt
      await audit({
        actorId: userId,
        actorEmail: email,
        action: "abuse.welcome_grant_blocked",
        resource: "auth",
        ip,
        requestId: reqId,
        metadata: {
          reason: !grantOk ? "ip_limit_exceeded" : emailTombstone ? "email_tombstone" : deviceTombstone ? "device_tombstone" : "canonical_email_duplicate",
          canonical: normalizedCanonical,
        },
      })
    }
  }

  // Refresh the session so the client picks up email_verified=true
  invalidateActiveUserCache(userId)
  await resetAuthRateLimit("verify_email", "ip", ip)

  return c.json({ ok: true, message: "Email verified. Welcome credits have been applied.", welcome_bonus_display_usd: WELCOME_DISPLAY_USD })
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
  totp_code: z.string().optional(),
  recovery_code: z.string().optional(),
})

auth.post("/login", async (c) => {
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  // --- IP rate limit first (before parsing body) ---
  const ipRl = await checkAuthRateLimit("login", "ip", ip, true)
  if (!ipRl.allowed) {
    return c.json(
      { error: "too_many_requests", message: "Too many login attempts. Please try again later.",
        retry_after_ms: ipRl.retryAfterMs },
      429,
    )
  }

  const body = await c.req.json().catch(() => null)
  const parsed = loginSchema.safeParse(body)
  // Non-enumerable: same error for bad schema as for wrong credentials
  if (!parsed.success) {
    await verifyDummyPassword("")
    return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401)
  }

  const email = normalizeEmail(parsed.data.email)
  const { password, totp_code, recovery_code } = parsed.data

  // --- Email-level rate limit ---
  const emailRl = await checkAuthRateLimit("login", "email", email, true)
  if (!emailRl.allowed) {
    // Still run dummy verify so timing is indistinguishable
    await verifyDummyPassword(password)
    return c.json(
      { error: "too_many_requests", message: "Too many login attempts. Please try again later.",
        retry_after_ms: emailRl.retryAfterMs },
      429,
    )
  }

  const rows = await withDbResilience(() => sql`SELECT id, email, password_hash, role FROM users WHERE lower(email) = ${email}`)
  if (rows.length === 0) {
    // Constant-time dummy verify (non-enumerable)
    await verifyDummyPassword(password)
    return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401)
  }

  let user = rows[0] as { id: string; password_hash: string; role: "user" | "admin"; email: string }
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) {
    // Record failure for lockout
    await checkAuthRateLimit("login", "ip", ip, true)
    await checkAuthRateLimit("login", "email", email, true)

    // Abuse check: >10 failed logins for same email in 15 min
    const recentFails = await withDbResilience(() => sql`
      SELECT attempt_count FROM auth_rate_limits
      WHERE key_type = 'email' AND key_value = ${email} AND endpoint = 'login'
    `).catch(() => [])
    if (Number(recentFails[0]?.attempt_count ?? 0) > 10) {
      console.warn(`[abuse-alert] >10 failed logins for email ${email} in last 15 min`)
      await audit({
        actorEmail: email,
        action: "abuse.failed_login_spike",
        resource: "abuse",
        ip,
        requestId: reqId,
        metadata: { email, attempts: recentFails[0]?.attempt_count },
      })
    }

    return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401)
  }

  const loginEmail = normalizeEmail(user.email ?? email)
  const isBootstrapAdmin = loginEmail === normalizeEmail(env.ADMIN_EMAIL)
  if (isBootstrapAdmin && user.role !== "admin") {
    const [promoted] = await withDbResilience(() => sql`
      UPDATE users SET role = 'admin', status = 'active'
      WHERE id = ${user.id}
      RETURNING id, email, password_hash, role
    `)
    if (promoted) {
      user = promoted as typeof user
      invalidateActiveUserCache(user.id)
    }
  }

  // Enforce account state everywhere via getActiveUser
  const activeUser = await getActiveUser(user.id)
  if (!activeUser) {
    return c.json({ error: "account_suspended", message: "Your account has been suspended" }, 403)
  }

  // Reset rate limit counters on successful credential verification
  await resetAuthRateLimit("login", "ip", ip)
  await resetAuthRateLimit("login", "email", email)

  // Check MFA (required for admin, optional for user)
  const mfaRows = await withDbResilience(() => sql`
    SELECT totp_secret, enabled FROM user_mfa WHERE user_id = ${user.id} LIMIT 1
  `).catch(() => [])

  const mfa = mfaRows[0]
  const isMfaEnrolled = mfa && mfa.enabled
  const isMfaRequired = activeUser.role === "admin" ? env.ADMIN_MFA_REQUIRED : Boolean(isMfaEnrolled)

  if (isMfaRequired) {
    if (!isMfaEnrolled && activeUser.role === "admin") {
      // Admin must set up MFA before logging in
      const mfaTicket = signMfaTicket(user.id)
      return c.json({ mfa_setup_required: true, mfa_ticket: mfaTicket })
    }

    // MFA is enrolled: verify supplied code
    if (!totp_code && !recovery_code) {
      const mfaTicket = signMfaTicket(user.id)
      return c.json({ mfa_required: true, mfa_ticket: mfaTicket })
    }

    let mfaValid = false
    if (totp_code && mfa) {
      mfaValid = verifyTotpCode(mfa.totp_secret, totp_code)
    } else if (recovery_code) {
      const codeHash = hashRecoveryCode(recovery_code)
      const rcRows = await withDbResilience(() => sql`
        SELECT id FROM user_mfa_recovery_codes
        WHERE user_id = ${user.id} AND code_hash = ${codeHash} AND NOT used
        LIMIT 1
      `).catch(() => [])
      if (rcRows.length > 0) {
        mfaValid = true
        await withDbResilience(() => sql`
          UPDATE user_mfa_recovery_codes SET used = true, used_at = now() WHERE id = ${rcRows[0].id}
        `).catch(() => {})
      }
    }

    if (!mfaValid) {
      return c.json({ error: "invalid_mfa_code", message: "Invalid MFA code" }, 401)
    }
  }

  // Upgrade legacy bcrypt hashes opportunistically
  if (isLegacyBcryptHash(user.password_hash)) {
    const upgradedHash = await hashPassword(password)
    await withDbResilience(() => sql`
      UPDATE users SET password_hash = ${upgradedHash}
      WHERE id = ${user.id} AND password_hash = ${user.password_hash}
    `).catch((err) => console.warn("[auth] password hash upgrade failed:", err))
  }

  // Session rotation on login: revoke previous session if present (prevents fixation)
  const existingToken = getSessionToken(c)
  if (existingToken) {
    await revokeSession(existingToken)
  }

  const session = await issueSession(user.id, activeUser.role, { ip, ua: c.req.header("user-agent") })
  setSessionCookie(c, session.token, activeUser.role)

  // Abuse signal tracking on login
  const deviceId = c.req.header("x-zen-device-id") ?? undefined
  const fingerprintRaw = c.req.header("x-zen-fingerprint") ?? undefined
  const userCanonical = canonicalEmail(activeUser.email)
  await recordLoginSignal(user.id, userCanonical, ip, deviceId, fingerprintRaw)
  if (deviceId) {
    await reevaluateDeviceSignal(user.id, deviceId, reqId)
  }

  await audit({
    actorId: user.id,
    actorEmail: activeUser.email,
    action: "auth.login",
    resource: "auth",
    ip,
    requestId: reqId,
    metadata: { role: activeUser.role },
  })

  return c.json({ message: "logged in", role: activeUser.role })
})

auth.post("/logout", async (c) => {
  const token = getSessionToken(c)
  const session = token ? await verifySession(token) : null
  if (token) {
    await revokeSession(token)
  }
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  if (session) {
    await audit({
      actorId: session.userId,
      action: "auth.logout",
      resource: "auth",
      ip,
      requestId: reqId,
    })
  }

  return c.json({ message: "logged out" })
})

auth.post("/logout-all", requireSession(), async (c) => {
  const session = c.var.session
  await revokeAllUserSessions(session.userId)
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: session.userId,
    action: "auth.logout_all",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ message: "logged out from all devices" })
})

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10).max(256),
})

auth.post("/change-password", requireSession(), async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = changePasswordSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400)

  // HIBP + min-length check on new password
  const strength = await checkPasswordStrength(parsed.data.new_password)
  if (!strength.ok) {
    const msg = strength.reason === "pwned"
      ? "This password has appeared in a data breach. Please choose a different password."
      : "Password must be at least 10 characters."
    return c.json({ error: "weak_password", message: msg }, 400)
  }

  const rows = await withDbResilience(() => sql`
    SELECT password_hash FROM users WHERE id = ${session.userId} LIMIT 1
  `)
  if (rows.length === 0) return c.json({ error: "not_found" }, 404)

  const ok = await verifyPassword(parsed.data.current_password, rows[0].password_hash)
  if (!ok) return c.json({ error: "invalid_current_password", message: "Current password does not match" }, 400)

  const newHash = await hashPassword(parsed.data.new_password)
  await withDbResilience(() => sql`
    UPDATE users SET password_hash = ${newHash} WHERE id = ${session.userId}
  `)

  // Password change must revoke all existing sessions
  await revokeAllUserSessions(session.userId)
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: session.userId,
    action: "auth.password_change",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ message: "password updated successfully; please log in again" })
})

// ---------------------------------------------------------------------------
// Password reset — unauthenticated flow (forgot password)
// ---------------------------------------------------------------------------

auth.post("/password-reset/request", async (c) => {
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  // Rate limit by IP
  const ipRl = await checkAuthRateLimit("password_reset", "ip", ip, true)
  if (!ipRl.allowed) {
    return c.json({ error: "too_many_requests", retry_after_ms: ipRl.retryAfterMs }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const emailRaw = typeof body?.email === "string" ? body.email.trim() : ""
  if (!emailRaw) {
    // Non-enumerable: same response for unknown email
    return c.json({ message: "If this email is registered, a reset link has been sent." })
  }

  const email = normalizeEmail(emailRaw)

  // Rate limit by email too
  await checkAuthRateLimit("password_reset", "email", email, true)

  const rows = await withDbResilience(() => sql`
    SELECT id FROM users WHERE lower(email) = ${email} LIMIT 1
  `)

  if (rows.length > 0) {
    const userId = rows[0].id
    const resetToken = await issuePasswordResetToken(userId)
    const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(resetToken)}`

    // NOTE: In production, send an actual email here.
    console.info(`[auth] password reset link for ${email}: ${resetUrl}`)

    await audit({
      actorId: userId,
      actorEmail: email,
      action: "auth.password_reset_requested",
      resource: "auth",
      ip,
      requestId: reqId,
    })
  }

  // Always same response — non-enumerable
  return c.json({ message: "If this email is registered, a reset link has been sent." })
})

const passwordResetConfirmSchema = z.object({
  token: z.string().min(16),
  new_password: z.string().min(10).max(256),
})

auth.post("/password-reset/confirm", async (c) => {
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  const ipRl = await checkAuthRateLimit("password_reset", "ip", ip, true)
  if (!ipRl.allowed) {
    return c.json({ error: "too_many_requests", retry_after_ms: ipRl.retryAfterMs }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = passwordResetConfirmSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: "invalid_request", message: "Token and new password (min 10 chars) required" }, 400)

  // Strength check before consuming the token
  const strength = await checkPasswordStrength(parsed.data.new_password)
  if (!strength.ok) {
    const msg = strength.reason === "pwned"
      ? "This password has appeared in a data breach. Please choose a different password."
      : "Password must be at least 10 characters."
    return c.json({ error: "weak_password", message: msg }, 400)
  }

  const result = await verifyPasswordResetToken(parsed.data.token)
  if (!result.ok) {
    return c.json({ error: "invalid_or_expired_token", message: "The reset link is invalid or has expired." }, 400)
  }

  const newHash = await hashPassword(parsed.data.new_password)
  await withDbResilience(() => sql`
    UPDATE users SET password_hash = ${newHash} WHERE id = ${result.userId}
  `)

  // Revoke all sessions — user must re-login
  await revokeAllUserSessions(result.userId)

  const activeUser = await getActiveUser(result.userId)
  await audit({
    actorId: result.userId,
    actorEmail: activeUser?.email,
    action: "auth.password_reset_completed",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  await resetAuthRateLimit("password_reset", "ip", ip)

  return c.json({ message: "Password reset successfully. Please log in with your new password." })
})

// ---------------------------------------------------------------------------
// MFA Endpoints: Setup, Enable, Verify
// ---------------------------------------------------------------------------

auth.post("/mfa/setup", async (c) => {
  let userId: string | null = null
  const ticket = c.req.header("x-mfa-ticket") || (await c.req.json().catch(() => ({})))?.mfa_ticket
  if (ticket) {
    userId = verifyMfaTicket(ticket)
  }
  if (!userId) {
    const sessionToken = getSessionToken(c)
    const session = sessionToken ? await verifySession(sessionToken) : null
    userId = session ? session.userId : null
  }
  if (!userId) return c.json({ error: "unauthorized", message: "Session or valid MFA ticket required" }, 401)

  const activeUser = await getActiveUser(userId)
  if (!activeUser) return c.json({ error: "account_suspended" }, 403)

  const secret = generateTotpSecret()
  const recoveryCodes = generateRecoveryCodes(8)

  await withDbResilience(() => sql`
    INSERT INTO user_mfa (user_id, totp_secret, enabled, updated_at)
    VALUES (${userId}, ${secret}, false, now())
    ON CONFLICT (user_id) DO UPDATE SET totp_secret = ${secret}, enabled = false, updated_at = now()
  `)

  // Store recovery codes hashed
  await withDbResilience(() => sql`DELETE FROM user_mfa_recovery_codes WHERE user_id = ${userId}`)
  for (const rc of recoveryCodes) {
    const hash = hashRecoveryCode(rc)
    await withDbResilience(() => sql`
      INSERT INTO user_mfa_recovery_codes (user_id, code_hash) VALUES (${userId}, ${hash})
    `)
  }

  const otpauthUri = generateOtpAuthUri(activeUser.email, secret, "ZenGateway")
  return c.json({
    secret,
    otpauth_uri: otpauthUri,
    recovery_codes: recoveryCodes,
  })
})

const mfaEnableSchema = z.object({
  code: z.string().min(6).max(8),
  mfa_ticket: z.string().optional(),
})

auth.post("/mfa/enable", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = mfaEnableSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: "invalid_payload" }, 400)

  let userId: string | null = null
  if (parsed.data.mfa_ticket) {
    userId = verifyMfaTicket(parsed.data.mfa_ticket)
  }
  if (!userId) {
    const sessionToken = getSessionToken(c)
    const session = sessionToken ? await verifySession(sessionToken) : null
    userId = session ? session.userId : null
  }
  if (!userId) return c.json({ error: "unauthorized" }, 401)

  const mfaRows = await withDbResilience(() => sql`
    SELECT totp_secret FROM user_mfa WHERE user_id = ${userId} LIMIT 1
  `)
  if (mfaRows.length === 0) return c.json({ error: "mfa_not_initialized" }, 400)

  const valid = verifyTotpCode(mfaRows[0].totp_secret, parsed.data.code)
  if (!valid) return c.json({ error: "invalid_code", message: "Invalid verification code" }, 400)

  await withDbResilience(() => sql`
    UPDATE user_mfa SET enabled = true, updated_at = now() WHERE user_id = ${userId}
  `)

  const activeUser = await getActiveUser(userId)
  const ip = getClientIp(c)
  const reqId = getRequestId(c)

  await audit({
    actorId: userId,
    actorEmail: activeUser?.email,
    action: "auth.mfa_enabled",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  // If enabled via mfa_ticket during login, issue session!
  if (parsed.data.mfa_ticket && activeUser) {
    const session = await issueSession(userId, activeUser.role, { ip, ua: c.req.header("user-agent") })
    setSessionCookie(c, session.token, activeUser.role)
    return c.json({ ok: true, message: "MFA enabled and logged in", role: activeUser.role })
  }

  return c.json({ ok: true, message: "MFA enabled successfully" })
})

const mfaVerifySchema = z.object({
  mfa_ticket: z.string(),
  totp_code: z.string().optional(),
  recovery_code: z.string().optional(),
})

auth.post("/mfa/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = mfaVerifySchema.safeParse(body)
  if (!parsed.success) return c.json({ error: "invalid_payload" }, 400)

  const userId = verifyMfaTicket(parsed.data.mfa_ticket)
  if (!userId) return c.json({ error: "invalid_ticket", message: "MFA ticket expired or invalid" }, 401)

  const activeUser = await getActiveUser(userId)
  if (!activeUser) return c.json({ error: "account_suspended" }, 403)

  const mfaRows = await withDbResilience(() => sql`
    SELECT totp_secret, enabled FROM user_mfa WHERE user_id = ${userId} LIMIT 1
  `)
  if (mfaRows.length === 0 || !mfaRows[0].enabled) {
    return c.json({ error: "mfa_not_enabled" }, 400)
  }

  let valid = false
  if (parsed.data.totp_code) {
    valid = verifyTotpCode(mfaRows[0].totp_secret, parsed.data.totp_code)
  } else if (parsed.data.recovery_code) {
    const codeHash = hashRecoveryCode(parsed.data.recovery_code)
    const rcRows = await withDbResilience(() => sql`
      SELECT id FROM user_mfa_recovery_codes
      WHERE user_id = ${userId} AND code_hash = ${codeHash} AND NOT used
      LIMIT 1
    `)
    if (rcRows.length > 0) {
      valid = true
      await withDbResilience(() => sql`
        UPDATE user_mfa_recovery_codes SET used = true, used_at = now() WHERE id = ${rcRows[0].id}
      `)
    }
  }

  if (!valid) {
    return c.json({ error: "invalid_mfa_code", message: "Invalid MFA code" }, 401)
  }

  const existingToken = getSessionToken(c)
  if (existingToken) {
    await revokeSession(existingToken)
  }

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  const session = await issueSession(userId, activeUser.role, { ip, ua: c.req.header("user-agent") })
  setSessionCookie(c, session.token, activeUser.role)

  await audit({
    actorId: userId,
    actorEmail: activeUser.email,
    action: "auth.login",
    resource: "auth",
    ip,
    requestId: reqId,
    metadata: { mfa: true, role: activeUser.role },
  })

  return c.json({ message: "logged in", role: activeUser.role })
})

// ---------------------------------------------------------------------------
// API keys — created from the dashboard, used by the CLI
// ---------------------------------------------------------------------------

auth.post("/api-keys", requireSession(), async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const label = typeof body.label === "string" ? body.label.slice(0, 128) : null

  const { raw, hash, prefix } = generateApiKey()
  await withDbResilience(() => sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (${session.userId}, ${hash}, ${prefix}, ${label})
  `)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: session.userId,
    actorEmail: await actorEmailFor(session.userId),
    action: "api_key.create",
    resource: "api_key",
    ip,
    requestId: reqId,
    metadata: { prefix, label },
  })

  return c.json({ api_key: raw, prefix })
})

auth.get("/api-keys", requireSession(), async (c) => {
  const session = c.var.session
  const rows = await withDbResilience(() => sql`
    SELECT id, key_prefix, label, created_at, last_used_at, revoked
    FROM api_keys WHERE user_id = ${session.userId} ORDER BY created_at DESC
  `)
  return c.json(rows)
})

auth.post("/api-keys/:id/revoke", requireSession(), async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  await withDbResilience(() => sql`UPDATE api_keys SET revoked = true WHERE id = ${id} AND user_id = ${session.userId}`)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: session.userId,
    actorEmail: await actorEmailFor(session.userId),
    action: "api_key.revoke",
    resource: "api_key",
    resourceId: id,
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true })
})
