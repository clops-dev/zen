import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "./env"

const SESSION_TTL_MS = 8 * 60 * 60 * 1000
export const SESSION_COOKIE = "zen_session"

const sign = (payload: string) => createHmac("sha256", env.SESSION_SECRET).update(payload).digest("hex")

export function issueSession(userId: string, role: "user" | "admin"): { token: string; maxAgeSec: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = `${userId}|${role}|${expiresAt}`
  const sig = sign(payload)
  return {
    token: `${Buffer.from(payload).toString("base64url")}.${sig}`,
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
  }
}

export function verifySession(token: string | undefined): { userId: string; role: "user" | "admin" } | null {
  if (!token) return null
  const idx = token.lastIndexOf(".")
  if (idx === -1) return null

  const encodedPayload = token.slice(0, idx)
  const givenSig = token.slice(idx + 1)
  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8")
  const expectedSig = sign(payload)

  const a = Buffer.from(givenSig, "hex")
  const b = Buffer.from(expectedSig, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const parts = payload.split("|")
  if (parts.length !== 3) return null
  const [userId, role, expiresAtStr] = parts
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
  if (role !== "user" && role !== "admin") return null

  return { userId, role }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
  ...(process.env.NODE_ENV !== "development" ? { secure: true as const } : {}),
}
