import { describe, expect, test } from "bun:test"
import { MemoryRateLimiter } from "./rate-limit"

describe("P4.4 memory rate limiter", () => {
  test("enforces user+IP fixed windows without a database", () => {
    const limiter = new MemoryRateLimiter()
    expect(limiter.check("user:ip", 2, 60_000, 1_000).allowed).toBe(true)
    expect(limiter.check("user:ip", 2, 60_000, 1_001).allowed).toBe(true)
    expect(limiter.check("user:ip", 2, 60_000, 1_002).allowed).toBe(false)
    expect(limiter.check("user:ip", 2, 60_000, 60_000).allowed).toBe(true)
  })
})
