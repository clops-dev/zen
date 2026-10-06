import { Hono } from "hono"
import { z } from "zod"
import { sql, withDbResilience } from "../lib/db"
import { requireApiKey } from "../middleware/api-key"
import { rateLimit } from "../middleware/rate-limit"
import { classifyComplexity, isAgentRequest } from "../lib/complexity"
import { env } from "../lib/env"
import {
  pickRoute,
  reportRouteOutcome,
  type RouteTarget,
  ContextWindowExceededError,
  UnsupportedCapabilityError,
  ExplicitModelCapabilityError,
} from "../lib/routing"
import { deriveConversationKey, getAffinityStore } from "../lib/affinity"
import { callNonStreaming, callStreaming, classifyProviderError, type StreamStartResult } from "../lib/ai-call"
import { UpstreamTimeoutError } from "../lib/ai-call"
import { checkQuota, recordUsage } from "../lib/quota"
import { deductCredits, usdToDt, InsufficientCreditsError } from "../lib/credits"
import { hashPrompt, getCached, isResponseCacheEligible, setCached } from "../lib/cache"
import { calcCost } from "../lib/pricing"
import { DEFAULT_GATEWAY_RATE_LIMIT_RPM, GATEWAY_RATE_LIMIT_WINDOW_MS } from "../lib/rate-limit-config"
import { countInputTokens } from "../lib/tokens"
import { resolveBilledInputTokens } from "../lib/billing-tokens"
import { SSE_HEADERS } from "../lib/sse-headers"
import { log } from "../lib/logger"
import { recordRequestMetrics, recordStageMs } from "../lib/metrics"
import { getActiveUser } from "../lib/active-user"

export const gateway = new Hono()

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullable().optional(),
}).passthrough()

const chatCompletionsSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
})

// P3.10: Configurable fallback attempts per request before failing (default: 4)
const MAX_FALLBACK_ATTEMPTS = env.MAX_FALLBACK_ATTEMPTS

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
  requestId?: string
}): Promise<string | null> {
  try {
    const [row] = await withDbResilience(() => sql<{ id: string }[]>`
      INSERT INTO ai_requests (
        user_id, ip, model_label, prompt_hash, input_tokens, output_tokens,
        cost_usd, latency_ms, status, reject_reason, from_cache, request_id
      ) VALUES (
        ${fields.userId}, ${fields.ip}, ${fields.modelLabel}, ${fields.promptHash ?? null},
        ${fields.inputTokens ?? 0}, ${fields.outputTokens ?? 0}, ${fields.costUsd ?? 0},
        ${fields.latencyMs ?? null}, ${fields.status}, ${fields.rejectReason ?? null}, ${fields.fromCache ?? false},
        ${fields.requestId ?? null}
      )
      RETURNING id
    `)
    return row?.id ?? null
  } catch (err) {
    console.error("[gateway] failed to log request:", err)
    return null
  }
}

function logStructuredRequest(fields: {
  requestId: string
  userId: string
  tier: string
  routeDecision?: string
  routeReason?: string
  model: string
  attemptCount: number
  ttftMs?: number | null
  totalLatencyMs: number
  overheadMs?: number
  tokens: { input: number; output: number; cached: number }
  costUsd: number
  cancelled: boolean
  failoverChain: Array<{ kind: string; model?: string }>
  status: "success" | "failure" | "rejected"
  errorReason?: string
  stream: boolean
}) {
  log.info("gateway request completed", {
    request_id: fields.requestId,
    user_id: fields.userId,
    tier: fields.tier,
    route_decision: fields.routeDecision ?? fields.model,
    route_reason: fields.routeReason ?? "tier_pick",
    model: fields.model,
    attempt_count: fields.attemptCount,
    ttft_ms: fields.ttftMs ?? null,
    total_latency_ms: fields.totalLatencyMs,
    gateway_overhead_ms: fields.overheadMs ?? 0,
    input_tokens: fields.tokens.input,
    output_tokens: fields.tokens.output,
    cached_tokens: fields.tokens.cached,
    cost_usd: fields.costUsd,
    cancelled: fields.cancelled,
    failover_chain: fields.failoverChain,
    status: fields.status,
    error_reason: fields.errorReason ?? undefined,
  })

  recordRequestMetrics({
    status: fields.status,
    tier: fields.tier,
    stream: fields.stream,
    cancelled: fields.cancelled,
    ttftMs: fields.ttftMs ?? null,
    overheadMs: fields.overheadMs ?? 0,
    totalMs: fields.totalLatencyMs,
    inputTokens: fields.tokens.input,
    outputTokens: fields.tokens.output,
    cachedTokens: fields.tokens.cached,
    costUsd: fields.costUsd,
    failoverChain: fields.failoverChain,
  })
}

