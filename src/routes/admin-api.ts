import { Hono } from "hono"
import { z } from "zod"
import { sql, withDbResilience } from "../lib/db"
import { requireAdmin } from "../middleware/session-auth"
import { audit, actorEmailFor } from "../lib/audit"
import { fetchOpenRouterModelMetadata } from "../lib/openrouter"


export const adminApi = new Hono()
adminApi.use("*", requireAdmin())

const jsonError = (c: any, status: number, code: string, message?: string) =>
  c.json({ error: code, message: message ?? code }, status)

const ip = (c: any) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  c.req.header("x-real-ip") ??
  null

const requireColumn = async (table: string, column: string): Promise<boolean> => {
  const r = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = ${table} AND column_name = ${column}
    ) AS exists
  `
  return !!r[0]?.exists
}

const persistProviderMeta = async (providerId: string, meta: Record<string, unknown>) => {
  if (Object.keys(meta).length === 0) return
  try {
    await sql`
      INSERT INTO provider_meta (provider_id, metadata)
      VALUES (${providerId}, ${sql.json(meta as Record<string, any>)})
      ON CONFLICT (provider_id) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()
    `
  } catch {
    // provider_meta table may not exist on older DBs. Silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Dashboard overview
// ---------------------------------------------------------------------------

adminApi.get("/dashboard/overview", async (c) => {
  try {
    const [totals] = await sql`
      SELECT
        (SELECT count(*) FROM ai_requests) AS total_requests,
        (SELECT count(*) FROM ai_requests WHERE created_at >= date_trunc('day', now())) AS requests_today,
        (SELECT count(*) FILTER (WHERE status='success') FROM ai_requests) AS success,
        (SELECT count(*) FILTER (WHERE status='failure') FROM ai_requests) AS failed,
        (SELECT count(*) FILTER (WHERE status='rejected') FROM ai_requests) AS rejected,
        (SELECT count(*) FILTER (WHERE from_cache) FROM ai_requests) AS cached,
        (SELECT COALESCE(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL AND status='success'), 0)::int FROM ai_requests) AS avg_latency_ms,
        (SELECT COALESCE(sum(input_tokens + output_tokens), 0) FROM ai_requests) AS total_tokens,
        (SELECT COALESCE(sum(cost_usd), 0) FROM ai_requests) AS total_cost
    `

    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM providers WHERE enabled) AS active_providers,
        (SELECT count(*) FROM models WHERE enabled) AS active_models,
        (SELECT count(*) FROM api_keys WHERE revoked = false) AS api_keys,
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM combos WHERE status = 'active') AS active_combos
    `

    const requestsTimeline = await sql`
      SELECT date_trunc('hour', created_at) AS bucket,
             count(*) AS requests,
             count(*) FILTER (WHERE status='success') AS success,
             count(*) FILTER (WHERE status='failure') AS failed,
             count(*) FILTER (WHERE status='rejected') AS rejected,
             COALESCE(sum(cost_usd),0) AS cost
        FROM ai_requests
       WHERE created_at >= now() - interval '24 hours'
       GROUP BY bucket ORDER BY bucket
    `

    const providerUsage = await sql`
      SELECT split_part(model_label, '/', 1) AS provider, count(*) AS requests,
             COALESCE(sum(cost_usd),0) AS cost
        FROM ai_requests
       WHERE created_at >= now() - interval '7 days'
       GROUP BY provider ORDER BY requests DESC LIMIT 20
    `

    const modelUsage = await sql`
      SELECT model_label, count(*) AS requests, COALESCE(sum(cost_usd),0) AS cost
        FROM ai_requests
       WHERE created_at >= now() - interval '7 days'
       GROUP BY model_label ORDER BY requests DESC LIMIT 20
    `

    const latencyTimeline = await sql`
      SELECT date_trunc('hour', created_at) AS bucket,
             COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::int AS p50,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::int AS p95
        FROM ai_requests
       WHERE created_at >= now() - interval '24 hours'
         AND latency_ms IS NOT NULL
       GROUP BY bucket ORDER BY bucket
    `

    const successFailure = await sql`SELECT status, count(*) AS n FROM ai_requests GROUP BY status`

    return c.json({
      totals,
      counts,
      requestsTimeline,
      providerUsage,
      modelUsage,
      latencyTimeline,
      successFailure,
    })
  } catch (err) {
    return jsonError(c, 500, "overview_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/dashboard/providers/health", async (c) => {
  try {
    const rows = await sql`
      SELECT id, name, base_url, provider_type, enabled, healthy, consecutive_failures, last_failure_at
        FROM providers ORDER BY name
    `
    return c.json({ providers: rows })
  } catch (err) {
    return jsonError(c, 500, "provider_health_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const userListSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

adminApi.get("/users", async (c) => {
  const parsed = userListSchema.safeParse(c.req.query())
  if (!parsed.success) return jsonError(c, 400, "invalid_query")
  const q = parsed.data.q ?? ""
  const limit = parsed.data.limit
  try {
    const rows = await sql`
      SELECT u.id, u.email, u.role, u.created_at,
             s.tier, s.status AS subscription_status, s.token_budget_monthly,
             COALESCE((SELECT count(*) FROM api_keys WHERE user_id = u.id AND revoked = false), 0) AS active_keys,
             COALESCE((SELECT count(*) FROM ai_requests WHERE user_id = u.id), 0) AS total_requests,
             COALESCE((SELECT sum(cost_usd) FROM ai_requests WHERE user_id = u.id), 0) AS total_cost
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.email ILIKE ${"%" + q + "%"} OR u.role ILIKE ${"%" + q + "%"}
       ORDER BY u.created_at DESC
       LIMIT ${limit}
    `
    const lastLogin = await sql`SELECT user_id, max(last_used_at) AS last_used_at FROM api_keys GROUP BY user_id`
    const lastMap = new Map(lastLogin.map((r: any) => [r.user_id, r.last_used_at]))
    return c.json({
      users: rows.map((r: any) => ({ ...r, last_login_at: lastMap.get(r.id) ?? null })),
    })
  } catch (err) {
    return jsonError(c, 500, "users_list_failed", err instanceof Error ? err.message : String(err))
  }
})

const userCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  role: z.enum(["user", "admin"]).default("user"),
  tier: z.enum(["free", "pro", "enterprise"]).default("free"),
  token_budget_monthly: z.coerce.number().int().min(0).default(50000),
})

adminApi.post("/users", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = userCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload", JSON.stringify(parsed.error.flatten()))
  const { email, password, role, tier, token_budget_monthly } = parsed.data
  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`
    if (existing.length > 0) return jsonError(c, 409, "email_taken")
    const { hashPassword } = await import("../lib/password")
    const hash = await hashPassword(password)
    const [u] = await sql`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, ${role}) RETURNING id
    `
    await sql`
      INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
      VALUES (${u.id}, ${tier}, 'active', ${token_budget_monthly})
      ON CONFLICT (user_id) DO UPDATE SET tier=${tier}, token_budget_monthly=${token_budget_monthly}
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.create",
      resource: "user",
      resourceId: u.id,
      ip: ip(c),
      metadata: { email, role, tier },
    })
    return c.json({ id: u.id, email, role, tier })
  } catch (err) {
    return jsonError(c, 500, "user_create_failed", err instanceof Error ? err.message : String(err))
  }
})

