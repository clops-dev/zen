import { describe, it, expect } from "bun:test"
import { maskApiKey, encryptSecret, decryptSecret } from "./crypto"

describe("Secrets Management & AES-256-GCM Encryption", () => {
  it("masks API keys showing only the last 4 characters", () => {
    expect(maskApiKey("sk-proj-1234567890abcdef")).toBe("••••cdef")
    expect(maskApiKey("short")).toBe("••••hort")
    expect(maskApiKey("1234")).toBe("••••")
    expect(maskApiKey("")).toBe("")
    expect(maskApiKey(null)).toBe("")
    expect(maskApiKey(undefined)).toBe("")
  })

  it("encrypts and decrypts round-trip with AES-256-GCM", () => {
    const raw = "sk-live-secret-key-abcdef-123456789"
    const encrypted = encryptSecret(raw)

    expect(encrypted.startsWith("enc:v1:k1:")).toBe(true)
    expect(encrypted).not.toContain(raw)

    const decrypted = decryptSecret(encrypted)
    expect(decrypted).toBe(raw)
  })

  it("correctly masks an encrypted API key", () => {
    const raw = "sk-live-secret-key-abcdef-123456789"
    const encrypted = encryptSecret(raw)

    expect(maskApiKey(encrypted)).toBe("••••6789")
  })

  it("handles legacy unencrypted plaintext gracefully", () => {
    const legacy = "sk-openrouter-legacy-key"
    expect(decryptSecret(legacy)).toBe(legacy)
    expect(maskApiKey(legacy)).toBe("••••-key")
  })

  it("is idempotent when encryptSecret is called on already encrypted string", () => {
    const raw = "sk-test-key-9999"
    const enc1 = encryptSecret(raw)
    const enc2 = encryptSecret(enc1)
    expect(enc2).toBe(enc1)
    expect(decryptSecret(enc2)).toBe(raw)
  })
})
