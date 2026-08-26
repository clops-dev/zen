import type { MiddlewareHandler } from "hono"
import { randomBytes } from "node:crypto"
import { log } from "../lib/logger"

declare module "hono" {
  interface ContextVariableMap {
    requestId: string
    requestStartedAt: number
  }
}

/**
 * Request-id middleware.
 *
 * - Honours an inbound `X-Request-Id` header if present (so upstream
 *   proxies / load balancers can correlate their logs with ours). If
 *   absent, generates a 16-byte hex id.
 * - Stores the id on the Hono context so handlers can reference it.
 * - Echoes it back on the response (`X-Request-Id`) so the client can
 *   cite it when reporting issues.
 * - Logs the request start with method, path, ip, ua — never the body
 *   (which may contain credentials). Never logs the Authorization header.
 *
 * The companion response log is NOT emitted here — it's the request
 * handler's responsibility to log completion (via `logRequestComplete`)
 * because only the handler knows the status code and duration.
 */
export const requestId = (): MiddlewareHandler => async (c, next) => {
  const incoming = c.req.header("x-request-id")
  const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomBytes(16).toString("hex")
  c.set("requestId", id)
  c.set("requestStartedAt", Date.now())
  c.header("X-Request-Id", id)

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  log.info("http_request", {
    request_id: id,
    method: c.req.method,
    path: c.req.path,
    ip,
    user_agent: c.req.header("user-agent") ?? undefined,
  })

  await next()

  const startedAt = c.get("requestStartedAt") ?? Date.now()
  log.info("http_response", {
    request_id: id,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - startedAt,
  })
}