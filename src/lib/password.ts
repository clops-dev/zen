import bcrypt from "bcryptjs"
import { env } from "./env"

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
