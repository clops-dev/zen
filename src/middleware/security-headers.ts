import type { MiddlewareHandler } from "hono"

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()

    // Enforce modern security headers
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Frame-Options", "DENY")
    c.header("Referrer-Policy", "strict-origin-when-cross-origin")
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )

    if (process.env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    }
  }
}
