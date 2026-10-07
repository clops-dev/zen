import { describe, expect, test } from "bun:test"
import { bootstrapConfiguredAdmin } from "./admin-bootstrap"

describe("configured admin bootstrap", () => {
  test("resets a configured admin's incorrect password and repairs its account", async () => {
    const user = { id: "admin-1", password_hash: "old-hash", role: "user", status: "suspended" }
    let loginLockoutCleared = false
    const revoked: string[] = []
    const invalidated: string[] = []
    const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join("?").replace(/\s+/g, " ").toLowerCase()
      if (query.includes("select id, password_hash from users")) return [user]
      if (query.includes("update users set password_hash")) {
        user.password_hash = values[0]
        user.role = "admin"
        user.status = "active"
        return [{ id: user.id }]
      }
      if (query.includes("delete from auth_rate_limits")) {
        loginLockoutCleared = true
        return []
      }
      return []
    }

    const result = await bootstrapConfiguredAdmin({
      sql,
      email: "admin@example.com",
      password: "new-password",
      hashPassword: async (password) => `hash:${password}`,
      verifyPassword: async () => false,
      revokeAllSessions: async (id) => { revoked.push(id) },
      invalidateActiveUserCache: (id) => { invalidated.push(id) },
    })

    expect(result).toEqual({ id: "admin-1", passwordSynced: true })
    expect(user).toEqual({ id: "admin-1", password_hash: "hash:new-password", role: "admin", status: "active" })
    expect(loginLockoutCleared).toBe(true)
    expect(revoked).toEqual(["admin-1"])
    expect(invalidated).toEqual(["admin-1"])
  })
})