const userUpdateSchema = z.object({
  role: z.enum(["user", "admin"]).optional(),
  tier: z.enum(["free", "pro", "enterprise"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  token_budget_monthly: z.coerce.number().int().min(0).optional(),
})

adminApi.patch("/users/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const parsed = userUpdateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  try {
    const existing = await sql`SELECT id FROM users WHERE id = ${id}`
    if (existing.length === 0) return jsonError(c, 404, "not_found")
    if (parsed.data.role) await sql`UPDATE users SET role = ${parsed.data.role} WHERE id = ${id}`
    if (parsed.data.tier || parsed.data.status || parsed.data.token_budget_monthly !== undefined) {
      const tier = parsed.data.tier ?? null
      const status = parsed.data.status ?? null
      const budget = parsed.data.token_budget_monthly ?? null
      await sql`
        INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
        VALUES (${id}, ${parsed.data.tier ?? "free"}, ${parsed.data.status ?? "active"}, ${parsed.data.token_budget_monthly ?? 50000})
        ON CONFLICT (user_id) DO UPDATE SET
          tier = COALESCE(${tier}::text, subscriptions.tier),
          status = COALESCE(${status}::text, subscriptions.status),
          token_budget_monthly = COALESCE(${budget}::bigint, subscriptions.token_budget_monthly)
      `
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.update",
      resource: "user",
      resourceId: id,
      ip: ip(c),
      metadata: parsed.data,
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "user_update_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.delete("/users/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  if (id === session.userId) return jsonError(c, 400, "cannot_delete_self")
  try {
    await sql`DELETE FROM users WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.delete",
      resource: "user",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "user_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/users/:id", async (c) => {
  try {
    const [u] = await sql`
      SELECT u.id, u.email, u.role, u.created_at,
             s.tier, s.status, s.token_budget_monthly
        FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.id = ${c.req.param("id")}
    `
    if (!u) return jsonError(c, 404, "not_found")
    const [usage] = await sql`
      SELECT COALESCE(sum(input_tokens + output_tokens), 0) AS tokens,
             COALESCE(sum(cost_usd), 0) AS cost,
             count(*) AS requests
        FROM ai_requests WHERE user_id = ${u.id}
    `
    const keys = await sql`
      SELECT id, key_prefix, label, created_at, last_used_at, revoked
        FROM api_keys WHERE user_id = ${u.id} ORDER BY created_at DESC
    `
    return c.json({ user: u, usage, keys })
  } catch (err) {
    return jsonError(c, 500, "user_get_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

adminApi.get("/providers", async (c) => {
  try {
    const rows = await sql`
      SELECT id, name, base_url, provider_type, enabled, healthy, consecutive_failures, last_failure_at, created_at
        FROM providers ORDER BY created_at DESC
    `
    const masked = (await sql`SELECT id, length(api_key) AS key_length FROM providers`).reduce(
      (acc: any, r: any) => {
        acc[r.id] = {
          has_key: r.key_length > 0,
          key_preview: r.key_length > 0 ? `•••• (${r.key_length} chars)` : "",
        }
        return acc
      },
      {} as Record<string, { has_key: boolean; key_preview: string }>,
    )

    const metaByProvider = new Map<string, any>()
    try {
      const meta = await sql`SELECT provider_id, metadata FROM provider_meta`
      for (const row of meta as any[]) metaByProvider.set(row.provider_id, row.metadata)
    } catch {
      // ignore
    }

    return c.json({
      providers: rows.map((r: any) => ({
        ...r,
        ...(masked[r.id] ?? { has_key: false, key_preview: "" }),
        meta: metaByProvider.get(r.id) ?? {},
      })),
    })
  } catch (err) {
    return jsonError(c, 500, "providers_list_failed", err instanceof Error ? err.message : String(err))
  }
})

const providerCreateSchema = z.object({
  name: z.string().min(1).max(128),
  base_url: z.string().url(),
  provider_type: z.enum(["openai-compatible", "anthropic-compatible"]).default("openai-compatible"),
  api_key: z.string().optional().default(""),
  enabled: z.boolean().default(true),
  organization: z.string().optional(),
  region: z.string().optional(),
  timeout_ms: z.coerce.number().int().positive().optional(),
  retry_max: z.coerce.number().int().min(0).max(10).optional(),
  rate_limit_rpm: z.coerce.number().int().min(0).optional(),
  priority: z.coerce.number().int().min(0).max(100).default(50),
  weight: z.coerce.number().min(0).max(100).default(1),
  cost_multiplier: z.coerce.number().min(0).max(100).default(1),
  headers: z.record(z.string()).optional(),
})

adminApi.post("/providers", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = providerCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload", JSON.stringify(parsed.error.flatten()))
  const d = parsed.data
  try {
    const [p] = await sql`
      INSERT INTO providers (name, base_url, api_key, provider_type, enabled, healthy, consecutive_failures)
      VALUES (${d.name}, ${d.base_url}, ${d.api_key ?? ""}, ${d.provider_type}, ${d.enabled}, true, 0)
      RETURNING id
    `

    const meta: Record<string, unknown> = {}
    if (d.organization) meta.organization = d.organization
    if (d.region) meta.region = d.region
    if (d.timeout_ms) meta.timeout_ms = d.timeout_ms
    if (d.retry_max !== undefined) meta.retry_max = d.retry_max
    if (d.rate_limit_rpm !== undefined) meta.rate_limit_rpm = d.rate_limit_rpm
    if (d.priority !== undefined) meta.priority = d.priority
    if (d.weight !== undefined) meta.weight = d.weight
    if (d.cost_multiplier !== undefined) meta.cost_multiplier = d.cost_multiplier
    if (d.headers) meta.headers = d.headers
    await persistProviderMeta(p.id, meta)

    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "provider.create",
      resource: "provider",
      resourceId: p.id,
      ip: ip(c),
      metadata: { name: d.name, base_url: d.base_url, provider_type: d.provider_type },
    })
    return c.json({ id: p.id, name: d.name })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duplicate key/i.test(msg)) return jsonError(c, 409, "name_taken")
    return jsonError(c, 500, "provider_create_failed", msg)
  }
})

const providerUpdateSchema = providerCreateSchema.partial()

adminApi.patch("/providers/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const parsed = providerUpdateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data
  try {
    const existing = await sql`SELECT id FROM providers WHERE id = ${id}`
    if (existing.length === 0) return jsonError(c, 404, "not_found")

    const sets: string[] = []
    const params: any[] = []
    if (d.name !== undefined) { sets.push("name"); params.push(d.name) }
    if (d.base_url !== undefined) { sets.push("base_url"); params.push(d.base_url) }
    if (d.provider_type !== undefined) { sets.push("provider_type"); params.push(d.provider_type) }
    if (d.api_key !== undefined && d.api_key !== "") {
      sets.push("api_key"); params.push(d.api_key)
      sets.push("healthy"); params.push(true)
      sets.push("consecutive_failures"); params.push(0)
    }
    if (d.enabled !== undefined) { sets.push("enabled"); params.push(d.enabled) }

    if (sets.length > 0) {
      const setSql = sets.map((s, i) => `${s} = $${i + 1}`).join(", ")
      await sql.unsafe(`UPDATE providers SET ${setSql} WHERE id = $${sets.length + 1}`, [...params, id])
    }

    const meta: Record<string, unknown> = {}
    if (d.organization) meta.organization = d.organization
    if (d.region) meta.region = d.region
    if (d.timeout_ms !== undefined) meta.timeout_ms = d.timeout_ms
    if (d.retry_max !== undefined) meta.retry_max = d.retry_max
    if (d.rate_limit_rpm !== undefined) meta.rate_limit_rpm = d.rate_limit_rpm
    if (d.priority !== undefined) meta.priority = d.priority
    if (d.weight !== undefined) meta.weight = d.weight
    if (d.cost_multiplier !== undefined) meta.cost_multiplier = d.cost_multiplier
    if (d.headers) meta.headers = d.headers
    if (Object.keys(meta).length > 0) await persistProviderMeta(id, meta)

    const isKeyChange = d.api_key !== undefined && d.api_key !== ""
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: isKeyChange ? "provider.update_key" : "provider.update",
      resource: "provider",
      resourceId: id,
      ip: ip(c),
      metadata: { fields: Object.keys(d) },
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "provider_update_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/providers/:id/toggle", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [p] = await sql`UPDATE providers SET enabled = NOT enabled WHERE id = ${id} RETURNING enabled`
    if (!p) return jsonError(c, 404, "not_found")
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: p.enabled ? "provider.enable" : "provider.disable",
      resource: "provider",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true, enabled: p.enabled })
  } catch (err) {
    return jsonError(c, 500, "provider_toggle_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/providers/:id/test", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [p] = await sql`SELECT name, base_url, api_key, provider_type FROM providers WHERE id = ${id}`
    if (!p) return jsonError(c, 404, "not_found")
    const url = `${p.base_url.replace(/\/$/, "")}${p.provider_type === "anthropic-compatible" ? "" : "/models"}`
    const headers: Record<string, string> = {}
    if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`
    const start = Date.now()
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    const latency = Date.now() - start
    const ok = res.ok
    if (ok) await sql`UPDATE providers SET healthy = true, consecutive_failures = 0 WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "provider.test",
      resource: "provider",
      resourceId: id,
      ip: ip(c),
      result: ok ? "success" : "failure",
      metadata: { url, status: res.status, latency_ms: latency },
    })
    return c.json({ ok, status: res.status, latency_ms: latency })
  } catch (err) {
    return jsonError(c, 500, "provider_test_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.delete("/providers/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`DELETE FROM providers WHERE id = ${id}`
    try { await sql`DELETE FROM provider_meta WHERE provider_id = ${id}` } catch {}
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "provider.delete",
      resource: "provider",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "provider_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

adminApi.get("/models", async (c) => {
  try {
    const hasStreaming = await requireColumn("models", "supports_streaming")
    const hasReasoning = await requireColumn("models", "supports_reasoning")
    const hasEmbeddings = await requireColumn("models", "supports_embeddings")

    const rows = await sql`
      SELECT m.*, p.name AS provider_name, p.id AS provider_id, p.base_url AS provider_base_url
        FROM models m JOIN providers p ON p.id = m.provider_id
       ORDER BY p.name, m.model_id
    `

    return c.json({
      models: rows.map((m: any) => ({
        ...m,
        supports_streaming: hasStreaming ? (m.supports_streaming ?? true) : true,
        supports_reasoning: hasReasoning ? (m.supports_reasoning ?? false) : false,
        supports_embeddings: hasEmbeddings ? (m.supports_embeddings ?? false) : false,
      })),
    })
  } catch (err) {
    return jsonError(c, 500, "models_list_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/models/openrouter-fetch", async (c) => {
  const body = await c.req.json().catch(() => null)
  const providerId = body?.provider_id
  const modelId = body?.model_id
  if (!providerId || !modelId) {
    return jsonError(c, 400, "invalid_payload", "provider_id and model_id are required")
  }

  const [provider] = await sql`SELECT base_url FROM providers WHERE id = ${providerId}`
  if (!provider) {
    return jsonError(c, 404, "provider_not_found", "Provider not found")
  }

  if (!provider.base_url.toLowerCase().includes("openrouter.ai")) {
    return jsonError(c, 400, "not_openrouter_provider", "Provider base_url is not OpenRouter")
  }

  try {
    const meta = await fetchOpenRouterModelMetadata(modelId)
    return c.json({ ok: true, metadata: meta })
  } catch (err: any) {
    const statusCode = err?.statusCode === 404 ? 404 : 500
    const code = err?.statusCode === 404 ? "openrouter_model_not_found" : "openrouter_fetch_failed"
    return jsonError(c, statusCode, code, err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/models/:id/refresh", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [m] = await sql`
      SELECT m.*, p.base_url
        FROM models m
        JOIN providers p ON p.id = m.provider_id
       WHERE m.id = ${id}
    `
    if (!m) return jsonError(c, 404, "not_found", "Model not found")

    if (!m.base_url.toLowerCase().includes("openrouter.ai")) {
      return jsonError(c, 400, "not_openrouter_provider", "Model is not on an OpenRouter provider")
    }

    const meta = await fetchOpenRouterModelMetadata(m.openrouter_model_id || m.model_id)

    await sql`
      UPDATE models SET
        label = ${meta.label},
        input_price_per_1m = ${meta.input_price_per_1m},
        output_price_per_1m = ${meta.output_price_per_1m},
        input_cache_read_price_per_1m = ${meta.input_cache_read_price_per_1m},
        input_cache_write_price_per_1m = ${meta.input_cache_write_price_per_1m},
        request_price_flat = ${meta.request_price_flat},
        context_window = ${meta.context_window},
        supports_tools = ${meta.supports_tools},
        supports_vision = ${meta.supports_vision},
        supports_json_mode = ${meta.supports_json_mode},
        supports_structured_outputs = ${meta.supports_structured_outputs},
        supports_reasoning = ${meta.supports_reasoning},
        input_modalities = ${meta.input_modalities},
        output_modalities = ${meta.output_modalities},
        is_moderated = ${meta.is_moderated},
        max_completion_tokens = ${meta.max_completion_tokens},
        expiration_date = ${meta.expiration_date},
        openrouter_model_id = ${meta.openrouter_model_id},
        metadata_synced_at = now()
      WHERE id = ${id}
    `

    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "model.update",
      resource: "model",
      resourceId: id,
      ip: ip(c),
      metadata: { action: "refresh_openrouter_metadata", model_id: m.model_id },
    })

    return c.json({ ok: true, metadata: meta })
  } catch (err: any) {
    const statusCode = err?.statusCode === 404 ? 404 : 500
    const code = err?.statusCode === 404 ? "openrouter_model_not_found" : "openrouter_refresh_failed"
    return jsonError(c, statusCode, code, err instanceof Error ? err.message : String(err))
  }
})

const modelCreateSchema = z.object({
  provider_id: z.string().uuid(),
  model_id: z.string().min(1).max(256),
  label: z.string().optional().nullable(),
  input_price_per_1m: z.coerce.number().min(0).default(0),
  output_price_per_1m: z.coerce.number().min(0).default(0),
  input_cache_read_price_per_1m: z.coerce.number().min(0).optional().nullable(),
  input_cache_write_price_per_1m: z.coerce.number().min(0).optional().nullable(),
  request_price_flat: z.coerce.number().min(0).optional().default(0),
  context_window: z.coerce.number().int().positive().optional().nullable(),
  supports_tools: z.boolean().default(false),
  supports_vision: z.boolean().default(false),
  supports_json_mode: z.boolean().default(false),
  supports_streaming: z.boolean().default(true),
  supports_reasoning: z.boolean().default(false),
  supports_structured_outputs: z.boolean().default(false),
  supports_embeddings: z.boolean().default(false),
  input_modalities: z.array(z.string()).optional().default([]),
  output_modalities: z.array(z.string()).optional().default([]),
  is_moderated: z.boolean().default(false),
  max_completion_tokens: z.coerce.number().int().positive().optional().nullable(),
  expiration_date: z.string().optional().nullable(),
  openrouter_model_id: z.string().optional().nullable(),
  metadata_synced_at: z.string().optional().nullable(),
  enabled: z.boolean().default(true),
})

adminApi.post("/models", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = modelCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload", JSON.stringify(parsed.error.flatten()))
  let d = parsed.data

  try {
    const [provider] = await sql`SELECT base_url FROM providers WHERE id = ${d.provider_id}`
    const isOpenRouter = provider?.base_url?.toLowerCase().includes("openrouter.ai")

    // If registered on OpenRouter and metadata was not pre-fetched, perform server-side auto-fetch
    if (isOpenRouter && !d.metadata_synced_at && body?.auto_fetch !== false) {
      try {
        const fetched = await fetchOpenRouterModelMetadata(d.model_id)
        d = {
          ...d,
          label: d.label || fetched.label,
          input_price_per_1m: d.input_price_per_1m !== 0 ? d.input_price_per_1m : fetched.input_price_per_1m,
          output_price_per_1m: d.output_price_per_1m !== 0 ? d.output_price_per_1m : fetched.output_price_per_1m,
          input_cache_read_price_per_1m: d.input_cache_read_price_per_1m ?? fetched.input_cache_read_price_per_1m,
          input_cache_write_price_per_1m: d.input_cache_write_price_per_1m ?? fetched.input_cache_write_price_per_1m,
          request_price_flat: d.request_price_flat ?? fetched.request_price_flat,
          context_window: d.context_window ?? fetched.context_window,
          supports_tools: d.supports_tools || fetched.supports_tools,
          supports_vision: d.supports_vision || fetched.supports_vision,
          supports_json_mode: d.supports_json_mode || fetched.supports_json_mode,
          supports_structured_outputs: d.supports_structured_outputs || fetched.supports_structured_outputs,
          supports_reasoning: d.supports_reasoning || fetched.supports_reasoning,
          input_modalities: d.input_modalities?.length ? d.input_modalities : fetched.input_modalities,
          output_modalities: d.output_modalities?.length ? d.output_modalities : fetched.output_modalities,
          is_moderated: d.is_moderated || fetched.is_moderated,
          max_completion_tokens: d.max_completion_tokens ?? fetched.max_completion_tokens,
          expiration_date: d.expiration_date ?? fetched.expiration_date,
          openrouter_model_id: d.openrouter_model_id || fetched.openrouter_model_id,
          metadata_synced_at: fetched.metadata_synced_at,
        }
      } catch (fetchErr: any) {
        const statusCode = fetchErr?.statusCode === 404 ? 404 : 400
        const errCode = fetchErr?.statusCode === 404 ? "openrouter_model_not_found" : "openrouter_fetch_failed"
        return jsonError(c, statusCode, errCode, fetchErr instanceof Error ? fetchErr.message : String(fetchErr))
      }
    }

    const [m] = await sql`
      INSERT INTO models (
        provider_id, model_id, label, input_price_per_1m, output_price_per_1m,
        input_cache_read_price_per_1m, input_cache_write_price_per_1m, request_price_flat,
        context_window, supports_tools, supports_vision, supports_json_mode,
        supports_structured_outputs, supports_reasoning,
        input_modalities, output_modalities, is_moderated,
        max_completion_tokens, expiration_date, openrouter_model_id, metadata_synced_at, enabled
      )
      VALUES (
        ${d.provider_id}, ${d.model_id}, ${d.label ?? null}, ${d.input_price_per_1m}, ${d.output_price_per_1m},
        ${d.input_cache_read_price_per_1m ?? null}, ${d.input_cache_write_price_per_1m ?? null}, ${d.request_price_flat ?? 0},
        ${d.context_window ?? null}, ${d.supports_tools}, ${d.supports_vision}, ${d.supports_json_mode},
        ${d.supports_structured_outputs}, ${d.supports_reasoning},
        ${d.input_modalities}, ${d.output_modalities}, ${d.is_moderated},
        ${d.max_completion_tokens ?? null}, ${d.expiration_date ?? null}, ${d.openrouter_model_id ?? null},
        ${d.metadata_synced_at ? new Date(d.metadata_synced_at) : null}, ${d.enabled}
      )
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "model.create",
      resource: "model",
      resourceId: m.id,
      ip: ip(c),
      metadata: { model_id: d.model_id, provider_id: d.provider_id },
    })
    return c.json({ id: m.id })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duplicate key/i.test(msg)) return jsonError(c, 409, "model_exists")
    return jsonError(c, 500, "model_create_failed", msg)
  }
})

