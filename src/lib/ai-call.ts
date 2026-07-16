import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText, generateText, tool, jsonSchema, type ModelMessage, type CoreTool } from "ai"
import type { RouteTarget } from "./routing"
import { normalizeMessages } from "./message-normalizer"

export interface CallResult {
  content: string
  toolCalls?: any[]
  inputTokens: number
  outputTokens: number
}

function mapTools(tools?: any[]): Record<string, CoreTool> | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return undefined
  const result: Record<string, CoreTool> = {}
  for (const t of tools) {
    if (t.type === "function" && t.function?.name) {
      result[t.function.name] = tool({
        description: t.function.description,
        parameters: jsonSchema(t.function.parameters ?? { type: "object", properties: {} })
      })
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function mapToolChoice(tc?: any) {
  if (!tc) return undefined
  if (tc === "none" || tc === "auto" || tc === "required") return tc
  if (typeof tc === "object" && tc.type === "function" && tc.function?.name) {
    return { type: "tool" as const, toolName: tc.function.name }
  }
  return undefined
}

function toModel(target: RouteTarget) {
  const provider = createOpenAICompatible({
    name: target.providerName,
    baseURL: target.baseUrl,
    // Some providers (e.g. a local Ollama instance) don't require a key at
    // all — an empty string here means the SDK just won't send an
    // Authorization header if you pass undefined instead of "".
    apiKey: target.apiKey || undefined,
  })
  return provider(target.modelId)
}

/** Non-streaming call. Returns the full text + usage once complete. */
export async function callNonStreaming(
  target: RouteTarget,
  messages: ModelMessage[],
  maxOutputTokens: number,
  temperature?: number,
  tools?: any[],
  toolChoice?: any,
): Promise<CallResult> {
  const { system, nonSystemMessages } = normalizeMessages(messages)

  const result = await generateText({
    model: toModel(target),
    ...(system ? { system } : {}),
    messages: nonSystemMessages,
    maxOutputTokens,
    temperature,
    tools: mapTools(tools),
    toolChoice: mapToolChoice(toolChoice),
  })
  return {
    content: result.text,
    toolCalls: result.toolCalls?.map((t: any) => ({
      id: t.toolCallId,
      type: "function",
      function: { name: t.toolName, arguments: JSON.stringify(t.args || t.input) }
    })),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  }
}

/**
 * Streaming call. Returns an OpenAI-compatible SSE Response directly (the
 * shape the CLI's /v1/chat/completions client already expects), plus a
 * promise that resolves to final usage once the stream completes — the
 * caller awaits that AFTER sending the response to log the ledger entry.
 */
export function callStreaming(
  target: RouteTarget,
  messages: ModelMessage[],
  maxOutputTokens: number,
  temperature: number | undefined,
  modelLabel: string,
  tools?: any[],
  toolChoice?: any,
): { response: Response; done: Promise<CallResult> } {
  const { system, nonSystemMessages } = normalizeMessages(messages)

  const result = streamText({
    model: toModel(target),
    ...(system ? { system } : {}),
    messages: nonSystemMessages,
    maxOutputTokens,
    temperature,
    tools: mapTools(tools),
    toolChoice: mapToolChoice(toolChoice),
  })

  let resolveDone!: (r: CallResult) => void
  let rejectDone!: (err: unknown) => void
  const done = new Promise<CallResult>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })

  const encoder = new TextEncoder()
  let fullContent = ""
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${Date.now()}`

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          if (chunk.type === 'text-delta') {
            fullContent += chunk.textDelta
            const responseChunk = {
              id, object: "chat.completion.chunk", created, model: modelLabel,
              choices: [{ index: 0, delta: { content: chunk.textDelta }, finish_reason: null }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`))
          } else if (chunk.type === 'tool-call') {
            const args = (chunk as any).args || (chunk as any).input;
            const responseChunk = {
              id, object: "chat.completion.chunk", created, model: modelLabel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: chunk.toolCallId,
                    type: "function",
                    function: {
                      name: chunk.toolName,
                      arguments: JSON.stringify(args)
                    }
                  }]
                },
                finish_reason: null
              }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`))
          }
        }

        const usage = await result.usage
        const finalChunk = {
          id, object: "chat.completion.chunk", created, model: modelLabel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? 0,
          },
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()

        resolveDone({
          content: fullContent,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        })
      } catch (err) {
        controller.error(err)
        rejectDone(err)
      }
    },
    cancel() {
      rejectDone(new Error("stream cancelled by client"))
    },
  })

  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    done,
  }
}