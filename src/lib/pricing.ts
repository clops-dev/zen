export function calcCost(
  inputPricePer1M: number,
  outputPricePer1M: number,
  inputTokens: number,
  outputTokens: number,
): number {
  const cost = (inputTokens / 1_000_000) * inputPricePer1M + (outputTokens / 1_000_000) * outputPricePer1M
  return Number(cost.toFixed(8))
}
