import { sql, withDbResilience } from "./db"
import type { ComplexityTier } from "./db"

export interface QuotaStatus {
  allowed: boolean
  reason?: string
  maxComplexityTier: ComplexityTier
}

function monthStart(): Date {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export async function checkQuota(userId: string): Promise<QuotaStatus> {
  const subRows = await withDbResilience(() => sql`SELECT status, token_budget_monthly FROM subscriptions WHERE user_id = ${userId}`)
  if (subRows.length === 0) {
    return { allowed: false, reason: "no_subscription", maxComplexityTier: "trivial" }
  }
  const { status, token_budget_monthly } = subRows[0]
  if (status === "suspended") {
    return { allowed: false, reason: "suspended", maxComplexityTier: "trivial" }
  }

  const usageRows = await withDbResilience(() => sql`
    SELECT total_input_tokens, total_output_tokens
    FROM monthly_usage WHERE user_id = ${userId} AND month = ${monthStart()}
  `)
  const used = usageRows.length
    ? Number(usageRows[0].total_input_tokens) + Number(usageRows[0].total_output_tokens)
    : 0
  const budget = Number(token_budget_monthly)
  const remaining = budget - used

  if (remaining <= 0) {
    return { allowed: false, reason: "quota_exceeded", maxComplexityTier: "trivial" }
  }

  // Soft degradation: cap which complexity tier the user can be routed to as
  // their monthly budget runs low, rather than a hard cutoff at zero.
  const ratio = remaining / budget
  const maxComplexityTier: ComplexityTier = ratio < 0.1 ? "simple" : ratio < 0.25 ? "medium" : "complex"

  return { allowed: true, maxComplexityTier }
}

export async function recordUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): Promise<void> {
  await withDbResilience(() => sql`
    INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, request_count)
    VALUES (${userId}, ${monthStart()}, ${inputTokens}, ${outputTokens}, ${costUsd}, 1)
    ON CONFLICT (user_id, month) DO UPDATE SET
      total_input_tokens = monthly_usage.total_input_tokens + EXCLUDED.total_input_tokens,
      total_output_tokens = monthly_usage.total_output_tokens + EXCLUDED.total_output_tokens,
      total_cost_usd = monthly_usage.total_cost_usd + EXCLUDED.total_cost_usd,
      request_count = monthly_usage.request_count + 1
  `)
}
