import { describe, expect, test } from "bun:test"
import { DEFAULT_GATEWAY_RATE_LIMIT_RPM, GATEWAY_RATE_LIMIT_WINDOW_MS, gatewayRateLimitRpm } from "./rate-limit-config"

describe("gateway rate limit config", () => {
  test("allows 50 requests per minute by default", () => {
    expect(DEFAULT_GATEWAY_RATE_LIMIT_RPM).toBe(50)
    expect(GATEWAY_RATE_LIMIT_WINDOW_MS).toBe(60_000)
  })

  test("supports an explicit unlimited setting", () => {
    const previous = process.env.GATEWAY_RATE_LIMIT_RPM
    process.env.GATEWAY_RATE_LIMIT_RPM = "0"
    expect(gatewayRateLimitRpm()).toBe(0)
    if (previous === undefined) delete process.env.GATEWAY_RATE_LIMIT_RPM
    else process.env.GATEWAY_RATE_LIMIT_RPM = previous
  })
})