gateway.get("/models", requireApiKey(), async (c) => {
  const [rows, aliasRows] = await Promise.all([
    withDbResilience(() => sql`
      SELECT p.name AS provider, m.model_id, m.label, m.context_window
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = true AND p.enabled = true
      ORDER BY p.name, m.model_id
    `).catch(() => []),
    withDbResilience(() => sql`
      SELECT alias, target_tier, target_model_id, description
      FROM model_aliases
      ORDER BY alias
    `).catch(() => []),
  ])

  const fallbackAliases = [
    { alias: "zen/auto", description: "Dynamic tier routing based on prompt intent" },
    { alias: "zen/fast", description: "Fast, lightweight tier for quick completions" },
    { alias: "zen/smart", description: "High-capability tier for complex reasoning and tools" },
    { alias: "zen/reasoning", description: "Reasoning and deep architecture tasks" },
  ]
  const aliasesToUse = aliasRows && aliasRows.length > 0 ? aliasRows : fallbackAliases
  const aliasEntries = aliasesToUse.map((a: any) => ({
    id: a.alias,
    object: "model",
    owned_by: "zen",
    description: a.description,
  }))

  return c.json({
    object: "list",
    data: [
      ...aliasEntries,
      ...rows.map((r: any) => ({
        id: `${r.provider}/${r.model_id}`,
        object: "model",
        owned_by: r.provider,
        context_window: r.context_window,
      })),
    ],
  })
})

