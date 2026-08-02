import { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { sql } from "../lib/db"
import { generateApiKey } from "../lib/apikeys"

export const deviceAuth = new Hono()

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes to complete the browser login

// Base URL for the browser-facing pages. Falls back to constructing from
// the request itself if WEB_URL isn't set — fine for local dev, set WEB_URL
// explicitly once this is deployed somewhere real.
function webBaseUrl(requestUrl: string): string {
  if (process.env.WEB_URL) return process.env.WEB_URL.replace(/\/$/, "")
  const u = new URL(requestUrl)
  return `${u.protocol}//${u.host}`
}

/**
 * Step 1 — the CLI calls this first, no auth required. Returns a short
 * code and a URL for the user to open in a browser.
 */
deviceAuth.post("/device/start", async (c) => {
  const deviceCode = randomBytes(24).toString("base64url")
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS)

  await sql`
    INSERT INTO device_auth_requests (device_code, status, expires_at)
    VALUES (${deviceCode}, 'pending', ${expiresAt})
  `

  return c.json({
    device_code: deviceCode,
    verification_url: `${webBaseUrl(c.req.url)}/device?code=${deviceCode}`,
    expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    poll_interval: 2,
  })
})

/**
 * Step 3 — the CLI polls this every `poll_interval` seconds after opening
 * the browser. Returns the real API key exactly once, the moment the
 * browser login (web.ts's /device route) approves it.
 */
deviceAuth.get("/device/poll", async (c) => {
  const code = c.req.query("code")
  if (!code) return c.json({ error: "missing code" }, 400)

  const rows = await sql`
    SELECT status, raw_key_once, user_id, expires_at FROM device_auth_requests WHERE device_code = ${code}
  `
  if (rows.length === 0) return c.json({ status: "not_found" }, 404)
  const row = rows[0]

  if (new Date(row.expires_at) < new Date() && row.status === "pending") {
    await sql`UPDATE device_auth_requests SET status = 'expired' WHERE device_code = ${code}`
    return c.json({ status: "expired" })
  }

  if (row.status === "pending") return c.json({ status: "pending" })
  if (row.status === "expired") return c.json({ status: "expired" })

  // status === 'approved' — hand over the key exactly once, then wipe it.
  if (!row.raw_key_once) {
    // Already picked up by a previous poll — don't hand it out twice.
    return c.json({ status: "already_claimed" }, 410)
  }

  const emailRows = await sql`SELECT email FROM users WHERE id = ${row.user_id}`
  const apiKey = row.raw_key_once
  await sql`UPDATE device_auth_requests SET raw_key_once = NULL WHERE device_code = ${code}`

  return c.json({ status: "approved", api_key: apiKey, email: emailRows[0]?.email })
})

/**
 * Internal helper called by web.ts's POST /device handler once the browser
 * login succeeds — mints a real long-lived API key and attaches it to this
 * device_code for the CLI's next poll to pick up.
 */
export async function approveDeviceCode(deviceCode: string, userId: string): Promise<boolean> {
  const rows = await sql`SELECT status, expires_at FROM device_auth_requests WHERE device_code = ${deviceCode}`
  if (rows.length === 0) return false
  if (rows[0].status !== "pending" || new Date(rows[0].expires_at) < new Date()) return false

  const { raw, hash, prefix } = generateApiKey()
  await sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (${userId}, ${hash}, ${prefix}, 'zen login (device flow)')
  `
  await sql`
    UPDATE device_auth_requests SET status = 'approved', user_id = ${userId}, raw_key_once = ${raw} WHERE device_code = ${deviceCode}
  `
  return true
}