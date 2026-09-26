import { describe, expect, test } from "bun:test"
import bcrypt from "bcryptjs"
import { hashPassword, isLegacyBcryptHash, verifyPassword } from "./password"

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
