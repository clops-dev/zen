/**
 * /user-api  —  protected JSON API consumed exclusively by the Zencode React SPA.
 *
 * All routes require a valid session cookie with role = 'user'.
 * Admins use /admin-api instead; these endpoints deliberately reject admin
 * sessions so the admin account can never accidentally pollute user data.
 *
 * Routes:
 *   GET  /user-api/me                    — profile + subscription summary
 *   GET  /user-api/api-keys              — list the user's API keys
 *   POST /user-api/api-keys              — create a new key
 *   POST /user-api/api-keys/:id/revoke   — revoke a key
 *   GET  /user-api/usage                 — monthly usage rows (last 6 months)
 *   GET  /user-api/usage/daily           — daily usage rows (last N days)
 *   POST /user-api/logout                — clear session cookie
 */

import { Hono, type Context } from "hono"
import { sql, withDbResilience } from "../lib/db"
import { requireSession } from "../middleware/session-auth"
import { csrfProtection } from "../middleware/csrf"
import { generateApiKey } from "../lib/apikeys"
import {
  getSessionToken,
  clearSessionCookie,
  revokeSession,
  revokeAllUserSessions,
  issueSession,
  setSessionCookie,
} from "../lib/session"
import { hashPassword, verifyPassword } from "../lib/password"
import {
  generateTotpSecret,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  generateOtpAuthUri,
} from "../lib/totp"
import { audit, actorEmailFor } from "../lib/audit"
import { getActiveUser } from "../lib/active-user"
import {
  getBalance,
  getTransactionHistory,
  addCredits,
  isValidPackage,
  DT_PER_USD,
  getUserBillingSummary,
  canSeeBalance,
} from "../lib/credits"

export const userApi = new Hono()

// Apply CSRF protection
userApi.use("*", csrfProtection())

import { getClientIp } from "../lib/client-ip"

function getRequestId(c: Context): string {
  return c.get("requestId") ?? c.req.header("x-request-id") ?? `req-${Date.now()}`
}

// ---------------------------------------------------------------------------
// Auth guard — all routes below require a user session.
// ---------------------------------------------------------------------------

userApi.use("*", requireSession())

// Reject admin sessions — admins should never hit the user portal API.
userApi.use("*", async (c, next) => {
  if (c.var.session.role !== "user") {
    return c.json({ error: "forbidden", message: "user session required" }, 403)
  }
  return next()
})

// ---------------------------------------------------------------------------
// GET /user-api/me
// ---------------------------------------------------------------------------

userApi.get("/me", async (c) => {
  const { userId } = c.var.session

  const rows = await withDbResilience(() => sql`
    SELECT
      u.id,
      u.email,
      u.avatar_url,
      u.created_at,
      (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND revoked = false) AS active_key_count,
      (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) AS total_key_count
    FROM users u
    WHERE u.id = ${userId}
  `)

  if (rows.length === 0) return c.json({ error: "user_not_found" }, 404)
  const u = rows[0] as any

  const billing = await getUserBillingSummary(userId)
  const visible = await canSeeBalance(userId)

  return c.json({
    id: u.id, email: u.email, avatar_url: u.avatar_url ?? null, created_at: u.created_at,
    status: "active", active_key_count: Number(u.active_key_count ?? 0), total_key_count: Number(u.total_key_count ?? 0),
    ...(visible ? {
      total_credits_purchased: billing.total_credits_purchased, total_credits_purchased_dt: billing.total_credits_purchased_dt,
      total_usage_cost: billing.total_usage_cost, remaining_credits: billing.remaining_credits, remaining_credits_dt: billing.remaining_credits_dt,
      credit_balance_dt: billing.remaining_credits_dt, credit_balance_usd_value: billing.remaining_credits,
      has_credits: billing.remaining_credits > 0,
    } : { trial_status: billing.total_usage_cost > 0 ? "Free trial used up" : "Free trial: active", trial_cta: "Add credits to continue" }),
    total_requests: billing.total_requests, input_tokens: billing.input_tokens, output_tokens: billing.output_tokens, total_tokens: billing.total_tokens,
    ...(visible ? { has_purchased_credits: billing.has_purchased_credits } : { balance_visible: false }),
  })
})

