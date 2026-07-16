import type { ModelMessage } from "ai"

export function normalizeMessages(messages: any[]): { system?: string, nonSystemMessages: ModelMessage[] } {
  const systemMessages = messages.filter((m) => m.role === "system")
  const systemText = systemMessages.map((m) => {
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((part: any) => (part.type === "text" ? part.text : ""))
        .join("")
    }
    return ""
  }).filter(Boolean).join("\n\n")

  const nonSystemMessages: ModelMessage[] = messages
    .filter((m) => m.role !== "system")
    .map((m): ModelMessage | null => {
      if (m.role === "user") {
        let newContent = m.content
        if (Array.isArray(newContent)) {
          const hasOnlyText = newContent.every(part => part.type === "text" || typeof part === "string")
          if (hasOnlyText) {
            newContent = newContent.map(part => typeof part === "string" ? part : part.text).join("")
          } else {
            newContent = newContent.map(part => {
              if (typeof part === "string") return { type: 'text', text: part }
              return part
            })
          }
        }
        return { role: "user", content: newContent } as ModelMessage
      }

      if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length > 0) {
          const content: any[] = []
          if (typeof m.content === "string" && m.content) {
            content.push({ type: "text", text: m.content })
          } else if (Array.isArray(m.content)) {
            m.content.forEach((part: any) => {
              if (part.type === "text") content.push({ type: "text", text: part.text })
              else if (typeof part === "string") content.push({ type: "text", text: part })
            })
          }

          for (const tc of m.tool_calls) {
            if (tc.type === "function") {
              let args = tc.function.arguments
              if (typeof args === "string") {
                try { args = JSON.parse(args) } catch { args = {} }
              }
              content.push({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.function.name,
                input: args
              })
            }
          }
          return { role: "assistant", content } as ModelMessage
        } else {
          let newContent = m.content || ""
          if (Array.isArray(newContent)) {
            newContent = newContent
              .filter(part => part.type === "text" || typeof part === "string")
              .map(part => typeof part === "string" ? part : part.text)
              .join("")
          }
          return { role: "assistant", content: newContent } as ModelMessage
        }
      }

      if (m.role === "tool") {
        // Wraps a raw tool result value in the AI SDK v7 `output` shape.
        // v7 removed the old `result: <any>` field in favor of a typed
        // `output` object — { type: "text", value: string } for plain
        // text/JSON-stringified output, or { type: "json", value } if the
        // result is already structured data we want to keep as JSON.
        const toOutput = (value: any) =>
          typeof value === "string"
            ? { type: "text" as const, value }
            : { type: "json" as const, value }

        if (Array.isArray(m.content) && m.content.some((p: any) => p.type === 'tool-result')) {
          const content = m.content.map((p: any) => {
            if (p.type !== 'tool-result') return p
            if (p.output) return p // already in the correct v7 shape
            return {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName || "unknown",
              output: toOutput(p.result),
            }
          })
          return { role: "tool", content } as ModelMessage
        }

        const content: any[] = []
        if (m.tool_call_id) {
          content.push({
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: m.name || "unknown",
            output: toOutput(m.content)
          })
        }

        if (content.length > 0) {
          return { role: "tool", content } as ModelMessage
        }
        return null
      }

      if (m.role === "data") {
        return m as ModelMessage
      }

      return null
    })
    .filter((m): m is ModelMessage => m !== null)

  return { system: systemText || undefined, nonSystemMessages }
}