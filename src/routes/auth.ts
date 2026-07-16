import { Hono } from "hono"
import { z } from "zod"
import { setCookie, deleteCookie } from "hono/cookie"
import { sql } from "../lib/db"
import { hashPassword, verifyPassword } from "../lib/password"
import { issueSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "../lib/session"
import { generateApiKey } from "../lib/apikeys"
import { requireSession } from "../middleware/session-auth"
import { env } from "../lib/env"

export const auth = new Hono()

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
})

auth.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = signupSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: "invalid payload", details: parsed.error.flatten() }, 400)

  const { email, password } = parsed.data
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`
  if (existing.length > 0) return c.json({ error: "email already registered" }, 409)

  const hash = await hashPassword(password)
  const [newUser] = await sql`
    INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, 'user') RETURNING id
  `
  await sql`
    INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
    VALUES (${newUser.id}, 'free', 'active', ${env.DEFAULT_FREE_TOKEN_BUDGET})
  `

  const session = issueSession(newUser.id, "user")
  setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)
  return c.json({ message: "account created", user_id: newUser.id })
})

auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = signupSchema.safeParse(body) // same shape as signup
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400)

  const { email, password } = parsed.data
  const rows = await sql`SELECT id, password_hash, role FROM users WHERE email = ${email}`
  if (rows.length === 0) return c.json({ error: "invalid credentials" }, 401)

  const user = rows[0] as { id: string; password_hash: string; role: "user" | "admin" }
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) return c.json({ error: "invalid credentials" }, 401)

  const session = issueSession(user.id, user.role)
  setCookie(c, SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS)
  return c.json({ message: "logged in", role: user.role })
})

auth.post("/logout", async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
  return c.json({ message: "logged out" })
})

// ---------------------------------------------------------------------------
// API keys — created from the dashboard, used by the CLI
// ---------------------------------------------------------------------------

auth.post("/api-keys", requireSession(), async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const label = typeof body.label === "string" ? body.label.slice(0, 128) : null

  const { raw, hash, prefix } = generateApiKey()
  await sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (${session.userId}, ${hash}, ${prefix}, ${label})
  `
  // The raw key is returned exactly once — it is not recoverable after this response.
  return c.json({ api_key: raw, prefix })
})

auth.get("/api-keys", requireSession(), async (c) => {
  const session = c.var.session
  const rows = await sql`
    SELECT id, key_prefix, label, created_at, last_used_at, revoked
    FROM api_keys WHERE user_id = ${session.userId} ORDER BY created_at DESC
  `
  return c.json(rows)
})

auth.post("/api-keys/:id/revoke", requireSession(), async (c) => {
  const session = c.var.session
  await sql`UPDATE api_keys SET revoked = true WHERE id = ${c.req.param("id")} AND user_id = ${session.userId}`
  return c.json({ ok: true })
})
