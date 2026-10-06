import { describe, test, expect, beforeEach } from "bun:test"
import {
  issueEmailVerificationToken,
  verifyEmailToken,
  issuePasswordResetToken,
  verifyPasswordResetToken,
} from "./email-verification"
import { setSql } from "./db"

describe("Email verification tokens", () => {
  // Simple in-memory DB mock
  interface MockToken {
    id: string
    user_id: string
    token_hash: string
    used: boolean
    expires_at: Date
  }

  let verifyTokens: MockToken[] = []
  let resetTokens: MockToken[] = []

  beforeEach(() => {
    verifyTokens = []
    resetTokens = []

    // Ensure SESSION_SECRET is set for HMAC
    process.env.SESSION_SECRET = "test-secret-at-least-32-characters-long!"

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // INSERT INTO email_verifications
      if (q.includes("insert into email_verifications")) {
        const [userId, tokenHash, expiresAt] = values
        verifyTokens.push({
          id: `ev-${Math.random().toString(36).slice(2)}`,
          user_id: userId,
          token_hash: tokenHash,
          used: false,
          expires_at: new Date(expiresAt),
        })
        return []
      }

      // UPDATE email_verifications SET used = true ... RETURNING user_id
      if (q.includes("update email_verifications") && q.includes("returning user_id")) {
        const tokenHash = values[0]
        const found = verifyTokens.find(
          (t) => t.token_hash === tokenHash && !t.used && t.expires_at > new Date(),
        )
        if (!found) return []
        found.used = true
        return [{ user_id: found.user_id }]
      }

      // UPDATE email_verifications SET used = true WHERE user_id (mass revoke)
      if (q.includes("update email_verifications") && q.includes("user_id = ?")) {
        const userId = values[0]
        for (const t of verifyTokens) {
          if (t.user_id === userId && !t.used) t.used = true
        }
        return []
      }

      // INSERT INTO password_reset_tokens
      if (q.includes("insert into password_reset_tokens")) {
        const [userId, tokenHash, expiresAt] = values
        resetTokens.push({
          id: `rt-${Math.random().toString(36).slice(2)}`,
          user_id: userId,
          token_hash: tokenHash,
          used: false,
          expires_at: new Date(expiresAt),
        })
        return []
      }

      // UPDATE password_reset_tokens SET used = true ... RETURNING user_id
      if (q.includes("update password_reset_tokens") && q.includes("returning user_id")) {
        const tokenHash = values[0]
        const found = resetTokens.find(
          (t) => t.token_hash === tokenHash && !t.used && t.expires_at > new Date(),
        )
        if (!found) return []
        found.used = true
        return [{ user_id: found.user_id }]
      }

      // UPDATE password_reset_tokens SET used = true WHERE user_id (mass revoke)
      if (q.includes("update password_reset_tokens") && q.includes("user_id = ?")) {
        const userId = values[0]
        for (const t of resetTokens) {
          if (t.user_id === userId && !t.used) t.used = true
        }
        return []
      }

      return []
    }

    setSql(mockSql)
  })

  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  test("issues a verifiable token for a user", async () => {
    const raw = await issueEmailVerificationToken("user-1")
    expect(typeof raw).toBe("string")
    expect(raw.length).toBeGreaterThan(20)
    expect(verifyTokens.length).toBe(1)
    expect(verifyTokens[0].used).toBe(false)
  })

  test("token is stored hashed (not raw)", async () => {
    const raw = await issueEmailVerificationToken("user-1")
    expect(verifyTokens[0].token_hash).not.toBe(raw)
    expect(verifyTokens[0].token_hash.length).toBe(64) // SHA-256 hex
  })

  test("verifyEmailToken succeeds with valid token", async () => {
    const raw = await issueEmailVerificationToken("user-1")
    const result = await verifyEmailToken(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBe("user-1")
  })

  test("verifyEmailToken fails with forged token", async () => {
    await issueEmailVerificationToken("user-1")
    const result = await verifyEmailToken("forged.token")
    expect(result.ok).toBe(false)
  })

  test("verifyEmailToken fails on second use (single-use)", async () => {
    const raw = await issueEmailVerificationToken("user-1")
    const first = await verifyEmailToken(raw)
    expect(first.ok).toBe(true)
    const second = await verifyEmailToken(raw)
    expect(second.ok).toBe(false)
  })

  test("re-issuing a token revokes the previous one", async () => {
    const raw1 = await issueEmailVerificationToken("user-1")
    const raw2 = await issueEmailVerificationToken("user-1")

    // Previous token should be marked used
    expect(verifyTokens[0].used).toBe(true)

    // New token should work
    const result = await verifyEmailToken(raw2)
    expect(result.ok).toBe(true)

    // Old token should fail
    const old = await verifyEmailToken(raw1)
    expect(old.ok).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------------

  test("issues a password reset token", async () => {
    const raw = await issuePasswordResetToken("user-2")
    expect(typeof raw).toBe("string")
    expect(raw.length).toBeGreaterThan(20)
    expect(resetTokens.length).toBe(1)
  })

  test("reset token stored hashed", async () => {
    const raw = await issuePasswordResetToken("user-2")
    expect(resetTokens[0].token_hash).not.toBe(raw)
  })

  test("verifyPasswordResetToken succeeds with valid token", async () => {
    const raw = await issuePasswordResetToken("user-2")
    const result = await verifyPasswordResetToken(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBe("user-2")
  })

  test("verifyPasswordResetToken is single-use", async () => {
    const raw = await issuePasswordResetToken("user-2")
    expect((await verifyPasswordResetToken(raw)).ok).toBe(true)
    expect((await verifyPasswordResetToken(raw)).ok).toBe(false)
  })

  test("verifyPasswordResetToken rejects unknown token", async () => {
    const result = await verifyPasswordResetToken("a".repeat(32))
    expect(result.ok).toBe(false)
  })
})
