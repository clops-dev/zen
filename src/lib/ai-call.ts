import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { streamText, generateText, tool, jsonSchema, type ModelMessage } from "ai"
import type { RouteTarget } from "./routing"
import { normalizeMessages } from "./message-normalizer"
import { env } from "./env"
import { SSE_HEADERS } from "./sse-headers"

export interface CallResult {
  content: string
  toolCalls?: any[]
  inputTokens: number
  outputTokens: number
  finishReason?: string
}

export interface StreamStartResult {
  ok: boolean
  error?: unknown
}

const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" as const }

/** Map AI SDK finish reasons to OpenAI wire-format finish_reason values. */
function toOpenAIFinishReason(sdkFinishReason: string | undefined, hasToolCalls: boolean): string {
  if (sdkFinishReason === "length") return "length"
  if (hasToolCalls || sdkFinishReason === "tool-calls") return "tool_calls"
  return "stop"
}

/** Add Anthropic prompt-caching breakpoints so repeated turns with a growing
 * prefix aren't billed at full price for unchanged content. Only applied for
 * anthropic-compatible providers — others ignore providerOptions silently. */
function applyPromptCaching(
  target: RouteTarget,
  system: string | undefined,
  messages: ModelMessage[],
): { system: string | { role: "system"; content: string; providerOptions: { anthropic: { cacheControl: typeof ANTHROPIC_CACHE_CONTROL } } } | undefined; messages: ModelMessage[] } {
  if (target.providerType !== "anthropic-compatible") {
    return { system, messages }
  }

  const cacheOpts = { anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } }
  const cachedSystem = system
    ? { role: "system" as const, content: system, providerOptions: cacheOpts }
    : undefined

  if (messages.length === 0) {
    return { system: cachedSystem, messages }
  }

  // Breakpoint on the penultimate message (stable prefix before the latest turn).
  const breakpointIdx = messages.length >= 2 ? messages.length - 2 : messages.length - 1
  const cachedMessages = messages.map((m, i) => {
    if (i !== breakpointIdx) return m
    const existing = (m as { providerOptions?: Record<string, unknown> }).providerOptions ?? {}
    return {
      ...m,
      providerOptions: {
        ...existing,
        anthropic: {
          ...((existing.anthropic as Record<string, unknown> | undefined) ?? {}),
          cacheControl: ANTHROPIC_CACHE_CONTROL,
        },
      },
    } as ModelMessage
  })

  return { system: cachedSystem, messages: cachedMessages }
}

