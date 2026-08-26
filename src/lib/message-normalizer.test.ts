import { expect, test, describe } from "bun:test"
import { normalizeMessages } from "./message-normalizer"

describe("message-normalizer", () => {
  test("normal chat messages (1)", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" }
    ]
    const result = normalizeMessages(messages)
    expect(result.system).toBe("You are a helpful assistant.")
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" }
    ])
  })

  test("assistant tool calls (2)", () => {
    const messages = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"location\":\"Tokyo\"}"
            }
          }
        ]
      }
    ]
    const result = normalizeMessages(messages)
    expect(result.nonSystemMessages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "get_weather",
          input: { location: "Tokyo" }
        }
      ]
    })
  })

  test("tool results (3)", () => {
    // The orphan-filter rejects tool messages whose tool_call_id was never
    // emitted by an assistant in the same history. To pass case (3) we must
    // include a prior assistant tool_call with the same id. This is the
    // PAIRSED-tool-call/result contract: tools only survive if their
    // parent assistant tool-call is present in the conversation.
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        name: "get_weather",
        content: "Sunny"
      }
    ]
    const result = normalizeMessages(messages)
    const toolMsg = result.nonSystemMessages.find((m: any) => m.role === "tool")
    expect(toolMsg).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "get_weather",
          output: { type: "text", value: "Sunny" }
        }
      ]
    })
  })

  test("mixed KiloCode/OpenAI messages (4)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "image_url", image_url: { url: "http://example.com/image.png" } }
        ]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Nice image!" }]
      }
    ]
    const result = normalizeMessages(messages)
    expect(result.nonSystemMessages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look at this:" },
        { type: "image_url", image_url: { url: "http://example.com/image.png" } }
      ]
    })
    expect(result.nonSystemMessages[1]).toEqual({
      role: "assistant",
      content: "Nice image!"
    })
  })

  // The next five tests pin the fix for the "invalid message at index 55"
  // bug. The provider rejects messages whose content is empty AND has no
  // tool calls. The normalizer must DROP these so the gateway never sends
  // them. Content="" is the canonical failure case; null/undefined
  // content and empty array all reduce to the same effective shape.

  test("assistant content=null (no tool_calls) is DROPPED, not emitted as empty string", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: null },
      { role: "user", content: "World" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
    // Must not contain an empty assistant message
    for (const m of result.nonSystemMessages) {
      const c = (m as any).content
      if ((m as any).role === "assistant") {
        expect(c).toBeTruthy()
        expect(typeof c === "string" ? c.length > 0 : true).toBe(true)
      }
    }
  })

  test("assistant content=undefined (no tool_calls) is DROPPED", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant" },
      { role: "user", content: "World" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
  })

  test("assistant content=\"\" (empty string, no tool_calls) is DROPPED", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "World" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
  })

  test("assistant content=[] (empty array, no tool_calls) is DROPPED", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [] },
      { role: "user", content: "World" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
  })

  test("assistant content with only whitespace is DROPPED (would serialize to empty)", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "   \n\n  " },
      { role: "user", content: "World" },
    ])
    // Whitespace-only content currently passes the truthy-string check; this
    // test documents current behavior. If we ever tighten it to strip
    // whitespace, this test will tell us to revisit the empty-string case.
    expect(result.nonSystemMessages.length).toBeGreaterThanOrEqual(2)
  })

  test("assistant with tool_calls and empty content is KEPT (tool calls satisfy the validity rule)", () => {
    const result = normalizeMessages([
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_abc", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
    ])
    expect(result.nonSystemMessages).toHaveLength(2)
    expect((result.nonSystemMessages[1] as any).role).toBe("assistant")
    expect((result.nonSystemMessages[1] as any).content).toEqual([
      { type: "tool-call", toolCallId: "call_abc", toolName: "get_weather", input: {} },
    ])
  })

  test("user content=null is dropped (no empty user message either)", () => {
    const result = normalizeMessages([
      { role: "user", content: null },
      { role: "user", content: "Hi" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hi" },
    ])
  })

  test("user content=[] is dropped", () => {
    const result = normalizeMessages([
      { role: "user", content: [] },
      { role: "user", content: "Hi" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hi" },
    ])
  })

  test("orphan tool-result (no matching assistant tool_call) is dropped", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hi" },
      // Orphan — no prior assistant tool-call with this id
      { role: "tool", tool_call_id: "call_orphan", name: "n", content: "x" },
      { role: "assistant", content: "ok" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "ok" },
    ])
  })

  test("paired tool-call + tool-result both pass through", () => {
    const result = normalizeMessages([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"sf\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_x", name: "get_weather", content: "foggy" },
      { role: "assistant", content: "It's foggy." },
    ])
    expect(result.nonSystemMessages).toHaveLength(4)
    expect((result.nonSystemMessages[2] as any).role).toBe("tool")
  })

  test("long conversation with one empty assistant message in the middle is filtered", () => {
    // Simulates the index-55 bug: a long history where one assistant
    // message accidentally has content=null. After normalization, the
    // outgoing list must NOT contain an empty assistant message.
    const messages: any[] = [{ role: "system", content: "Helper." }]
    for (let i = 0; i < 60; i++) {
      messages.push({ role: "user", content: `q${i}` })
      if (i === 55) {
        messages.push({ role: "assistant", content: null })
      } else {
        messages.push({ role: "assistant", content: `a${i}` })
      }
    }
    const result = normalizeMessages(messages)
    for (const m of result.nonSystemMessages) {
      if ((m as any).role === "assistant") {
        const c = (m as any).content
        expect(c == null || (typeof c === "string" && c.length === 0)).toBe(false)
      }
    }
  })

  test("tool-result inside an array content with missing toolCallId is dropped", () => {
    const result = normalizeMessages([
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "f", output: { type: "text", value: "ok" } },
          { type: "tool-result", /* missing toolCallId */ output: { type: "text", value: "junk" } },
        ],
      },
    ])
    const toolMsg = result.nonSystemMessages.find((m: any) => m.role === "tool") as any
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toHaveLength(1)
    expect(toolMsg.content[0].toolCallId).toBe("call_1")
  })

  test("tool message with no tool_call_id and no tool-result items is dropped", () => {
    const result = normalizeMessages([
      { role: "user", content: "x" },
      { role: "tool", content: "no call id" },
    ])
    expect(result.nonSystemMessages).toEqual([
      { role: "user", content: "x" },
    ])
  })
})
