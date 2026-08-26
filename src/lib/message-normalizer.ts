import type { ModelMessage } from "ai"

/** Extract a non-empty string from any content shape (string | array |
 * null | undefined). Returns "" only if there's no text at all. */
function extractText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object") {
          if (part.type === "text" && typeof part.text === "string") return part.text
          // Reasoning-style content: also extract the text payload.
          if (part.type === "reasoning" && typeof part.text === "string") return part.text
        }
        return ""
      })
      .join("")
  }
  if (content && typeof content === "object" && (content as any).type === "text") {
    return typeof (content as any).text === "string" ? (content as any).text : ""
  }
  return ""
}

/** Normalize incoming messages into the shape the AI SDK / OpenAI-compatible
 * providers will accept.
 *
 * The KEY invariant this function enforces: NO outgoing message may be an
 * empty assistant turn. OpenAI-compatible providers (Cohere in particular)
 * reject a request where any message is `{ role: "assistant", content: "" }`
 * — they require either non-empty content OR at least one tool call.
 *
 * OpenRouter/Cohere was returning 400 on "invalid message at index 55"
 * because at some point in the long conversation history the assistant
 * emitted an empty content string (or null) without any tool_calls. The
 * gateway was faithfully relaying that as `{role:"assistant", content:""}`
 * to the next model. This function now DROPS such empty assistant messages
 * from the outgoing list rather than passing them through.
 *
 * Other invariants:
 *  - User messages with no text content after dropping non-text parts are
 *    dropped as well (OpenAI rejects empty user messages too).
 *  - Tool-result messages must reference a tool_call_id present in the
 *    outgoing assistant message(s); if not, the orphan is dropped. The
 *    "OpenAI tool message must be followed by assistant tool_calls" rule.
 *  - Unknown roles (data, function, anything else the AI SDK doesn't
 *    consume) are passed through only if the AI SDK accepts them. */
export function normalizeMessages(messages: any[]): { system?: string, nonSystemMessages: ModelMessage[] } {
  const systemMessages = messages.filter((m) => m.role === "system")
  const systemText = systemMessages.map((m) => extractText(m.content)).filter(Boolean).join("\n\n")

  const rawNonSystem = messages.filter((m) => m.role !== "system")

  // First pass: shape-convert each role into the AI SDK's ModelMessage form.
  const shaped: (ModelMessage | null)[] = rawNonSystem.map((m): ModelMessage | null => {
    if (m.role === "user") {
      let newContent = m.content
      if (Array.isArray(newContent)) {
        const hasOnlyText = newContent.every(
          (part: any) => part && (part.type === "text" || part.type === "reasoning" || typeof part === "string"),
        )
        if (hasOnlyText) {
          newContent = newContent
            .map((part: any) => typeof part === "string" ? part : (part.text ?? ""))
            .join("")
        } else {
          newContent = newContent.map((part: any) => {
            if (typeof part === "string") return { type: "text", text: part }
            return part
          })
        }
      }
      if (newContent == null) newContent = ""
      return { role: "user", content: newContent } as ModelMessage
    }

    if (m.role === "assistant") {
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const content: any[] = []
        const text = extractText(m.content)
        if (text) content.push({ type: "text", text })
        for (const tc of m.tool_calls) {
          if (tc && tc.type === "function" && tc.function?.name) {
            let args = tc.function.arguments
            if (typeof args === "string") {
              try { args = JSON.parse(args) } catch { args = {} }
            } else if (args == null) {
              args = {}
            }
            content.push({
              type: "tool-call",
              toolCallId: tc.id ?? `tc_${Math.random().toString(36).slice(2)}`,
              toolName: tc.function.name,
              input: args,
            })
          }
        }
        // Tool-call-only assistant message (no text) is valid — OpenAI
        // accepts it. We must always return the message in that case.
        if (content.length === 0) return null
        return { role: "assistant", content } as ModelMessage
      }

      // No tool_calls. Build a plain assistant message with text content.
      const text = extractText(m.content)
      // CRITICAL: drop assistant messages with no text AND no tool calls.
      // Passing `{role:"assistant", content:""}` to Cohere/OpenRouter
      // produces 400 "must have non-empty content or tool calls". This
      // is the fix for the index-55 bug.
      if (!text) return null
      return { role: "assistant", content: text } as ModelMessage
    }

    if (m.role === "tool") {
      const toOutput = (value: any) =>
        typeof value === "string"
          ? { type: "text" as const, value }
          : { type: "json" as const, value }

      if (Array.isArray(m.content) && m.content.some((p: any) => p?.type === "tool-result")) {
        const content = m.content
          .map((p: any) => {
            if (!p || p.type !== "tool-result") return null
            if (p.output) return p
            if (!p.toolCallId) return null
            return {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName || "unknown",
              output: toOutput(p.result),
            }
          })
          .filter((p: any) => p !== null)
        if (content.length === 0) return null
        return { role: "tool", content } as ModelMessage
      }

      if (!m.tool_call_id) return null
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id,
          toolName: m.name || "unknown",
          output: toOutput(m.content),
        }],
      } as ModelMessage
    }

    if (m.role === "data") {
      return m as ModelMessage
    }

    return null
  })

  // Second pass: drop nulls, then validate tool/assistant pairing so we
  // never send an orphan tool-result (OpenAI rejects it). Track the set
  // of tool_call_ids the model has SEEN as assistant tool-calls; any
  // tool-result whose id isn't in that set is dropped here, not silently
  // passed through to the provider.
  const seenToolCallIds = new Set<string>()
  for (const m of shaped) {
    if (!m) continue
    if ((m as any).role !== "assistant") continue
    const content = (m as any).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === "tool-call" && typeof part.toolCallId === "string") {
        seenToolCallIds.add(part.toolCallId)
      }
    }
  }

  const nonSystemMessages: ModelMessage[] = []
  for (const m of shaped) {
    if (!m) continue
    if ((m as any).role === "tool") {
      const content = (m as any).content
      if (Array.isArray(content)) {
        const filtered = content.filter((p: any) =>
          p && p.type === "tool-result" && typeof p.toolCallId === "string" && seenToolCallIds.has(p.toolCallId),
        )
        if (filtered.length === 0) continue
        ;(m as any).content = filtered
      }
    }
    if ((m as any).role === "user") {
      // Drop user messages whose content is empty string after shaping —
      // the provider will 400 on these too.
      const c = (m as any).content
      if (c === "" || c == null) continue
      if (Array.isArray(c) && c.length === 0) continue
    }
    nonSystemMessages.push(m)
  }

  return { system: systemText || undefined, nonSystemMessages }
}