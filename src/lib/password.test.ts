import { describe, expect, test, beforeEach } from "bun:test"
import bcrypt from "bcryptjs"
import { hashPassword, isLegacyBcryptHash, verifyPassword, checkPasswordStrength } from "./password"

const originalFetch = globalThis.fetch

describe("P4.10 native password hashing", () => {
  test("new passwords use argon2id and verify", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true)
    expect(await verifyPassword("wrong password", hash)).toBe(false)
  })

  test("existing bcrypt hashes remain valid and are identified for upgrade", async () => {
    const bcryptHash = await bcrypt.hash("legacy password", 4)
    expect(isLegacyBcryptHash(bcryptHash)).toBe(true)
    expect(await verifyPassword("legacy password", bcryptHash)).toBe(true)
  })
})

describe("checkPasswordStrength", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test("rejects passwords shorter than 10 chars", async () => {
    process.env.HIBP_ENABLED = "false"
    const result = await checkPasswordStrength("short")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("too_short")
  })

  test("rejects password of exactly 9 chars", async () => {
    process.env.HIBP_ENABLED = "false"
    const result = await checkPasswordStrength("123456789")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("too_short")
  })

  test("accepts 10+ char password when HIBP disabled", async () => {
    process.env.HIBP_ENABLED = "false"
    const result = await checkPasswordStrength("verylongpassword!")
    expect(result.ok).toBe(true)
  })

  test("fails open when HIBP is unreachable (network error)", async () => {
    process.env.HIBP_ENABLED = "true"
    globalThis.fetch = (async () => { throw new Error("Network error") }) as any
    const result = await checkPasswordStrength("longpassword123!")
    expect(result.ok).toBe(true) // fail open
    globalThis.fetch = originalFetch
  })

  test("rejects pwned password (mocked HIBP response)", async () => {
    process.env.HIBP_ENABLED = "true"
    // SHA1("password123") = CBFDAC6008F9CAB4083784CBD1874F76618D2A97
    const sha1suffix = "C6008F9CAB4083784CBD1874F76618D2A97"
    globalThis.fetch = (async () => new Response(`${sha1suffix}:99999\nABCDE:1`, { status: 200 })) as any

    const result = await checkPasswordStrength("password123")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("pwned")
    expect((result.pwnedCount ?? 0) > 0).toBe(true)
    globalThis.fetch = originalFetch
  })

  test("accepts strong password when suffix not in HIBP response", async () => {
    process.env.HIBP_ENABLED = "true"
    globalThis.fetch = (async () => new Response("AAAAA:5\nBBBBB:3", { status: 200 })) as any
    const result = await checkPasswordStrength("xK9$mP@wL#2qRt!vN8")
    expect(result.ok).toBe(true)
    globalThis.fetch = originalFetch
  })
})
