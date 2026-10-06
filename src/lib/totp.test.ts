import { describe, test, expect } from "bun:test"
import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  generateOtpAuthUri,
} from "./totp"

describe("TOTP MFA", () => {
  test("generates valid base32 secret", () => {
    const secret = generateTotpSecret()
    expect(secret.length).toBeGreaterThanOrEqual(16)
    expect(/^[A-Z2-7]+$/.test(secret)).toBe(true)
  })

  test("generates 6-digit TOTP code and verifies successfully", () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const code = generateTotpCode(secret, now)

    expect(code).toMatch(/^\d{6}$/)
    expect(verifyTotpCode(secret, code, now)).toBe(true)
  })

  test("verifies code within clock drift window (-30s, +30s)", () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const pastCode = generateTotpCode(secret, now - 30_000)
    const futureCode = generateTotpCode(secret, now + 30_000)
    const tooOldCode = generateTotpCode(secret, now - 90_000)

    expect(verifyTotpCode(secret, pastCode, now)).toBe(true)
    expect(verifyTotpCode(secret, futureCode, now)).toBe(true)
    expect(verifyTotpCode(secret, tooOldCode, now)).toBe(false)
  })

  test("rejects incorrect code", () => {
    const secret = generateTotpSecret()
    expect(verifyTotpCode(secret, "000000")).toBe(false)
    expect(verifyTotpCode(secret, "abc")).toBe(false)
  })

  test("generates and hashes recovery codes", () => {
    const codes = generateRecoveryCodes(8)
    expect(codes.length).toBe(8)
    for (const code of codes) {
      expect(code).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}$/)
      const hash1 = hashRecoveryCode(code)
      const hash2 = hashRecoveryCode(code.toUpperCase()) // case-insensitive
      expect(hash1).toBe(hash2)
      expect(hash1.length).toBe(64)
    }
  })

  test("generates correct otpauth URI", () => {
    const secret = "JBSWY3DPEHPK3PXP"
    const uri = generateOtpAuthUri("admin@example.com", secret, "ZenGateway")
    expect(uri).toContain("otpauth://totp/ZenGateway:admin@example.com")
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain("issuer=ZenGateway")
  })
})
