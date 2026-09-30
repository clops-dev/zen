import { describe, expect, test } from "bun:test"
import { CREDIT_PACKAGES, DT_PER_USD } from "./credits"

describe("credit packages", () => {
  test("matches the backoffice package data", () => {
    expect(CREDIT_PACKAGES).toEqual([
      { dt: 15, usd: 5 },
      { dt: 30, usd: 10 },
      { dt: 45, usd: 15 },
      { dt: 60, usd: 20 },
      { dt: 150, usd: 50 },
    ])
    expect(DT_PER_USD).toBe(3)
  })
})
