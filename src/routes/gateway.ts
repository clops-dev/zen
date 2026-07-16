import { Hono } from "hono"
import { z } from "zod"
import { sql } from "../lib/db"
import { requireApiKey } from "../middleware/api-key"
import { rateLimit } from "../middleware/rate-limit"
import { classifyComplexity } from "../lib/complexity"
import { pickRoute, reportRouteOutcome } from "../lib/routing"
import { callNonStreaming, callStreaming } from "../lib/ai-call"
import { checkQuota, recordUsage } from "../lib/quota"
import { hashPrompt, getCached, setCached } from "../lib/cache"
import { calcCost } from "../lib/pricing"

export const gateway = new Hono()

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullish(),
}).passthrough()

const chatCompletionsSchema = z.object({
  model: z.string().nullish(), // accepted for OpenAI-client compatibility, not used for routing — routing is complexity-based
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  temperature: z.number().nullish(),
  tools: z.array(z.any()).nullish(),
  tool_choice: z.any().nullish(),
}).passthrough()

function bg(p: Promise<unknown>) {
  p.catch((err) => console.error("[gateway] background task error:", err))
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
    await sql`
      INSERT INTO ai_requests (
        user_id, ip, model_label, prompt_hash, input_tokens, output_tokens,
        cost_usd, latency_ms, status, reject_reason, from_cache
      ) VALUES (
        ${fields.userId}, ${fields.ip}, ${fields.modelLabel}, ${fields.promptHash ?? null},
        ${fields.inputTokens ?? 0}, ${fields.outputTokens ?? 0}, ${fields.costUsd ?? 0},
        ${fields.latencyMs ?? null}, ${fields.status}, ${fields.rejectReason ?? null}, ${fields.fromCache ?? false}
      )
    `
  } catch (err) {
    console.error("[gateway] failed to log request:", err)
  }
}

gateway.get("/models", requireApiKey(), async (c) => {
  const rows = await sql`
    SELECT p.name AS provider, m.model_id, m.label, m.context_window
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = true AND p.enabled = true
    ORDER BY p.name, m.model_id
  `
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
    console.error("Invalid payload details:", parsed.error.flatten(), "Body:", JSON.stringify(body, null, 2))
    return c.json({ error: "invalid payload", details: parsed.error.flatten() }, 400)
  }
  const { messages, stream, max_tokens, temperature, tools, tool_choice } = parsed.data
  const maxOutputTokens = max_tokens ?? 4096

  const quota = await checkQuota(user.id)
  if (!quota.allowed) {
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: quota.reason }))
    const statusCode = quota.reason === "quota_exceeded" ? 402 : quota.reason === "suspended" ? 403 : 401
    return c.json({ error: quota.reason }, statusCode)
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

  // ---- pick a route ----
  const target = await pickRoute(complexity.tier, quota.maxComplexityTier)
  if (!target) {
    bg(recordRequest({ userId: user.id, ip, modelLabel: "n/a", status: "rejected", rejectReason: "no_providers_configured" }))
    return c.json({ error: "no AI providers configured — add one in the admin dashboard under Providers" }, 503)
  }

  const started = Date.now()

  if (!stream) {
    try {
      const result = await callNonStreaming(target, messages as any, maxOutputTokens, temperature, tools, tool_choice)
      const latencyMs = Date.now() - started
      const cost = calcCost(target.inputPricePer1M, target.outputPricePer1M, result.inputTokens, result.outputTokens)

      bg(reportRouteOutcome(target.providerId, true))
      bg(recordUsage(user.id, result.inputTokens, result.outputTokens, cost))
      bg(recordRequest({
        userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost,
        latencyMs, status: "success",
      }))
      bg(setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens))

      return c.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: target.label,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.content,
            ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {})
          },
          finish_reason: result.toolCalls?.length ? "tool_calls" : "stop"
        }],
        usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens },
      })
    } catch (err) {
      console.error(`[gateway] ${target.label} call failed:`, err)
      bg(reportRouteOutcome(target.providerId, false))
      bg(recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: String(err) }))
      return c.json({ error: "upstream provider failed", provider: target.providerName }, 502)
    }
  }

  // ---- streaming ----
  try {
    const { response, done } = callStreaming(target, messages as any, maxOutputTokens, temperature, target.label, tools, tool_choice)

    bg((async () => {
      try {
        const result = await done
        const latencyMs = Date.now() - started
        const cost = calcCost(target.inputPricePer1M, target.outputPricePer1M, result.inputTokens, result.outputTokens)
        await reportRouteOutcome(target.providerId, true)
        await recordUsage(user.id, result.inputTokens, result.outputTokens, cost)
        await recordRequest({
          userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost,
          latencyMs, status: "success",
        })
        await setCached(cacheKey, target.label, result.content, result.inputTokens, result.outputTokens)
      } catch (err) {
        console.error(`[gateway] streaming ${target.label} failed:`, err)
        await reportRouteOutcome(target.providerId, false)
        await recordRequest({ userId: user.id, ip, modelLabel: target.label, promptHash: cacheKey, status: "failure", rejectReason: String(err) })
      }
    })())

    return response
  } catch (err) {
    console.error(`[gateway] ${target.label} stream setup failed:`, err)
    bg(reportRouteOutcome(target.providerId, false))
    return c.json({ error: "upstream provider failed", provider: target.providerName }, 502)
  }
})
