import { sql, withDbResilience } from "./db"
import type { ComplexityTier } from "./db"
import { hasCredits, getBalance } from "./credits"

// ---------------------------------------------------------------------------
// Credit-user quota helper
// ---------------------------------------------------------------------------

export interface CreditQuotaStatus {
  /** true when the user has a positive credit balance */
  isCreditUser: boolean
  balance_dt: number
}

/**
 * Quick pre-check for the gateway: if the user has any paid credits, they
 * bypass the free token-budget system entirely.  Called BEFORE checkQuota.
 */
export async function checkCreditQuota(userId: string): Promise<CreditQuotaStatus> {
  const [creditsUser] = await Promise.all([hasCredits(userId)])
  if (!creditsUser) return { isCreditUser: false, balance_dt: 0 }
  const bal = await getBalance(userId)
  return { isCreditUser: true, balance_dt: bal.balance_dt }
}

export interface QuotaStatus {
  allowed: boolean
  reason?: string
  maxComplexityTier: ComplexityTier
}

export interface UserSpendingInfo {
  spendingCapUsd: number | null
  spendingCapEnabled: boolean
  spendingCapPeriod: string
  currentUsageUsd: number
  remainingUsd: number | null
  isLimitReached: boolean
}

export function monthStart(): Date {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export async function checkQuota(userId: string, estimatedCostUsd = 0.0001): Promise<QuotaStatus> {
  const subRows = await withDbResilience(() => sql`
    SELECT status, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period
    FROM subscriptions WHERE user_id = ${userId}
  `)
  if (subRows.length === 0) {
    return { allowed: false, reason: "no_subscription", maxComplexityTier: "trivial" }
  }
  const { status, token_budget_monthly, spending_cap_usd, spending_cap_enabled } = subRows[0]
  if (status === "suspended") {
    return { allowed: false, reason: "suspended", maxComplexityTier: "trivial" }
  }

  const usageRows = await withDbResilience(() => sql`
    SELECT total_input_tokens, total_output_tokens, total_cost_usd
    FROM monthly_usage WHERE user_id = ${userId} AND month = ${monthStart()}
  `)

  const usedTokens = usageRows.length
    ? Number(usageRows[0].total_input_tokens) + Number(usageRows[0].total_output_tokens)
    : 0
  const usedCost = usageRows.length ? Number(usageRows[0].total_cost_usd) : 0

  // 1. Spending Cap check (monetary limit)
  if (spending_cap_enabled && spending_cap_usd != null) {
    const cap = Number(spending_cap_usd)
    if (cap >= 0) {
      const remainingCost = Math.max(0, cap - usedCost)
      if (usedCost >= cap || remainingCost < estimatedCostUsd) {
        return { allowed: false, reason: "USAGE_LIMIT_REACHED", maxComplexityTier: "trivial" }
      }
    }
  }

  // 2. Monthly Token Budget check
  const budget = Number(token_budget_monthly)
  const remainingTokens = budget - usedTokens

  if (remainingTokens <= 0) {
    return { allowed: false, reason: "quota_exceeded", maxComplexityTier: "trivial" }
  }

  // Soft degradation: cap which complexity tier the user can be routed to as
  // their monthly budget runs low.
  const ratio = remainingTokens / budget
  const maxComplexityTier: ComplexityTier = ratio < 0.1 ? "simple" : ratio < 0.25 ? "medium" : "complex"

  return { allowed: true, maxComplexityTier }
}

export async function getUserSpending(userId: string): Promise<UserSpendingInfo> {
  const subRows = await withDbResilience(() => sql`
    SELECT spending_cap_usd, spending_cap_enabled, spending_cap_period
    FROM subscriptions WHERE user_id = ${userId}
  `)
  const usageRows = await withDbResilience(() => sql`
    SELECT total_cost_usd
    FROM monthly_usage WHERE user_id = ${userId} AND month = ${monthStart()}
  `)

  const sub = subRows[0] ?? { spending_cap_usd: null, spending_cap_enabled: false, spending_cap_period: "monthly" }
  const currentUsageUsd = usageRows.length ? Number(Number(usageRows[0].total_cost_usd).toFixed(4)) : 0
  const spendingCapUsd = sub.spending_cap_usd != null ? Number(Number(sub.spending_cap_usd).toFixed(4)) : null
  const spendingCapEnabled = Boolean(sub.spending_cap_enabled)
  const spendingCapPeriod = sub.spending_cap_period ?? "monthly"

  let remainingUsd: number | null = null
  let isLimitReached = false

  if (spendingCapEnabled && spendingCapUsd !== null) {
    remainingUsd = Math.max(0, Number((spendingCapUsd - currentUsageUsd).toFixed(4)))
    isLimitReached = currentUsageUsd >= spendingCapUsd
  }

  return {
    spendingCapUsd,
    spendingCapEnabled,
    spendingCapPeriod,
    currentUsageUsd,
    remainingUsd,
    isLimitReached,
  }
}

export async function recordUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): Promise<void> {
  const safeCost = Number(costUsd.toFixed(8))
  await withDbResilience(() => sql`
    INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, request_count)
    VALUES (${userId}, ${monthStart()}, ${inputTokens}, ${outputTokens}, ${safeCost}, 1)
    ON CONFLICT (user_id, month) DO UPDATE SET
      total_input_tokens = monthly_usage.total_input_tokens + EXCLUDED.total_input_tokens,
      total_output_tokens = monthly_usage.total_output_tokens + EXCLUDED.total_output_tokens,
      total_cost_usd = monthly_usage.total_cost_usd + EXCLUDED.total_cost_usd,
      request_count = monthly_usage.request_count + 1
  `)
}
