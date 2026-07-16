import type { MiddlewareHandler } from "hono"
import { sql } from "../lib/db"
import { hashApiKey } from "../lib/apikeys"

declare module "hono" {
  interface ContextVariableMap {
    apiUser: { id: string; email: string }
  }
}

/**
 * Auth for machine clients (the CLI). Expects `Authorization: Bearer zen_xxx`
 * where zen_xxx is a raw API key created via the dashboard. No refresh-token
 * flow needed — keys are long-lived until revoked.
 */
export const requireApiKey = (): MiddlewareHandler => async (c, next) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "missing bearer token" }, 401)
  }
  const raw = header.slice("Bearer ".length).trim()
  const hash = hashApiKey(raw)

  const rows = await sql`
    SELECT ak.user_id, u.email
    FROM api_keys ak
    JOIN users u ON u.id = ak.user_id
    WHERE ak.key_hash = ${hash} AND ak.revoked = false
  `
  if (rows.length === 0) {
    return c.json({ error: "invalid or revoked API key" }, 401)
  }

  await sql`UPDATE api_keys SET last_used_at = now() WHERE key_hash = ${hash}`
  c.set("apiUser", { id: rows[0].user_id, email: rows[0].email })
  return next()
}
