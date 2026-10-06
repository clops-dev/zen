import type { MiddlewareHandler } from "hono"
import { getSessionToken } from "../lib/session"

function getExpectedOrigin(reqUrl: string, hostHeader?: string | null, forwardedProto?: string | null): string {
  try {
    const url = new URL(reqUrl)
    if (hostHeader) {
      const proto = forwardedProto || url.protocol.replace(":", "")
      return `${proto}://${hostHeader}`.toLowerCase()
    }
    return url.origin.toLowerCase()
  } catch {
    return ""
  }
}

function normalizeOrigin(origin: string): string {
  try {
    const u = new URL(origin)
    return u.origin.toLowerCase()
  } catch {
    return origin.trim().toLowerCase()
  }
}

/**
 * CSRF protection middleware for cookie-authenticated state-changing requests.
 * Enforces Origin, Sec-Fetch-Site, and Referer matching.
 * Rejects with 403 if request is cross-origin.
 */
export const csrfProtection = (): MiddlewareHandler => async (c, next) => {
  const method = c.req.method.toUpperCase()
  // Safe HTTP methods do not change state
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next()
  }

  // Only protect cookie-authenticated requests. API-key authenticated requests
  // (e.g. CLI or Bearer tokens) are immune to browser ambient-credential CSRF.
  const sessionToken = getSessionToken(c)
  if (!sessionToken) {
    return next()
  }

  // 1. Check Sec-Fetch-Site (modern browsers)
  const secFetchSite = c.req.header("sec-fetch-site")?.toLowerCase()
  if (secFetchSite === "cross-site") {
    return c.json({ error: "csrf_rejected", message: "Cross-site request rejected" }, 403)
  }

  // 2. Check Origin header
  const origin = c.req.header("origin")
  const hostHeader = c.req.header("host")
  const forwardedProto = c.req.header("x-forwarded-proto")
  const expectedOrigin = getExpectedOrigin(c.req.url, hostHeader, forwardedProto)

  if (origin) {
    const normalizedOrigin = normalizeOrigin(origin)
    if (normalizedOrigin !== expectedOrigin) {
      return c.json({ error: "csrf_rejected", message: "Origin header mismatch" }, 403)
    }
    return next()
  }

  // 3. If Origin is absent, fallback to Referer
  const referer = c.req.header("referer")
  if (referer) {
    const refererOrigin = normalizeOrigin(referer)
    if (refererOrigin !== expectedOrigin) {
      return c.json({ error: "csrf_rejected", message: "Referer header mismatch" }, 403)
    }
    return next()
  }

  return next()
}
