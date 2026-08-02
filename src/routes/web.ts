import { Hono } from "hono"
import { setCookie, deleteCookie } from "hono/cookie"
import { sql } from "../lib/db"
import { hashPassword, verifyPassword } from "../lib/password"
import { issueSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "../lib/session"
import { requireSession } from "../middleware/session-auth"
import { layoutHtml, escape } from "../lib/html"
import { generateApiKey } from "../lib/apikeys"
import { env } from "../lib/env"
import { approveDeviceCode } from "./device-auth"
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
  const email = String(body.email ?? "")
  const password = String(body.password ?? "")

  const rows = await sql`SELECT id, password_hash, role FROM users WHERE email = ${email}`
  if (rows.length === 0) return c.redirect("/login?error=invalid+credentials", 303)

  const user = rows[0] as { id: string; password_hash: string; role: "user" | "admin" }
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) return c.redirect("/login?error=invalid+credentials", 303)

  const session = issueSession(user.id, user.role)
  setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)
  return c.redirect(user.role === "admin" ? "/admin2" : "/dashboard", 303)
})

web.get("/signup", async (c) => {
  const body = `
  <div class="center-wrap">
    <div class="center-card">
      <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
      <h1>Create account</h1>
      <p class="lead">Free tier includes a 50,000 token monthly budget.</p>
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
  const email = String(body.email ?? "")
  const password = String(body.password ?? "")

  if (password.length < 8) return c.redirect("/signup?error=password+too+short", 303)

  const existing = await sql`SELECT id FROM users WHERE email = ${email}`
  if (existing.length > 0) return c.redirect("/signup?error=email+already+registered", 303)

  const hash = await hashPassword(password)
  const [newUser] = await sql`INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, 'user') RETURNING id`
  await sql`
    INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
    VALUES (${newUser.id}, 'free', 'active', ${env.DEFAULT_FREE_TOKEN_BUDGET})
  `

  const session = issueSession(newUser.id, "user")
  setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)
  return c.redirect("/dashboard", 303)
})

web.post("/logout", async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
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
web.get("/device", async (c) => {
  const code = c.req.query("code") ?? ""
  const error = c.req.query("error")

  const body = `
  <div class="center-wrap">
    <div class="center-card">
      <div class="brandmark"><span class="mark">z</span>zen-gateway</div>
      <h1>Connect the ZEN Code CLI</h1>
      <p class="lead">Log in to link this device. Your CLI session stays active until you run <code>zen logout</code>.</p>
      <form method="POST" action="/device">
        <input type="hidden" name="code" value="${escape(code)}">
        <input type="email" name="email" placeholder="email" required autocomplete="email">
        <input type="password" name="password" placeholder="password" required autocomplete="current-password">
        <button type="submit" class="primary">Connect</button>
      </form>
    </div>
  </div>`
  return c.html(layoutHtml("connect device", "", body, { error }))
})
 
web.post("/device", async (c) => {
  const body = await c.req.parseBody()
  const code = String(body.code ?? "")
  const email = String(body.email ?? "")
  const password = String(body.password ?? "")
 
  const rows = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`
  if (rows.length === 0) return c.redirect(`/device?code=${encodeURIComponent(code)}&error=invalid+credentials`, 303)
 
  const ok = await verifyPassword(password, rows[0].password_hash)
  if (!ok) return c.redirect(`/device?code=${encodeURIComponent(code)}&error=invalid+credentials`, 303)
 
  const approved = await approveDeviceCode(code, rows[0].id)
  if (!approved) {
    return c.redirect(`/device?code=${encodeURIComponent(code)}&error=this+code+expired,+run+zen+login+again`, 303)
  }
 
  const successBody = `
  <div class="center-wrap">
    <div class="center-card" style="text-align:center">
      <div class="brandmark" style="justify-content:center"><span class="mark">z</span>zen-gateway</div>
      <h1 style="text-align:center;color:var(--accent)">✓ Connected</h1>
      <p class="muted" style="text-align:center">You can close this tab and return to your terminal.</p>
    </div>
  </div>`
  return c.html(layoutHtml("connected", "", successBody))
})