gateway.post("/chat/completions", requireApiKey(), rateLimit(DEFAULT_GATEWAY_RATE_LIMIT_RPM, GATEWAY_RATE_LIMIT_WINDOW_MS), async (c) => {
  const user = c.var.apiUser
  const activeUser = await getActiveUser(user.id)
  if (!activeUser) {
    return c.json({
      error: {
        message: "Account is suspended or inactive",
        type: "permission_error",
        code: "account_suspended",
      }
    }, 403)
  }
  const reqId = c.get("requestId") ?? c.req.header("x-request-id") ?? `req-${Date.now()}`
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"

  const body = await c.req.json().catch(() => null)
  const parsed = chatCompletionsSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({
      error: {
        message: "invalid payload",
        type: "invalid_request_error",
        code: "invalid_payload",
        details: parsed.error.flatten(),
      }
    }, 400)
  }
  const { messages, stream, max_tokens, temperature, tools, tool_choice } = parsed.data
  const maxOutputTokens = max_tokens ?? 16384

  // ---------------------------------------------------------------------------
  // Credit check — user access depends strictly on available credit balance
  // ---------------------------------------------------------------------------

  const quota = await checkQuota(user.id, 0.0001)

  if (!quota.allowed) {
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: quota.reason, requestId: reqId }))
    const statusCode = 402
    const remainingVal = quota.remainingUsd ?? 0
    const message = `Insufficient credits. Your current balance is $${remainingVal.toFixed(2)}. Please purchase additional credits to continue.`

    const errorBody = {
      error: {
        message,
        type: "insufficient_credits",
        code: "insufficient_credits",
      }
    }

    if (stream) {
      const sseBody = `data: ${JSON.stringify(errorBody)}\n\ndata: [DONE]\n\n`
      return new Response(sseBody, {
        status: statusCode,
        headers: SSE_HEADERS,
      })
    }
    return c.json(errorBody, statusCode as any)
  }


  const isAgent = isAgentRequest(messages as any, tools)
  const complexity = isAgent
    ? { tier: env.AGENT_TIER, score: 99, reasons: ["agent_traffic_bypass"] }
    : classifyComplexity(messages as any)

  // ---- cache check ----
  // Cache entries must never cross account, model, or generation-parameter
  // boundaries. Cache only explicit, deterministic non-agent requests.
  const cacheEligible = isResponseCacheEligible({
    model: parsed.data.model,
    temperature,
    isAgent,
  })
  const cacheKey = hashPrompt(messages as any, {
    userId: user.id,
    model: parsed.data.model ?? "zen/auto",
    maxOutputTokens,
    temperature: temperature ?? -1,
  })
  const cached = !cacheEligible ? null : await getCached(cacheKey).catch((err) => {
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
      return new Response(s, { headers: SSE_HEADERS })
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
  const reqStart = performance.now()
  const tried = new Set<string>()
  const failoverChain: Array<{ kind: string; model?: string }> = []
  let lastErr: unknown = null
  let breakLoopErr: unknown = null

  const affinityStore = getAffinityStore()
  const sessionId = c.req.header("x-session-id") ?? c.req.header("x-zen-conversation-id") ?? c.req.header("x-cursor-session-id") ?? null
  const firstUserMsg = (messages as any[]).find((m: any) => m.role === "user")?.content
  const firstUserText = typeof firstUserMsg === "string" ? firstUserMsg : (Array.isArray(firstUserMsg) ? JSON.stringify(firstUserMsg) : null)
  const systemMsg = (messages as any[]).find((m: any) => m.role === "system")?.content
  const systemText = typeof systemMsg === "string" ? systemMsg : (Array.isArray(systemMsg) ? JSON.stringify(systemMsg) : null)

  const convKey = deriveConversationKey({
    sessionId,
    apiKeyId: user.id,
    systemPrompt: systemText,
    firstUserMessage: firstUserText,
  })
  const activeAffinity = convKey ? await affinityStore.get(convKey) : null
  const initialPinnedRowId = activeAffinity?.modelRowId
  const requestDeadlineMs = env.REQUEST_DEADLINE_MS

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
        const elapsed = Date.now() - started
        const remainingMs = requestDeadlineMs - elapsed
        if (remainingMs <= 0) {
          failoverChain.push({ kind: "deadline_exceeded" })
          break
        }

        const target = await pickRoute(
          complexity.tier,
          quota.maxComplexityTier,
          tried,
          requirements,
          parsed.data.model,
          initialPinnedRowId,
        )
        if (!target) break
        tried.add(target.modelRowId)
        const gatewayOverheadMs = Math.round(performance.now() - reqStart)

        try {
          const result = await callNonStreaming(target, messages as any, maxOutputTokens, temperature, tools, tool_choice, remainingMs)
          const latencyMs = Date.now() - started
          const billedInputTokens = resolveBilledInputTokens(result.inputTokens, requirements.requiredTokens)
          const cost = calcCost({
            inputPricePer1M: target.inputPricePer1M,
            outputPricePer1M: target.outputPricePer1M,
            inputTokens: billedInputTokens,
            outputTokens: result.outputTokens,
            inputCacheReadPricePer1M: target.inputCacheReadPricePer1M,
            inputCacheWritePricePer1M: target.inputCacheWritePricePer1M,
            requestPriceFlat: target.requestPriceFlat,
            cachedTokens: (result as any).cachedTokens ?? 0,
          })

          bg(reportRouteOutcome(target.providerId, true, target.modelRowId))
          bg((async () => {
            const aiRequestId = await recordRequest({
              userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
              inputTokens: billedInputTokens, outputTokens: result.outputTokens, costUsd: cost,
              latencyMs, status: "success", requestId: reqId,
            })
            if (cost > 0) {
              try {
                await deductCredits(user.id, usdToDt(cost), aiRequestId ?? undefined)
              } catch (err) {
                if (err instanceof InsufficientCreditsError) {
                  console.warn(`[gateway] credit deduction failed (insufficient): userId=${user.id} required=${err.required}dt balance=${err.balance}dt`)
                } else {
                  console.error("[gateway] credit deduction error:", err)
                }
              }
            }
          })())
          if (cacheEligible && result.content.length > 0 && result.toolCalls?.length === 0) {
            bg(setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens))
          }

          logStructuredRequest({
            requestId: reqId,
            userId: user.id,
            tier: complexity.tier,
            routeDecision: target.label,
            routeReason: target.label,
            model: target.label,
            attemptCount: attempt + 1,
            totalLatencyMs: latencyMs,
            overheadMs: gatewayOverheadMs,
            tokens: { input: result.inputTokens, output: result.outputTokens, cached: (result as any).cachedTokens ?? 0 },
            costUsd: cost,
            cancelled: false,
            failoverChain,
            status: "success",
            stream: false,
          })

          if (convKey) {
            await affinityStore.set(convKey, {
              modelRowId: target.modelRowId,
              providerId: target.providerId,
              modelLabel: target.label,
              pinnedAt: Date.now(),
            })
          }
          if (activeAffinity && activeAffinity.modelRowId !== target.modelRowId) {
            console.warn(`[affinity] conversation ${convKey} switched from model ${activeAffinity.modelLabel} (${activeAffinity.modelRowId}) to ${target.label} (${target.modelRowId})`)
            c.header("x-zen-model-switched", "true")
          }
          const reqModel = parsed.data.model
          if (reqModel && !reqModel.startsWith("zen/") && target.label !== reqModel && `${target.providerName}/${target.modelId}` !== reqModel && target.modelId !== reqModel) {
            c.header("x-zen-model-substituted", "true")
            c.header("x-zen-model-requested", reqModel)
          }
          c.header("x-zen-model", target.label)

          console.log(`[gateway] non-stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} latencyMs=${latencyMs} tokens=${result.inputTokens}+${result.outputTokens} status=success`)
          return c.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: target.label,
            choices: [{
              index: 0,
              message: { role: "assistant", content: result.content, ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}) },
              finish_reason: result.finishReason ?? (result.toolCalls?.length ? "tool_calls" : "stop"),
            }],
            usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens },
          })
        } catch (err) {
          if (err instanceof ContextWindowExceededError || err instanceof UnsupportedCapabilityError || err instanceof ExplicitModelCapabilityError) throw err

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
          failoverChain.push({ kind: classification.kind, model: target.label })
          bg(reportRouteOutcome(target.providerId, { success: false, error: err }, target.modelRowId))
          bg(recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: failureReason(err), requestId: reqId }))
          if (classification.action === "break_loop") {
            breakLoopErr = err
            break
          }
        }
      }
    } catch (err) {
      if (err instanceof ContextWindowExceededError) {
        bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `context_window_exceeded: required=${err.requiredTokens}, largest=${err.largestAvailable}`, requestId: reqId }))
        return c.json({
          error: {
            message: err.message,
            type: "context_length_exceeded",
            code: "context_length_exceeded",
            required_tokens: err.requiredTokens,
            largest_context_window: err.largestAvailable,
            suggested_action: "compact_context_or_summarize",
            tier: err.tier,
          }
        }, 413)
      }
      if (err instanceof ExplicitModelCapabilityError) {
        bg(recordRequest({ userId: user.id, ip, modelLabel: err.requestedModel, status: "rejected", rejectReason: `unsupported_capability: ${err.missingCapabilities.join(",")}`, requestId: reqId }))
        return c.json({
          error: {
            message: err.message,
            type: "unsupported_capability",
            code: "unsupported_capability",
            missing_capabilities: err.missingCapabilities,
            requested_model: err.requestedModel,
          }
        }, 400)
      }
      if (err instanceof UnsupportedCapabilityError) {
        const errCode = err.missingCapabilities.includes("tools") ? "NO_TOOL_CAPABLE_MODEL_AVAILABLE" : "unsupported_capability"
        bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `${errCode.toLowerCase()}: ${err.missingCapabilities.join(",")}`, requestId: reqId }))
        return c.json({
          error: {
            message: err.message,
            type: errCode.toLowerCase(),
            code: errCode,
            missing_capabilities: err.missingCapabilities,
            tier: err.tier,
          }
        }, 400)
      }
      throw err
    }

    const totalElapsed = Date.now() - started
    if (totalElapsed >= requestDeadlineMs || failoverChain.some(f => f.kind === "deadline_exceeded")) {
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "gateway_deadline_exceeded", requestId: reqId }))
      return c.json({
        error: {
          message: "Gateway deadline exceeded across fallback attempts",
          type: "gateway_deadline_exceeded",
          code: "gateway_deadline_exceeded",
          failover_chain: failoverChain,
        }
      }, 504)
    }

    if (breakLoopErr) {
      const classification = classifyProviderError(breakLoopErr)
      const status = breakLoopStatus(classification)
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `non_retryable: ${failureReason(breakLoopErr)}`, requestId: reqId }))
      logStructuredRequest({
        requestId: reqId,
        userId: user.id,
        tier: complexity.tier,
        model: "n/a",
        attemptCount: tried.size,
        totalLatencyMs: Date.now() - started,
        overheadMs: Math.round(performance.now() - reqStart),
        tokens: { input: 0, output: 0, cached: 0 },
        costUsd: 0,
        cancelled: false,
        failoverChain,
        status: "rejected",
        errorReason: `non_retryable: ${failureReason(breakLoopErr)}`,
        stream: false,
      })
      const readableMessage = classification.kind === "content_policy_violation" ? "Your request was rejected for violating safety policies." :
                              classification.kind === "unsupported_parameter" ? "Your request contained an unsupported parameter or feature." :
                              classification.kind === "context_length_exceeded" ? "Your request is too long for this model." :
                              "Your request was rejected by the AI provider. Please check your prompt and attachments.";
      return c.json({
        error: {
          message: readableMessage,
          type: "upstream_rejected_request",
          code: "UPSTREAM_REJECTED_REQUEST",
          classification: classification.kind,
          upstream_status: classification.statusCode ?? null,
        }
      }, status as 400)
    }

    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "all_fallback_attempts_failed", requestId: reqId }))
    logStructuredRequest({
      requestId: reqId,
      userId: user.id,
      tier: complexity.tier,
      model: "n/a",
      attemptCount: tried.size,
      totalLatencyMs: Date.now() - started,
      overheadMs: Math.round(performance.now() - reqStart),
      tokens: { input: 0, output: 0, cached: 0 },
      costUsd: 0,
      cancelled: false,
      failoverChain,
      status: "failure",
      errorReason: "all_fallback_attempts_failed",
      stream: false,
    })
    const lastClassification = lastErr ? classifyProviderError(lastErr) : null
    const hint = lastClassification
      ? hintForClassification(lastClassification)
      : "No AI providers responded successfully."
    const errorType = tried.size === 0 ? "NO_PROVIDERS_CONFIGURED" : "ALL_PROVIDERS_FAILED"
    const message = tried.size === 0 ? "No AI providers configured — add one in the admin dashboard" : "All AI providers are currently unavailable. Please try again later."
    return c.json({
      error: {
        message,
        type: errorType.toLowerCase(),
        code: errorType,
        hint,
        last_failure: lastClassification
          ? { kind: lastClassification.kind, action: lastClassification.action, statusCode: lastClassification.statusCode ?? null }
          : null,
      }
    }, tried.size === 0 ? 503 : 502)
  }

  // ---- streaming: peek each candidate for real output before committing to the client ----
  let committedTarget: RouteTarget | null = null
  let committedStream: ReadableStream | null = null
  let isSwitchedStream = false
  let isSubstitutedStream = false

  try {
    for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
      const elapsed = Date.now() - started
      const remainingMs = requestDeadlineMs - elapsed
      if (remainingMs <= 0) {
        failoverChain.push({ kind: "deadline_exceeded" })
        break
      }

      const target: RouteTarget | null = await pickRoute(
        complexity.tier,
        quota.maxComplexityTier,
        tried,
        requirements,
        parsed.data.model,
        initialPinnedRowId,
      )
      if (!target) break
      tried.add(target.modelRowId)
      const gatewayOverheadMs = Math.round(performance.now() - reqStart)

      const { response, started: streamStarted, done } = callStreaming(
        target, messages as any, maxOutputTokens, temperature, target.label, tools, tool_choice, remainingMs,
      )
      let startResult: StreamStartResult
      try {
        startResult = await streamStarted
      } catch (err) {
        startResult = { ok: false, error: err }
      }

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
        if (classification.action === "break_loop" && classification.kind === "bad_request") {
          logMessageDiagnostics(messages as any[], "incoming_request")
        }
        lastErr = startResult.error
        failoverChain.push({ kind: classification.kind, model: target.label })
        bg(reportRouteOutcome(target.providerId, { success: false, error: startResult.error }, target.modelRowId))
        bg(recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: failureReason(startResult.error), requestId: reqId }))
        if (classification.action === "break_loop") {
          breakLoopErr = startResult.error
          break
        }
        continue
      }

      // Committed — this target actually produced output, stream its response to the client.
      committedTarget = target
      committedStream = response.body!
      const ttftMs = Date.now() - started
      console.log(`[gateway] stream ${target.label} attempt=${attempt + 1}/${MAX_FALLBACK_ATTEMPTS} stream=committed firstTokenReceived=true elapsedMs=${ttftMs}`)

      if (convKey) {
        await affinityStore.set(convKey, {
          modelRowId: target.modelRowId,
          providerId: target.providerId,
          modelLabel: target.label,
          pinnedAt: Date.now(),
        })
      }
      if (activeAffinity && activeAffinity.modelRowId !== target.modelRowId) {
        isSwitchedStream = true
        console.warn(`[affinity] conversation ${convKey} switched from model ${activeAffinity.modelLabel} (${activeAffinity.modelRowId}) to ${target.label} (${target.modelRowId})`)
      }
      const reqModel = parsed.data.model
      if (reqModel && !reqModel.startsWith("zen/") && target.label !== reqModel && `${target.providerName}/${target.modelId}` !== reqModel && target.modelId !== reqModel) {
        isSubstitutedStream = true
      }

      bg((async () => {
        try {
          const result = await done
          const latencyMs = Date.now() - started
          const billedInputTokens = resolveBilledInputTokens(result.inputTokens, requirements.requiredTokens)
          const cost = calcCost({
            inputPricePer1M: target.inputPricePer1M,
            outputPricePer1M: target.outputPricePer1M,
            inputTokens: billedInputTokens,
            outputTokens: result.outputTokens,
            inputCacheReadPricePer1M: target.inputCacheReadPricePer1M,
            inputCacheWritePricePer1M: target.inputCacheWritePricePer1M,
            requestPriceFlat: target.requestPriceFlat,
            cachedTokens: (result as any).cachedTokens ?? 0,
          })
          await reportRouteOutcome(target.providerId, true, target.modelRowId)
          const aiRequestId = await recordRequest({
            userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
            inputTokens: billedInputTokens, outputTokens: result.outputTokens, costUsd: cost,
            latencyMs, status: "success", requestId: reqId,
          })
          if (cost > 0) {
            try {
              await deductCredits(user.id, usdToDt(cost), aiRequestId ?? undefined)
              await recordUsage(user.id, billedInputTokens, result.outputTokens, cost)
            } catch (err) {
              if (err instanceof InsufficientCreditsError) {
                console.warn(`[gateway] stream credit deduction failed (insufficient): userId=${user.id} required=${err.required}dt balance=${err.balance}dt`)
              } else {
                console.error("[gateway] stream credit deduction error:", err)
              }
            }
          }
          if (cacheEligible && result.content.length > 0) {
            await setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens)
          }
          logStructuredRequest({
            requestId: reqId,
            userId: user.id,
            tier: complexity.tier,
            routeDecision: target.label,
            routeReason: target.label,
            model: target.label,
            attemptCount: attempt + 1,
            ttftMs,
            totalLatencyMs: latencyMs,
            overheadMs: gatewayOverheadMs,
            tokens: { input: result.inputTokens, output: result.outputTokens, cached: (result as any).cachedTokens ?? 0 },
            costUsd: cost,
            cancelled: false,
            failoverChain,
            status: "success",
            stream: true,
          })
        } catch (err) {
          const isClientCancel =
            (err instanceof Error && (
              err.message.includes("stream cancelled by client") ||
              err.message.includes("cancelled by client") ||
              err.name === "AbortError"
            )) ||
            (typeof err === "string" && (err.includes("stream cancelled by client") || err.includes("cancelled by client")))

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
          if (!isClientCancel) {
            await reportRouteOutcome(target.providerId, { success: false, error: err }, target.modelRowId)
          }
          await recordRequest({
            userId: user.id,
            ip,
            modelLabel: target.label,
            promptHash: cacheKey,
            status: "failure",
            rejectReason: isClientCancel ? "client_cancelled" : ("mid_stream_failure: " + failureReason(err)),
            requestId: reqId,
          })
          logStructuredRequest({
            requestId: reqId,
            userId: user.id,
            tier: complexity.tier,
            routeDecision: target.label,
            routeReason: target.label,
            model: target.label,
            attemptCount: attempt + 1,
            ttftMs,
            totalLatencyMs: Date.now() - started,
            overheadMs: gatewayOverheadMs,
            tokens: { input: 0, output: 0, cached: 0 },
            costUsd: 0,
            cancelled: isClientCancel,
            failoverChain,
            status: "failure",
            errorReason: isClientCancel ? "client_cancelled" : ("mid_stream_failure: " + failureReason(err)),
            stream: true,
          })
        }
      })())

      break
    }
  } catch (err) {
    if (err instanceof ContextWindowExceededError) {
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `context_window_exceeded: required=${err.requiredTokens}, largest=${err.largestAvailable}`, requestId: reqId }))
      return c.json({
        error: {
          message: err.message,
          type: "context_length_exceeded",
          code: "context_length_exceeded",
          required_tokens: err.requiredTokens,
          largest_context_window: err.largestAvailable,
          suggested_action: "compact_context_or_summarize",
          tier: err.tier,
        }
      }, 413)
    }
    if (err instanceof ExplicitModelCapabilityError) {
      bg(recordRequest({ userId: user.id, ip, modelLabel: err.requestedModel, status: "rejected", rejectReason: `unsupported_capability: ${err.missingCapabilities.join(",")}`, requestId: reqId }))
      return c.json({
        error: {
          message: err.message,
          type: "unsupported_capability",
          code: "unsupported_capability",
          missing_capabilities: err.missingCapabilities,
          requested_model: err.requestedModel,
        }
      }, 400)
    }
    if (err instanceof UnsupportedCapabilityError) {
      const errCode = err.missingCapabilities.includes("tools") ? "NO_TOOL_CAPABLE_MODEL_AVAILABLE" : "unsupported_capability"
      bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `${errCode.toLowerCase()}: ${err.missingCapabilities.join(",")}`, requestId: reqId }))
      return c.json({
        error: {
          message: err.message,
          type: errCode.toLowerCase(),
          code: errCode,
          missing_capabilities: err.missingCapabilities,
          tier: err.tier,
        }
      }, 400)
    }
    throw err
  }

  if (committedStream && committedTarget) {
    const headers: Record<string, string> = {
      ...SSE_HEADERS,
      "x-zen-model": committedTarget.label,
    }
    if (isSwitchedStream) headers["x-zen-model-switched"] = "true"
    if (isSubstitutedStream) {
      headers["x-zen-model-substituted"] = "true"
      headers["x-zen-model-requested"] = parsed.data.model!
    }
    return new Response(committedStream, {
      status: 200,
      headers,
    })
  }

  const streamElapsed = Date.now() - started
  if (streamElapsed >= requestDeadlineMs || failoverChain.some(f => f.kind === "deadline_exceeded")) {
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "gateway_deadline_exceeded", requestId: reqId }))
    return c.json({
      error: {
        message: "Gateway deadline exceeded across fallback attempts",
        type: "gateway_deadline_exceeded",
        code: "gateway_deadline_exceeded",
        failover_chain: failoverChain,
      }
    }, 504)
  }

  if (breakLoopErr) {
    const classification = classifyProviderError(breakLoopErr)
    const status = breakLoopStatus(classification)
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: `non_retryable: ${failureReason(breakLoopErr)}`, requestId: reqId }))
    const readableMessage = classification.kind === "content_policy_violation" ? "Your request was rejected for violating safety policies." :
                            classification.kind === "unsupported_parameter" ? "Your request contained an unsupported parameter or feature." :
                            classification.kind === "context_length_exceeded" ? "Your request is too long for this model." :
                            "Your request was rejected by the AI provider. Please check your prompt and attachments.";
    const sseBody = `data: ${JSON.stringify({
      error: {
        message: readableMessage,
        type: "upstream_rejected_request",
        code: "UPSTREAM_REJECTED_REQUEST",
        classification: classification.kind,
        upstream_status: classification.statusCode ?? null,
      }
    })}\n\ndata: [DONE]\n\n`
    return new Response(sseBody, {
      status: status,
      headers: SSE_HEADERS,
    })
  }

  bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "all_fallback_attempts_failed", requestId: reqId }))
  logStructuredRequest({
    requestId: reqId,
    userId: user.id,
    tier: complexity.tier,
    model: "n/a",
    attemptCount: tried.size,
    totalLatencyMs: Date.now() - started,
    overheadMs: Math.round(performance.now() - reqStart),
    tokens: { input: 0, output: 0, cached: 0 },
    costUsd: 0,
    cancelled: false,
    failoverChain,
    status: "failure",
    errorReason: "all_fallback_attempts_failed",
    stream: true,
  })
  const errorType = tried.size === 0 ? "NO_PROVIDERS_CONFIGURED" : "ALL_PROVIDERS_FAILED"
  const message = tried.size === 0 ? "No AI providers configured — add one in the admin dashboard" : "All AI providers are currently unavailable. Please try again later."
  const lastClassification = lastErr ? classifyProviderError(lastErr) : null
  const hint = lastClassification ? hintForClassification(lastClassification) : "No AI providers responded successfully."
  const sseBody = `data: ${JSON.stringify({
    error: {
      message: message,
      type: errorType.toLowerCase(),
      code: errorType,
      hint,
      last_failure: lastClassification
        ? { kind: lastClassification.kind, action: lastClassification.action, statusCode: lastClassification.statusCode ?? null }
        : null,
    }
  })}\n\ndata: [DONE]\n\n`
  return new Response(sseBody, {
    status: 200,
    headers: SSE_HEADERS,
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

gateway.post("/embeddings", requireApiKey(), rateLimit(DEFAULT_GATEWAY_RATE_LIMIT_RPM, GATEWAY_RATE_LIMIT_WINDOW_MS), async (c) => {
  const body = await c.req.json().catch(() => null)
  
  if (!body || !body.input) {
    return c.json({ error: "invalid payload" }, 400)
  }
  try {
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const dimensions = body.dimensions || 1536
    
    return c.json({
      object: "list",
      data: inputs.map((_: unknown, index: number) => ({
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