userApi.get("/billing/summary", async (c) => {
  const { userId } = c.var.session
  const billing = await getUserBillingSummary(userId)
  if (await canSeeBalance(userId)) return c.json(billing)
  return c.json({ userId, trial_status: billing.total_usage_cost > 0 ? "Free trial used up" : "Free trial: active", trial_cta: "Add credits to continue", total_requests: billing.total_requests, input_tokens: billing.input_tokens, output_tokens: billing.output_tokens, total_tokens: billing.total_tokens })
})

// ---------------------------------------------------------------------------
// GET /user-api/api-keys
// ---------------------------------------------------------------------------

userApi.get("/api-keys", async (c) => {
  const { userId } = c.var.session
  const rows = await withDbResilience(() => sql`
    SELECT id, key_prefix, label, created_at, last_used_at, revoked
      FROM api_keys
     WHERE user_id = ${userId}
     ORDER BY created_at DESC
  `)
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /user-api/api-keys
// ---------------------------------------------------------------------------

userApi.post("/api-keys", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 128) : null

  const { raw, hash, prefix } = generateApiKey()
  await withDbResilience(() => sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
    VALUES (${userId}, ${hash}, ${prefix}, ${label})
  `)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    actorEmail: await actorEmailFor(userId),
    action: "api_key.create",
    resource: "api_key",
    ip,
    requestId: reqId,
    metadata: { prefix, label },
  })

  // Raw key returned exactly once — not stored, not recoverable.
  return c.json({ api_key: raw, prefix }, 201)
})

// ---------------------------------------------------------------------------
// POST /user-api/api-keys/:id/revoke
// ---------------------------------------------------------------------------

userApi.post("/api-keys/:id/revoke", async (c) => {
  const { userId } = c.var.session
  const keyId = c.req.param("id")

  const result = await withDbResilience(() => sql`
    UPDATE api_keys
       SET revoked = true
     WHERE id = ${keyId}
       AND user_id = ${userId}
       AND revoked = false
  `)

  if (result.count === 0) {
    return c.json({ error: "not_found_or_already_revoked" }, 404)
  }

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    actorEmail: await actorEmailFor(userId),
    action: "api_key.revoke",
    resource: "api_key",
    resourceId: keyId,
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// GET /user-api/usage  —  monthly aggregates (last 6 months)
// ---------------------------------------------------------------------------

userApi.get("/usage", async (c) => {
  const { userId } = c.var.session

  const rows = await withDbResilience(() => sql`
    SELECT
      month,
      total_input_tokens,
      total_output_tokens,
      total_cached_tokens,
      total_cost_usd,
      request_count
    FROM monthly_usage
    WHERE user_id = ${userId}
      AND month >= date_trunc('month', now() - interval '5 months')::date
    ORDER BY month ASC
  `)

  const visible = await canSeeBalance(userId)
  return c.json(rows.map((r: any) => ({
    month: r.month, input_tokens: Number(r.total_input_tokens), output_tokens: Number(r.total_output_tokens), cached_tokens: Number(r.total_cached_tokens),
    ...(visible ? { cost_usd: Number(r.total_cost_usd) } : {}), request_count: Number(r.request_count),
  })))
})

// ---------------------------------------------------------------------------
// GET /user-api/usage/daily  —  per-day usage (last 30 days by default)
// ---------------------------------------------------------------------------

userApi.get("/usage/daily", async (c) => {
  const { userId } = c.var.session
  const days = Math.min(90, Math.max(7, Number(c.req.query("days") ?? 30)))

  const rows = await withDbResilience(() => sql`
    SELECT
      created_at::date AS day,
      COUNT(*) AS request_count,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cost_usd)      AS cost_usd
    FROM ai_requests
    WHERE user_id = ${userId}
      AND status = 'success'
      AND created_at >= now() - (${days} || ' days')::interval
    GROUP BY day
    ORDER BY day ASC
  `)

  const visible = await canSeeBalance(userId)
  return c.json(rows.map((r: any) => ({
    day: r.day, request_count: Number(r.request_count), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
    ...(visible ? { cost_usd: Number(r.cost_usd) } : {}),
  })))
})

// ---------------------------------------------------------------------------
// POST /user-api/logout
// ---------------------------------------------------------------------------

userApi.post("/logout", async (c) => {
  const token = getSessionToken(c)
  if (token) {
    await revokeSession(token)
  }
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: c.var.session.userId,
    action: "auth.logout",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /user-api/logout-all
// ---------------------------------------------------------------------------

userApi.post("/logout-all", async (c) => {
  const { userId } = c.var.session
  await revokeAllUserSessions(userId)
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    action: "auth.logout_all",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true, message: "Logged out from all devices" })
})

// ---------------------------------------------------------------------------
// POST /user-api/change-password
// ---------------------------------------------------------------------------

userApi.post("/change-password", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const { current_password, new_password } = body

  if (!current_password || !new_password || typeof new_password !== "string" || new_password.length < 8) {
    return c.json({ error: "invalid_payload", message: "Password must be at least 8 characters" }, 400)
  }

  const rows = await withDbResilience(() => sql`
    SELECT password_hash FROM users WHERE id = ${userId} LIMIT 1
  `)
  if (rows.length === 0) return c.json({ error: "not_found" }, 404)

  const ok = await verifyPassword(current_password, rows[0].password_hash)
  if (!ok) return c.json({ error: "invalid_current_password", message: "Current password does not match" }, 400)

  const newHash = await hashPassword(new_password)
  await withDbResilience(() => sql`
    UPDATE users SET password_hash = ${newHash} WHERE id = ${userId}
  `)

  // Revoke all existing sessions
  await revokeAllUserSessions(userId)
  clearSessionCookie(c)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    action: "auth.password_change",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true, message: "Password updated successfully; please log in again" })
})

// ---------------------------------------------------------------------------
// MFA Endpoints for User
// ---------------------------------------------------------------------------

userApi.get("/mfa", async (c) => {
  const { userId } = c.var.session
  const rows = await withDbResilience(() => sql`
    SELECT enabled FROM user_mfa WHERE user_id = ${userId} LIMIT 1
  `).catch(() => [])
  return c.json({ enabled: rows[0]?.enabled ?? false })
})

userApi.post("/mfa/setup", async (c) => {
  const { userId } = c.var.session
  const activeUser = await getActiveUser(userId)
  if (!activeUser) return c.json({ error: "account_suspended" }, 403)

  const secret = generateTotpSecret()
  const recoveryCodes = generateRecoveryCodes(8)

  await withDbResilience(() => sql`
    INSERT INTO user_mfa (user_id, totp_secret, enabled, updated_at)
    VALUES (${userId}, ${secret}, false, now())
    ON CONFLICT (user_id) DO UPDATE SET totp_secret = ${secret}, enabled = false, updated_at = now()
  `)

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

userApi.post("/mfa/enable", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code ?? "")

  const mfaRows = await withDbResilience(() => sql`
    SELECT totp_secret FROM user_mfa WHERE user_id = ${userId} LIMIT 1
  `)
  if (mfaRows.length === 0) return c.json({ error: "mfa_not_initialized" }, 400)

  const valid = verifyTotpCode(mfaRows[0].totp_secret, code)
  if (!valid) return c.json({ error: "invalid_code", message: "Invalid verification code" }, 400)

  await withDbResilience(() => sql`
    UPDATE user_mfa SET enabled = true, updated_at = now() WHERE user_id = ${userId}
  `)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    action: "auth.mfa_enabled",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true, message: "MFA enabled successfully" })
})

userApi.post("/mfa/disable", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code ?? "")

  const mfaRows = await withDbResilience(() => sql`
    SELECT totp_secret, enabled FROM user_mfa WHERE user_id = ${userId} LIMIT 1
  `)
  if (mfaRows.length === 0 || !mfaRows[0].enabled) return c.json({ error: "mfa_not_enabled" }, 400)

  const valid = verifyTotpCode(mfaRows[0].totp_secret, code)
  if (!valid) return c.json({ error: "invalid_code", message: "Invalid verification code" }, 400)

  await withDbResilience(() => sql`
    UPDATE user_mfa SET enabled = false, updated_at = now() WHERE user_id = ${userId}
  `)

  const ip = getClientIp(c)
  const reqId = getRequestId(c)
  await audit({
    actorId: userId,
    action: "auth.mfa_disabled",
    resource: "auth",
    ip,
    requestId: reqId,
  })

  return c.json({ ok: true, message: "MFA disabled successfully" })
})

// ---------------------------------------------------------------------------
// GET /user-api/credits  —  current balance
// ---------------------------------------------------------------------------

userApi.get("/credits", async (c) => {
  const { userId } = c.var.session
  if (!(await canSeeBalance(userId))) return c.json({ trial_status: "Free trial: active", trial_cta: "Add credits to continue" })
  const balance = await getBalance(userId)
  return c.json(balance)
})

// ---------------------------------------------------------------------------
// GET /user-api/credits/history  —  last 50 transactions
// ---------------------------------------------------------------------------

userApi.get("/credits/history", async (c) => {
  const { userId } = c.var.session
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)))
  if (!(await canSeeBalance(userId))) return c.json({ trial_status: "Free trial: active", trial_cta: "Add credits to continue", transactions: [] })
  const txs = await getTransactionHistory(userId, limit)
  return c.json(txs)
})

// ---------------------------------------------------------------------------
// POST /user-api/credits/purchase-intent
// Create a pending purchase record for the chosen DT package.
// When a real payment provider is integrated, it will confirm this
// transaction via a webhook; for now the record is returned to the client.
// ---------------------------------------------------------------------------

userApi.post("/credits/purchase-intent", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const amount_dt = Number(body.amount_dt)

  if (!isValidPackage(amount_dt)) {
    return c.json({
      error: "invalid_amount",
      message: `amount_dt must be a multiple of 5, between 5 and 10000 DT. Got: ${amount_dt}`,
    }, 400)
  }

  const usdValue = Number((amount_dt / DT_PER_USD).toFixed(2))

  const result = await addCredits(userId, amount_dt, "purchase", "pending", {
    paymentRef: undefined,
    adminNote: `Purchase intent: ${amount_dt} DT ($${usdValue} AI value)`,
  })

  return c.json({
    transaction_id: result.transaction_id,
    amount_dt,
    status: "pending",
    payment_ref: null,
    message: "Purchase intent recorded. Connect a payment provider to complete the transaction.",
  }, 201)
})

userApi.post("/credits/purchase", async (c) => {
  const { userId } = c.var.session
  const body = await c.req.json().catch(() => ({}))
  let amount_dt = Number(body.amount_dt)
  if (!amount_dt && body.amount_usd) {
    amount_dt = Number(body.amount_usd) * DT_PER_USD
  }

  if (!isValidPackage(amount_dt)) {
    return c.json({
      error: "invalid_amount",
      message: `amount_dt must be a multiple of 5, between 5 and 10000 DT. Got: ${amount_dt}`,
    }, 400)
  }

  const prevSummary = await getUserBillingSummary(userId)
  const prevBalanceUsd = prevSummary.remaining_credits
  const creditsAddedUsd = Number((amount_dt / DT_PER_USD).toFixed(2))

  const result = await addCredits(userId, amount_dt, "purchase", "pending", {
    adminNote: `User top-up purchase demand: ${amount_dt} DT ($${creditsAddedUsd} AI value)`,
  })

  const currentSummary = await getUserBillingSummary(userId)
  const visible = await canSeeBalance(userId)

  return c.json({
    ok: true,
    status: "pending",
    message: "Credit purchase demand submitted successfully. Your credits will be added to your wallet once approved by an admin.",
    receipt: {
      transaction_id: result.transaction_id,
      date: new Date().toISOString(),
      amount_paid_dt: amount_dt,
      ...(visible ? { credits_added_usd: creditsAddedUsd, previous_balance_usd: prevBalanceUsd, new_balance_usd: prevBalanceUsd } : {}),
      status: "pending",
    },
    billing: visible ? currentSummary : { trial_status: "Free trial: active", trial_cta: "Add credits to continue" },
  }, 201)
})
