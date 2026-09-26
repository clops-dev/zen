import { describe, test, expect } from "bun:test"
import {
  pickRoute,
  findAliasTarget,
  ExplicitModelCapabilityError,
  type RouteTarget,
} from "./routing"

describe("P3.4, P3.5, P3.9: Aliases, Explicit Model Capabilities, and Quality Ranking", () => {
  test("findAliasTarget resolves stable aliases correctly", async () => {
    const auto = await findAliasTarget("zen/auto")
    expect(auto?.alias).toBe("zen/auto")
    expect(auto?.targetTier).toBeNull()

    const fast = await findAliasTarget("zen/fast")
    expect(fast?.alias).toBe("zen/fast")
    expect(fast?.targetTier).toBe("simple")

    const smart = await findAliasTarget("zen/smart")
    expect(smart?.alias).toBe("zen/smart")
    expect(smart?.targetTier).toBe("complex")

    const reasoning = await findAliasTarget("zen/reasoning")
    expect(reasoning?.alias).toBe("zen/reasoning")
    expect(reasoning?.targetTier).toBe("complex")
  })

  test("ExplicitModelCapabilityError is thrown when explicit model lacks tools support", () => {
    const err = new ExplicitModelCapabilityError(["tools"], "openai/gpt-3.5-turbo-instruct")
    expect(err.name).toBe("ExplicitModelCapabilityError")
    expect(err.missingCapabilities).toEqual(["tools"])
    expect(err.requestedModel).toBe("openai/gpt-3.5-turbo-instruct")
    expect(err.message).toContain("does not support required capabilities: tools")
  })
})