function mapTools(tools?: any[]): Record<string, any> | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return undefined
  const result: Record<string, any> = {}
  for (const t of tools) {
    if (t.type === "function" && t.function?.name) {
      result[t.function.name] = tool({
        description: t.function.description,
        inputSchema: jsonSchema(t.function.parameters ?? { type: "object", properties: {} })
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

/** Public helper: figure out what to actually send to the upstream given
 * a candidate's capabilities. If the model can't handle tools, drop them
 * (and `tool_choice`) entirely — providers that don't support tools will
 * reject the request with a 400 otherwise. If the model is vision-capable
 * we leave the user message alone; if not, image_url parts are stripped so
 * the provider doesn't 400 on an unknown content type. Exported for
 * unit testing without spinning up the full call. */
export function adaptRequestForCapabilities(
  messages: ModelMessage[],
  tools: any[] | undefined,
  toolChoice: any,
  supportsTools: boolean,
  supportsVision: boolean,
): { messages: ModelMessage[]; tools?: any[]; toolChoice?: any } {
  if (supportsTools) {
    return { messages, tools, toolChoice }
  }
  // Drop tools + tool_choice — provider would 400 on either.
  if (!supportsVision) {
    // Also strip image_url parts from user messages so the provider
    // doesn't 400 on an unknown content type either.
    const stripped: ModelMessage[] = messages.map((m: any) => {
      if (m.role !== "user" || !Array.isArray(m.content)) return m
      const filtered = m.content.filter((p: any) =>
        p && typeof p === "object" && p.type !== "image_url" && p.type !== "image",
      )
      if (filtered.length === 0) {
        // The whole message was an image with no caption. Replace with
        // a placeholder so the provider still gets a user turn.
        return { ...m, content: "" }
      }
      if (filtered.length === m.content.length) return m
      // If everything is plain text, flatten to a string for safety.
      if (filtered.every((p: any) => p?.type === "text" || typeof p === "string")) {
        return { ...m, content: filtered.map((p: any) => typeof p === "string" ? p : p.text).join("") }
      }
      return { ...m, content: filtered }
    })
    return { messages: stripped, tools: undefined, toolChoice: undefined }
  }
  return { messages, tools: undefined, toolChoice: undefined }
}

/**
 * Normalize tool call arguments into a properly JSON-serialized string
 * for the OpenAI wire format.
 *
 * Some reasoning models (e.g. tencent/hy3) occasionally double-encode
 * their tool arguments — they emit a JSON string whose value is itself a
 * JSON string (e.g. `{"todos":"[{\"content\":\"...\"}]"}`). In that case
 * the AI SDK hands us an object where some values are strings that
 * parse as arrays/objects. We detect this per-value and unwrap one level
 * so the downstream client gets the correct native structure.
 *
 * The function always returns a JSON-stringified string as required by
 * the OpenAI tool-calls spec.
 */
function normalizeToolArgs(args: unknown): string {
  if (typeof args === "string") {
    // Already a string — the SDK passed through a raw unparsed value.
    // Return as-is (it's already a valid JSON string for the wire format).
    return args
  }
  if (args !== null && typeof args === "object") {
    // Walk the top-level values and unwrap any that are themselves
    // JSON-serialized strings representing arrays or objects.
    const unwrapped: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(args as Record<string, unknown>)) {
      if (typeof val === "string") {
        try {
          const parsed = JSON.parse(val)
          if (typeof parsed === "object" && parsed !== null) {
            // Double-encoded — unwrap one level.
            unwrapped[key] = parsed
            continue
          }
        } catch {
          // Not JSON — keep the string as-is.
        }
      }
      unwrapped[key] = val
    }
    return JSON.stringify(unwrapped)
  }
  return JSON.stringify(args ?? {})
}

function toModel(target: RouteTarget) {
  if (target.providerType === "anthropic-compatible") {
    // Anthropic-compatible adapter. The Anthropic SDK appends /messages to
    // whatever baseURL it's given — it does NOT auto-append /v1 (that only
    // happens when baseURL is exactly https://api.anthropic.com). So for
    // AgentRouter the baseURL is the literal "https://agentrouter.org" and
    // the final URL becomes "https://agentrouter.org/messages" by
    // construction.
    //
    // `authToken` is sent as `Authorization: Bearer <token>`, matching the
    // task's auth spec. The SDK also auto-sets `anthropic-version:
    // 2023-06-01` for us.
    //
    // `apiKey` (x-api-key header) is intentionally NOT used here — the
    // task spec requires Bearer auth for AgentRouter.
    return buildAnthropicModel(target)
  }

  return buildOpenAICompatibleModel(target)
}

/** Anthropic adapter path. Exported for direct unit testing — verifies
 * baseURL, auth, and adapter selection without round-tripping through
 * streamText/generateText.
 *
 * Upstream quirk: AgentRouter's Anthropic-compatible endpoint is mounted
 * at `/v1/messages`, NOT the SDK's default `/messages`. (The official
 * Anthropic API lives at `/v1/messages`, so AgentRouter is preserving
 * that path; the SDK only uses bare `/messages` when baseURL is the
 * canonical `https://api.anthropic.com`.) The task spec mandates
 * `baseURL = "https://agentrouter.org"` with NO `/v1` appended by us,
 * but the SDK would otherwise hit `/messages` and get back the
 * upstream's HTML SPA (verified live — 200 OK with `text/html` body).
 * We honor BOTH the spec (baseURL is the bare URL) AND reality (final
 * URL is `/v1/messages`) by wrapping the SDK's `fetch` to rewrite the
 * path. The DB row's `base_url` stays `https://agentrouter.org` (no
 * `/v1`), the migration CHECK constraint is satisfied, AND the actual
 * request reaches the Anthropic-compatible endpoint at
 * `/v1/messages`.
 *
 * Scoped to AgentRouter ONLY — this rewriter is a workaround for one
 * specific vendor's routing quirk, not a property of the Anthropic-
 * compatible category. Other Anthropic-compatible providers (e.g. a
 * mirror at the canonical `/messages` path, or `api.anthropic.com`
 * itself under different config) MUST NOT have their paths mutated.
 * If you ever add a second vendor that needs a similar quirk, give it
 * its own providerName check (or move this into a per-row quirks
 * field) rather than widening this condition. */
export function buildAnthropicModel(target: RouteTarget) {
  const fetchImpl =
    target.providerName === "agentrouter"
      ? (makeAgentrouterFetchRewriter(target.baseUrl) as unknown as typeof fetch)
      : undefined
  const provider = createAnthropic({
    name: target.providerName,
    baseURL: target.baseUrl,
    authToken: target.apiKey || undefined,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return provider(target.modelId)
}

/** Build a fetch wrapper that rewrites the SDK's default
 * `<baseURL>/messages` request URL to `<baseURL>/v1/messages` for
 * AgentRouter's upstream. Pure function — no I/O, no state — so the
 * caller can pass it directly to `createAnthropic({ fetch })`. */
function makeAgentrouterFetchRewriter(baseUrl: string) {
  // Compute the absolute URLs the SDK would call. We replace any
  // `<baseUrl>/messages` (with or without trailing slash variants)
  // with `<baseUrl>/v1/messages`. Other paths are passed through
  // unchanged so the wrapper doesn't accidentally rewrite unrelated
  // endpoints if the SDK adds new ones.
  const bareMessages = `${baseUrl.replace(/\/+$/, "")}/messages`
  const versionedMessages = `${baseUrl.replace(/\/+$/, "")}/v1/messages`
  return async (input: any, init?: any): Promise<Response> => {
    // The SDK passes a string URL or a Request object. Normalize to
    // string for the rewrite check, then pass through the original
    // shape so headers, body, method, signal are preserved.
    const url: string =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input?.url ?? "")
    let rewritten = url
    if (url === bareMessages) {
      rewritten = versionedMessages
    } else if (url.endsWith("/messages") && url.startsWith(baseUrl.replace(/\/+$/, "") + "/")) {
      rewritten = versionedMessages
    }
    if (rewritten !== url) {
      if (typeof input === "string") {
        return globalThis.fetch(rewritten, init)
      }
      // Rebuild a Request with the rewritten URL; copy method/body/etc.
      // from the original so non-URL properties are preserved.
      const newInit: RequestInit = { ...(init ?? {}) }
      if (input instanceof Request) {
        newInit.method = input.method
        newInit.headers = input.headers
        if (input.body !== null) newInit.body = input.body
        newInit.signal = input.signal
        newInit.credentials = input.credentials
        newInit.mode = input.mode
      }
      return globalThis.fetch(rewritten, newInit)
    }
    return globalThis.fetch(input, init)
  }
}

/**
 * Create a custom fetch wrapper that intercepts and normalizes tool-call deltas
 * in responses from OpenAI-compatible providers before they reach the AI SDK.
 *
 * Upstream models (such as `zebda/minimax/minimax-m2.7:free`) can send sparse,
 * out-of-order, or malformed tool-call deltas (e.g. sending `index: 1` when index 0
 * was never sent, omitting `index`, omitting `id`, or sending empty/non-object `tool_calls`).
 *
 * When passed to the AI SDK's `StreamingToolCallTracker`, sparse indices create
 * `undefined` entries in the tracker's internal `this.toolCalls` array. Upon stream
 * completion, the SDK's `flush()` handler iterates over `this.toolCalls` and evaluates
 * `toolCall.hasFinished`. If an entry is `undefined`, it throws an uncaught
 * `TypeError: undefined is not an object (evaluating 'toolCall.hasFinished')` that crashes
 * the entire Bun process.
 *
 * This fetch wrapper normalizes tool-call deltas in SSE lines and JSON bodies:
 * 1. Filtering out null/undefined/non-object tool calls.
 * 2. Mapping raw indices to contiguous zero-based integers (0, 1, 2...).
 * 3. Guaranteeing valid `id`, `type="function"`, and valid `function` `{ name, arguments }` objects.
 */
function makeToolCallNormalizingFetch(customFetch: (input: any, init?: any) => Promise<Response> = globalThis.fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await customFetch(input, init)
    if (!res.ok || !res.body) return res

    const contentType = res.headers.get("content-type") ?? ""

    if (contentType.includes("text/event-stream")) {
      return normalizeSseToolCallResponse(res)
    }

    if (contentType.includes("application/json")) {
      return normalizeJsonToolCallResponse(res)
    }

    return res
  }
}

function normalizeSseToolCallResponse(res: Response): Response {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  // Per-stream normalization state
  const indexMap = new Map<number | string, number>()
  let nextContiguousIndex = 0
  const toolCallStates = new Map<number, { id?: string }>()

  let buffer = ""

  function normalizeToolCalls(toolCalls: any[]): any[] {
    if (!Array.isArray(toolCalls)) return []
    const normalized: any[] = []

    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue

      // Determine raw index
      let rawIndex: number | string | undefined = undefined
      if (typeof tc.index === "number" && Number.isInteger(tc.index) && tc.index >= 0) {
        rawIndex = tc.index
      } else if (typeof tc.index === "string" && !isNaN(Number(tc.index)) && Number(tc.index) >= 0) {
        rawIndex = Math.floor(Number(tc.index))
      }

      // Assign contiguous mapped index
      let mappedIndex: number
      if (rawIndex !== undefined) {
        if (indexMap.has(rawIndex)) {
          mappedIndex = indexMap.get(rawIndex)!
        } else {
          mappedIndex = nextContiguousIndex++
          indexMap.set(rawIndex, mappedIndex)
        }
      } else {
        // Missing index in delta chunk
        let existingIndex: number | undefined
        if (tc.id) {
          for (const [idx, s] of toolCallStates.entries()) {
            if (s.id === tc.id) { existingIndex = idx; break }
          }
        }
        if (existingIndex !== undefined) {
          mappedIndex = existingIndex
        } else {
          mappedIndex = nextContiguousIndex++
        }
      }

      // State & ID tracking
      const state = toolCallStates.get(mappedIndex) ?? {}
      let id = tc.id ?? state.id
      if (!id) {
        id = `call_gen_${Date.now()}_${mappedIndex}`
      }
      toolCallStates.set(mappedIndex, { ...state, id })

      // Function object normalization
      let fn = tc.function
      if (!fn || typeof fn !== "object") {
        fn = { name: "", arguments: "" }
      } else {
        fn = {
          name: typeof fn.name === "string" ? fn.name : (fn.name != null ? String(fn.name) : ""),
          arguments: typeof fn.arguments === "string" ? fn.arguments : (fn.arguments != null ? normalizeToolArgs(fn.arguments) : ""),
        }
      }

      normalized.push({
        ...tc,
        index: mappedIndex,
        id,
        type: typeof tc.type === "string" ? tc.type : "function",
        function: fn,
      })
    }

    return normalized
  }

  function transformLine(line: string): string {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return line

    const payload = trimmed.slice(5).trim()
    if (payload === "[DONE]" || !payload.startsWith("{")) return line

    try {
      const parsed = JSON.parse(payload)
      if (parsed && Array.isArray(parsed.choices)) {
        let modified = false
        for (const choice of parsed.choices) {
          if (choice?.delta?.tool_calls) {
            choice.delta.tool_calls = normalizeToolCalls(choice.delta.tool_calls)
            modified = true
          }
        }
        if (modified) {
          return `data: ${JSON.stringify(parsed)}`
        }
      }
    } catch {
      // Non-JSON data payload; return line as-is
    }

    return line
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          if (buffer.trim()) {
            const transformed = transformLine(buffer)
            controller.enqueue(encoder.encode(transformed + "\n"))
            buffer = ""
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const transformed = transformLine(line)
          controller.enqueue(encoder.encode(transformed + "\n"))
        }
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

async function normalizeJsonToolCallResponse(res: Response): Promise<Response> {
  try {
    const text = await res.text()
    if (!text.trim().startsWith("{")) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    const parsed = JSON.parse(text)
    if (parsed && Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (choice?.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
          choice.message.tool_calls = choice.message.tool_calls.filter(
            (tc: any) => tc && typeof tc === "object"
          ).map((tc: any, idx: number) => ({
            ...tc,
            index: typeof tc.index === "number" ? tc.index : idx,
            id: tc.id ?? `call_gen_${Date.now()}_${idx}`,
            type: tc.type ?? "function",
            function: {
              name: typeof tc.function?.name === "string" ? tc.function.name : "",
              arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : normalizeToolArgs(tc.function?.arguments),
            },
          }))
        }
      }
      return new Response(JSON.stringify(parsed), { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch {
    return res
  }
}

/** OpenAI-compatible adapter path. Exported for direct unit testing. */
export function buildOpenAICompatibleModel(target: RouteTarget) {
  let baseUrl = target.baseUrl
  if (baseUrl.endsWith("/chat/completions/")) {
    baseUrl = baseUrl.slice(0, -"/chat/completions/".length)
  } else if (baseUrl.endsWith("/chat/completions")) {
    baseUrl = baseUrl.slice(0, -"/chat/completions".length)
  }

  const provider = createOpenAICompatible({
    name: target.providerName,
    baseURL: baseUrl,
    // Some providers (e.g. a local Ollama instance) don't require a key at
    // all — an empty string here means the SDK just won't send an
    // Authorization header if you pass undefined instead of "".
    apiKey: target.apiKey || undefined,
    // OpenRouter requires HTTP-Referer and recommends X-Title on every
    // request. They (a) let users see which app is calling their account
    // and (b) avoid being deprioritized on free models. We hardcode
    // X-Title to "zen-gateway" (our app name) and let APP_URL configure
    // the Referer per-deploy. Schema-enforced at boot in env.ts.
    headers: {
      "HTTP-Referer": env.APP_URL,
      "X-Title": "zen-gateway",
    },
    fetch: makeToolCallNormalizingFetch(),
  })
  return provider(target.modelId)
}

/** Marker tag set on the error we re-throw when our timeout fires. Lets the
 * gateway (and any future observability code) distinguish a genuine upstream
 * hang from a 4xx/5xx/network failure without string-sniffing.
 *
 * `rejectReason` distinguishes the two streaming abort causes:
 * - `"timeout:idle"` — provider went silent; the idle timer fired.
 * - `"timeout:max_duration"` — absolute backstop exceeded (runaway stream).
 * - `undefined` — non-streaming fixed deadline (no per-chunk timer involved). */
export class UpstreamTimeoutError extends Error {
  readonly timeoutMs: number
  readonly rejectReason?: string
  constructor(timeoutMs: number, cause?: unknown, rejectReason?: string) {
    const label = rejectReason ? ` (${rejectReason})` : ""
    super(`upstream timeout after ${timeoutMs}ms${label}`)
    this.name = "UpstreamTimeoutError"
    this.timeoutMs = timeoutMs
    this.rejectReason = rejectReason
    if (cause) this.cause = cause
  }
}

/** Stream completed successfully (no error, no abort) but produced zero
 * content, zero tool calls, and zero reasoning deltas. The model returned
 * an empty stream. Distinct from a timeout, network failure, or 4xx — and
 * importantly distinct from "unknown" — so the gateway ledger can tell
 * "model gave us nothing" apart from "we don't know what went wrong".
 *
 * Triggers `action: "continue"` in the fallback loop: the failure may be
 * model-specific (a buggy candidate, a provider that returned an empty
 * completion), so another candidate can still serve the request. */
export class NoOutputError extends Error {
  constructor() {
    super("upstream produced no output")
    this.name = "NoOutputError"
  }
}

function newTimeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout is in Node 17.3+ and Bun; safe here.
  return AbortSignal.timeout(ms)
}

/** True if `err` looks like it was caused by our abort signal firing (i.e.
 * a timeout, not a 4xx/5xx/network error). Matches both the AI SDK's
 * `TimeoutError` (AbortSignal.timeout) and the generic `AbortError` (in
 * case the signal aborts before the SDK can wrap it). */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: string }).name
  return name === "TimeoutError" || name === "AbortError" || name === "UpstreamTimeoutError"
}

/** Classification of an upstream provider error for the gateway's
 * cross-model fallback loop. Three loop-control outcomes:
 *
 * - `"continue"`  — try the next model in the chain. The failure is
 *   transient or a property of the provider (5xx, 429, network, timeout)
 *   and the same request may succeed against a different candidate.
 * - `"skip_candidate"` — this specific model is dead for the moment (bad
 *   API key, account has no access, model id doesn't exist on this
 *   provider) but the request itself is fine, so another candidate can
 *   still serve it. The gateway still falls through to the next model;
 *   the distinction is observability-only (the ledger shows
 *   `non_retryable_for_candidate` instead of `retryable:unauthorized`).
 *   Triggered by 401, 403, 404.
 * - `"break_loop"` — the request itself is invalid (malformed schema,
 *   unsupported parameter, semantically unprocessable). Trying any other
 *   model would fail identically. The gateway returns immediately to the
 *   client with a 4xx. Triggered by 400, 422, and "unsupported parameter"
 *   message patterns.
 *
 * The classification also carries the recovered `statusCode` when one
 * could be identified (either from the AI SDK's `APICallError` or by
 * scraping the error message as a last resort) so the gateway can mirror
 * the provider's status to the client on the break_loop path. */
export type ProviderErrorClassification = {
  action: "continue" | "skip_candidate" | "break_loop"
  kind:
    | "network" | "timeout" | "rate_limited" | "server_error" | "unknown" | "no_output"
    | "bad_request" | "invalid_request" | "unsupported" | "other_client_error"
    | "unauthorized" | "forbidden" | "not_found"
    // OpenRouter-specific normalized kinds. All carry action="continue"
    // (retry against a different model) but are queryable in the ledger
    // as distinct buckets instead of being lumped into generic
    // "rate_limited"/"server_error"/"unknown".
    | "quota_exceeded" | "provider_busy"
  statusCode?: number
}

/** OpenRouter passes upstream-provider error messages through with HTTP
 * statuses (429/503) that look like rate-limits or generic server errors.
 * The message body identifies the actual cause so the fallback loop can
 * log a normalized reject_reason — and so the admin /requests page
 * distinguishes "OpenRouter couldn't find a free provider for this model
 * right now" from "we hit our own per-user rate-limit" (rate-limit.ts).
 *
 * Returns a more specific kind than the status code alone would suggest,
 * or null if the message doesn't match any of these shapes (caller keeps
 * the status-code-based kind). */
function classifyOpenRouterMessage(msgLower: string, statusCode: number | undefined): ProviderErrorClassification["kind"] | null {
  // 1. Per-model provider capacity on OpenRouter's side (their own free
  //    workers are saturated). Treated as continue → next model. Status
  //    is 429 with a specific message.
  if (
    msgLower.includes("worker local total request limit reached") ||
    msgLower.includes("rate limit") && msgLower.includes("provider")
  ) return "provider_busy"

  // 2. Quota / billing errors from the underlying model provider passed
  //    through OpenRouter. The user's OpenRouter key may be fine, but
  //    the upstream provider (e.g. the actual Nvidia-hosted model) is
  //    out of credit. Continuing to the next OpenRouter model still
  //    helps if that model uses a different upstream.
  if (
    msgLower.includes("quota exceeded") ||
    msgLower.includes("you exceeded your current quota") ||
    msgLower.includes("insufficient credits") ||
    msgLower.includes("billing") && msgLower.includes("exceeded") ||
    msgLower.includes("payment required")
  ) return "quota_exceeded"

  // 3. OpenRouter's "all providers for model X are busy" — distinct
  //    from our own rate-limit.ts. Status is 503 with code
  //    "get_channel_failed".
  if (
    msgLower.includes("get_channel_failed") ||
    (statusCode === 503 && (
      msgLower.includes("all providers") && msgLower.includes("busy") ||
      msgLower.includes("no available providers") ||
      msgLower.includes("provider is busy")
    ))
  ) return "provider_busy"

  return null
}

/** Heuristic mapping for an error string when the underlying object has no
 * `statusCode` field. Matches the lower-case substring on the error
 * `message`. Used as a last-resort fallback so the classification still
 * produces something useful when the AI SDK's error type doesn't match
 * `APICallError` (e.g. a raw `fetch` failure, a pre-validation error from
 * a provider, etc.). */
function statusCodeFromMessage(msg: string): number | undefined {
  const m = msg.match(/\b(4\d{2}|5\d{2})\b/)
  return m ? Number(m[1]) : undefined
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: string }).name
  if (name === "TypeError") {
    // Bun/Node's fetch failure is a TypeError with "fetch failed" / "fetch timed out"
    // (the latter when AbortSignal.timeout fires before the SDK wraps it).
    const msg = String((err as { message?: string }).message ?? "").toLowerCase()
    if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("econnrefused") ||
        msg.includes("enotfound") || msg.includes("etimedout") || msg.includes("econnreset")) return true
  }
  // ECONNREFUSED, ENOTFOUND, etc. from undici surface as `cause.code` strings
  const code = (err as { code?: string; cause?: { code?: string } }).code
    ?? (err as { cause?: { code?: string } }).cause?.code
  if (typeof code === "string") {
    const c = code.toUpperCase()
    if (c === "ECONNREFUSED" || c === "ENOTFOUND" || c === "ETIMEDOUT" || c === "ECONNRESET" ||
        c === "EAI_AGAIN" || c === "EPIPE" || c === "UND_ERR_SOCKET") return true
  }
  return false
}

