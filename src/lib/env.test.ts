import { describe, expect, test } from "bun:test"
import { envSchema } from "./env"

const required = {
  DATABASE_URL: "postgresql://example.test/db",
  SESSION_SECRET: "x".repeat(32),
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_PASSWORD: "validpass",
}

describe("ADMIN_MFA_REQUIRED", () => {
  test("parses false and 0 as false, and defaults to true", () => {
    expect(envSchema.parse({ ...required, ADMIN_MFA_REQUIRED: "false" }).ADMIN_MFA_REQUIRED).toBe(false)
    expect(envSchema.parse({ ...required, ADMIN_MFA_REQUIRED: "0" }).ADMIN_MFA_REQUIRED).toBe(false)
    expect(envSchema.parse(required).ADMIN_MFA_REQUIRED).toBe(true)
  })
})
