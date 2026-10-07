import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { userApi } from "../routes/user-api"
import { setSql, resetSql } from "./db"
import { issueSession, SESSION_COOKIE } from "./session"
import { invalidateActiveUserCache } from "./active-user"

describe("IDOR and Object-Level Authorization", () => {
  interface MockApiKey {
    id: string
    user_id: string
    key_prefix: string
    key_hash: string
    label: string | null
    created_at: Date
    last_used_at: Date | null
    revoked: boolean
  }

  interface MockTransaction {
    id: string
    user_id: string
    amount_dt: number
    type: string
    status: string
    created_at: Date
  }

  let apiKeys: MockApiKey[] = []
  let transactions: MockTransaction[] = []
  let sessions: any[] = []

  const userA = { id: "user-uuid-aaaa-1111", email: "userA@example.com", role: "user" as const, status: "active" }
  const userB = { id: "user-uuid-bbbb-2222", email: "userB@example.com", role: "user" as const, status: "active" }

  let tokenA: string
  let tokenB: string

  beforeEach(async () => {
    apiKeys = [
      {
        id: "key-a-1",
        user_id: userA.id,
        key_prefix: "zen_keyA",
        key_hash: "hashA",
        label: "User A Key",
        created_at: new Date(),
        last_used_at: null,
        revoked: false,
      },
      {
        id: "key-b-1",
        user_id: userB.id,
        key_prefix: "zen_keyB",
        key_hash: "hashB",
        label: "User B Key",
        created_at: new Date(),
        last_used_at: null,
        revoked: false,
      },
    ]

    transactions = [
      { id: "tx-a-1", user_id: userA.id, amount_dt: 50, type: "purchase", status: "completed", created_at: new Date() },
      { id: "tx-b-1", user_id: userB.id, amount_dt: 100, type: "purchase", status: "completed", created_at: new Date() },
    ]

    sessions = []
    invalidateActiveUserCache()

    // Mock SQL queries
    const mockSql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // INSERT INTO sessions
      if (q.includes("insert into sessions")) {
        const [token_hash, user_id, ip_hash, ua_hash, expires_at] = values
        const s = {
          id: `s-${Math.random()}`,
          token_hash,
          user_id,
          last_seen_at: new Date(),
          expires_at: new Date(expires_at),
          revoked: false,
        }
        sessions.push(s)
        return [s]
      }

      // SELECT from sessions (verifySession)
      if (q.includes("from sessions where token_hash = ?")) {
        const [hash] = values
        const s = sessions.find((x) => x.token_hash === hash && !x.revoked)
        return s ? [s] : []
      }

      // getActiveUser query
      if (q.includes("from users u left join subscriptions s on s.user_id = u.id where u.id = ?")) {
        const [uid] = values
        const u = uid === userA.id ? userA : uid === userB.id ? userB : null
        return u ? [{ id: u.id, email: u.email, role: u.role, user_status: "active", sub_status: "active" }] : []
      }

      // Update sessions (touch last_seen or revoke)
      if (q.includes("update sessions")) {
        return { count: 1 }
      }

      // API keys list
      if (q.includes("from api_keys where user_id = ?")) {
        const [uid] = values
        return apiKeys.filter((k) => k.user_id === uid)
      }

      // API keys revoke with user_id ownership check
      if (q.includes("update api_keys set revoked = true where id = ? and user_id = ? and revoked = false")) {
        const [keyId, uid] = values
        const key = apiKeys.find((k) => k.id === keyId && k.user_id === uid && !k.revoked)
        if (key) {
          key.revoked = true
          return { count: 1 }
        }
        return { count: 0 }
      }

      // API key insert
      if (q.includes("insert into api_keys")) {
        const [uid, hash, prefix, label] = values
        const newKey: MockApiKey = {
          id: `key-new-${Math.random()}`,
          user_id: uid,
          key_prefix: prefix,
          key_hash: hash,
          label: label ?? null,
          created_at: new Date(),
          last_used_at: null,
          revoked: false,
        }
        apiKeys.push(newKey)
        return [newKey]
      }

      // user_credits table query (getBalance)
      if (q.includes("from user_credits where user_id = ?")) {
        const [uid] = values
        return [{ balance_dt: uid === userA.id ? 50 : 100, updated_at: new Date().toISOString() }]
      }

      // Billing / credit transactions
      if (q.includes("from credit_transactions")) {
        const uid = values.find((v) => v === userA.id || v === userB.id)
        return transactions.filter((t) => t.user_id === uid)
      }

      // Monthly usage
      if (q.includes("from monthly_usage where user_id = ?")) {
        const [uid] = values
        return uid === userA.id
          ? [{ month: "2026-09-01", total_input_tokens: 100, total_output_tokens: 200, total_cached_tokens: 0, total_cost_usd: 0.05, request_count: 5 }]
          : [{ month: "2026-09-01", total_input_tokens: 9999, total_output_tokens: 9999, total_cached_tokens: 0, total_cost_usd: 5.0, request_count: 99 }]
      }

      // Daily usage
      if (q.includes("from ai_requests where user_id = ?")) {
        const [uid] = values
        return uid === userA.id
          ? [{ day: "2026-10-01", request_count: 2, input_tokens: 50, output_tokens: 50, cost_usd: 0.02 }]
          : [{ day: "2026-10-01", request_count: 50, input_tokens: 5000, output_tokens: 5000, cost_usd: 2.0 }]
      }

      // Users table query
      if (q.includes("from users u")) {
        const [uid] = values
        const u = uid === userA.id ? userA : userB
        return [{ id: u.id, email: u.email, avatar_url: null, created_at: new Date(), active_key_count: 1, total_key_count: 1 }]
      }

      return []
    }

    setSql(mockSql)

    const sessionA = await issueSession(userA.id, userA.role)
    const sessionB = await issueSession(userB.id, userB.role)
    tokenA = sessionA.token
    tokenB = sessionB.token
  })

  test("User A cannot revoke User B's API key by ID (IDOR prevention)", async () => {
    // User A attempts to revoke key-b-1 (which belongs to User B)
    const res = await userApi.request(`/api-keys/${apiKeys[1].id}/revoke`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    // Must return 404 not found / unauthorized and NOT revoke the key
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error).toBe("not_found_or_already_revoked")

    // Key B must remain active (not revoked)
    expect(apiKeys[1].revoked).toBe(false)
  })

  test("User A can successfully revoke their own API key", async () => {
    const res = await userApi.request(`/api-keys/${apiKeys[0].id}/revoke`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(apiKeys[0].revoked).toBe(true)
  })

  test("User A cannot view User B's API keys", async () => {
    const res = await userApi.request("/api-keys", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const keys = (await res.json()) as any[]
    expect(keys.length).toBe(1)
    expect(keys[0].id).toBe(apiKeys[0].id)
    expect(keys.some((k) => k.id === apiKeys[1].id)).toBe(false)
  })

  test("User A cannot view User B's credit balance", async () => {
    const res = await userApi.request("/credits", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const balance = (await res.json()) as any
    // User A's balance is 50, User B's is 100
    expect(balance.balance_dt).toBe(50)
  })

  test("User B sees only User B's balance", async () => {
    const res = await userApi.request("/credits", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenB}`,
      },
    })

    expect(res.status).toBe(200)
    const balance = (await res.json()) as any
    expect(balance.balance_dt).toBe(100)
  })

  test("User A cannot view User B's transaction history", async () => {
    const res = await userApi.request("/credits/history", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const txs = (await res.json()) as any[]
    expect(txs.length).toBe(1)
    expect(txs[0].id).toBe("tx-a-1")
    expect(txs.some((t) => t.id === "tx-b-1")).toBe(false)
  })

  test("User A cannot view User B's monthly token usage", async () => {
    const res = await userApi.request("/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const usage = (await res.json()) as any[]
    expect(usage.length).toBe(1)
    expect(usage[0].cost_usd).toBe(0.05)
  })

  test("User A cannot view User B's daily token usage", async () => {
    const res = await userApi.request("/usage/daily", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${tokenA}`,
      },
    })

    expect(res.status).toBe(200)
    const daily = (await res.json()) as any[]
    expect(daily.length).toBe(1)
    expect(daily[0].cost_usd).toBe(0.02)
  })

  afterAll(() => {
    resetSql()
    invalidateActiveUserCache()
  })
})

