import { Hono } from "hono"
import { setCookie, deleteCookie, getCookie } from "hono/cookie"
import { randomBytes } from "node:crypto"
import { sql } from "../lib/db"
import { hashPassword, verifyPassword } from "../lib/password"
import {
  issueSession,
  verifySession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "../lib/session"
import { getActiveUser } from "../lib/active-user"
import { requireSession } from "../middleware/session-auth"
import { layoutHtml, escape } from "../lib/html"
import { generateApiKey } from "../lib/apikeys"
import { env } from "../lib/env"
import { approveDeviceByUserCode, getDeviceRequestByUserCode, recordFailedUserCodeAttempt } from "./device-auth"
import { formatUserCode, normalizeUserCode, coarseLocationForIp } from "../lib/device-code"
import { addCredits, WELCOME_CREDITS_DT, WELCOME_DISPLAY_USD } from "../lib/credits"
import { normalizeEmail } from "../lib/email"
export const web = new Hono()

// ---------------------------------------------------------------------------
// Login / signup — plain form posts, no client JS, sets the session cookie
// and redirects. Distinct from the JSON /v1/auth/* endpoints the CLI could
// also use if you ever want a scripted signup.
// ---------------------------------------------------------------------------

web.get("/login", async (c) => {
  const body = `
  <div class="center-wrap">
    <div class="center-card">
      <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
      <h1>Log in</h1>
      <p class="lead">Use the email and password from your account.</p>
      <form method="POST" action="/login">
        <input type="email" name="email" placeholder="email" required autocomplete="email">
        <input type="password" name="password" placeholder="password" required autocomplete="current-password">
        <button type="submit" class="primary">Log in</button>
      </form>
      <div class="switch">No account? <a href="/signup" class="accent">Sign up</a></div>
    </div>
  </div>`
  return c.html(layoutHtml("log in", "", body, { error: c.req.query("error") }))
})

web.post("/login", async (c) => {
  const body = await c.req.parseBody()
  const email = normalizeEmail(String(body.email ?? ""))
  const password = String(body.password ?? "")

  const rows = await sql`SELECT id, password_hash, role FROM users WHERE lower(email) = ${email}`
  if (rows.length === 0) return c.redirect("/login?error=invalid+credentials", 303)

  const user = rows[0] as { id: string; password_hash: string; role: "user" | "admin" }
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) return c.redirect("/login?error=invalid+credentials", 303)
  const activeUser = await getActiveUser(user.id)
  if (!activeUser) return c.redirect("/login?error=account+suspended", 303)

  const existingToken = getSessionToken(c)
  if (existingToken) {
    await revokeSession(existingToken)
  }

  const session = await issueSession(user.id, activeUser.role)
  setSessionCookie(c, session.token, activeUser.role)

  const redirectTarget = c.req.query("redirect")
  if (redirectTarget && redirectTarget.startsWith("/")) {
    return c.redirect(redirectTarget, 303)
  }

  return c.redirect(activeUser.role === "admin" ? "/admin2" : "/dashboard", 303)
})

web.get("/signup", async (c) => {
  const body = `
  <div class="center-wrap">
    <div class="center-card">
      <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
      <h1>Create account</h1>
       <p class="lead">New accounts include $0.50 in AI credits.</p>
      <form method="POST" action="/signup">
        <input type="email" name="email" placeholder="email" required autocomplete="email">
        <input type="password" name="password" placeholder="password (min 8 chars)" required minlength="8" autocomplete="new-password">
        <button type="submit" class="primary">Sign up</button>
      </form>
      <div class="switch">Already have an account? <a href="/login" class="accent">Log in</a></div>
    </div>
  </div>`
  return c.html(layoutHtml("sign up", "", body, { error: c.req.query("error") }))
})

