import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { streamText, generateText, tool, jsonSchema, type ModelMessage } from "ai"
import type { RouteTarget } from "./routing"
import { normalizeMessages } from "./message-normalizer"
import { env } from "./env"

export interface CallResult {
  content: string
  toolCalls?: any[]
  inputTokens: number
  outputTokens: number
}

export interface StreamStartResult {
  ok: boolean
  error?: unknown
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
  const { system, nonSystemMessages } = normalizeMessages(messages)
  const timeoutMs = env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
  const signal = newTimeoutSignal(timeoutMs)

  try {
    const result = await generateText({
      model: toModel(target),
      ...(system ? { system } : {}),
      messages: nonSystemMessages,
      maxOutputTokens,
      temperature,
      tools: mapTools(tools),
      toolChoice: mapToolChoice(toolChoice),
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
    }
  } catch (err) {
    if (isTimeoutError(err)) throw new UpstreamTimeoutError(timeoutMs, err)
    throw err
  }
}

/**
 * Streaming call. Returns:
 * - `response` — an OpenAI-compatible SSE Response, constructed immediately
 *   (Fetch API requires the stream to exist up front) but the caller MUST
 *   NOT hand this back to the real HTTP client until `started` resolves ok.
 * - `started` — resolves `{ ok: true }` the moment real content (a text
 *   delta or tool call) actually arrives from upstream, or `{ ok: false,
 *   error }` if the call fails or completes with zero output before that.
 *   This is the fallback gate: gateway.ts awaits this per attempt; on
 *   failure it discards this response entirely and tries the next model,
 *   so the client only ever sees output from whichever model actually
 *   worked — never a failed attempt, never two models' output mixed.
 * - `done` — resolves to final usage once the stream completes. Only
 *   meaningful once `started` has already resolved ok.
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
  const { system, nonSystemMessages } = normalizeMessages(messages)
  const idleMs = env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
  const maxMs = env.UPSTREAM_MAX_STREAM_DURATION_MS

  // One AbortController for this entire streaming call. Both the idle timer
  // and the max-duration backstop abort the same controller — whichever fires
  // first wins. abortCause is set by whichever timer fires first so the catch
  // block can identify the reason without reading signal.reason.
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
    ...(system ? { system } : {}),
    messages: nonSystemMessages,
    maxOutputTokens,
    temperature,
    tools: mapTools(tools),
    toolChoice: mapToolChoice(toolChoice),
    maxRetries: 0, // same reasoning as callNonStreaming — fail fast, let the gateway's cross-model fallback take over
    abortSignal: abortController.signal,
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

  const stream = new ReadableStream({
    async start(controller) {
      // -- Idle timer: resets on every content chunk. Fires if the provider
      // goes silent for UPSTREAM_IDLE_TIMEOUT_MS_STREAMING ms. Armed
      // immediately so TTFB stalls are also caught; reset on every content
      // chunk so a slow-but-healthy stream is never killed just for running
      // long — only for going silent.
      //
      let abortCause: UpstreamTimeoutError | undefined
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let rejectRace!: (err: unknown) => void
      const racePromise = new Promise<never>((_, rej) => { rejectRace = rej })

      const armIdleTimer = () => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          abortCause = new UpstreamTimeoutError(idleMs, undefined, "timeout:idle")
          rejectRace(abortCause)
        }, idleMs)
      }

      const maxTimer = setTimeout(() => {
        abortCause = new UpstreamTimeoutError(maxMs, undefined, "timeout:max_duration")
        rejectRace(abortCause)
      }, maxMs)

      armIdleTimer()

      const iterator = result.fullStream[Symbol.asyncIterator]()
      try {
        while (true) {
          const { value: chunk, done: isDone } = await Promise.race([
            iterator.next(),
            racePromise
          ])
          if (isDone) break
          
          armIdleTimer()

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
          //   2. abortCause (our idle/max-duration timeout fired)
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

        const usage = await result.usage
        const finalChunk = {
          id, object: "chat.completion.chunk", created, model: modelLabel,
          choices: [{ index: 0, delta: {}, finish_reason: gotToolCalls ? "tool_calls" : "stop" }],
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
        if (idleTimer !== null) clearTimeout(idleTimer)
        clearTimeout(maxTimer)
        iterator.return?.()
      }
    },
    cancel() {
      // Abort the upstream request immediately so the provider stops
      // streaming AND we don't keep its slot occupied (and burn tokens)
      // for a client that has already disconnected. Without this, the
      // underlying fetch would only be torn down when idleTimer or
      // maxTimer eventually fires (up to 5 minutes later). The local
      // settleStarted/rejectDone calls settle the consumer-facing
      // promises; abortController propagates the cancel to the SDK's
      // in-flight request via the signal we passed to streamText.
      try { abortController.abort() } catch { /* already aborted */ }
      settleStarted({ ok: false, error: new Error("stream cancelled by client") })
      rejectDone(new Error("stream cancelled by client"))
    },
  })

  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    started,
    done,
  }
}