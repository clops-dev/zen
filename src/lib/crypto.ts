import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"
import { env } from "./env"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96 bits for GCM
const CURRENT_KEY_ID = "k1"

/**
 * Derives a 32-byte AES key from PROVIDER_KEY_SECRET or fallback SESSION_SECRET
 */
function getMasterKey(keyId = CURRENT_KEY_ID): Buffer {
  const secret = process.env.PROVIDER_KEY_SECRET || env.SESSION_SECRET || "fallback-master-key-32-chars-min!"
  // Hash with salt to ensure exactly 32 bytes (256 bits)
  return createHash("sha256").update(`${keyId}:${secret}`).digest()
}

/**
 * Mask an API key so only the last 4 characters are visible.
 * E.g. "sk-proj-1234567890abcdef" -> "••••cdef"
 * E.g. "1234" -> "••••"
 * E.g. "" or null -> ""
 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return ""
  // If encrypted, decrypt first to mask the real key
  const plain = decryptSecret(key)
  if (!plain) return ""
  if (plain.length <= 4) return "••••"
  return "••••" + plain.slice(-4)
}

/**
 * Encrypt a plaintext secret using AES-256-GCM.
 * Stored format: enc:v1:<keyId>:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plainText: string, keyId = CURRENT_KEY_ID): string {
  if (!plainText) return ""
  // Already encrypted?
  if (plainText.startsWith("enc:v1:")) return plainText

  const key = getMasterKey(keyId)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(plainText, "utf8", "hex")
  encrypted += cipher.final("hex")
  const authTag = cipher.getAuthTag().toString("hex")

  return `enc:v1:${keyId}:${iv.toString("hex")}:${authTag}:${encrypted}`
}

/**
 * Decrypt an AES-256-GCM encrypted secret.
 * If the string does not have the enc:v1 prefix, it is returned as plaintext (for backwards compatibility).
 */
export function decryptSecret(cipherText: string | null | undefined): string {
  if (!cipherText) return ""
  if (!cipherText.startsWith("enc:v1:")) {
    // Legacy unencrypted plaintext
    return cipherText
  }

  const parts = cipherText.split(":")
  if (parts.length !== 6 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Invalid encrypted secret format")
  }

  const keyId = parts[2]
  const iv = Buffer.from(parts[3], "hex")
  const authTag = Buffer.from(parts[4], "hex")
  const encrypted = parts[5]

  const key = getMasterKey(keyId)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted, "hex", "utf8")
  decrypted += decipher.final("utf8")
  return decrypted
}
