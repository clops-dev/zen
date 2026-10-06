import bcrypt from "bcryptjs"
import { createHash } from "node:crypto"

/** New password hashes use Bun's native argon2id implementation, which does
 * not run the expensive derivation on the JavaScript event loop. */
export const hashPassword = (password: string) =>
  Bun.password.hash(password, { algorithm: "argon2id" })

export function isLegacyBcryptHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && /^\$2[aby]\$/.test(hash)
}

/** Verify both historical bcrypt hashes and current argon2id hashes. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (isLegacyBcryptHash(hash)) return bcrypt.compare(password, hash)
  return Bun.password.verify(password, hash)
}

/** Constant-work verification for unknown-email logins. */
let dummyHash: Promise<string> | undefined
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword("zen-gateway-invalid-login-dummy")
  await Bun.password.verify(password, await dummyHash)
}

// ---------------------------------------------------------------------------
// Password strength: min 10 chars + HIBP k-anonymity API check
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH ?? 10)
const HIBP_ENABLED = process.env.HIBP_ENABLED !== "false" // default on
const HIBP_TIMEOUT_MS = 3000

export interface PasswordStrengthResult {
  ok: boolean
  reason?: "too_short" | "pwned"
  pwnedCount?: number
}

/**
 * Check password strength:
 * 1. Minimum length (default 10 chars, configurable via MIN_PASSWORD_LENGTH).
 * 2. HIBP k-anonymity range API — reject passwords that appear in known breaches.
 *    Fails open if HIBP is unreachable (network error / timeout).
 *
 * Uses the SHA-1 k-anonymity API: sends only the first 5 chars of the hash,
 * never the full password.
 */
export async function checkPasswordStrength(password: string): Promise<PasswordStrengthResult> {
  const minLen = Number(process.env.MIN_PASSWORD_LENGTH ?? 10)
  const hibpEnabled = process.env.HIBP_ENABLED !== "false"

  if (password.length < minLen) {
    return { ok: false, reason: "too_short" }
  }

  if (!hibpEnabled) {
    return { ok: true }
  }

  try {
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase()
    const prefix = sha1.slice(0, 5)
    const suffix = sha1.slice(5)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true" },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // HIBP unavailable — fail open
      return { ok: true }
    }

    const text = await res.text()
    const lines = text.split("\n")
    for (const line of lines) {
      const [hashSuffix, countStr] = line.trim().split(":")
      if (hashSuffix?.toUpperCase() === suffix) {
        const count = Number(countStr ?? 0)
        if (count > 0) {
          return { ok: false, reason: "pwned", pwnedCount: count }
        }
      }
    }

    return { ok: true }
  } catch {
    // Network error or abort — fail open (don't block signup)
    return { ok: true }
  }
}
