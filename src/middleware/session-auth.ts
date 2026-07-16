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
  if (!session) return c.redirect("/login", 303)
  c.set("session", session)
  return next()
}

/** Admin-only pages. Redirects to /login if not authenticated, 403s if logged in but not admin. */
export const requireAdmin = (): MiddlewareHandler => async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const session = verifySession(token)
  if (!session) return c.redirect("/login", 303)
  if (session.role !== "admin") return c.html("<h1>403 — admin access required</h1>", 403)
  c.set("session", session)
  return next()
}
