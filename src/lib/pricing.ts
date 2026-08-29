export interface CostDetails {
  inputPricePer1M: number
  outputPricePer1M: number
  inputTokens: number
  outputTokens: number
  inputCacheReadPricePer1M?: number | null
  inputCacheWritePricePer1M?: number | null
  requestPriceFlat?: number | null
  cachedTokens?: number | null
}

export function calcCost(
  inputPricePer1M: number | CostDetails,
  outputPricePer1M?: number,
  inputTokens?: number,
  outputTokens?: number,
  inputCacheReadPricePer1M?: number | null,
  inputCacheWritePricePer1M?: number | null,
  requestPriceFlat?: number | null,
  cachedTokens?: number | null,
): number {
  if (typeof inputPricePer1M === "object" && inputPricePer1M !== null) {
    const d = inputPricePer1M
    return calcCost(
      d.inputPricePer1M,
      d.outputPricePer1M,
      d.inputTokens,
      d.outputTokens,
      d.inputCacheReadPricePer1M,
      d.inputCacheWritePricePer1M,
      d.requestPriceFlat,
      d.cachedTokens,
    )
  }

  const inPrice = inputPricePer1M ?? 0
  const outPrice = outputPricePer1M ?? 0
  const inTokens = inputTokens ?? 0
  const outTokens = outputTokens ?? 0
  const cTokens = cachedTokens ?? 0
  const cacheReadPrice = inputCacheReadPricePer1M ?? inPrice
  const flatFee = requestPriceFlat ?? 0

  const nonCachedInputTokens = Math.max(0, inTokens - cTokens)
  const inputCost = (nonCachedInputTokens / 1_000_000) * inPrice + (cTokens / 1_000_000) * cacheReadPrice
  const outputCost = (outTokens / 1_000_000) * outPrice
  const totalCost = inputCost + outputCost + flatFee

  return Number(totalCost.toFixed(8))
}

