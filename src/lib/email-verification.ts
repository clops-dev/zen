/**
 * Email verification flow for Zen Gateway.
 *
 * Single-use, HMAC-signed token (never stored raw — only SHA-256 hash in DB).
 * 24-hour TTL. Exactly one active token per user at a time (old ones revoked
 * on re-issue).
 *
 * Token format: base64url(userId|expiresAt) + "." + HMAC-SHA256(payload)
 * This lets us verify without a DB read, then mark used in the DB.
 */

import { randomBytes, createHmac, createHash } from "node:crypto"
import { sql, withDbResilience } from "./db"
import { env } from "./env"

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

function signToken(userId: string, expiresAt: number): string {
  const payload = `${userId}|${expiresAt}`
  const b64 = Buffer.from(payload).toString("base64url")
  const sig = createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url")
  return `${b64}.${sig}`
}

function parseToken(token: string): { userId: string; expiresAt: number } | null {
  if (!token || !token.includes(".")) return null
  const dotIdx = token.lastIndexOf(".")
  const b64 = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)

  let payload: string
  try {
    payload = Buffer.from(b64, "base64url").toString("utf8")
  } catch {
    return null
  }

  const expectedSig = createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url")
  // Constant-time compare
  if (sig.length !== expectedSig.length) return null
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i)
  if (diff !== 0) return null

  const parts = payload.split("|")
  if (parts.length !== 2) return null
  const expiresAt = Number(parts[1])
  if (!Number.isFinite(expiresAt)) return null
  return { userId: parts[0], expiresAt }
}

/**
 * Issue a new email verification token for a user.
 * Deletes any previous unused tokens for the user first (re-send scenario).
 * Returns the raw token to embed in the verification link.
 */
export async function issueEmailVerificationToken(userId: string): Promise<string> {
  const expiresAt = Date.now() + TOKEN_TTL_MS
  const raw = signToken(userId, expiresAt)
  const tokenHash = hashToken(raw)
  const expiresAtDate = new Date(expiresAt)

  // Revoke any previous unused tokens for this user
  await withDbResilience(() => sql`
    UPDATE email_verifications SET used = true
    WHERE user_id = ${userId} AND NOT used
  `)

  await withDbResilience(() => sql`
    INSERT INTO email_verifications (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAtDate})
  `)

  return raw
}

export type VerifyTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "not_found" }

/**
 * Verify a raw email verification token and mark it as used.
 * Must be called inside a transaction or with appropriate retries —
 * uses a single UPDATE to atomically claim the token.
 */
export async function verifyEmailToken(raw: string): Promise<VerifyTokenResult> {
  // 1. Parse + HMAC verify (no DB read needed yet)
  const parsed = parseToken(raw)
  if (!parsed) return { ok: false, reason: "invalid" }
  if (parsed.expiresAt < Date.now()) return { ok: false, reason: "expired" }

  const tokenHash = hashToken(raw)

  // 2. Atomically claim the token (mark used, check not already used/expired)
  const rows = await withDbResilience(() => sql`
    UPDATE email_verifications
    SET used = true
    WHERE token_hash = ${tokenHash}
      AND NOT used
      AND expires_at > now()
    RETURNING user_id
  `)

  if (rows.length === 0) return { ok: false, reason: "used" }
  return { ok: true, userId: rows[0].user_id }
}

/**
 * Issue a password reset token.
 * Single-use, 1-hour TTL.
 */
export async function issuePasswordResetToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url")
  const tokenHash = hashToken(raw)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Revoke previous tokens for this user
  await withDbResilience(() => sql`
    UPDATE password_reset_tokens SET used = true
    WHERE user_id = ${userId} AND NOT used
  `)

  await withDbResilience(() => sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt})
  `)

  return raw
}

export type ResetTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "used" }

export async function verifyPasswordResetToken(raw: string): Promise<ResetTokenResult> {
  if (!raw || raw.length < 16) return { ok: false, reason: "invalid" }
  const tokenHash = hashToken(raw)

  const rows = await withDbResilience(() => sql`
    UPDATE password_reset_tokens
    SET used = true
    WHERE token_hash = ${tokenHash}
      AND NOT used
      AND expires_at > now()
    RETURNING user_id
  `)

  if (rows.length === 0) return { ok: false, reason: "used" }
  return { ok: true, userId: rows[0].user_id }
}
