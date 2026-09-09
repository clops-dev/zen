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
 * Zero extra dependencies — uses only node:crypto + the native fetch API that
 * Bun ships. The PKCE challenge/verifier pair + a state nonce prevent CSRF and
 * code-injection attacks.
 *
 * Admin accounts (email+password) are completely unaffected — this route only
 * creates/matches rows with role = 'user'.
 */

import { Hono } from "hono"
import { setCookie, getCookie } from "hono/cookie"
import { randomBytes, createHash } from "node:crypto"
import { sql } from "../lib/db"
import { issueSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "../lib/session"
import { env } from "../lib/env"
import { approveDeviceCode } from "./device-auth"

export const googleAuth = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base64url-encode a Buffer (no padding). */
const b64url = (buf: Buffer) => buf.toString("base64url")

/** SHA-256 of a string → base64url (for PKCE code_challenge). */
const sha256b64 = (s: string) => b64url(createHash("sha256").update(s).digest())

/** Cookie names for transient OAuth state (survive the redirect round-trip). */
const STATE_COOKIE = "zen_oauth_state"
const VERIFIER_COOKIE = "zen_oauth_verifier"
const DEVICE_CODE_COOKIE = "zen_oauth_device_code"

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

function googleConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL)
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

  // PKCE: generate a random verifier and its SHA-256 challenge.
  const verifier = b64url(randomBytes(48))
  const challenge = sha256b64(verifier)

  // State nonce — stored in a cookie and verified in the callback.
  const state = b64url(randomBytes(24))

  // Short-lived cookies — 10 minutes, same as device_code TTL.
  const cookieOpts = {
    httpOnly: true,
    path: "/",
    maxAge: 600,
    sameSite: "Lax" as const,
    ...(process.env.NODE_ENV !== "development" ? { secure: true as const } : {}),
  }
  setCookie(c, STATE_COOKIE, state, cookieOpts)
  setCookie(c, VERIFIER_COOKIE, verifier, cookieOpts)
  if (deviceCode) setCookie(c, DEVICE_CODE_COOKIE, deviceCode, cookieOpts)

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_CALLBACK_URL!,
    response_type: "code",
    scope: "openid email profile",
    state,
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
  if (!googleConfigured()) {
    return c.redirect("/zencode/login?error=google_not_configured", 303)
  }

  const code = c.req.query("code")
  const returnedState = c.req.query("state")
  const errorParam = c.req.query("error")

  if (errorParam) {
    // User denied consent or Google returned an error.
    return c.redirect(`/zencode/login?error=${encodeURIComponent(errorParam)}`, 303)
  }

  if (!code || !returnedState) {
    return c.redirect("/zencode/login?error=missing_code_or_state", 303)
  }

  // Verify state nonce against the cookie.
  const storedState = getCookie(c, STATE_COOKIE)
  const verifier = getCookie(c, VERIFIER_COOKIE)
  const deviceCode = getCookie(c, DEVICE_CODE_COOKIE) ?? ""

  if (!storedState || returnedState !== storedState) {
    return c.redirect("/zencode/login?error=invalid_state", 303)
  }
  if (!verifier) {
    return c.redirect("/zencode/login?error=missing_verifier", 303)
  }

  // Clear the transient cookies.
  const clearOpts = { path: "/", maxAge: 0 }
  setCookie(c, STATE_COOKIE, "", { ...clearOpts, httpOnly: true, sameSite: "Lax" })
  setCookie(c, VERIFIER_COOKIE, "", { ...clearOpts, httpOnly: true, sameSite: "Lax" })
  setCookie(c, DEVICE_CODE_COOKIE, "", { ...clearOpts, httpOnly: true, sameSite: "Lax" })

  // Exchange the authorization code for tokens.
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
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description ?? tokenData.error ?? "token exchange failed")
    }
  } catch (err) {
    console.error("[google-auth] token exchange failed:", err)
    return c.redirect("/zencode/login?error=token_exchange_failed", 303)
  }

  // Fetch the Google profile.
  let profile: { sub: string; email: string; name?: string; picture?: string }
  try {
    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    profile = await profileRes.json()
    if (!profile.sub || !profile.email) throw new Error("incomplete profile")
  } catch (err) {
    console.error("[google-auth] userinfo fetch failed:", err)
    return c.redirect("/zencode/login?error=profile_fetch_failed", 303)
  }

  // Upsert user — match on google_id first, then fall back to email.
  let userId: string
  try {
    // Try to find existing user by google_id.
    let rows = await sql`SELECT id FROM users WHERE google_id = ${profile.sub}`

    if (rows.length === 0) {
      // No google_id match — check if email exists (e.g. old email/password account).
      rows = await sql`SELECT id FROM users WHERE email = ${profile.email}`
      if (rows.length > 0) {
        // Email exists — link Google account to it (first Google login upgrades the row).
        await sql`
          UPDATE users
             SET google_id  = ${profile.sub},
                 avatar_url = ${profile.picture ?? null}
           WHERE id = ${rows[0].id}
        `
        userId = rows[0].id
      } else {
        // Brand-new user — create with Google identity, no password.
        const [newUser] = await sql`
          INSERT INTO users (email, google_id, avatar_url, role)
          VALUES (${profile.email}, ${profile.sub}, ${profile.picture ?? null}, 'user')
          RETURNING id
        `
        await sql`
          INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
          VALUES (${newUser.id}, 'free', 'active', ${env.DEFAULT_FREE_TOKEN_BUDGET})
        `
        userId = newUser.id
      }
    } else {
      // Known Google user — refresh avatar in case it changed.
      userId = rows[0].id
      if (profile.picture) {
        await sql`UPDATE users SET avatar_url = ${profile.picture} WHERE id = ${userId}`
      }
    }

    // Verify the account isn't suspended.
    const [sub] = await sql`SELECT status FROM subscriptions WHERE user_id = ${userId}`
    if (sub?.status === "suspended") {
      return c.redirect("/zencode/login?error=account_suspended", 303)
    }
  } catch (err) {
    console.error("[google-auth] db upsert failed:", err)
    return c.redirect("/zencode/login?error=db_error", 303)
  }

  // Issue session cookie.
  const session = issueSession(userId, "user")
  setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)

  // If the user came from `zencode login` (device flow), approve the device code.
  if (deviceCode) {
    try {
      const approved = await approveDeviceCode(deviceCode, userId)
      if (!approved) {
        // Code expired — but the user is still logged in to the web portal.
        return c.redirect("/zencode/app/dashboard?error=device_code_expired", 303)
      }
      // Show a success page inside the SPA for the device flow.
      return c.redirect("/zencode/device-success", 303)
    } catch (err) {
      console.error("[google-auth] device code approval failed:", err)
      return c.redirect("/zencode/app/dashboard?error=device_approval_failed", 303)
    }
  }

  // Normal web login — go to dashboard.
  return c.redirect("/zencode/app/dashboard", 303)
})