const modelUpdateSchema = modelCreateSchema.partial()

adminApi.patch("/models/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const parsed = modelUpdateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data
  try {
    const existing = await sql`SELECT id FROM models WHERE id = ${id}`
    if (existing.length === 0) return jsonError(c, 404, "not_found")
    const map: Record<string, string> = {
      label: "label",
      input_price_per_1m: "input_price_per_1m",
      output_price_per_1m: "output_price_per_1m",
      input_cache_read_price_per_1m: "input_cache_read_price_per_1m",
      input_cache_write_price_per_1m: "input_cache_write_price_per_1m",
      request_price_flat: "request_price_flat",
      context_window: "context_window",
      supports_tools: "supports_tools",
      supports_vision: "supports_vision",
      supports_json_mode: "supports_json_mode",
      supports_structured_outputs: "supports_structured_outputs",
      supports_streaming: "supports_streaming",
      supports_reasoning: "supports_reasoning",
      supports_embeddings: "supports_embeddings",
      input_modalities: "input_modalities",
      output_modalities: "output_modalities",
      is_moderated: "is_moderated",
      max_completion_tokens: "max_completion_tokens",
      expiration_date: "expiration_date",
      openrouter_model_id: "openrouter_model_id",
      metadata_synced_at: "metadata_synced_at",
      enabled: "enabled",
    }
    const sets: string[] = []
    const params: any[] = []
    for (const [k, col] of Object.entries(map)) {
      if ((d as any)[k] !== undefined) {
        sets.push(col)
        params.push((d as any)[k])
      }
    }
    if (sets.length > 0) {
      const setSql = sets.map((s, i) => `${s} = $${i + 1}`).join(", ")
      await sql.unsafe(`UPDATE models SET ${setSql} WHERE id = $${sets.length + 1}`, [...params, id])
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "model.update",
      resource: "model",
      resourceId: id,
      ip: ip(c),
      metadata: { fields: Object.keys(d) },
    })
    return c.json({ ok: true })

  } catch (err) {
    return jsonError(c, 500, "model_update_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/models/:id/clone", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [m] = await sql`SELECT * FROM models WHERE id = ${id}`
    if (!m) return jsonError(c, 404, "not_found")
    const [clone] = await sql`
      INSERT INTO models (provider_id, model_id, label, input_price_per_1m, output_price_per_1m,
                          context_window, supports_tools, supports_vision, supports_json_mode, enabled)
      VALUES (${m.provider_id}, ${m.model_id + "-copy"}, ${(m.label ?? "") + " (copy)"}, ${m.input_price_per_1m}, ${m.output_price_per_1m},
              ${m.context_window}, ${m.supports_tools}, ${m.supports_vision}, ${m.supports_json_mode}, ${m.enabled})
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "model.update",
      resource: "model",
      resourceId: clone.id,
      ip: ip(c),
      metadata: { cloned_from: id },
    })
    return c.json({ id: clone.id })
  } catch (err) {
    return jsonError(c, 500, "model_clone_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/models/:id/toggle", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [m] = await sql`UPDATE models SET enabled = NOT enabled WHERE id = ${id} RETURNING enabled`
    if (!m) return jsonError(c, 404, "not_found")
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: m.enabled ? "model.enable" : "model.disable",
      resource: "model",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true, enabled: m.enabled })
  } catch (err) {
    return jsonError(c, 500, "model_toggle_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/models/:id/test", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [row] = await sql`
      SELECT m.model_id, p.base_url, p.api_key, p.name
        FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ${id}
    `
    if (!row) return jsonError(c, 404, "not_found")
    const url = `${row.base_url.replace(/\/$/, "")}/chat/completions`
    const start = Date.now()
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(row.api_key ? { Authorization: `Bearer ${row.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: row.model_id,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const latency = Date.now() - start
    const ok = res.status < 500
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "provider.test",
      resource: "model",
      resourceId: id,
      ip: ip(c),
      result: ok ? "success" : "failure",
      metadata: { model: row.model_id, status: res.status, latency_ms: latency },
    })
    return c.json({ ok, status: res.status, latency_ms: latency })
  } catch (err) {
    return jsonError(c, 500, "model_test_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.delete("/models/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`DELETE FROM models WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "model.delete",
      resource: "model",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "model_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

adminApi.get("/routing", async (c) => {
  try {
    const routes = await sql`
      SELECT tr.id, tr.tier, tr.weight, tr.enabled,
             m.id AS model_id, m.model_id, m.label,
             p.id AS provider_id, p.name AS provider_name, p.base_url
        FROM tier_routes tr
        JOIN models m ON m.id = tr.model_id
        JOIN providers p ON p.id = m.provider_id
       ORDER BY tr.tier, tr.weight DESC
    `
    return c.json({ routes })
  } catch (err) {
    return jsonError(c, 500, "routing_list_failed", err instanceof Error ? err.message : String(err))
  }
})

const routeCreateSchema = z.object({
  tier: z.enum(["trivial", "simple", "medium", "complex"]),
  model_id: z.string().uuid(),
  weight: z.coerce.number().min(0).default(1),
})

adminApi.post("/routing", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = routeCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data
  try {
    const [r] = await sql`
      INSERT INTO tier_routes (tier, model_id, weight) VALUES (${d.tier}, ${d.model_id}, ${d.weight})
      ON CONFLICT (tier, model_id) DO UPDATE SET weight = ${d.weight}
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "route.create",
      resource: "routing",
      resourceId: r.id,
      ip: ip(c),
      metadata: { tier: d.tier, model_id: d.model_id },
    })
    return c.json({ id: r.id })
  } catch (err) {
    return jsonError(c, 500, "routing_create_failed", err instanceof Error ? err.message : String(err))
  }
})

