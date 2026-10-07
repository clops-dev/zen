import { describe, test, expect, beforeEach } from "bun:test"
import { checkQuota } from "./quota"
import { setSql } from "./db"

describe("Quota and Credit Freeze checks", () => {
  let userRows: any[] = []
  let creditTxRows: any[] = []

  beforeEach(() => {
    userRows = []
    creditTxRows = []

    const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()

      // SELECT credits_frozen FROM users
      if (q.includes("from users") && q.includes("credits_frozen")) {
        const uid = values[0]
        const u = userRows.find(x => x.id === uid)
        return u ? [u] : []
      }

      // credit_transactions queries from getUserBillingSummary
      if (q.includes("from credit_transactions") && q.includes("sum(amount_dt)")) {
        const uid = values[0]
        const txs = creditTxRows.filter(t => t.user_id === uid && t.status === "completed")
        const total_dt = txs.reduce((sum, t) => sum + (t.amount_dt ?? 0), 0)
        return [{ total_dt }]
      }

      if (q.includes("from credit_transactions") && q.includes("exists")) {
        const uid = values[0]
        const has = creditTxRows.some(t => t.user_id === uid && t.type === "purchase")
        return [{ has_purchase: has }]
      }

      if (q.includes("from ai_requests")) {
        return [{ total_requests: 0, input_tokens: 0, output_tokens: 0, total_usage_cost: 0 }]
      }

      return []
    }

    setSql(mockSql)
  })

  test("user with positive credits and credits_frozen = false is allowed", async () => {
    userRows.push({ id: "user-ok", credits_frozen: false, credits_freeze_reason: null })
    creditTxRows.push({ user_id: "user-ok", amount_dt: 15, type: "purchase", status: "completed" })

    const res = await checkQuota("user-ok", 0.0001)
    expect(res.allowed).toBe(true)
    expect(res.remainingUsd).toBeGreaterThan(0)
  })

  test("user with credits_frozen = true is denied with reason: credits_frozen", async () => {
    userRows.push({ id: "user-frozen", credits_frozen: true, credits_freeze_reason: "device_id_collision" })
    creditTxRows.push({ user_id: "user-frozen", amount_dt: 15, type: "purchase", status: "completed" })

    const res = await checkQuota("user-frozen", 0.0001)
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe("credits_frozen")
    expect(res.remainingUsd).toBe(0)
  })

  test("user with 0 balance is denied with reason: insufficient_credits", async () => {
    userRows.push({ id: "user-zero", credits_frozen: false, credits_freeze_reason: null })

    const res = await checkQuota("user-zero", 0.0001)
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe("insufficient_credits")
  })
})