function messageOf(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}

/** Classify an upstream provider error for the cross-model fallback loop.
 * See `ProviderErrorClassification` for the three-way action contract
 * (`continue` / `skip_candidate` / `break_loop`).
 *
 * Pure & standalone so it can be unit-tested in isolation and reused by
 * future retry/backoff code. Order of checks matters: network errors are
 * detected before any status-code scrape, so a `ECONNREFUSED 127.0.0.1:443`
 * isn't mis-read as HTTP 443. */
export function classifyProviderError(err: unknown): ProviderErrorClassification {
  if (!err) return { action: "continue", kind: "unknown" }

  // Our own timeout tag wins over anything the SDK might say.
  if (err instanceof UpstreamTimeoutError) {
    return { action: "continue", kind: "timeout" }
  }
  if (isTimeoutError(err)) {
    return { action: "continue", kind: "timeout" }
  }

  // Our own no-output tag — stream completed cleanly but emitted nothing.
  // Continue the loop: another candidate may serve the request. Distinct
  // kind (not "unknown") so the ledger can tell this apart from real
  // unidentifiable errors.
  if (err instanceof NoOutputError) {
    return { action: "continue", kind: "no_output" }
  }

  // AI SDK v5 wraps upstream HTTP errors as APICallError with statusCode.
  // We use the dynamic import path to avoid pulling @ai-sdk/provider into
  // the typegraph; the runtime check is structural and works regardless.
  const isAPICallError =
    typeof (err as { constructor?: { name?: string } }).constructor?.name === "string" &&
    (err as { constructor: { name: string } }).constructor.name === "APICallError"
  // Some build setups strip class names — fall back to duck-typing on statusCode + isRetryable.
  const statusFromAPICall =
    isAPICallError && typeof (err as { statusCode?: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : undefined

  const statusCode = statusFromAPICall ?? statusCodeFromMessage(messageOf(err))
  const msgLower = messageOf(err).toLowerCase()

  // Network errors can contain port numbers (e.g. "ECONNREFUSED 127.0.0.1:443")
  // that look like HTTP status codes. Detect them FIRST so we don't mis-read
  // "443" as a status and route a genuine network failure down the 4xx path.
  if (isNetworkError(err)) {
    return { action: "continue", kind: "network" }
  }

  if (statusCode !== undefined) {
    // OpenRouter-specific shapes: a 429/503 with a recognizable message
    // is one of `quota_exceeded` or `provider_busy` rather than the
    // generic `rate_limited`/`server_error`. We keep action=continue
    // (these ARE retryable against a different model) but emit a
    // normalized kind so the ledger is queryable per cause.
    if (statusCode === 429 || statusCode === 503) {
      const orKind = classifyOpenRouterMessage(msgLower, statusCode)
      if (orKind) return { action: "continue", kind: orKind, statusCode }
    }
    if (statusCode === 429) return { action: "continue", kind: "rate_limited", statusCode }
    if (statusCode >= 500 && statusCode < 600) return { action: "continue", kind: "server_error", statusCode }
    if (statusCode === 400) return { action: "break_loop", kind: "bad_request", statusCode }
    if (statusCode === 422) return { action: "break_loop", kind: "invalid_request", statusCode }
    if (statusCode === 408) return { action: "continue", kind: "timeout", statusCode } // request timeout from the provider
    // 401/403/404: this candidate is dead, but the request may still be
    // servable by another model — keep falling through the chain.
    if (statusCode === 401) return { action: "skip_candidate", kind: "unauthorized", statusCode }
    if (statusCode === 403) return { action: "skip_candidate", kind: "forbidden", statusCode }
    if (statusCode === 404) return { action: "skip_candidate", kind: "not_found", statusCode }
    // Any other 4xx (410, 451, 418, etc.) signals the request is wrong
    // and another model won't help.
    if (statusCode >= 400 && statusCode < 500) return { action: "break_loop", kind: "other_client_error", statusCode }
  }

  // Detect "unsupported parameter for this model" without a 4xx — some
  // providers (or older SDK wrappers) surface this as a 200-with-error
  // payload. The request itself is invalid, so this is break_loop.
  if (
    msgLower.includes("unsupported") ||
    msgLower.includes("not supported") ||
    msgLower.includes("unknown parameter") ||
    msgLower.includes("invalid parameter") ||
    msgLower.includes("unknown tool") ||
    msgLower.includes("tool not supported")
  ) {
    return { action: "break_loop", kind: "unsupported" }
  }

  // Truly unknown — treat as continue so we still try other models, but
  // mark as "unknown" so the ledger/log can flag it. Better to over-fall-
  // back once than to bail on a transient we couldn't identify.
  return { action: "continue", kind: "unknown" }
}

/** Non-streaming call. Returns the full text + usage once complete.
 * Throws on any failure — the caller (gateway.ts) catches this per-attempt
 * in its own fallback loop, since nothing has been sent to the client yet
 * at this point, no special "peek before commit" gate is needed here. */
export async function callNonStreaming(
  target: RouteTarget,
  messages: ModelMessage[],
  maxOutputTokens: number,
  temperature?: number,
  tools?: any[],
  toolChoice?: any,
): Promise<CallResult> {
  const adapted = adaptRequestForCapabilities(
    messages, tools, toolChoice,
    target.supportsTools, target.supportsVision,
  )
  const { system, nonSystemMessages } = normalizeMessages(adapted.messages as any)
  const cached = applyPromptCaching(target, system, nonSystemMessages)
  const timeoutMs = env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
  const signal = newTimeoutSignal(timeoutMs)

  try {
    const result = await generateText({
      model: toModel(target),
      ...(cached.system ? { system: cached.system } : {}),
      messages: cached.messages,
      maxOutputTokens,
      temperature,
      tools: mapTools(adapted.tools),
      toolChoice: mapToolChoice(adapted.toolChoice),
      maxRetries: 0, // the gateway's own fallback loop retries across DIFFERENT models — no benefit to ai-sdk also retrying the same rate-limited one with backoff
      abortSignal: signal,
    })
    return {
      content: result.text,
      toolCalls: result.toolCalls?.map((t: any) => ({
        id: t.toolCallId,
        type: "function",
        function: { name: t.toolName, arguments: normalizeToolArgs(t.args ?? t.input) }
      })),
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      finishReason: toOpenAIFinishReason(result.finishReason, !!(result.toolCalls?.length)),
    }
  } catch (err) {
    if (isTimeoutError(err)) throw new UpstreamTimeoutError(timeoutMs, err, "timeout:non_streaming")
    throw err
  }
}

/**
 * Streaming call. Returns:
 * - `response` — an OpenAI-compatible SSE Response, constructed immediately
 *   (Fetch API requires the stream to exist up front) but the caller MUST
 *   NOT hand this back to the real HTTP client until `started` resolves ok.
 * - `started` — resolves `{ ok: true }` the moment real content (a text
 *   delta, reasoning delta, or tool call) actually arrives from upstream,
 *   or `{ ok: false, error }` if the call fails or completes with zero
 *   output before that. This is the fallback gate: gateway.ts awaits this
 *   per attempt; on failure it discards this response entirely and tries
 *   the next model, so the client only ever sees output from whichever
 *   model actually worked — never a failed attempt, never two models'
 *   output mixed.
 * - `done` — resolves to final usage once the stream completes. Only
 *   meaningful once `started` has already resolved ok.
 *
 * Timeout architecture (FOUR independent timers):
 *   1. connect     — TCP+TLS handshake budget before first byte. Fires only
 *                    before any output has arrived. Default 10s.
 *   2. firstToken  — Time from request start to first valid output chunk.
 *                    Fires only before the first chunk. Default 120s.
 *   3. idle        — Gap between any two valid chunks; resets on every
 *                    chunk. Default 120s.
 *   4. total       — Never resets. Hard backstop. Default 600s.
 * The first two are arm-then-disarm semantics: the moment any valid
 * chunk arrives, both are cleared and never re-armed. The idle timer
 * replaces them. The total timer is armed once and never disarmed.
 *
 * All four timers funnel into the same AbortController via a shared
 * `racePromise`, so the streaming loop can race the iterator against
 * whichever timer fires first. The exact reason is preserved on the
 * UpstreamTimeoutError's `rejectReason` so the gateway's classifier
 * can break down failures in the ledger.
 */
export function callStreaming(
  target: RouteTarget,
  messages: ModelMessage[],
  maxOutputTokens: number,
  temperature: number | undefined,
  modelLabel: string,
  tools?: any[],
  toolChoice?: any,
): { response: Response; started: Promise<StreamStartResult>; done: Promise<CallResult> } {
  const adapted = adaptRequestForCapabilities(
    messages, tools, toolChoice,
    target.supportsTools, target.supportsVision,
  )
  const { system, nonSystemMessages } = normalizeMessages(adapted.messages as any)
  const cached = applyPromptCaching(target, system, nonSystemMessages)
  const connectMs = env.UPSTREAM_CONNECT_TIMEOUT_MS
  const firstTokenMs = env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS
  const idleMs = env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
  const maxMs = env.UPSTREAM_MAX_STREAM_DURATION_MS

  // One AbortController for this entire streaming call. Every timer below
  // funnels into the same controller via the shared racePromise. The
  // controller also gets called by the ReadableStream's `cancel` (client
  // disconnect), so all exit paths share one cleanup path.
  //
  // The no-op "abort" listener is intentional: Bun emits an unhandled global
  // AbortError to stderr when abort() fires on a signal that has NO "abort"
  // listeners — even if the error is fully handled inside a for-await catch
  // block. This listener tells Bun the abort is expected and suppresses the
  // global noise without changing any semantics.
  const abortController = new AbortController()
  abortController.signal.addEventListener("abort", () => {})

  const result = streamText({
    model: toModel(target),
    ...(cached.system ? { system: cached.system } : {}),
    messages: cached.messages,
    maxOutputTokens,
    temperature,
    tools: mapTools(adapted.tools),
    toolChoice: mapToolChoice(adapted.toolChoice),
    maxRetries: 0, // same reasoning as callNonStreaming — fail fast, let the gateway's cross-model fallback take over
    abortSignal: abortController.signal,
    onError({ error }) {
      if (!sdkRejection) sdkRejection = error
    },
  })

  // @ai-sdk/streamText attaches several promises to the result object that
  // may reject if the upstream returns an error status with a content-type
  // that LOOKS like an SSE stream (e.g. Cloudflare edge errors — a 429 or 503
  // with `content-type: text/event-stream` and an `{"error":...}` body). The
  // stream iterator then completes with `done: true` and no chunks, which
  // would otherwise look like a clean empty stream to us. We need to capture
  // the SDK's actual rejection so the classifier can see the real status
  // code (rate_limited, server_error, etc.) instead of tagging every such
  // failure as no_output. We also swallow the rejection globally to prevent
  // Bun's unhandled-rejection noise — the captured one is the source of truth.
  let sdkRejection: unknown = undefined
  if ((result as any).response) {
    Promise.resolve((result as any).response).then(
      (res: any) => {
        if (!sdkRejection && res && typeof res === "object") {
          const status = typeof res.statusCode === "number" ? res.statusCode : (typeof res.status === "number" ? res.status : undefined)
          if (status !== undefined && status >= 400) {
            sdkRejection = { statusCode: status, message: res.responseBody ?? res.statusText ?? `HTTP ${status}` }
          }
        }
      },
      (err: unknown) => {
        if (!sdkRejection) sdkRejection = err
      },
    ).catch(() => {})
  }

  const sdkPromises = [
    "response", "finishReason", "rawFinishReason", "text", "reasoningText",
    "usage", "totalUsage", "content", "steps", "warnings", "providerMetadata"
  ]
  for (const key of sdkPromises) {
    try {
      const val = (result as any)[key]
      if (val && typeof val.then === "function") {
        val.then(
          (res: any) => {
            if (!sdkRejection && res && typeof res === "object") {
              const status = typeof res.statusCode === "number" ? res.statusCode : (typeof res.status === "number" ? res.status : undefined)
              if (status !== undefined && status >= 400) {
                sdkRejection = { statusCode: status, message: res.responseBody ?? res.statusText ?? `HTTP ${status}` }
              }
            }
          },
          (err: unknown) => {
            if (!sdkRejection) sdkRejection = err
          },
        )
      }
    } catch {
      // Ignore getter throws
    }
  }


  let resolveDone!: (r: CallResult) => void
  let rejectDone!: (err: unknown) => void
  const done = new Promise<CallResult>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => {}) // avoids Bun's unhandled-rejection noise when a stream is cancelled/never committed

  let resolveStarted!: (r: StreamStartResult) => void
  const started = new Promise<StreamStartResult>((res) => {
    resolveStarted = res
  })
  let startedSettled = false
  const settleStarted = (r: StreamStartResult) => {
    if (startedSettled) return
    startedSettled = true
    resolveStarted(r)
  }

  const encoder = new TextEncoder()
  let fullContent = ""
  let gotAnyContent = false
  let gotToolCalls = false  // track if any tool-call chunks were sent
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${Date.now()}`
  const requestStartedAt = Date.now()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

const stream = new ReadableStream({
    async start(controller) {
      let abortCause: UpstreamTimeoutError | undefined
      let rejectRace!: (err: unknown) => void
      const racePromise = new Promise<never>((_, rej) => { rejectRace = rej })

      // Each timer is held in a variable so the finally block can clear it
      // deterministically. Using `let` and null-init makes the cleanup
      // idempotent even if start() throws before arming.
      let connectTimer: ReturnType<typeof setTimeout> | null = null
      let firstTokenTimer: ReturnType<typeof setTimeout> | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const maxTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        abortCause = new UpstreamTimeoutError(maxMs, undefined, "timeout:max_duration")
        rejectRace(abortCause)
      }, maxMs)

      // Arm the pre-first-byte timers. Both are cleared on the first valid
      // chunk and never re-armed.
      connectTimer = setTimeout(() => {
        abortCause = new UpstreamTimeoutError(connectMs, undefined, "timeout:connect")
        rejectRace(abortCause)
      }, connectMs)
      firstTokenTimer = setTimeout(() => {
        abortCause = new UpstreamTimeoutError(firstTokenMs, undefined, "timeout:first_token")
        rejectRace(abortCause)
      }, firstTokenMs)

      const armIdleTimer = () => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          abortCause = new UpstreamTimeoutError(idleMs, undefined, "timeout:idle")
          rejectRace(abortCause)
        }, idleMs)
      }

      const clearPreFirstByteTimers = () => {
        if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null }
        if (firstTokenTimer !== null) { clearTimeout(firstTokenTimer); firstTokenTimer = null }
      }

      const clearAllTimers = () => {
        clearPreFirstByteTimers()
        if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
        clearTimeout(maxTimer)
        stopHeartbeat()
      }

      // SSE comment heartbeats keep Azure Container Apps ingress alive
      // (~30s idle timeout) any time the wire goes quiet — not just before
      // the first chunk. Reasoning models can go silent for 20-40s BETWEEN
      // reasoning-delta chunks or between reasoning and the real answer;
      // if we stop heartbeating after the first chunk (old behavior), that
      // silent gap has zero bytes on the wire and Azure's ingress kills the
      // connection with no error the app-level idle timer ever sees. So:
      // this timer runs for the entire stream and only actually emits a
      // heartbeat if nothing real has been sent recently.
      let lastEnqueueAt = Date.now()
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastEnqueueAt < 15_000) return
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"))
          lastEnqueueAt = Date.now()
        } catch {
          stopHeartbeat()
        }
      }, 15_000)

      const iterator = result.fullStream[Symbol.asyncIterator]()
      try {
        while (true) {
          const { value: chunk, done: isDone } = await Promise.race([
            iterator.next(),
            racePromise
          ])
          if (isDone) break

          // First valid chunk? Switch timer regime: clear the pre-first-byte
          // timers, arm the idle timer. The first-token timer firing after
          // we already got a chunk is the most common false positive of the
          // old 30s single-timer design — fix that here.
          const isContentChunk =
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'tool-call' ||
            chunk.type === 'tool-result'
          if (isContentChunk) {
            // First content chunk: kill the pre-first-byte budgets
            // (connect + firstToken). Arm (or reset) the idle timer.
            clearPreFirstByteTimers()
            if (idleTimer === null) armIdleTimer()
            else armIdleTimer() // reset
          } else {
            // Non-content chunks (start, start-step, finish-step,
            // metadata, abort-ack, etc.) — DON'T clear the pre-first-byte
            // timers here. The SDK synthesizes a `start` chunk BEFORE the
            // upstream fetch has completed: clearing the connect timer
            // would mask a hung upstream as if we'd already heard from
            // the provider. The firstToken timer is the authoritative
            // pre-first-byte budget and it stays armed. We do arm the
            // idle timer on this first contact so a stream that goes
            // silent after metadata but before content still aborts
            // within idleTimeoutMs instead of hanging forever.
            if (idleTimer === null) armIdleTimer()
            else armIdleTimer() // reset
          }

          if (chunk.type === 'text-delta') {
            if (!gotAnyContent) {
              gotAnyContent = true
              settleStarted({ ok: true })
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", created, model: modelLabel,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              })}\n\n`))
            }
            fullContent += chunk.text
            const responseChunk = {
              id, object: "chat.completion.chunk", created, model: modelLabel,
              choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`))
            lastEnqueueAt = Date.now()
          } else if (chunk.type === 'reasoning-delta') {
            if (!gotAnyContent) {
              gotAnyContent = true
              settleStarted({ ok: true })
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", created, model: modelLabel,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              })}\n\n`))
            }
            const responseChunk = {
              id, object: "chat.completion.chunk", created, model: modelLabel,
              choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`))
            lastEnqueueAt = Date.now()
          } else if (chunk.type === 'tool-call') {
            if (!gotAnyContent) {
              gotAnyContent = true
              settleStarted({ ok: true })
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", created, model: modelLabel,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              })}\n\n`))
            }
            gotToolCalls = true
            const rawArgs = (chunk as any).args ?? (chunk as any).input
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
                      arguments: normalizeToolArgs(rawArgs)
                    }
                  }]
                },
                finish_reason: null
              }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`))
            lastEnqueueAt = Date.now()
          } else if (chunk.type === 'error') {
            sdkRejection = (chunk as any).error
            break
          }
        }

        if (!gotAnyContent) {
          // Pick the most informative error in priority order:
          //   1. SDK rejection (carries APICallError with statusCode —
          //      the upstream's real status from a JSON error body
          //      disguised as an SSE stream)
          //   2. abortCause (one of our four timers fired)
          //   3. NoOutputError (stream completed cleanly, produced nothing)
          // Without #1, every Cloudflare-edge 429/503 would be mis-tagged
          // as no_output in the ledger and the classifier would never see
          // the real status.
          const err = sdkRejection ?? abortCause ?? new NoOutputError()
          settleStarted({ ok: false, error: err })
          controller.error(err)
          rejectDone(err)
          return
        }

        let usage: any = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        let sdkFinishReason: string | undefined = undefined
        try {
          usage = (await result.usage) ?? usage
        } catch (e) {
          if (!sdkRejection) sdkRejection = e
        }
        try {
          sdkFinishReason = await result.finishReason
        } catch (e) {
          if (!sdkRejection) sdkRejection = e
        }
        const finishReason = toOpenAIFinishReason(sdkFinishReason, gotToolCalls)
        const finalChunk = {
          id, object: "chat.completion.chunk", created, model: modelLabel,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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
      } catch (err: unknown) {
        iterator.return?.()
        // Same priority as the !gotAnyContent branch: SDK rejection
        // (e.g. APICallError with statusCode) > our own timeout > original
        // thrown error.
        const finalErr = sdkRejection ?? abortCause ?? err
        if (!startedSettled) settleStarted({ ok: false, error: finalErr as Error })
        controller.error(finalErr)
        rejectDone(finalErr)
      } finally {
        clearAllTimers()
        iterator.return?.()
      }
    },
    cancel() {
      stopHeartbeat()
      // Abort the upstream request immediately so the provider stops
      // streaming AND we don't keep its slot occupied (and burn tokens)
      // for a client that has already disconnected. Without this, the
      // underlying fetch would only be torn down when the maxTimer
      // eventually fires (up to 10 minutes later by default). The local
      // settleStarted/rejectDone calls settle the consumer-facing
      // promises; abortController propagates the cancel to the SDK's
      // in-flight request via the signal we passed to streamText.
      try { abortController.abort() } catch { /* already aborted */ }
      settleStarted({ ok: false, error: new Error("stream cancelled by client") })
      rejectDone(new Error("stream cancelled by client"))
    },
  })

  // Surface the request start time via a tag on the response so gateway.ts
  // can compute accurate per-attempt elapsed time without an extra clock
  // read. Useful for the per-attempt log line in gateway.ts.
  ;(stream as any)._zenStartedAt = requestStartedAt

  return {
    response: new Response(stream, { headers: SSE_HEADERS }),
    started,
    done,
  }
}