import { describe, test, expect, beforeEach } from "bun:test"
import { getActiveUser, invalidateActiveUserCache } from "./active-user"
import { setSql, resetSql } from "./db"

describe("getActiveUser", () => {
  interface MockUser {
    id: string
    email: string
    role: "user" | "admin"
    status: string
  }
  interface MockSub {
    user_id: string
    status: string
  }

  let users: MockUser[] = []
  let subs: MockSub[] = []
  let queryCount = 0

  beforeEach(() => {
    users = []
    subs = []
    queryCount = 0
    invalidateActiveUserCache()

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()
      if (q.includes("from users") && q.includes("where u.id = ?")) {
        queryCount++
        const uid = values[0]
        const u = users.find((x) => x.id === uid)
        if (!u) return []
        const s = subs.find((x) => x.user_id === uid)
        return [
          {
            id: u.id,
            email: u.email,
            role: u.role,
            user_status: u.status,
            sub_status: s ? s.status : "active",
          },
        ]
      }
      return []
    }
    setSql(mockSql)
  })

  test("returns active user when user and subscription are active", async () => {
    users.push({ id: "user-1", email: "user1@example.com", role: "user", status: "active" })
    subs.push({ user_id: "user-1", status: "active" })

    const res = await getActiveUser("user-1")
    expect(res).not.toBeNull()
    expect(res?.id).toBe("user-1")
    expect(res?.email).toBe("user1@example.com")
    expect(res?.role).toBe("user")
  })

  test("returns null if user does not exist", async () => {
    const res = await getActiveUser("non-existent")
    expect(res).toBeNull()
  })

  test("returns null if user status is suspended", async () => {
    users.push({ id: "user-suspended", email: "susp@example.com", role: "user", status: "suspended" })
    subs.push({ user_id: "user-suspended", status: "active" })

    const res = await getActiveUser("user-suspended")
    expect(res).toBeNull()
  })

  test("returns null if user status is deleted", async () => {
    users.push({ id: "user-deleted", email: "del@example.com", role: "user", status: "deleted" })
    subs.push({ user_id: "user-deleted", status: "active" })

    const res = await getActiveUser("user-deleted")
    expect(res).toBeNull()
  })

  test("returns null if subscription status is suspended", async () => {
    users.push({ id: "user-sub-suspended", email: "sub-susp@example.com", role: "user", status: "active" })
    subs.push({ user_id: "user-sub-suspended", status: "suspended" })

    const res = await getActiveUser("user-sub-suspended")
    expect(res).toBeNull()
  })

  test("caches active user for TTL and avoids extra queries", async () => {
    users.push({ id: "user-cached", email: "cached@example.com", role: "user", status: "active" })
    subs.push({ user_id: "user-cached", status: "active" })

    const res1 = await getActiveUser("user-cached")
    expect(res1?.id).toBe("user-cached")
    expect(queryCount).toBe(1)

    const res2 = await getActiveUser("user-cached")
    expect(res2?.id).toBe("user-cached")
    expect(queryCount).toBe(1) // cached!

    // Invalidate cache
    invalidateActiveUserCache("user-cached")
    const res3 = await getActiveUser("user-cached")
    expect(res3?.id).toBe("user-cached")
    expect(queryCount).toBe(2) // queried again
  })
})