const routeUpdateSchema = routeCreateSchema.partial()

adminApi.patch("/routing/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const parsed = routeUpdateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data
  try {
    const sets: string[] = []
    const params: any[] = []
    if (d.tier) { sets.push("tier"); params.push(d.tier) }
    if (d.weight !== undefined) { sets.push("weight"); params.push(d.weight) }
    if (sets.length > 0) {
      const setSql = sets.map((s, i) => `${s} = $${i + 1}`).join(", ")
      await sql.unsafe(`UPDATE tier_routes SET ${setSql} WHERE id = $${sets.length + 1}`, [...params, id])
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "route.update",
      resource: "routing",
      resourceId: id,
      ip: ip(c),
      metadata: { fields: Object.keys(d) },
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "routing_update_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/routing/:id/toggle", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [r] = await sql`UPDATE tier_routes SET enabled = NOT enabled WHERE id = ${id} RETURNING enabled`
    if (!r) return jsonError(c, 404, "not_found")
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: r.enabled ? "route.enable" : "route.disable",
      resource: "routing",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true, enabled: r.enabled })
  } catch (err) {
    return jsonError(c, 500, "routing_toggle_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.delete("/routing/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`DELETE FROM tier_routes WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "route.delete",
      resource: "routing",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "routing_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Requests explorer
// ---------------------------------------------------------------------------

const requestListSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  user_id: z.string().uuid().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(["success", "failure", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

adminApi.get("/requests", async (c) => {
  const parsed = requestListSchema.safeParse(c.req.query())
  if (!parsed.success) return jsonError(c, 400, "invalid_query")
  const f = parsed.data
  try {
    const where: string[] = []
    const params: any[] = []
    if (f.from) { params.push(f.from); where.push(`r.created_at >= $${params.length}`) }
    if (f.to) { params.push(f.to); where.push(`r.created_at <= $${params.length}`) }
    if (f.user_id) { params.push(f.user_id); where.push(`r.user_id = $${params.length}`) }
    if (f.provider) { params.push(`%${f.provider}%`); where.push(`r.model_label LIKE $${params.length}`) }
    if (f.model) { params.push(`%${f.model}%`); where.push(`r.model_label LIKE $${params.length}`) }
    if (f.status) { params.push(f.status); where.push(`r.status = $${params.length}`) }

    params.push(f.limit); const limitIdx = params.length
    params.push(f.offset); const offsetIdx = params.length

    const rows = await sql.unsafe(
      `SELECT r.id, r.created_at, r.user_id, u.email AS user_email,
              r.model_label, r.status, r.reject_reason, r.cost_usd,
              r.input_tokens, r.output_tokens, r.cached_tokens,
              r.latency_ms, r.from_cache, r.ip
         FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY r.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    return c.json({ requests: rows })
  } catch (err) {
    return jsonError(c, 500, "requests_list_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/requests/:id", async (c) => {
  try {
    const [r] = await sql.unsafe(
      `SELECT r.*, u.email AS user_email FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
      [c.req.param("id")],
    )
    if (!r) return jsonError(c, 404, "not_found")
    return c.json({ request: r })
  } catch (err) {
    return jsonError(c, 500, "request_get_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// API keys admin
// ---------------------------------------------------------------------------

adminApi.get("/api-keys", async (c) => {
  try {
    const rows = await sql`
      SELECT k.id, k.user_id, k.key_prefix, k.label, k.created_at, k.last_used_at, k.revoked, k.combo_id,
             u.email AS user_email,
             c.slug AS combo_slug, c.name AS combo_name
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
        LEFT JOIN combos c ON c.id = k.combo_id
       ORDER BY k.created_at DESC
       LIMIT 500
    `
    return c.json({ keys: rows })
  } catch (err) {
    return jsonError(c, 500, "api_keys_list_failed", err instanceof Error ? err.message : String(err))
  }
})

const apiKeyCreateSchema = z.object({
  user_id: z.string().uuid(),
  label: z.string().max(128).optional(),
  combo_id: z.string().uuid().optional().nullable(),
})

adminApi.post("/api-keys", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = apiKeyCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  try {
    const { raw, hash, prefix } = (await import("../lib/apikeys")).generateApiKey()
    const [k] = await sql`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, label, combo_id)
      VALUES (${parsed.data.user_id}, ${hash}, ${prefix}, ${parsed.data.label ?? null}, ${parsed.data.combo_id ?? null})
      RETURNING id, created_at, key_prefix
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "api_key.create",
      resource: "api_key",
      resourceId: k.id,
      ip: ip(c),
      metadata: { user_id: parsed.data.user_id, label: parsed.data.label ?? null },
    })
    return c.json({ id: k.id, api_key: raw, prefix: k.key_prefix, created_at: k.created_at })
  } catch (err) {
    return jsonError(c, 500, "api_key_create_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/api-keys/:id/revoke", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [k] = await sql`UPDATE api_keys SET revoked = true WHERE id = ${id} RETURNING id`
    if (!k) return jsonError(c, 404, "not_found")
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "api_key.revoke",
      resource: "api_key",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "api_key_revoke_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/api-keys/:id/rotate", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [existing] = await sql`SELECT user_id, label, combo_id FROM api_keys WHERE id = ${id}`
    if (!existing) return jsonError(c, 404, "not_found")
    const { raw, hash, prefix } = (await import("../lib/apikeys")).generateApiKey()
    const [k] = await sql`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, label, combo_id)
      VALUES (${existing.user_id}, ${hash}, ${prefix}, ${(existing.label ?? "") + " (rotated)"}, ${existing.combo_id})
      RETURNING id, created_at, key_prefix
    `
    await sql`UPDATE api_keys SET revoked = true WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "api_key.rotate",
      resource: "api_key",
      resourceId: k.id,
      ip: ip(c),
      metadata: { rotated_from: id },
    })
    return c.json({ id: k.id, api_key: raw, prefix: k.key_prefix, created_at: k.created_at })
  } catch (err) {
    return jsonError(c, 500, "api_key_rotate_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

adminApi.get("/combos", async (c) => {
  try {
    const rows = await sql`
      SELECT id, slug, name, description, status, routing_strategy,
             rate_limit_rpm, monthly_token_cap, monthly_cost_cap_usd,
             is_template, created_at, updated_at
        FROM combos ORDER BY is_template DESC, created_at DESC
    `
    return c.json({ combos: rows })
  } catch (err) {
    return jsonError(c, 500, "combos_list_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/combos/:id", async (c) => {
  try {
    const [combo] = await sql`SELECT * FROM combos WHERE id = ${c.req.param("id")}`
    if (!combo) return jsonError(c, 404, "not_found")
    const providers = combo.provider_ids?.length
      ? await sql`SELECT id, name, base_url, provider_type FROM providers WHERE id = ANY(${combo.provider_ids})`
      : []
    const models = combo.model_ids?.length
      ? await sql`SELECT m.id, m.model_id, m.label, p.name AS provider_name FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ANY(${combo.model_ids})`
      : []
    return c.json({ combo, providers, models })
  } catch (err) {
    return jsonError(c, 500, "combo_get_failed", err instanceof Error ? err.message : String(err))
  }
})

const comboCreateSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional().nullable(),
  status: z.enum(["active", "archived", "draft"]).default("active"),
  provider_ids: z.array(z.string().uuid()).default([]),
  model_ids: z.array(z.string().uuid()).default([]),
  routing_strategy: z.enum([
    "priority", "weighted", "round-robin", "cost-optimized",
    "latency-optimized", "fallback", "health",
  ]).default("fallback"),
  routing_config: z.record(z.any()).default({}),
  fallback_chain: z.array(z.string().uuid()).default([]),
  defaults: z.record(z.any()).default({}),
  rate_limit_rpm: z.coerce.number().int().min(0).default(60),
  monthly_token_cap: z.coerce.number().int().min(0).default(0),
  monthly_cost_cap_usd: z.coerce.number().min(0).default(0),
  allowed_user_ids: z.array(z.string().uuid()).default([]),
  is_template: z.boolean().default(false),
})

adminApi.post("/combos", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = comboCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload", JSON.stringify(parsed.error.flatten()))
  const d = parsed.data
  try {
    const [cb] = await sql`
      INSERT INTO combos (slug, name, description, status,
                          provider_ids, model_ids,
                          routing_strategy, routing_config, fallback_chain,
                          defaults, rate_limit_rpm,
                          monthly_token_cap, monthly_cost_cap_usd,
                          allowed_user_ids, is_template)
      VALUES (${d.slug}, ${d.name}, ${d.description ?? null}, ${d.status},
              ${sql.array(d.provider_ids)}, ${sql.array(d.model_ids)},
              ${d.routing_strategy}, ${sql.json(d.routing_config)}, ${sql.array(d.fallback_chain)},
              ${sql.json(d.defaults)}, ${d.rate_limit_rpm},
              ${d.monthly_token_cap}, ${d.monthly_cost_cap_usd},
              ${sql.array(d.allowed_user_ids)}, ${d.is_template})
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.create",
      resource: "combo",
      resourceId: cb.id,
      ip: ip(c),
      metadata: { slug: d.slug, name: d.name, routing_strategy: d.routing_strategy },
    })
    return c.json({ id: cb.id })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duplicate key/i.test(msg)) return jsonError(c, 409, "slug_taken")
    return jsonError(c, 500, "combo_create_failed", msg)
  }
})

