import { describe, expect, test } from "bun:test"
import { DEFAULT_GATEWAY_RATE_LIMIT_RPM, GATEWAY_RATE_LIMIT_WINDOW_MS } from "./rate-limit-config"

describe("gateway rate limit config", () => {
  test("allows 50 requests per minute", () => {
    expect(DEFAULT_GATEWAY_RATE_LIMIT_RPM).toBe(50)
    expect(GATEWAY_RATE_LIMIT_WINDOW_MS).toBe(60_000)
  })
})
