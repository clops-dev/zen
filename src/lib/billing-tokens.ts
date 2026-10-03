export function resolveBilledInputTokens(reportedTokens: number, estimatedTokens: number): number {
  if (Number.isFinite(reportedTokens) && reportedTokens > 0) return Math.floor(reportedTokens)
  return Math.max(0, Math.floor(estimatedTokens))
}
