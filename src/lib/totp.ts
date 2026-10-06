import { createHmac, createHash, randomBytes } from "node:crypto"

// Base32 RFC 4648 alphabet
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ""

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]
    bits += 8

    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31]
  }

  return output
}

export function base32Decode(str: string): Buffer {
  const cleanStr = str.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "")
  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (let i = 0; i < cleanStr.length; i++) {
    const idx = BASE32_CHARS.indexOf(cleanStr[i])
    if (idx === -1) continue

    value = (value << 5) | idx
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

/**
 * Generates a 20-byte cryptographically secure random base32 secret.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * Computes a 6-digit TOTP code for a given secret and timestamp (RFC 6238).
 */
export function generateTotpCode(secret: string, timestampMs = Date.now()): string {
  const secretBuf = base32Decode(secret)
  const step = Math.floor(timestampMs / 1000 / 30)

  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigInt64BE(BigInt(step))

  const hmac = createHmac("sha1", secretBuf).update(counterBuf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f

  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  const code = (binary % 1_000_000).toString().padStart(6, "0")
  return code
}

/**
 * Verifies a 6-digit TOTP code against a secret with +/- window steps.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  timestampMs = Date.now(),
  windowSteps = 1,
): boolean {
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return false
  }
  const cleanCode = code.trim()

  for (let step = -windowSteps; step <= windowSteps; step++) {
    const candidate = generateTotpCode(secret, timestampMs + step * 30_000)
    if (candidate === cleanCode) {
      return true
    }
  }
  return false
}

/**
 * Generates random alphanumeric recovery codes (e.g. "a1b2-c3d4").
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(4).toString("hex")
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`)
  }
  return codes
}

/**
 * Hashes a recovery code using SHA-256 for secure storage.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(code.trim().toLowerCase().replace(/[\s-]/g, ""))
    .digest("hex")
}

/**
 * Formats an otpauth URI for QR codes.
 */
export function generateOtpAuthUri(
  accountName: string,
  secret: string,
  issuer = "ZenGateway",
): string {
  const label = `${encodeURIComponent(issuer)}:${accountName}`
  const encodedIssuer = encodeURIComponent(issuer)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`
}
