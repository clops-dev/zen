import { sql, withDbResilience } from "./db"
import type { ComplexityTier } from "./db"
import { getUserBillingSummary } from "./credits"

export interface QuotaStatus {
  allowed: boolean
  reason?: string
  remainingUsd: number
  maxComplexityTier: ComplexityTier
}

export function monthStart(): Date {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/**
 * Check if a user has sufficient credits to perform an AI request.
 * Subscriptions have been removed — access depends ONLY on available credit balance.
 */
export async function checkQuota(userId: string, estimatedCostUsd = 0.0001): Promise<QuotaStatus> {
  const summary = await getUserBillingSummary(userId)
  const remainingUsd = summary.remaining_credits

  if (remainingUsd <= 0 || remainingUsd < estimatedCostUsd) {
    return {
      allowed: false,
      reason: "insufficient_credits",
      remainingUsd,
      maxComplexityTier: "trivial",
    }
  }

  return {
    allowed: true,
    remainingUsd,
    maxComplexityTier: "complex",
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