web.post("/signup", async (c) => {
  const body = await c.req.parseBody()
  const email = normalizeEmail(String(body.email ?? ""))
  const password = String(body.password ?? "")

  if (password.length < 8) return c.redirect("/signup?error=password+too+short", 303)

  const existing = await sql`SELECT id FROM users WHERE lower(email) = ${email}`
  if (existing.length > 0) return c.redirect("/signup?error=email+already+registered", 303)

  const hash = await hashPassword(password)
  const [newUser] = await sql`INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, 'user') RETURNING id`
  await sql`
    INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
    VALUES (${newUser.id}, 'free', 'active', ${env.DEFAULT_FREE_TOKEN_BUDGET})
  `
  await addCredits(newUser.id, WELCOME_CREDITS_DT, "admin_grant", "completed", {
    adminNote: `Welcome bonus: ${WELCOME_CREDITS_DT} DT granted on signup (displays as $${WELCOME_DISPLAY_USD} to user)`,
  })

  const session = await issueSession(newUser.id, "user")
  setSessionCookie(c, session.token, "user")
  return c.redirect("/dashboard", 303)
})

web.post("/logout", async (c) => {
  const token = getSessionToken(c)
  if (token) {
    await revokeSession(token)
  }
  clearSessionCookie(c)
  return c.redirect("/login", 303)
})

// ---------------------------------------------------------------------------
// Dashboard — a logged-in user's own tier, usage, and API keys
// ---------------------------------------------------------------------------

