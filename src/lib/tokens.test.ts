import { describe, test, expect } from "bun:test"
import { countInputTokens, defaultReserveFor } from "./tokens"

describe("countInputTokens", () => {
  test("returns just the per-request overhead for empty inputs", () => {
    // 2 = the per-request priming overhead. There is no system, no messages,
    // no tools to count.
    expect(countInputTokens({ system: "", messages: [], tools: [] })).toBe(2)
  })

  test("counts a single short user message", () => {
    const n = countInputTokens({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] })
    // "hi" → 1 token in cl100k_base, plus "user: " → 2 more (3 content tokens).
    // Per-message overhead (4) + per-request overhead (2) + 3 = 9.
    expect(n).toBe(9)
  })

  test("scales roughly linearly with message length", () => {
    const short = countInputTokens({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] })
    const long = countInputTokens({
      system: "",
      messages: [{ role: "user", content: "the quick brown fox jumps over the lazy dog. ".repeat(100) }],
      tools: [],
    })
    expect(long).toBeGreaterThan(short * 20)
  })

  test("includes system prompt tokens", () => {
    const without = countInputTokens({ system: "", messages: [{ role: "user", content: "hello" }], tools: [] })
    const withSystem = countInputTokens({ system: "You are a helpful assistant.", messages: [{ role: "user", content: "hello" }], tools: [] })
    expect(withSystem).toBeGreaterThan(without)
  })

  test("includes tool definition tokens (tool name + JSON schema)", () => {
    const without = countInputTokens({ system: "", messages: [], tools: [] })
    const withTools = countInputTokens({
      system: "",
      messages: [],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "Get the current weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
      }],
    })
    // a tool definition is hundreds of tokens — at minimum it must be more than empty.
    expect(withTools).toBeGreaterThan(without + 10)
  })

  test("treats system as array of content blocks correctly", () => {
    const single = countInputTokens({ system: "you are helpful", messages: [], tools: [] })
    const arr = countInputTokens({ system: [{ type: "text", text: "you are helpful" }], messages: [], tools: [] })
    // both forms encode the same text and should produce a very similar count
    expect(Math.abs(single - arr)).toBeLessThan(5)
  })

  test("counts assistant and tool messages too", () => {
    const n = countInputTokens({
      system: "",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello there" },
        { role: "user", content: "tell me a joke" },
      ],
      tools: [],
    })
    // three messages * (4 + at least 1 content token) + 2 request overhead = >= 17
    expect(n).toBeGreaterThan(15)
  })

  test("does NOT throw on strings containing OpenAI special-token markers", () => {
    // Regression for: "Internal Server Error: Disallowed special token
    // found: <|endoftext|>" / "<|fim_prefix|>" etc. The cl100k_base
    // encoding refuses to encode strings that contain these boundary
    // markers by default. User prompts that happen to contain them
    // (chat templates, LLM traces, markdown with `<|...|>` fences) used
    // to crash the entire gateway with a 500. We pass
    // `allowedSpecial: "all"` so the counter treats them as plain bytes
    // — the real LLM call goes through @ai-sdk/openai-compatible /
    // @ai-sdk/anthropic which has its own (correct) tokenization.
    const cases = [
      "hello world", // baseline — should never throw
      "hello<|endoftext|>world",
      "hello<|fim_prefix|>world",
      "hello<|fim_suffix|>world",
      "test `` test",
      "<|endoftext|>", // bare marker
      "x<|im_start|>y",
      "<|im_end|>",
    ]
    for (const content of cases) {
      expect(() =>
        countInputTokens({ system: "", messages: [{ role: "user", content }], tools: [] }),
      ).not.toThrow()
      // And actually returns a positive integer
      const n = countInputTokens({ system: "", messages: [{ role: "user", content }], tools: [] })
      expect(n).toBeGreaterThan(0)
    }
  })

  test("P3.12: supports o200k_base tokenizer for newer OpenAI models", () => {
    const input = { system: "", messages: [{ role: "user", content: "hello world" }], tools: [] }
    const cl100kCount = countInputTokens({ ...input, tokenizer: "cl100k" })
    const o200kCount = countInputTokens({ ...input, tokenizer: "o200k" })
    expect(cl100kCount).toBeGreaterThan(0)
    expect(o200kCount).toBeGreaterThan(0)
  })

  test("P3.12: applies 1.15x conservative factor for Anthropic and Gemini", () => {
    const input = { system: "System prompt instructions", messages: [{ role: "user", content: "Write a function in python to sort an array." }], tools: [] }
    const baseCount = countInputTokens({ ...input, tokenizer: "cl100k" })
    const anthropicCount = countInputTokens({ ...input, tokenizer: "anthropic" })
    const geminiCount = countInputTokens({ ...input, tokenizer: "gemini" })
    expect(anthropicCount).toBe(Math.ceil(baseCount * 1.15))
    expect(geminiCount).toBe(Math.ceil(baseCount * 1.15))
  })

  test("P3.12: applies 1.25x conservative factor for approx models", () => {
    const input = { system: "System prompt instructions", messages: [{ role: "user", content: "Write a function in python to sort an array." }], tools: [] }
    const baseCount = countInputTokens({ ...input, tokenizer: "cl100k" })
    const approxCount = countInputTokens({ ...input, tokenizer: "approx" })
    expect(approxCount).toBe(Math.ceil(baseCount * 1.25))
  })
})

describe("defaultReserveFor", () => {
  test("uses 20% of the window for large windows", () => {
    // 8192 * 0.2 = 1638.4 → floor 1638. max(2048, 1638) = 2048
    expect(defaultReserveFor(8192)).toBe(2048)
    // 32768 * 0.2 = 6553.6 → floor 6553. max(2048, 6553) = 6553
    expect(defaultReserveFor(32768)).toBe(6553)
    // 200000 * 0.2 = 40000, capped at 8192 max reserve
    expect(defaultReserveFor(200000)).toBe(8192)
  })

  test("uses 2048 floor for windows where 20% would be smaller", () => {
    // 8000 * 0.2 = 1600. max(2048, 1600) = 2048
    expect(defaultReserveFor(8000)).toBe(2048)
    // 1000 * 0.2 = 200. max(2048, 200) = 2048
    expect(defaultReserveFor(1000)).toBe(2048)
  })
})
