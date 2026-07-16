import { randomBytes, createHash } from "node:crypto"

const PREFIX = "zen_"

/** Generates a new raw API key. Shown to the user exactly once — only the hash is stored. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = PREFIX + randomBytes(24).toString("base64url")
  const hash = createHash("sha256").update(raw).digest("hex")
  return { raw, hash, prefix: raw.slice(0, 12) }
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}
