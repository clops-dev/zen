import { randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Character set for RFC 8628 User Codes:
 * Excludes ambiguous characters (0, O, 1, I, L) and vowels (A, E, I, O, U)
 * to avoid unintended offensive words.
 *
 * 28 characters: B, C, D, F, G, H, J, K, M, N, P, Q, R, S, T, V, W, X, Y, Z, 2, 3, 4, 5, 6, 7, 8, 9
 */
export const USER_CODE_CHARS = "BCDFGHJKMNPQRSTVWXYZ23456789"
export const USER_CODE_LENGTH = 8

/** Generate a random 8-character user_code without ambiguous characters. */
export function generateUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH)
  let code = ""
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_CHARS[bytes[i] % USER_CODE_CHARS.length]
  }
  return code
}

/** Format an 8-character code for display: e.g. "WDJB93KP" -> "WDJB-93KP" */
export function formatUserCode(code: string): string {
  const clean = normalizeUserCode(code)
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`
  }
  return clean
}

/** Normalize user input: uppercase, strip spaces, hyphens, and non-alphanumeric chars. */
export function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Constant-time comparison between two string codes. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

/** Derive coarse location / label from an IP address. */
export function coarseLocationForIp(ip: string): string {
  if (!ip || ip === "unknown") return "Unknown location"
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return "Local loopback (this machine)"
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.16.") || ip.startsWith("172.31.")) {
    return "Private local network"
  }
  return `IP ${ip}`
}
