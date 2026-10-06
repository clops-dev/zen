/**
 * Google OAuth 2.0 flow for the Zencode user portal.
 *
 * Two endpoints:
 *   GET /auth/google          — builds the Google consent URL and redirects.
 *   GET /auth/google/callback — exchanges the code, upserts the user, issues
 *                               a session cookie, and handles device-code
 *                               approval if the original request carried one
 *                               (i.e. the user came from `zencode login`).
 *
 * Zero extra dependencies — uses node:crypto + native fetch.
 * The PKCE challenge/verifier pair + state nonce + ID token nonce prevent CSRF,
 * replay, and code-injection attacks.
 *
 * Security guarantees:
 * 1. email_verified must be true (verified in ID token and userinfo).
 * 2. ID token is cryptographically verified (signature, iss, aud, exp, nonce).
 * 3. Existing admin accounts are NEVER auto-linked to Google identities.
 * 4. Existing password accounts are NEVER silently linked; linking requires
 *    the user to be authenticated into that account first.
 * 5. All emails are canonicalized via normalizeEmail (lower(trim())).
 * 6. Suspended users are checked and denied before issuing any session.
 * 7. Fails closed on every error path, never revealing failure reasons to the browser.
 */

import { Hono, type Context } from "hono"
import { setCookie, getCookie } from "hono/cookie"
import { randomBytes, createHash } from "node:crypto"
import { sql } from "../lib/db"
import { issueSession, verifySession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "../lib/session"
import { env } from "../lib/env"
import { log } from "../lib/logger"
import { approveDeviceCode } from "./device-auth"
import { addCredits, WELCOME_CREDITS_DT, WELCOME_DISPLAY_USD } from "../lib/credits"
import { normalizeEmail } from "../lib/email"
import { verifyGoogleIdToken, type GoogleIdTokenClaims } from "../lib/google-token"

export const googleAuth = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base64url-encode a Buffer (no padding). */
const b64url = (buf: Buffer) => buf.toString("base64url")

/** SHA-256 of a string → base64url (for PKCE code_challenge). */
const sha256b64 = (s: string) => b64url(createHash("sha256").update(s).digest())

/** Cookie names for transient OAuth state (survive the redirect round-trip). */
export const STATE_COOKIE = "zen_oauth_state"
export const VERIFIER_COOKIE = "zen_oauth_verifier"
export const NONCE_COOKIE = "zen_oauth_nonce"
export const DEVICE_CODE_COOKIE = "zen_oauth_device_code"
export const LINK_USER_COOKIE = "zen_oauth_link_user"

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

function googleConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL)
}

function clearTransientCookies(c: Context) {
  const clearOpts = { path: "/", maxAge: 0, httpOnly: true, sameSite: "Lax" as const }
  setCookie(c, STATE_COOKIE, "", clearOpts)
  setCookie(c, VERIFIER_COOKIE, "", clearOpts)
  setCookie(c, NONCE_COOKIE, "", clearOpts)
  setCookie(c, DEVICE_CODE_COOKIE, "", clearOpts)
  setCookie(c, LINK_USER_COOKIE, "", clearOpts)
}

// ---------------------------------------------------------------------------
// GET /auth/google  —  build consent URL, redirect
// ---------------------------------------------------------------------------

googleAuth.get("/google", async (c) => {
  if (!googleConfigured()) {
    return c.json(
      {
        error: "google_oauth_not_configured",
        message:
          "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL in your .env to enable Google login.",
      },
      503,
    )
  }

  // Optional device_code forwarded by the CLI flow via query param.
  const deviceCode = c.req.query("device_code") ?? ""

  // Check if an existing logged-in user is initiating the flow (explicit link).
  const currentSessionToken = getCookie(c, SESSION_COOKIE)
  const currentSession = currentSessionToken ? verifySession(currentSessionToken) : null

  // PKCE: generate random verifier and its SHA-256 challenge.
  const verifier = b64url(randomBytes(48))
  const challenge = sha256b64(verifier)

  // State nonce — verified in the callback to prevent CSRF.
  const state = b64url(randomBytes(24))

  // OpenID Connect nonce — verified inside ID token claims to prevent replay.
  const nonce = b64url(randomBytes(24))

  // Short-lived cookies — 10 minutes.
  const cookieOpts = {
    httpOnly: true,
    path: "/",
    maxAge: 600,
    sameSite: "Lax" as const,
    ...(process.env.NODE_ENV !== "development" ? { secure: true as const } : {}),
  }
  setCookie(c, STATE_COOKIE, state, cookieOpts)
  setCookie(c, VERIFIER_COOKIE, verifier, cookieOpts)
  setCookie(c, NONCE_COOKIE, nonce, cookieOpts)
  if (deviceCode) setCookie(c, DEVICE_CODE_COOKIE, deviceCode, cookieOpts)
  if (currentSession?.userId) setCookie(c, LINK_USER_COOKIE, currentSession.userId, cookieOpts)

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_CALLBACK_URL!,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account",
  })

  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302)
})