web.get("/dashboard", requireSession(), async (c) => {
  const session = c.var.session
  let err: string | null = null
  let user: any = null
  let keys: any[] = []

  try {
    const rows = await sql`
      SELECT u.email, s.tier, s.status, s.token_budget_monthly,
        COALESCE((SELECT total_input_tokens + total_output_tokens FROM monthly_usage
          WHERE user_id = u.id AND month = date_trunc('month', now())::date), 0) AS used_this_month
      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = ${session.userId}
    `
    user = rows[0]
    keys = await sql`
      SELECT id, key_prefix, label, created_at, last_used_at, revoked
      FROM api_keys WHERE user_id = ${session.userId} ORDER BY created_at DESC
    `
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const used = Number(user?.used_this_month ?? 0)
  const budget = Number(user?.token_budget_monthly ?? 1)
  const pct = Math.min(100, (used / budget) * 100).toFixed(1)

  const justCreatedKey = c.req.query("new_key")

  const body = `
  <h1>Account</h1>
  <p class="lead">Your tier, this month's usage, and API keys for the CLI.</p>

  <div class="stat-grid">
    <div class="stat-card">
      <div class="label">Email</div>
      <div class="val" style="font-size:14px">${escape(user?.email ?? "—")}</div>
    </div>
    <div class="stat-card">
      <div class="label">Tier</div>
      <div class="val"><span class="tier ${escape(user?.tier ?? "free")}">${escape(user?.tier ?? "free")}</span></div>
    </div>
    <div class="stat-card">
      <div class="label">This month</div>
      <div class="val">${used.toLocaleString()}</div>
      <div class="sub">of ${budget.toLocaleString()} tokens · ${pct}%</div>
    </div>
    <div class="stat-card">
      <div class="label">Active keys</div>
      <div class="val">${keys.filter(k => !k.revoked).length}</div>
      <div class="sub">${keys.length} total</div>
    </div>
  </div>

  ${justCreatedKey ? `
  <div class="success-box">
    New API key created — copy it now, it won't be shown again:<br>
    <code class="mono-block">${escape(justCreatedKey)}</code>
  </div>` : ""}

  <h2>API keys</h2>
  <p class="muted" style="font-size:13px">Used by the CLI — see the CLI setup instructions in the README. Session login (this dashboard) and API keys (the CLI) are separate; revoking a key doesn't log you out here.</p>
  <table>
    <thead><tr><th>key</th><th>label</th><th>created</th><th>last used</th><th>status</th><th></th></tr></thead>
    <tbody>
    ${keys.length ? keys.map(k => `<tr>
      <td><code>${escape(k.key_prefix)}…</code></td>
      <td>${escape(k.label ?? "—")}</td>
      <td>${new Date(k.created_at).toLocaleString()}</td>
      <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : `<span class="muted">never</span>`}</td>
      <td><span class="badge ${k.revoked ? "rejected" : "good"}">${k.revoked ? "revoked" : "active"}</span></td>
      <td style="text-align:right">${!k.revoked ? `<form method="POST" action="/dashboard/api-keys/${escape(k.id)}/revoke" onsubmit="return confirm('Revoke this key? Anything using it will stop working immediately.')"><button type="submit" class="danger">Revoke</button></form>` : ""}</td>
    </tr>`).join("") : `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px">No API keys yet — create one below</td></tr>`}
    </tbody>
  </table>

  <h2>Create a key</h2>
  <form method="POST" action="/dashboard/api-keys" class="form-row">
    <input name="label" placeholder="label (e.g. 'zen code cli - laptop')" style="flex:1;min-width:240px">
    <button type="submit" class="primary">Create API key</button>
  </form>`

  return c.html(layoutHtml("dashboard", "dashboard", body, { role: session.role, error: err }))
})

web.post("/dashboard/api-keys", requireSession(), async (c) => {
  const session = c.var.session
  const body = await c.req.parseBody()
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 128) : null

  const { raw, hash, prefix } = generateApiKey()
  await sql`INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (${session.userId}, ${hash}, ${prefix}, ${label})`
  return c.redirect(`/dashboard?new_key=${encodeURIComponent(raw)}`, 303)
})

web.post("/dashboard/api-keys/:id/revoke", requireSession(), async (c) => {
  const session = c.var.session
  await sql`UPDATE api_keys SET revoked = true WHERE id = ${c.req.param("id")} AND user_id = ${session.userId}`
  return c.redirect("/dashboard", 303)
})

// ---------------------------------------------------------------------------
// RFC 8628 Device Authorization Consent Flow
// ---------------------------------------------------------------------------

web.get("/device", async (c) => {
  const token = getSessionToken(c)
  const session = token ? await verifySession(token) : null
  const rawCode = (c.req.query("user_code") || c.req.query("code") || "").trim()

  // Requirement 6: Bind approval to the logged-in user session; reject if no session
  if (!session) {
    const returnPath = rawCode ? `/device?user_code=${encodeURIComponent(rawCode)}` : `/device`
    return c.redirect(`/login?error=login_required_for_device&redirect=${encodeURIComponent(returnPath)}`, 303)
  }

  // Account suspension check
  const activeUser = await getActiveUser(session.userId)
  if (!activeUser) {
    return c.html(
      layoutHtml(
        "suspended",
        "",
        "<div class='center-wrap'><div class='center-card'><h1>Account Suspended</h1><p class='lead'>Your account has been suspended. You cannot authorize devices.</p></div></div>",
      ),
      403,
    )
  }

  let error = c.req.query("error") || ""

  // When a code is provided, look up the device request and show consent screen
  if (rawCode) {
    const req = await getDeviceRequestByUserCode(rawCode)
    if (!req) {
      error = "Invalid device code. Please check your terminal and try again."
    } else if (req.locked) {
      error = "This device authorization has been locked due to too many failed attempts. Run `zen login` again in your terminal."
    } else if (new Date(req.expires_at) < new Date() || req.status === "expired") {
      error = "This device authorization request has expired. Run `zen login` again in your terminal."
    } else if (req.status !== "pending") {
      error = "This device code is no longer pending or has already been used."
    } else {
      // Valid pending request — show explicit consent screen with CSRF token
      const csrfToken = randomBytes(24).toString("hex")
      setCookie(c, "zen_device_csrf", csrfToken, {
        httpOnly: true,
        path: "/",
        maxAge: 600,
        sameSite: "Lax",
        ...(process.env.NODE_ENV !== "development" ? { secure: true } : {}),
      })

      const locationLabel = coarseLocationForIp(req.ip_address)
      const requestedTime = new Date(req.created_at).toUTCString()
      const formattedCode = formatUserCode(req.user_code)

      const consentBody = `
      <div class="center-wrap">
        <div class="center-card" style="max-width:440px">
          <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
          <h1 style="margin-bottom:8px">Authorize this device?</h1>
          <p class="lead" style="margin-bottom:20px">A command-line terminal is requesting API access to your account.</p>

          <div style="background:#171717;border:1px solid #262626;border-radius:8px;padding:16px;margin-bottom:20px;text-align:left;font-size:13px;line-height:1.6">
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #262626;padding-bottom:8px;margin-bottom:8px">
              <span style="color:#8c8c8c">Confirmation Code</span>
              <strong style="font-family:monospace;font-size:16px;letter-spacing:1px;color:var(--accent)">${escape(formattedCode)}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="color:#8c8c8c">Requesting IP</span>
              <span>${escape(locationLabel)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="color:#8c8c8c">User-Agent</span>
              <span style="font-family:monospace;font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(req.user_agent || "ZEN CLI")}</span>
            </div>
            <div style="display:flex;justify-content:space-between">
              <span style="color:#8c8c8c">Time</span>
              <span style="font-size:12px">${escape(requestedTime)}</span>
            </div>
          </div>

          <div style="background:rgba(239, 68, 68, 0.12);border:1px solid rgba(239, 68, 68, 0.4);color:#fca5a5;padding:12px 14px;border-radius:6px;margin-bottom:20px;font-size:12px;text-align:left;line-height:1.4">
            <strong>⚠️ Warning:</strong> only continue if you started this in your own terminal. Never approve codes sent to you by anyone else.
          </div>

          <form method="POST" action="/device/approve">
            <input type="hidden" name="user_code" value="${escape(req.user_code)}">
            <input type="hidden" name="csrf_token" value="${escape(csrfToken)}">
            <button type="submit" class="primary" style="width:100%;margin-bottom:8px">Authorize Device</button>
          </form>
          <div class="switch"><a href="/dashboard" style="color:var(--muted)">Cancel</a></div>
        </div>
      </div>`

      return c.html(layoutHtml("authorize device", "", consentBody))
    }
  }

  // Default: Code entry screen
  const entryBody = `
  <div class="center-wrap">
    <div class="center-card">
      <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
      <h1>Connect CLI Device</h1>
      <p class="lead">Enter the 8-character confirmation code shown in your terminal.</p>
      <form method="GET" action="/device">
        <input type="text" name="user_code" placeholder="XXXX-XXXX" required autofocus maxlength="12"
               style="font-family:monospace;letter-spacing:3px;font-size:18px;text-align:center;text-transform:uppercase">
        <button type="submit" class="primary">Continue</button>
      </form>
    </div>
  </div>`
  return c.html(layoutHtml("connect device", "", entryBody, { error }))
})

web.post("/device", async (c) => {
  const body = await c.req.parseBody()
  const code = String(body.user_code || body.code || "")
  return c.redirect(`/device?user_code=${encodeURIComponent(code)}`, 303)
})

web.post("/device/approve", async (c) => {
  const token = getSessionToken(c)
  const session = token ? await verifySession(token) : null
  if (!session) {
    return c.redirect("/login?error=authentication_required", 303)
  }

  const body = await c.req.parseBody()
  const submittedCsrf = String(body.csrf_token ?? "")
  const cookieCsrf = getCookie(c, "zen_device_csrf")

  // Enforce CSRF protection
  if (!submittedCsrf || !cookieCsrf || submittedCsrf !== cookieCsrf) {
    return c.html(
      layoutHtml(
        "forbidden",
        "",
        "<div class='center-wrap'><div class='center-card'><h1>403 Forbidden</h1><p class='lead'>Missing or invalid CSRF token. Authorization rejected.</p></div></div>",
      ),
      403,
    )
  }
  setCookie(c, "zen_device_csrf", "", { path: "/", maxAge: 0 })

  const activeUser = await getActiveUser(session.userId)
  if (!activeUser) {
    return c.html(
      layoutHtml(
        "suspended",
        "",
        "<div class='center-wrap'><div class='center-card'><h1>Account Suspended</h1><p class='lead'>Your account has been suspended.</p></div></div>",
      ),
      403,
    )
  }

  const rawCode = String(body.user_code ?? "")
  const ok = await approveDeviceByUserCode(rawCode, session.userId)
  if (!ok) {
    await recordFailedUserCodeAttempt(rawCode)
    return c.redirect("/device?error=code_expired_or_invalid", 303)
  }

  const successBody = `
  <div class="center-wrap">
    <div class="center-card" style="text-align:center">
      <div class="brandmark" style="justify-content:center"><span class="mark">z</span>zen-gateway</div>
      <h1 style="text-align:center;color:var(--accent)">✓ Device Authorized</h1>
      <p class="muted" style="text-align:center;margin-top:12px">You have approved this device. You can now close this tab and return to your terminal.</p>
      <div style="margin-top:24px">
        <a href="/dashboard" class="primary" style="display:inline-block;padding:8px 16px;border-radius:6px;background:var(--accent);color:#fff">Go to Dashboard</a>
      </div>
    </div>
  </div>`
  return c.html(layoutHtml("device authorized", "", successBody))
})