const comboUpdateSchema = comboCreateSchema.partial()

adminApi.patch("/combos/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const parsed = comboUpdateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data
  try {
    const map: Record<string, string> = {
      slug: "slug",
      name: "name",
      description: "description",
      status: "status",
      routing_strategy: "routing_strategy",
      rate_limit_rpm: "rate_limit_rpm",
      monthly_token_cap: "monthly_token_cap",
      monthly_cost_cap_usd: "monthly_cost_cap_usd",
      is_template: "is_template",
    }
    const sets: string[] = []
    const params: any[] = []
    for (const [k, col] of Object.entries(map)) {
      if ((d as any)[k] !== undefined) {
        sets.push(col)
        params.push((d as any)[k])
      }
    }
    if (d.provider_ids !== undefined) { sets.push("provider_ids"); params.push(sql.array(d.provider_ids)) }
    if (d.model_ids !== undefined) { sets.push("model_ids"); params.push(sql.array(d.model_ids)) }
    if (d.fallback_chain !== undefined) { sets.push("fallback_chain"); params.push(sql.array(d.fallback_chain)) }
    if (d.allowed_user_ids !== undefined) { sets.push("allowed_user_ids"); params.push(sql.array(d.allowed_user_ids)) }
    if (d.routing_config !== undefined) { sets.push("routing_config"); params.push(sql.json(d.routing_config)) }
    if (d.defaults !== undefined) { sets.push("defaults"); params.push(sql.json(d.defaults)) }
    if (sets.length > 0) {
      const setSql = sets.map((s, i) => `${s} = $${i + 1}`).join(", ")
      await sql.unsafe(`UPDATE combos SET ${setSql} WHERE id = $${sets.length + 1}`, [...params, id])
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.update",
      resource: "combo",
      resourceId: id,
      ip: ip(c),
      metadata: { fields: Object.keys(d) },
    })
    return c.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duplicate key/i.test(msg)) return jsonError(c, 409, "slug_taken")
    return jsonError(c, 500, "combo_update_failed", msg)
  }
})

