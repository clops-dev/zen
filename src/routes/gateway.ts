import { Hono } from "hono"
import { z } from "zod"
import { sql, withDbResilience } from "../lib/db"
import { requireApiKey } from "../middleware/api-key"
import { rateLimit } from "../middleware/rate-limit"
import { classifyComplexity } from "../lib/complexity"
import { pickRoute, reportRouteOutcome, type RouteTarget, ContextWindowExceededError, UnsupportedCapabilityError } from "../lib/routing"
import { callNonStreaming, callStreaming, classifyProviderError } from "../lib/ai-call"
import { UpstreamTimeoutError } from "../lib/ai-call"
import { checkQuota, recordUsage } from "../lib/quota"
import { hashPrompt, getCached, setCached } from "../lib/cache"
import { calcCost } from "../lib/pricing"
import { countInputTokens } from "../lib/tokens"

export const gateway = new Hono()

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullable().optional(),
}).passthrough()

const chatCompletionsSchema = z.object({
  model: z.string().optional(), // accepted for OpenAI-client compatibility, not used for routing — routing is complexity-based
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
})

// How many different models/providers to try, per request, before giving up entirely.
// When multiple OpenRouter API keys or candidates are registered, the gateway
// will attempt each one sequentially upon rate-limits (429) or failures.
const MAX_FALLBACK_ATTEMPTS = 10

function bg(p: Promise<unknown>) {
  p.catch((err) => console.error("[gateway] background task error:", err))
}

/** Compact failure string for the reject_reason column. Tags the error
 * with its classification and loop-control action so observability queries
 * can break down failure types — and so a 400 doesn't look like a 500 in
 * the dashboard. The three prefixes mirror `action`:
 *   `retryable:<kind>:`            — try-next-model failures
 *   `non_retryable_for_candidate:` — this model is dead, another may work
 *   `non_retryable:<kind>:`        — request is bad, the whole loop gave up */
function failureReason(err: unknown): string {
  const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const c = classifyProviderError(err)
  if (c.action === "continue") return `retryable:${c.kind}: ${base}`
  if (c.action === "skip_candidate") return `non_retryable_for_candidate:${c.kind}: ${base}`
  const status = c.statusCode ? `(${c.statusCode}) ` : ""
  return `non_retryable:${c.kind}: ${status}${base}`
}

/** Safe per-message diagnostic. NEVER includes the actual content (could
 * be PII / secrets). The provider only needs to know the SHAPE of the
 * message that broke so we can fix the normalizer. */
function safeMessageDiagnostic(m: any, index: number): string {
  const role = m?.role ?? "unknown"
  const content = m?.content
  let contentType = "missing"
  let contentLength = 0
  let hasToolCalls = false
  let hasToolResults = false
  if (content == null) {
    contentType = "null"
  } else if (typeof content === "string") {
    contentType = "string"
    contentLength = content.length
  } else if (Array.isArray(content)) {
    contentType = "array"
    contentLength = content.length
    hasToolCalls = content.some((p: any) => p?.type === "tool-call")
    hasToolResults = content.some((p: any) => p?.type === "tool-result")
  } else {
    contentType = typeof content
  }
  const toolCallsCount = Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0
  return `msg[${index}] role=${role} contentType=${contentType} contentLength=${contentLength} hasToolCalls=${hasToolCalls || toolCallsCount > 0} toolCallsCount=${toolCallsCount} hasToolResults=${hasToolResults}`
}

/** Returns a short, safe diagnostic string for inclusion in the log line —
 * pure metadata, NEVER the prompts or tool bodies. */
function rejectionExtras(err: unknown): string {
  if (!err || typeof err !== "object") return ""
  const e = err as any
  if (typeof e.message === "string" && /invalid message at index/i.test(e.message)) {
    const m = e.message.match(/invalid message at index\s+(\d+)/i)
    if (m) {
      // Optionally include the message's role if the AI SDK reported it
      // alongside. We don't have the original message here, so just record
      // the index. The full safe per-message diagnostic is logged separately
      // when we shape the message list at request entry.
      return ` invalidMessageIndex=${m[1]}`
    }
    return " invalidMessageIndex=unknown"
  }
  return ""
}

/** Best-effort: walk the request's messages and log safe diagnostics for any
 * that LOOK suspicious (empty content, null, etc.) so we can correlate
 * provider 400s to the normalizer. Called from the streaming branch when
 * startResult.error suggests a bad message. Never logs content. */
