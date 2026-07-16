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
          args: { location: "Tokyo" }
        }
      ]
    })
  })

  test("tool results (3)", () => {
    const messages = [
      {
        role: "tool",
        tool_call_id: "call_123",
        name: "get_weather",
        content: "Sunny"
      }
    ]
    const result = normalizeMessages(messages)
    expect(result.nonSystemMessages[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "get_weather",
          result: "Sunny"
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
})