// ---------------------------------------------------------------------------
// GET /auth/google/callback  —  exchange code, upsert user, issue session
// ---------------------------------------------------------------------------

googleAuth.get("/google/callback", async (c) => {
  const reqId = c.get("requestId") ?? randomBytes(16).toString("hex")

  // Helper to fail closed on every error path, log server-side with request_id,
  // clear transient state cookies, and never reveal details to the browser.
  const failClosed = (reason: string, details?: unknown) => {
    log.warn("google_oauth_callback_failed", {
      request_id: reqId,
      reason,
      details: details instanceof Error ? details.message : details ? String(details) : undefined,
    })
    clearTransientCookies(c)
    return c.redirect("/zencode/login?error=auth_failed", 303)
  }

  if (!googleConfigured()) {
    return failClosed("google_not_configured")
  }

  const code = c.req.query("code")
  const returnedState = c.req.query("state")
  const errorParam = c.req.query("error")

  if (errorParam) {
    return failClosed("google_returned_error", errorParam)
  }

  if (!code || !returnedState) {
    return failClosed("missing_code_or_state")
  }

  // Retrieve transient cookies
  const storedState = getCookie(c, STATE_COOKIE)
  const verifier = getCookie(c, VERIFIER_COOKIE)
  const storedNonce = getCookie(c, NONCE_COOKIE)
  const deviceCode = getCookie(c, DEVICE_CODE_COOKIE) ?? ""
  const linkUserId = getCookie(c, LINK_USER_COOKIE) ?? ""

  // State, verifier, and nonce verification
  if (!storedState || returnedState !== storedState) {
    return failClosed("invalid_or_mismatched_state")
  }
  if (!verifier) {
    return failClosed("missing_verifier")
  }
  if (!storedNonce) {
    return failClosed("missing_nonce")
  }

  // Clear transient cookies immediately — prevents replay of the authorization code/state.
  clearTransientCookies(c)

  // 1. Exchange authorization code for tokens
  let tokenData: any
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: env.GOOGLE_CALLBACK_URL!,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        code_verifier: verifier,
      }),
    })
    tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token || !tokenData.id_token) {
      return failClosed("token_exchange_failed", tokenData?.error_description ?? tokenData?.error ?? `status_${tokenRes.status}`)
    }
  } catch (err) {
    return failClosed("token_exchange_exception", err)
  }

  // 2. Validate Google ID token (signature, iss, aud, exp, nonce, email_verified)
  let idTokenClaims: GoogleIdTokenClaims
  try {
    idTokenClaims = await verifyGoogleIdToken({
      idToken: tokenData.id_token,
      expectedAudience: env.GOOGLE_CLIENT_ID!,
      expectedNonce: storedNonce,
    })
  } catch (err) {
    return failClosed("id_token_validation_failed", err)
  }

  // 3. Fetch userinfo profile
  let profile: { sub: string; email: string; email_verified?: boolean | string; name?: string; picture?: string }
  try {
    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    if (!profileRes.ok) {
      return failClosed("userinfo_fetch_failed", `status_${profileRes.status}`)
    }
    profile = await profileRes.json()
    if (!profile.sub || !profile.email) {
      return failClosed("incomplete_userinfo_profile")
    }
  } catch (err) {
    return failClosed("userinfo_fetch_exception", err)
  }

  // 4. Reject login unless userinfo response has email_verified === true
  const userinfoEmailVerified = profile.email_verified === true || profile.email_verified === "true"
  if (!userinfoEmailVerified) {
    return failClosed("userinfo_email_not_verified")
  }

  // Cross-validate userinfo against validated ID token claims
  if (profile.sub !== idTokenClaims.sub) {
    return failClosed("userinfo_id_token_sub_mismatch")
  }
  if (normalizeEmail(profile.email) !== normalizeEmail(idTokenClaims.email)) {
    return failClosed("userinfo_id_token_email_mismatch")
  }

  // 5. Account resolution, anti-impersonation, and linking checks
  const email = normalizeEmail(profile.email)
  const googleId = profile.sub
  const avatarUrl = typeof profile.picture === "string" ? profile.picture : null

  let userId: string
  let userRole: "user" | "admin" = "user"

  try {
    // Check if user already exists by google_id
    const existingByGoogle = await sql`
      SELECT id, role FROM users WHERE google_id = ${googleId}
    `

    if (existingByGoogle.length > 0) {
      userId = existingByGoogle[0].id
      userRole = existingByGoogle[0].role === "admin" ? "admin" : "user"

      // Check suspended status before issuing session
      const [sub] = await sql`SELECT status FROM subscriptions WHERE user_id = ${userId}`
      if (sub?.status === "suspended") {
        return failClosed("account_suspended", { userId })
      }

      // Refresh avatar
      if (avatarUrl) {
        await sql`UPDATE users SET avatar_url = ${avatarUrl} WHERE id = ${userId}`
      }
    } else {
      // No google_id match — check if an account already exists with this email
      const existingByEmail = await sql`
        SELECT id, role, password_hash, google_id FROM users WHERE lower(email) = ${email}
      `

      if (existingByEmail.length > 0) {
        const existing = existingByEmail[0]

        // Rule 2: NEVER auto-link Google to an existing account with role "admin"
        if (existing.role === "admin") {
          return failClosed("auto_link_to_admin_account_denied", { email })
        }

        // Rule 3: For existing password accounts: do NOT silently link.
        // Require the user to be logged in to that account first and explicitly link.
        const isPasswordAccount = Boolean(existing.password_hash)
        const isExplicitLink = Boolean(linkUserId && linkUserId === existing.id)

        if (isPasswordAccount && !isExplicitLink) {
          return failClosed("silent_link_to_password_account_denied", { email })
        }

        userId = existing.id
        userRole = existing.role === "admin" ? "admin" : "user"

        // Check suspended status before linking
        const [sub] = await sql`SELECT status FROM subscriptions WHERE user_id = ${userId}`
        if (sub?.status === "suspended") {
          return failClosed("account_suspended", { userId })
        }

        await sql`
          UPDATE users
             SET google_id  = ${googleId},
                 avatar_url = COALESCE(${avatarUrl}, avatar_url)
           WHERE id = ${userId}
        `
      } else {
        // Brand-new user — create user with Google identity
        const [newUser] = await sql`
          INSERT INTO users (email, google_id, avatar_url, role)
          VALUES (${email}, ${googleId}, ${avatarUrl}, 'user')
          RETURNING id
        `
        userId = newUser.id
        userRole = "user"

        await sql`
          INSERT INTO user_credits (user_id, balance_dt)
          VALUES (${userId}, 0)
          ON CONFLICT (user_id) DO NOTHING
        `
        await sql`
          INSERT INTO subscriptions (user_id, tier, status)
          VALUES (${userId}, 'free', 'active')
          ON CONFLICT (user_id) DO NOTHING
        `
        await addCredits(userId, WELCOME_CREDITS_DT, "admin_grant", "completed", {
          adminNote: `Welcome bonus: ${WELCOME_CREDITS_DT} DT granted on Google signup (displays as $${WELCOME_DISPLAY_USD} to user)`,
        })
      }
    }

    // Final check for suspension before issuing session
    const [finalSub] = await sql`SELECT status FROM subscriptions WHERE user_id = ${userId}`
    if (finalSub?.status === "suspended") {
      return failClosed("account_suspended", { userId })
    }

    // Issue session cookie
    const session = issueSession(userId, userRole)
    setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)
  } catch (err) {
    return failClosed("db_error", err)
  }

  // Handle device-code approval if present (CLI flow)
  if (deviceCode) {
    try {
      const approved = await approveDeviceCode(deviceCode, userId)
      if (!approved) {
        return c.redirect("/zencode/app/dashboard?error=device_code_expired", 303)
      }
      return c.redirect("/zencode/device-success", 303)
    } catch (err) {
      log.warn("google_oauth_device_approval_failed", { request_id: reqId, error: String(err) })
      return c.redirect("/zencode/app/dashboard?error=device_approval_failed", 303)
    }
  }

  return c.redirect("/zencode/app/dashboard", 303)
})