adminApi.post("/combos/:id/clone", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [src] = await sql`SELECT * FROM combos WHERE id = ${id}`
    if (!src) return jsonError(c, 404, "not_found")
    const newSlug = `${src.slug}-copy-${Date.now().toString(36).slice(-4)}`
    const [cb] = await sql`
      INSERT INTO combos (slug, name, description, status,
                          provider_ids, model_ids,
                          routing_strategy, routing_config, fallback_chain,
                          defaults, rate_limit_rpm,
                          monthly_token_cap, monthly_cost_cap_usd,
                          allowed_user_ids, is_template)
      VALUES (${newSlug}, ${(src.name ?? "") + " (copy)"}, ${src.description}, 'draft',
              ${sql.array(src.provider_ids ?? [])}, ${sql.array(src.model_ids ?? [])},
              ${src.routing_strategy}, ${sql.json(src.routing_config ?? {})}, ${sql.array(src.fallback_chain ?? [])},
              ${sql.json(src.defaults ?? {})}, ${src.rate_limit_rpm},
              ${src.monthly_token_cap}, ${src.monthly_cost_cap_usd},
              ${sql.array(src.allowed_user_ids ?? [])}, false)
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.clone",
      resource: "combo",
      resourceId: cb.id,
      ip: ip(c),
      metadata: { cloned_from: id },
    })
    return c.json({ id: cb.id, slug: newSlug })
  } catch (err) {
    return jsonError(c, 500, "combo_clone_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/combos/:id/archive", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`UPDATE combos SET status = 'archived' WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.archive",
      resource: "combo",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "combo_archive_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/combos/:id/export", async (c) => {
  try {
    const [cb] = await sql`SELECT * FROM combos WHERE id = ${c.req.param("id")}`
    if (!cb) return jsonError(c, 404, "not_found")
    return c.json({ combo: cb, exported_at: new Date().toISOString() })
  } catch (err) {
    return jsonError(c, 500, "combo_export_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/combos/import", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== "object" || !body.combo) return jsonError(c, 400, "invalid_payload")
  const src = body.combo as any
  try {
    const slug = `${src.slug}-imported-${Date.now().toString(36).slice(-4)}`
    const [cb] = await sql`
      INSERT INTO combos (slug, name, description, status,
                          provider_ids, model_ids,
                          routing_strategy, routing_config, fallback_chain,
                          defaults, rate_limit_rpm,
                          monthly_token_cap, monthly_cost_cap_usd,
                          allowed_user_ids, is_template)
      VALUES (${slug}, ${src.name + " (imported)"}, ${src.description ?? null}, 'draft',
              ${sql.array(src.provider_ids ?? [])}, ${sql.array(src.model_ids ?? [])},
              ${src.routing_strategy ?? "fallback"}, ${sql.json(src.routing_config ?? {})}, ${sql.array(src.fallback_chain ?? [])},
              ${sql.json(src.defaults ?? {})}, ${src.rate_limit_rpm ?? 60},
              ${src.monthly_token_cap ?? 0}, ${src.monthly_cost_cap_usd ?? 0},
              ${sql.array(src.allowed_user_ids ?? [])}, false)
      RETURNING id
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.import",
      resource: "combo",
      resourceId: cb.id,
      ip: ip(c),
      metadata: { imported_from: src.slug ?? null },
    })
    return c.json({ id: cb.id, slug })
  } catch (err) {
    return jsonError(c, 500, "combo_import_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.delete("/combos/:id", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`DELETE FROM combos WHERE id = ${id}`
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.delete",
      resource: "combo",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "combo_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.post("/combos/:id/test", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    const [cb] = await sql`SELECT * FROM combos WHERE id = ${id}`
    if (!cb) return jsonError(c, 404, "not_found")
    const providers = cb.provider_ids?.length
      ? await sql`SELECT id, name, base_url, api_key, provider_type, enabled, healthy FROM providers WHERE id = ANY(${cb.provider_ids})`
      : []
    const results: { provider: string; ok: boolean; status: number; latency_ms: number }[] = []
    for (const p of providers as any[]) {
      if (!p.enabled) continue
      try {
        const url = `${p.base_url.replace(/\/$/, "")}${p.provider_type === "anthropic-compatible" ? "" : "/models"}`
        const headers: Record<string, string> = {}
        if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`
        const start = Date.now()
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
        results.push({ provider: p.name, ok: res.ok, status: res.status, latency_ms: Date.now() - start })
      } catch {
        results.push({ provider: p.name, ok: false, status: 0, latency_ms: 0 })
      }
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "combo.update",
      resource: "combo",
      resourceId: id,
      ip: ip(c),
      metadata: { test: results },
    })
    return c.json({ results })
  } catch (err) {
    return jsonError(c, 500, "combo_test_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditListSchema = z.object({
  actor_id: z.string().uuid().optional(),
  resource: z.string().optional(),
  action: z.string().optional(),
  result: z.enum(["success", "failure", "denied"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

adminApi.get("/audit", async (c) => {
  const parsed = auditListSchema.safeParse(c.req.query())
  if (!parsed.success) return jsonError(c, 400, "invalid_query")
  const f = parsed.data
  try {
    const where: string[] = []
    const params: any[] = []
    if (f.actor_id) { params.push(f.actor_id); where.push(`actor_id = $${params.length}`) }
    if (f.resource) { params.push(f.resource); where.push(`resource = $${params.length}`) }
    if (f.action) { params.push(`%${f.action}%`); where.push(`action LIKE $${params.length}`) }
    if (f.result) { params.push(f.result); where.push(`result = $${params.length}`) }
    if (f.from) { params.push(f.from); where.push(`created_at >= $${params.length}`) }
    if (f.to) { params.push(f.to); where.push(`created_at <= $${params.length}`) }
    params.push(f.limit); const limitIdx = params.length
    params.push(f.offset); const offsetIdx = params.length

    const rows = await sql.unsafe(
      `SELECT id, actor_id, actor_email, action, resource, resource_id, ip, result, metadata, created_at
         FROM audit_logs
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    return c.json({ events: rows })
  } catch (err) {
    return jsonError(c, 500, "audit_list_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Settings + me
// ---------------------------------------------------------------------------

adminApi.get("/settings", async (c) => {
  try {
    const [s] = await sql`
      SELECT
        (SELECT count(*) FROM users) AS users_total,
        (SELECT count(*) FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE s.status='suspended') AS users_suspended,
        (SELECT count(*) FROM providers WHERE enabled) AS providers_active,
        (SELECT count(*) FROM models WHERE enabled) AS models_active,
        (SELECT count(*) FROM api_keys WHERE revoked = false) AS api_keys_active,
        (SELECT count(*) FROM combos WHERE status='active') AS combos_active
    `
    return c.json({ summary: s, env: { app_url: process.env.APP_URL, port: process.env.PORT } })
  } catch (err) {
    return jsonError(c, 500, "settings_get_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/me", async (c) => {
  const session = c.var.session
  const [u] = await withDbResilience(() => sql`SELECT id, email, role FROM users WHERE id = ${session.userId}`)
  return c.json({ user: u })
})