function logMessageDiagnostics(messages: any[], reason: string) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const content = m?.content
    const isEmpty =
      content == null ||
      (typeof content === "string" && content.length === 0) ||
      (Array.isArray(content) && content.length === 0)
    const isAssistantNoTools = m?.role === "assistant" && !(Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
    if (isEmpty && isAssistantNoTools) {
      console.warn(`[gateway] suspicious outgoing message ${reason}: ${safeMessageDiagnostic(m, i)}`)
    }
  }
}

/** Map a break_loop classification to the HTTP status the client should
 * see. We mirror the provider's status when it's a sensible client error
 * (400, 422, 410, 451) so the client can interpret it; we synthesize 400
 * for `unsupported` / `other_client_error` (no provider status to mirror)
 * and fall back to 400 for anything else. Never 5xx — that would be
 * misleading for a request that was wrong on the client side. */
function breakLoopStatus(c: ReturnType<typeof classifyProviderError>): number {
  if (!c.statusCode) return 400
  if (c.statusCode >= 400 && c.statusCode < 500) return c.statusCode
  return 400
}

/** Short hint string for the dashboard / client when ALL candidates
 * failed. Different kinds of failure need different user actions, so
 * we don't collapse them into one generic "try again later". */
function hintForClassification(c: ReturnType<typeof classifyProviderError>): string {
  switch (c.kind) {
    case "unauthorized":
      return "One or more providers returned 401. Check the API key in the admin dashboard — it may be missing, revoked, or rejected by the upstream."
    case "forbidden":
      return "One or more providers returned 403. The key may lack access to the requested model."
    case "not_found":
      return "One or more providers returned 404. The requested model id may not exist on that provider."
    case "rate_limited":
      return "All candidates are rate-limited (429). Wait a moment and retry, or add more providers."
    case "quota_exceeded":
    case "provider_busy":
      return "All candidates exhausted their free-tier capacity upstream. Retry later or upgrade the upstream plan."
    case "server_error":
      return "All candidates returned 5xx. The upstream providers may be having an incident."
    case "timeout":
    case "network":
      return "All candidates failed to respond in time. Check network connectivity to the upstream providers."
    case "bad_request":
      return "The upstream rejected the request as malformed (400). Shorten the prompt or remove unsupported parameters."
    case "unsupported":
      return "The request uses a feature the upstream doesn't support (tool calls, vision, etc.)."
    case "no_output":
      return "Models completed cleanly but emitted no content."
    default:
      return "Retry later. Check the gateway logs for the underlying provider error."
  }
}

async function recordRequest(fields: {
  userId: string
  ip: string
  modelLabel: string
  promptHash?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  latencyMs?: number
  status: "success" | "failure" | "rejected"
  rejectReason?: string
  fromCache?: boolean
}) {
  try {
    await withDbResilience(() => sql`
      INSERT INTO ai_requests (
        user_id, ip, model_label, prompt_hash, input_tokens, output_tokens,
        cost_usd, latency_ms, status, reject_reason, from_cache
      ) VALUES (
        ${fields.userId}, ${fields.ip}, ${fields.modelLabel}, ${fields.promptHash ?? null},
        ${fields.inputTokens ?? 0}, ${fields.outputTokens ?? 0}, ${fields.costUsd ?? 0},
        ${fields.latencyMs ?? null}, ${fields.status}, ${fields.rejectReason ?? null}, ${fields.fromCache ?? false}
      )
    `)
  } catch (err) {
    console.error("[gateway] failed to log request:", err)
  }
}

gateway.get("/models", requireApiKey(), async (c) => {
  const rows = await withDbResilience(() => sql`
    SELECT p.name AS provider, m.model_id, m.label, m.context_window
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = true AND p.enabled = true
    ORDER BY p.name, m.model_id
  `)
  return c.json({
    object: "list",
    data: rows.map((r: any) => ({
      id: `${r.provider}/${r.model_id}`,
      object: "model",
      owned_by: r.provider,
      context_window: r.context_window,
    })),
  })
})

