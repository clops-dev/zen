import { describe, expect, test } from "bun:test"
import { calcCost } from "./pricing"

describe("calcCost", () => {
  test("calculates standard prompt and completion token cost", () => {
    // 1M prompt @ $3, 1M completion @ $15
    const cost = calcCost(3, 15, 1_000_000, 1_000_000)
    expect(cost).toBe(18)
  })

  test("calculates cache read discount cost correctly", () => {
    // 1M total input, 500k cached @ $0.30/1M, 500k standard @ $3.00/1M, 0 completion
    // Input cost = 0.5 * 3.00 + 0.5 * 0.30 = 1.50 + 0.15 = 1.65
    const cost = calcCost({
      inputPricePer1M: 3,
      outputPricePer1M: 15,
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputCacheReadPricePer1M: 0.3,
      cachedTokens: 500_000,
    })
    expect(cost).toBe(1.65)
  })

  test("uses prompt price for cache when inputCacheReadPricePer1M is null", () => {
    // 1M total input, 500k cached, cache price null (treat as prompt price $3.00)
    const cost = calcCost({
      inputPricePer1M: 3,
      outputPricePer1M: 15,
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputCacheReadPricePer1M: null,
      cachedTokens: 500_000,
    })
    expect(cost).toBe(3)
  })

  test("adds flat request fee if specified", () => {
    // $0.01 flat fee + standard tokens
    const cost = calcCost({
      inputPricePer1M: 3,
      outputPricePer1M: 15,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      requestPriceFlat: 0.01,
    })
    expect(cost).toBe(18.01)
  })

  test("handles zero/free model pricing correctly", () => {
    const cost = calcCost(0, 0, 100_000, 50_000)
    expect(cost).toBe(0)
  })
})
