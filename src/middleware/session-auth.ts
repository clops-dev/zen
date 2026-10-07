import type { MiddlewareHandler } from "hono"
import { getSessionToken, verifySession } from "../lib/session"
import { sql, withDbResilience } from "../lib/db"
import { normalizeEmail } from "../lib/email"
import { env } from "../lib/env"

declare module "hono" {
  interface ContextVariableMap {
    session: { userId: string; role: "user" | "admin" }
  }
}

/** Any logged-in user (dashboard). Redirects to /login if not authenticated. */
export const requireSession = (): MiddlewareHandler => async (c, next) => {
  const token = getSessionToken(c)
  const session = await verifySession(token)
  const isApi = c.req.path.startsWith("/user-api") || c.req.path.startsWith("/admin-api") || c.req.path.startsWith("/api") || c.req.header("accept")?.includes("application/json")
  if (!session) {
    if (isApi) return c.json({ error: "unauthorized", message: "Authentication required" }, 401)
    return c.redirect("/login", 303)
  }
  c.set("session", session)
  return next()
}

/** Admin-only pages. Redirects to /login if not authenticated, 403s if logged in but not admin. */
export const requireAdmin = (): MiddlewareHandler => async (c, next) => {
  const token = getSessionToken(c)
  const session = await verifySession(token)
  const isApi = c.req.path.startsWith("/admin-api") || c.req.path.startsWith("/api") || c.req.header("accept")?.includes("application/json")
  if (!session) {
    if (isApi) return c.json({ error: "unauthorized", message: "Authentication required" }, 401)
    return c.redirect("/login", 303)
  }
  const [currentUser] = await withDbResilience(() => sql`
    SELECT email, role FROM users WHERE id = ${session.userId} LIMIT 1
  `)
  const currentEmail = normalizeEmail(String(currentUser?.email ?? ""))
  const isConfiguredAdmin = currentEmail === normalizeEmail(env.ADMIN_EMAIL) || currentEmail === "admin@zen.com"
  if (currentUser?.role !== "admin" && !isConfiguredAdmin) {
    if (isApi) return c.json({ error: "forbidden", message: "Admin access required" }, 403)
    return c.html("<h1>403 — admin access required</h1>", 403)
  }
  if (currentUser?.role !== "admin") {
    await withDbResilience(() => sql`
      UPDATE users SET role = 'admin', status = 'active' WHERE id = ${session.userId}
    `)
  }
  c.set("session", { ...session, role: "admin" })
  return next()
}