gateway.post("/chat/completions", requireApiKey(), rateLimit(30, 60_000), async (c) => {
  const user = c.var.apiUser
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"

  const body = await c.req.json().catch(() => null)
  const parsed = chatCompletionsSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: "invalid payload", details: parsed.error.flatten() }, 400)
  }
  const { messages, stream, max_tokens, temperature, tools, tool_choice } = parsed.data
  const maxOutputTokens = max_tokens ?? 4096

  const quota = await checkQuota(user.id)
  if (!quota.allowed) {
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: quota.reason }))
    const statusCode = quota.reason === "quota_exceeded" ? 402 : quota.reason === "suspended" ? 403 : 401
    const message = quota.reason === "quota_exceeded" ? "Your account ran out of credits." :
                    quota.reason === "suspended" ? "Your account is suspended — contact support." :
                    "Your account is not authorized."
    
    const errorBody = {
      error: quota.reason.toUpperCase(),
      message: message
    }
    
    if (stream) {
      const sseBody = `data: ${JSON.stringify(errorBody)}\n\ndata: [DONE]\n\n`
      return new Response(sseBody, {
        status: statusCode,
        headers: { "content-type": "text/event-stream" },
      })
    }
    return c.json(errorBody, statusCode)
  }

  const complexity = classifyComplexity(messages as any)

  // ---- cache check ----
  const cacheKey = hashPrompt(messages as any, complexity.tier)
  const cached = await getCached(cacheKey).catch((err) => {
    console.error("[gateway] cache read failed:", err)
    return null
  })
  if (cached) {
    bg((async () => {
      const cost = 0 // cached responses are free — no upstream call happened
      await recordUsage(user.id, cached.inputTokens, cached.outputTokens, cost)
      await recordRequest({
        userId: user.id, ip, modelLabel: "cache", promptHash: cacheKey,
        inputTokens: cached.inputTokens, outputTokens: cached.outputTokens, costUsd: cost,
        status: "success", fromCache: true,
      })
    })())

    if (stream) {
      const encoder = new TextEncoder()
      const s = new ReadableStream({
        start(controller) {
          const chunk = { choices: [{ delta: { content: cached.content }, finish_reason: "stop" }] }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(s, { headers: { "content-type": "text/event-stream" } })
    }
    return c.json({
      id: `chatcmpl-cache-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "cache",
      choices: [{ index: 0, message: { role: "assistant", content: cached.content }, finish_reason: "stop" }],
      usage: { prompt_tokens: cached.inputTokens, completion_tokens: cached.outputTokens, from_cache: true },
    })
  }

  const started = Date.now()
  const tried = new Set<string>()
  let lastErr: unknown = null
  let breakLoopErr: unknown = null

  // Pre-compute input tokens once. Used by pickRoute to filter out models
  // whose context window can't fit this request — runs on every pickRoute
  // call (including the catch-all "any model" set) so that a tier with
  // only small-context models doesn't get picked and then hard-fail at
  // the provider. If a model in the chain does fit, we use it; if none
  // fit, ContextWindowExceededError propagates out and we 413 the client.
  // `system` mirrors what normalizeMessages will concatenate, so the count
  // reflects what the provider actually sees.
  const systemParts: string[] = []
  let requiresVision = false
  for (const m of messages as any[]) {
    if (m.role === "system") {
      if (typeof m.content === "string") {
        if (m.content) systemParts.push(m.content)
      } else if (Array.isArray(m.content)) {
        const text = m.content.map((p: any) => p?.type === "text" ? String(p.text ?? "") : "").join("")
        if (text) systemParts.push(text)
      }
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      if (m.content.some((p: any) => p?.type === "image_url")) {
        requiresVision = true
      }
    }
  }
  const requiresTools = Array.isArray(tools) && tools.length > 0
  const requirements = {
    requiredTokens: countInputTokens({
      system: systemParts.length ? systemParts.join("\n\n") : undefined,
      messages: messages as any,
      tools,
    }),
    requiresTools,
    requiresVision
  }

  // ---- non-streaming: try each candidate in full, fall back on any failure ----
  if (!stream) {
    try {
      for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
        const target = await pickRoute(complexity.tier, quota.maxComplexityTier, tried, requirements)
        if (!target) break
        tried.add(target.modelRowId)

        try {
          const result = await callNonStreaming(target, messages as any, maxOutputTokens, temperature, tools, tool_choice)
          const latencyMs = Date.now() - started
          const cost = calcCost({
            inputPricePer1M: target.inputPricePer1M,
            outputPricePer1M: target.outputPricePer1M,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            inputCacheReadPricePer1M: target.inputCacheReadPricePer1M,
            inputCacheWritePricePer1M: target.inputCacheWritePricePer1M,
            requestPriceFlat: target.requestPriceFlat,
            cachedTokens: (result as any).cachedTokens ?? 0,
          })

          bg(reportRouteOutcome(target.providerId, true))
          bg(recordUsage(user.id, result.inputTokens, result.outputTokens, cost))
          bg(recordRequest({
            userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost,
            latencyMs, status: "success",
          }))
          bg(setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens))

          console.log(`[gateway] non-stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} latencyMs=${latencyMs} tokens=${result.inputTokens}+${result.outputTokens} status=success`)
          return c.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: target.label,
            choices: [{
              index: 0,
              message: { role: "assistant", content: result.content, ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}) },
              finish_reason: result.toolCalls?.length ? "tool_calls" : "stop",
            }],
            usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens },
          })
        } catch (err) {
          // Context-window and unsupported-capability errors are not retryable
          // across the rest of the chain (pickRoute already filtered to fitting models).
          // Let it bubble out of the whole loop so we can 4xx the client.
          if (err instanceof ContextWindowExceededError || err instanceof UnsupportedCapabilityError) throw err

          // Classify the upstream error into one of three loop-control
          // actions:
          //   continue        — try the next model in the chain (5xx, 429,
          //                     network, timeout, unknown).
          //   skip_candidate  — this specific (provider, model) is dead
          //                     (401, 403, 404 — bad key, no access,
          //                     unknown model id on that provider) but the
          //                     request itself is fine, so the next model
          //                     can still serve it. We continue the loop
          //                     and only stop if no candidate works.
          //   break_loop      — the request itself is invalid (400, 422,
          //                     unsupported param/tool). Trying any other
          //                     model would fail identically. Bail out
          //                     immediately and return the error to the
          //                     client.
          const classification = classifyProviderError(err)
          const latencyMs = Date.now() - started
          const rejectReason = (err as UpstreamTimeoutError)?.rejectReason
          const extras = rejectionExtras(err)
          console.error(
            `[gateway] non-stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} ` +
            `latencyMs=${latencyMs} status=${classification.action}:${classification.kind}` +
            (classification.statusCode ? ` upstreamHttp=${classification.statusCode}` : "") +
            (rejectReason ? ` timeout=${rejectReason}` : "") +
            extras,
            err,
          )
          lastErr = err
          bg(reportRouteOutcome(target.providerId, false))
          bg(recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: failureReason(err) }))
          if (classification.action === "break_loop") {
            breakLoopErr = err
            break
          }
          // continue or skip_candidate: loop continues — pickRoute will
          // exclude this model_row_id next iteration either way
        }
      }
    } catch (err) {
      if (err instanceof ContextWindowExceededError) {
        bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `context_window_exceeded: required=${err.requiredTokens}, largest=${err.largestAvailable}` }))
        return c.json({
          error: "context_window_exceeded",
          message: err.message,
          required_tokens: err.requiredTokens,
          largest_context_window: err.largestAvailable,
          tier: err.tier,
        }, 413)
      }
      if (err instanceof UnsupportedCapabilityError) {
        const errCode = err.missingCapabilities.includes("tools") ? "NO_TOOL_CAPABLE_MODEL_AVAILABLE" : "unsupported_capability"
        bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `${errCode.toLowerCase()}: ${err.missingCapabilities.join(",")}` }))
        return c.json({
          error: errCode,
          message: err.message,
          missing_capabilities: err.missingCapabilities,
          tier: err.tier,
        }, 400)
      }
      throw err
    }

    // If the loop exited because the last attempt hit a break_loop error
    // (the request itself is invalid), surface it to the client with a
    // clear message and the provider's status code (or a synthesized 400).
    // skip_candidate errors do NOT exit the loop — those loop bodies
    // already `continue` to the next model, and we only land here after
    // all candidates have been tried.
    if (breakLoopErr) {
      const classification = classifyProviderError(breakLoopErr)
      const status = breakLoopStatus(classification)
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `non_retryable: ${failureReason(breakLoopErr)}` }))
      const readableMessage = classification.kind === "content_policy_violation" ? "Your request was rejected for violating safety policies." :
                              classification.kind === "unsupported_parameter" ? "Your request contained an unsupported parameter or feature." :
                              classification.kind === "context_length_exceeded" ? "Your request is too long for this model." :
                              "Your request was rejected by the AI provider. Please check your prompt and attachments.";
      return c.json({
        error: "UPSTREAM_REJECTED_REQUEST",
        message: readableMessage,
        classification: classification.kind,
        upstream_status: classification.statusCode ?? null,
      }, status as 400)
    }

    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "all_fallback_attempts_failed" }))
    // Surface the last error's classification in the response so the
    // client knows whether to retry (rate limit / busy), fix their
    // input (context window / bad request), or fix their config
    // (unauthorized — usually means a provider key is missing or
    // rejected by the upstream). Without this, every failure looks
    // the same in the dashboard.
    const lastClassification = lastErr ? classifyProviderError(lastErr) : null
    const hint = lastClassification
      ? hintForClassification(lastClassification)
      : "No AI providers responded successfully."
    return c.json({
      error: tried.size === 0 ? "NO_PROVIDERS_CONFIGURED" : "ALL_PROVIDERS_FAILED",
      message: tried.size === 0 ? "No AI providers configured — add one in the admin dashboard" : "All AI providers are currently unavailable. Please try again later.",
      hint,
      last_failure: lastClassification
        ? { kind: lastClassification.kind, action: lastClassification.action, statusCode: lastClassification.statusCode ?? null }
        : null,
    }, tried.size === 0 ? 503 : 502)
  }

  // ---- streaming: peek each candidate for real output before committing to the client ----
  try {
    for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
      const target: RouteTarget | null = await pickRoute(complexity.tier, quota.maxComplexityTier, tried, requirements)
      if (!target) break
      tried.add(target.modelRowId)

      const { response, started: streamStarted, done } = callStreaming(
        target, messages as any, maxOutputTokens, temperature, target.label, tools, tool_choice,
      )
      const startResult = await streamStarted

      if (!startResult.ok) {
        const classification = classifyProviderError(startResult.error)
        const latencyMs = Date.now() - started
        const rejectReason = (startResult.error as UpstreamTimeoutError)?.rejectReason
        const extras = rejectionExtras(startResult.error)
        console.error(
          `[gateway] stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} ` +
          `latencyMs=${latencyMs} status=${classification.action}:${classification.kind}` +
          (classification.statusCode ? ` upstreamHttp=${classification.statusCode}` : "") +
          (rejectReason ? ` timeout=${rejectReason}` : "") +
          extras,
          startResult.error,
        )
        // If the provider rejected a message in the conversation, log safe
        // per-message diagnostics so we can correlate the index to the
        // normalizer's output. Never logs content.
        if (classification.action === "break_loop" && classification.kind === "bad_request") {
          logMessageDiagnostics(messages as any[], "incoming_request")
        }
        lastErr = startResult.error
        bg(reportRouteOutcome(target.providerId, false))
        bg(recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: failureReason(startResult.error) }))
        if (classification.action === "break_loop") {
          breakLoopErr = startResult.error
          break
        }
        // continue or skip_candidate: client has seen NOTHING from this
        // attempt, so it's safe to try the next model.
        continue
      }

      // Committed — this target actually produced output, hand its response to the real client.
      console.log(`[gateway] stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} stream=committed firstTokenReceived=true elapsedMs=${Date.now() - started}`)
      bg((async () => {
        try {
          const result = await done
          const latencyMs = Date.now() - started
          const cost = calcCost({
            inputPricePer1M: target.inputPricePer1M,
            outputPricePer1M: target.outputPricePer1M,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            inputCacheReadPricePer1M: target.inputCacheReadPricePer1M,
            inputCacheWritePricePer1M: target.inputCacheWritePricePer1M,
            requestPriceFlat: target.requestPriceFlat,
            cachedTokens: (result as any).cachedTokens ?? 0,
          })
          await reportRouteOutcome(target.providerId, true)
          await recordUsage(user.id, result.inputTokens, result.outputTokens, cost)
          await recordRequest({
            userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost,
            latencyMs, status: "success",
          })
          await setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens)
        } catch (err) {
          // Mid-stream failure AFTER commit — cannot fall back at this point,
          // the client already has partial output from this model. Just log it.
          const classification = classifyProviderError(err)
          const rejectReason = (err as UpstreamTimeoutError)?.rejectReason
          console.error(
            `[gateway] stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} ` +
            `status=${classification.action}:${classification.kind}` +
            (classification.statusCode ? ` upstreamHttp=${classification.statusCode}` : "") +
            (rejectReason ? ` timeout=${rejectReason}` : "") +
            ` stage=mid_stream`,
            err,
          )
          await reportRouteOutcome(target.providerId, false)
          await recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: "mid_stream_failure: " + failureReason(err) })
        }
      })())

      return response
    }
  } catch (err) {
    if (err instanceof ContextWindowExceededError) {
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `context_window_exceeded: required=${err.requiredTokens}, largest=${err.largestAvailable}` }))
      // Streaming clients: emit a single SSE error event then [DONE], so
      // EventSource consumers (Kilo, web UIs) can display a clean message
      // instead of silently closing the stream.
      const body = `data: ${JSON.stringify({
        error: "context_window_exceeded",
        message: err.message,
        required_tokens: err.requiredTokens,
        largest_context_window: err.largestAvailable,
        tier: err.tier,
      })}\n\ndata: [DONE]\n\n`
      return new Response(body, {
        status: 413,
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (err instanceof UnsupportedCapabilityError) {
      const errCode = err.missingCapabilities.includes("tools") ? "NO_TOOL_CAPABLE_MODEL_AVAILABLE" : "unsupported_capability"
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `${errCode.toLowerCase()}: ${err.missingCapabilities.join(",")}` }))
      const body = `data: ${JSON.stringify({
        error: errCode,
        message: err.message,
        missing_capabilities: err.missingCapabilities,
        tier: err.tier,
      })}\n\ndata: [DONE]\n\n`
      return new Response(body, {
        status: 400,
        headers: { "content-type": "text/event-stream" },
      })
    }
    throw err
  }

  // If the loop exited because the last attempt hit a break_loop error,
  // surface it to the client as an SSE error event (mirroring the
  // context-window 413 SSE shape) with a 4xx status.
  if (breakLoopErr) {
    const classification = classifyProviderError(breakLoopErr)
    const status = breakLoopStatus(classification)
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `non_retryable: ${failureReason(breakLoopErr)}` }))
    const readableMessage = classification.kind === "content_policy_violation" ? "Your request was rejected for violating safety policies." :
                            classification.kind === "unsupported_parameter" ? "Your request contained an unsupported parameter or feature." :
                            classification.kind === "context_length_exceeded" ? "Your request is too long for this model." :
                            "Your request was rejected by the AI provider. Please check your prompt and attachments.";
    const sseBody = `data: ${JSON.stringify({
      error: "UPSTREAM_REJECTED_REQUEST",
      message: readableMessage,
      classification: classification.kind,
      upstream_status: classification.statusCode ?? null,
    })}\n\ndata: [DONE]\n\n`
    return new Response(sseBody, {
      status,
      headers: { "content-type": "text/event-stream" },
    })
  }

  bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "all_fallback_attempts_failed" }))
  const errorType = tried.size === 0 ? "NO_PROVIDERS_CONFIGURED" : "ALL_PROVIDERS_FAILED"
  const message = tried.size === 0 ? "No AI providers configured — add one in the admin dashboard" : "All AI providers are currently unavailable. Please try again later."
  const lastClassification = lastErr ? classifyProviderError(lastErr) : null
  const hint = lastClassification ? hintForClassification(lastClassification) : "No AI providers responded successfully."
  const sseBody = `data: ${JSON.stringify({
    error: errorType,
    message: message,
    hint,
    last_failure: lastClassification
      ? { kind: lastClassification.kind, action: lastClassification.action, statusCode: lastClassification.statusCode ?? null }
      : null,
  })}\n\ndata: [DONE]\n\n`
  return new Response(sseBody, {
    status: tried.size === 0 ? 503 : 502,
    headers: { "content-type": "text/event-stream" },
  })
})

gateway.get("/embedding-models", requireApiKey(), async (c) => {
  return c.json({
    // The ID of the default embedding model Kilo should use
    defaultModel: "text-embedding-3-small",
    models: [
      {
        id: "text-embedding-3-small",
        name: "Text Embedding 3 Small",
        // Make sure this matches the actual dimension size of your model
        dimension: 1536, 
        scoreThreshold: 0.5
      }
    ],
    aliases: {}
  })
})

gateway.post("/embeddings", requireApiKey(), rateLimit(30, 60_000), async (c) => {
  const body = await c.req.json().catch(() => null)
  
  if (!body || !body.input) {
    return c.json({ error: "invalid payload" }, 400)
  }
  try {
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const dimensions = body.dimensions || 1536
    
    return c.json({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding",
        // Replace this with actual embeddings from your provider
        embedding: new Array(dimensions).fill(0),
        index,
      })),
      model: body.model || "text-embedding-3-small",
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      }
    })
  } catch (err) {
    console.error("[gateway] embeddings error:", err)
    return c.json({ error: "Failed to generate embeddings" }, 500)
  }
})