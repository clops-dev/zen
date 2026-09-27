import { describe, expect, test } from "bun:test"
import { hashPrompt, isResponseCacheEligible } from "./cache"

const messages = [{ role: "user", content: "Explain this code" }]
const scope = { userId: "user-a", model: "provider/gpt-5.6-luna", maxOutputTokens: 100, temperature: 0 }

describe("response cache safety", () => {
  test("separates cache keys by user, model, and generation parameters", () => {
    const original = hashPrompt(messages, scope)
    expect(hashPrompt(messages, { ...scope, userId: "user-b" })).not.toBe(original)
    expect(hashPrompt(messages, { ...scope, model: "provider/other" })).not.toBe(original)
    expect(hashPrompt(messages, { ...scope, maxOutputTokens: 200 })).not.toBe(original)
  })

  test("only permits deterministic requests for an explicit model", () => {
    expect(isResponseCacheEligible({ model: "provider/gpt-5.6-luna", temperature: 0, isAgent: false })).toBe(true)
    expect(isResponseCacheEligible({ model: undefined, temperature: 0, isAgent: false })).toBe(false)
    expect(isResponseCacheEligible({ model: "zen/auto", temperature: 0, isAgent: false })).toBe(false)
    expect(isResponseCacheEligible({ model: "provider/gpt-5.6-luna", temperature: undefined, isAgent: false })).toBe(false)
    expect(isResponseCacheEligible({ model: "provider/gpt-5.6-luna", temperature: 0, isAgent: true })).toBe(false)
  })
})
