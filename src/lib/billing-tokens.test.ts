import { describe, expect, test } from "bun:test"
import { resolveBilledInputTokens } from "./billing-tokens"

describe("resolveBilledInputTokens", () => {
  test("uses provider usage when available", () => {
    expect(resolveBilledInputTokens(120, 100)).toBe(120)
  })

  test("falls back to gateway count when provider usage is missing", () => {
    expect(resolveBilledInputTokens(0, 100)).toBe(100)
    expect(resolveBilledInputTokens(Number.NaN, 100)).toBe(100)
  })
})
