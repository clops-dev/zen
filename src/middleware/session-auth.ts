import type { MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"
import { SESSION_COOKIE, verifySession } from "../lib/session"

declare module "hono" {
  interface ContextVariableMap {
    session: { userId: string; role: "user" | "admin" }
  }
}

/** Any logged-in user (dashboard). Redirects to /login if not authenticated. */
export const requireSession = (): MiddlewareHandler => async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const session = verifySession(token)
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
  const token = getCookie(c, SESSION_COOKIE)
  const session = verifySession(token)
  const isApi = c.req.path.startsWith("/admin-api") || c.req.path.startsWith("/api") || c.req.header("accept")?.includes("application/json")
  if (!session) {
    if (isApi) return c.json({ error: "unauthorized", message: "Authentication required" }, 401)
    return c.redirect("/login", 303)
  }
  if (session.role !== "admin") {
    if (isApi) return c.json({ error: "forbidden", message: "Admin access required" }, 403)
    return c.html("<h1>403 — admin access required</h1>", 403)
  }
  c.set("session", session)
  return next()
}
