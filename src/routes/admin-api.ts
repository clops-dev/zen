import { Hono } from "hono"
import { z } from "zod"
import { normalizeEmail } from "../lib/email"
import { sql, withDbResilience } from "../lib/db"
import { requireAdmin } from "../middleware/session-auth"
import { csrfProtection } from "../middleware/csrf"
import { revokeAllUserSessions } from "../lib/session"
import { invalidateActiveUserCache } from "../lib/active-user"
import { audit, actorEmailFor } from "../lib/audit"
import { fetchOpenRouterModelMetadata } from "../lib/openrouter"
import { validateSafeUrl, safeFetch } from "../lib/ssrf"
import { maskApiKey, encryptSecret, decryptSecret } from "../lib/crypto"

import {
  getBalance,
  getTransactionHistory,
  addCredits,
  isValidPackage,
  DT_PER_USD,
  getPendingPaymentDemands,
  confirmPaymentDemand,
  rejectPaymentDemand,
  getUserBillingSummary,
  getAdminBillingOverview,
  CREDIT_PACKAGES,
} from "../lib/credits"

export const adminApi = new Hono()
adminApi.use("*", requireAdmin())
adminApi.use("*", csrfProtection())

adminApi.get("/credit-packages", (c) => c.json({ packages: CREDIT_PACKAGES, dt_per_usd: DT_PER_USD }))

import { getClientIp } from "../lib/client-ip"

const jsonError = (c: any, status: number, code: string, message?: string) =>
  c.json({ error: code, message: message ?? code }, status)

const ip = (c: any) => getClientIp(c)

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
      SELECT id, name, base_url, provider_type, enabled, healthy, health_state, consecutive_failures, last_failure_at, cooldown_until, last_failure_reason, last_success_at
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
  search: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  plan: z.enum(["free", "paid"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  sort: z.enum(["created_at"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
})

const userSortColumns = { created_at: sql`u.created_at` } as const
const userOrderFragments = { asc: sql`ASC`, desc: sql`DESC` } as const

type UserCursor = { created_at: string; id: string }

function decodeUserCursor(value: string | undefined): UserCursor | null {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as UserCursor
    if (typeof decoded.created_at !== "string" || typeof decoded.id !== "string") return null
    return decoded
  } catch {
    return null
  }
}

function encodeUserCursor(row: { created_at: unknown; id: string } | Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ created_at: new Date(row.created_at as string).toISOString(), id: row.id })).toString("base64url")
}

adminApi.get("/users", async (c) => {
  const parsed = userListSchema.safeParse(c.req.query())
  if (!parsed.success) return jsonError(c, 400, "invalid_query")
  const cursor = decodeUserCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return jsonError(c, 400, "invalid_cursor")
  const search = parsed.data.search ?? parsed.data.q ?? ""
  const limit = parsed.data.limit
  const sortColumn = userSortColumns[parsed.data.sort]
  const order = userOrderFragments[parsed.data.order]
  const afterCursor = cursor
    ? parsed.data.order === "desc"
      ? sql`AND (u.created_at, u.id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
      : sql`AND (u.created_at, u.id) > (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
    : sql``
  try {
    const rows = await sql`
      SELECT u.id, u.email, u.role, u.status, u.email_verified, u.created_at,
             COALESCE(s.tier, 'free') AS tier,
             COALESCE(s.status, 'active') AS subscription_status,
             COALESCE(k.active_keys, 0) AS active_keys,
             k.last_login_at,
             r.last_active_at,
             COALESCE(r.requests, 0) AS requests,
             COALESCE(r.input_tokens, 0) AS input_tokens,
             COALESCE(r.output_tokens, 0) AS output_tokens,
             COALESCE(f.risk_score, 0) AS risk_score,
             COALESCE(f.risk_level, 'low') AS risk_level,
             COALESCE(f.flag_reason, '') AS risk_flags,
             COALESCE(cr.purchased_dt, 0) AS credits_purchased_dt,
             COALESCE(cr.usage_cost, 0) AS usage_cost,
             COALESCE(cr.remaining_dt, 0) AS remaining_credits_dt
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE NOT revoked) AS active_keys, max(last_used_at) AS last_login_at
            FROM api_keys WHERE user_id = u.id
        ) k ON true
        LEFT JOIN LATERAL (
          SELECT max(created_at) AS last_active_at, count(*) AS requests,
                 COALESCE(sum(input_tokens), 0) AS input_tokens,
                 COALESCE(sum(output_tokens), 0) AS output_tokens
            FROM ai_requests WHERE user_id = u.id
        ) r ON true
        LEFT JOIN flagged_accounts f ON f.user_id = u.id AND f.status = 'pending'
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(amount_dt) FILTER (WHERE type IN ('purchase', 'admin_grant') AND status = 'completed'), 0) AS purchased_dt,
                 COALESCE(sum(amount_dt) FILTER (WHERE type = 'usage' AND status = 'completed'), 0) / ${DT_PER_USD} AS usage_cost,
                 COALESCE(sum(amount_dt) FILTER (WHERE status = 'completed'), 0) AS remaining_dt
            FROM credit_transactions WHERE user_id = u.id
        ) cr ON true
       WHERE (${search} = '' OR u.email ILIKE ${"%" + search + "%"})
         AND (${parsed.data.plan ? sql`COALESCE(s.tier, 'free') ${parsed.data.plan === "free" ? sql`=` : sql`<>`} 'free'` : sql`TRUE`})
         AND (${parsed.data.status ? sql`u.status = ${parsed.data.status}` : sql`TRUE`})
         ${afterCursor}
       ORDER BY ${sortColumn} ${order}, u.id ${order}
       LIMIT ${limit + 1}
    `
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && pageRows.length > 0 ? encodeUserCursor(pageRows[pageRows.length - 1]) : null
    const [countRow] = await sql`SELECT count(*) AS count FROM users WHERE created_at >= now() - interval '24 hours'`
    const users = pageRows.map((r: any) => ({
      id: r.id, email: r.email, role: r.role, status: r.status, tier: r.tier,
      subscription_status: r.subscription_status, created_at: r.created_at,
      email_verified: r.email_verified, active_keys: Number(r.active_keys),
      last_login_at: r.last_login_at ?? null, last_active_at: r.last_active_at ?? null,
      risk_score: Number(r.risk_score), risk_level: r.risk_level, risk_flags: r.risk_flags,
      credits_purchased_dt: Number(r.credits_purchased_dt), usage_cost: Number(r.usage_cost),
      remaining_credits_dt: Number(r.remaining_credits_dt), requests: Number(r.requests),
      input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
      tokens: Number(r.input_tokens) + Number(r.output_tokens),
    }))
    return c.json({ users, next_cursor: nextCursor, has_more: hasMore, new_last_24h: Number(countRow?.count ?? 0) })
  } catch (err) {
    return jsonError(c, 500, "users_list_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/billing", async (c) => {
  try {
    const overview = await getAdminBillingOverview()
    return c.json(overview)
  } catch (err) {
    return jsonError(c, 500, "admin_billing_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/users/:id/billing", async (c) => {
  const userId = c.req.param("id")
  try {
    const summary = await getUserBillingSummary(userId)
    const txs = await getTransactionHistory(userId, 50)
    return c.json({ summary, transactions: txs })
  } catch (err) {
    return jsonError(c, 500, "user_billing_failed", err instanceof Error ? err.message : String(err))
  }
})

const userCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  role: z.enum(["user", "admin"]).default("user"),
  tier: z.enum(["free", "pro", "enterprise"]).default("free"),
  subscription_price_usd: z.coerce.number().min(0).optional(),
  token_budget_monthly: z.coerce.number().int().min(0).default(50000),
  spending_cap_usd: z.coerce.number().min(0).optional().nullable(),
  spending_cap_enabled: z.boolean().default(false),
  spending_cap_period: z.enum(["monthly"]).default("monthly"),
})

adminApi.post("/users", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = userCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload", JSON.stringify(parsed.error.flatten()))
  const { email: rawEmail, password, role, tier, subscription_price_usd, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period } = parsed.data
  const email = normalizeEmail(rawEmail)
  try {
    const existing = await sql`SELECT id FROM users WHERE lower(email) = ${email}`
    if (existing.length > 0) return jsonError(c, 409, "email_taken")
    const { hashPassword } = await import("../lib/password")
    const hash = await hashPassword(password)
    const [u] = await sql`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, ${role}) RETURNING id
    `
    const cap = spending_cap_usd !== undefined ? spending_cap_usd : null
    const price = subscription_price_usd !== undefined ? subscription_price_usd : (tier === "pro" ? 20 : tier === "enterprise" ? 100 : 0)
    const hasPriceCol = await requireColumn("subscriptions", "subscription_price_usd")
    if (hasPriceCol) {
      await sql`
        INSERT INTO subscriptions (user_id, tier, status, subscription_price_usd, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period)
        VALUES (${u.id}, ${tier}, 'active', ${price}, ${token_budget_monthly}, ${cap}, ${spending_cap_enabled}, ${spending_cap_period})
        ON CONFLICT (user_id) DO UPDATE SET
          tier=${tier},
          subscription_price_usd=${price},
          token_budget_monthly=${token_budget_monthly},
          spending_cap_usd=${cap},
          spending_cap_enabled=${spending_cap_enabled},
          spending_cap_period=${spending_cap_period}
      `
    } else {
      await sql`
        INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period)
        VALUES (${u.id}, ${tier}, 'active', ${token_budget_monthly}, ${cap}, ${spending_cap_enabled}, ${spending_cap_period})
        ON CONFLICT (user_id) DO UPDATE SET
          tier=${tier},
          token_budget_monthly=${token_budget_monthly},
          spending_cap_usd=${cap},
          spending_cap_enabled=${spending_cap_enabled},
          spending_cap_period=${spending_cap_period}
      `
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.create",
      resource: "user",
      resourceId: u.id,
      ip: ip(c),
      metadata: { email, role, tier, subscription_price_usd: price, spending_cap_usd: cap, spending_cap_enabled },
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
  subscription_price_usd: z.coerce.number().min(0).optional(),
  token_budget_monthly: z.coerce.number().int().min(0).optional(),
  spending_cap_usd: z.coerce.number().min(0).optional().nullable(),
  spending_cap_enabled: z.boolean().optional(),
  spending_cap_period: z.enum(["monthly"]).optional(),
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
    if (parsed.data.role) {
      await sql`UPDATE users SET role = ${parsed.data.role} WHERE id = ${id}`
      await revokeAllUserSessions(id)
      invalidateActiveUserCache(id)
    }
    if (parsed.data.status) {
      try {
        await sql`UPDATE users SET status = ${parsed.data.status} WHERE id = ${id}`
      } catch {}
      if (parsed.data.status === "suspended") {
        await revokeAllUserSessions(id)
        invalidateActiveUserCache(id)
      }
    }
    if (
      parsed.data.tier || parsed.data.status || parsed.data.subscription_price_usd !== undefined || parsed.data.token_budget_monthly !== undefined ||
      parsed.data.spending_cap_usd !== undefined || parsed.data.spending_cap_enabled !== undefined || parsed.data.spending_cap_period !== undefined
    ) {
      const tier = parsed.data.tier ?? null
      const status = parsed.data.status ?? null
      const subPrice = parsed.data.subscription_price_usd !== undefined ? parsed.data.subscription_price_usd : null
      const budget = parsed.data.token_budget_monthly ?? null
      const capUsd = parsed.data.spending_cap_usd !== undefined ? parsed.data.spending_cap_usd : null
      const capEnabled = parsed.data.spending_cap_enabled !== undefined ? parsed.data.spending_cap_enabled : null
      const capPeriod = parsed.data.spending_cap_period ?? null

      const hasPriceCol = await requireColumn("subscriptions", "subscription_price_usd")
      if (hasPriceCol) {
        await sql`
          INSERT INTO subscriptions (user_id, tier, status, subscription_price_usd, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period)
          VALUES (${id}, ${parsed.data.tier ?? "free"}, ${parsed.data.status ?? "active"}, ${subPrice ?? 0}, ${parsed.data.token_budget_monthly ?? 50000}, ${capUsd}, ${parsed.data.spending_cap_enabled ?? false}, ${parsed.data.spending_cap_period ?? "monthly"})
          ON CONFLICT (user_id) DO UPDATE SET
            tier = COALESCE(${tier}::text, subscriptions.tier),
            status = COALESCE(${status}::text, subscriptions.status),
            subscription_price_usd = CASE WHEN ${parsed.data.subscription_price_usd !== undefined} THEN ${subPrice}::numeric ELSE subscriptions.subscription_price_usd END,
            token_budget_monthly = COALESCE(${budget}::bigint, subscriptions.token_budget_monthly),
            spending_cap_usd = CASE WHEN ${parsed.data.spending_cap_usd !== undefined} THEN ${capUsd}::numeric ELSE subscriptions.spending_cap_usd END,
            spending_cap_enabled = CASE WHEN ${parsed.data.spending_cap_enabled !== undefined} THEN ${capEnabled}::boolean ELSE subscriptions.spending_cap_enabled END,
            spending_cap_period = COALESCE(${capPeriod}::text, subscriptions.spending_cap_period)
        `
      } else {
        await sql`
          INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly, spending_cap_usd, spending_cap_enabled, spending_cap_period)
          VALUES (${id}, ${parsed.data.tier ?? "free"}, ${parsed.data.status ?? "active"}, ${parsed.data.token_budget_monthly ?? 50000}, ${capUsd}, ${parsed.data.spending_cap_enabled ?? false}, ${parsed.data.spending_cap_period ?? "monthly"})
          ON CONFLICT (user_id) DO UPDATE SET
            tier = COALESCE(${tier}::text, subscriptions.tier),
            status = COALESCE(${status}::text, subscriptions.status),
            token_budget_monthly = COALESCE(${budget}::bigint, subscriptions.token_budget_monthly),
            spending_cap_usd = CASE WHEN ${parsed.data.spending_cap_usd !== undefined} THEN ${capUsd}::numeric ELSE subscriptions.spending_cap_usd END,
            spending_cap_enabled = CASE WHEN ${parsed.data.spending_cap_enabled !== undefined} THEN ${capEnabled}::boolean ELSE subscriptions.spending_cap_enabled END,
            spending_cap_period = COALESCE(${capPeriod}::text, subscriptions.spending_cap_period)
        `
      }
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.update",
      resource: "user",
      resourceId: id,
      ip: ip(c),
      requestId: c.get("requestId") ?? c.req.header("x-request-id"),
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
    await revokeAllUserSessions(id)
    invalidateActiveUserCache(id)
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "user.delete",
      resource: "user",
      resourceId: id,
      ip: ip(c),
      requestId: c.get("requestId") ?? c.req.header("x-request-id"),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "user_delete_failed", err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Wallet & Subscription Income / Usage Endpoint
// ---------------------------------------------------------------------------

adminApi.get("/wallet/summary", async (c) => {
  try {
    const hasPriceCol = await requireColumn("subscriptions", "subscription_price_usd")

    const [userRows, creditRevenueRows, txRows] = await Promise.all([
      sql`
        SELECT
          u.id,
          u.email,
          u.role,
          u.created_at,
          COALESCE(s.tier, 'free') AS tier,
          COALESCE(s.status, 'active') AS subscription_status,
          ${hasPriceCol ? sql`COALESCE(s.subscription_price_usd, 0)` : sql`0`} AS subscription_price_usd,
          COALESCE(SUM(r.cost_usd), 0) AS usage_cost_usd,
          COALESCE(COUNT(r.id), 0) AS total_requests,
          COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
          MAX(r.created_at) AS last_active_at
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
        LEFT JOIN ai_requests r ON r.user_id = u.id
        GROUP BY u.id, u.email, u.role, u.created_at, s.tier, s.status${hasPriceCol ? sql`, s.subscription_price_usd` : sql``}
        ORDER BY u.created_at DESC
      `,
      sql`
        SELECT COALESCE(SUM(amount_dt), 0) AS total_revenue_dt
        FROM credit_transactions
        WHERE status = 'completed' AND type IN ('purchase', 'admin_grant')
      `,
      sql`
        SELECT
          ct.id,
          ct.user_id,
          u.email,
          ct.amount_dt,
          ct.type,
          ct.status,
          ct.admin_note,
          ct.payment_ref,
          ct.created_at,
          cb.email AS created_by_email
        FROM credit_transactions ct
        JOIN users u ON u.id = ct.user_id
        LEFT JOIN users cb ON cb.id = ct.created_by
        ORDER BY ct.created_at DESC
        LIMIT 100
      `,
    ])

    const totalRevenueDt = Number(creditRevenueRows[0]?.total_revenue_dt ?? 0)
    const totalCreditRevenueUsd = Number((totalRevenueDt / DT_PER_USD).toFixed(6))

    let accumulatedSubIncome = 0
    let accumulatedUsageCost = 0
    let totalRequests = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let activeUsersCount = 0

    const users = userRows.map((r: any) => {
      const subPrice = Number(Number(r.subscription_price_usd || 0).toFixed(6))
      const usageCost = Number(Number(r.usage_cost_usd || 0).toFixed(6))
      const reqCount = Number(r.total_requests || 0)
      const inTokens = Number(r.input_tokens || 0)
      const outTokens = Number(r.output_tokens || 0)
      const totTokens = inTokens + outTokens

      accumulatedSubIncome += subPrice
      accumulatedUsageCost += usageCost
      totalRequests += reqCount
      totalInputTokens += inTokens
      totalOutputTokens += outTokens
      if (reqCount > 0 || r.subscription_status === "active") {
        activeUsersCount++
      }

      return {
        id: r.id,
        email: r.email,
        role: r.role,
        tier: r.tier,
        subscription_status: r.subscription_status,
        subscription_price_usd: subPrice.toFixed(6),
        usage_cost_usd: usageCost.toFixed(6),
        net_income_usd: Number((subPrice - usageCost).toFixed(6)).toFixed(6),
        total_requests: reqCount,
        input_tokens: inTokens,
        output_tokens: outTokens,
        total_tokens: totTokens,
        last_active_at: r.last_active_at ?? null,
      }
    })

    const totalRevenueUsd = Number((accumulatedSubIncome + totalCreditRevenueUsd).toFixed(6))
    const totalNetIncomeUsd = Number((totalRevenueUsd - accumulatedUsageCost).toFixed(6))
    const profitMarginPct = totalRevenueUsd > 0 ? Number(((totalNetIncomeUsd / totalRevenueUsd) * 100).toFixed(2)) : 0
    const totalTokens = totalInputTokens + totalOutputTokens

    return c.json({
      totals: {
        accumulated_users: users.length,
        active_users: activeUsersCount,
        total_revenue_dt: totalRevenueDt.toFixed(2),
        total_revenue_usd: totalRevenueUsd.toFixed(6),
        total_subscription_income_usd: accumulatedSubIncome.toFixed(6),
        total_credit_revenue_usd: totalCreditRevenueUsd.toFixed(6),
        total_usage_cost_usd: accumulatedUsageCost.toFixed(6),
        total_net_income_usd: totalNetIncomeUsd.toFixed(6),
        profit_margin_pct: profitMarginPct,
        dt_per_usd: DT_PER_USD,
        total_requests: totalRequests,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_tokens: totalTokens,
        avg_income_per_user_usd: users.length > 0 ? (totalRevenueUsd / users.length).toFixed(6) : "0.000000",
        avg_cost_per_user_usd: users.length > 0 ? (accumulatedUsageCost / users.length).toFixed(6) : "0.000000",
      },
      users,
      transactions: txRows.map((r: any) => ({
        id: r.id,
        user_id: r.user_id,
        email: r.email,
        amount_dt: Number(r.amount_dt),
        amount_usd: Number((Number(r.amount_dt) / DT_PER_USD).toFixed(2)),
        type: r.type,
        status: r.status,
        admin_note: r.admin_note ?? null,
        payment_ref: r.payment_ref ?? null,
        created_at: r.created_at,
        created_by_email: r.created_by_email ?? null,
      })),
    })
  } catch (err) {
    return jsonError(c, 500, "wallet_summary_failed", err instanceof Error ? err.message : String(err))
  }
})

adminApi.get("/users/:id", async (c) => {
  try {
    const id = c.req.param("id")
    const [u] = await sql`
      SELECT u.id, u.email, u.role, u.created_at
        FROM users u WHERE u.id = ${id}
    `
    if (!u) return jsonError(c, 404, "not_found")
    const billing = await getUserBillingSummary(id)
    const keys = await sql`
      SELECT id, key_prefix, label, created_at, last_used_at, revoked
        FROM api_keys WHERE user_id = ${u.id} ORDER BY created_at DESC
    `
    return c.json({ user: { ...u, ...billing }, usage: billing, keys })
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
      SELECT id, name, base_url, provider_type, enabled, healthy, health_state, consecutive_failures, last_failure_at, cooldown_until, last_failure_reason, last_success_at, created_at
        FROM providers ORDER BY created_at DESC
    `
    // Never return raw api_key values — show masked preview only
    const masked = (await sql`SELECT id, api_key FROM providers`).reduce(
      (acc: any, r: any) => {
        const hasKey = Boolean(r.api_key)
        acc[r.id] = {
          has_key: hasKey,
          key_preview: hasKey ? maskApiKey(r.api_key) : "",
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
  provider_type: z.enum(["openai-compatible", "anthropic-compatible", "custom"]).default("openai-compatible"),
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
    // SSRF: validate base_url before persisting
    const urlCheck = await validateSafeUrl(d.base_url, { allowHttpDev: process.env.NODE_ENV !== "production" })
    if (!urlCheck.safe) return jsonError(c, 400, "invalid_base_url", `base_url rejected: ${urlCheck.error}`)

    // Encrypt API key at rest before storage
    const apiKeyToStore = d.api_key ? encryptSecret(d.api_key) : ""

    const [p] = await sql`
      INSERT INTO providers (name, base_url, api_key, provider_type, enabled, healthy, consecutive_failures)
      VALUES (${d.name}, ${d.base_url}, ${apiKeyToStore}, ${d.provider_type}, ${d.enabled}, true, 0)
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
      // Never log raw api_key in audit metadata
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

    // SSRF: validate base_url if it is being changed
    if (d.base_url !== undefined) {
      const urlCheck = await validateSafeUrl(d.base_url, { allowHttpDev: process.env.NODE_ENV !== "production" })
      if (!urlCheck.safe) return jsonError(c, 400, "invalid_base_url", `base_url rejected: ${urlCheck.error}`)
    }

    // Build a strictly allowlisted update object — columns come only from our code, not user input
    const updateFields: Record<string, unknown> = {}
    if (d.name !== undefined) updateFields.name = d.name
    if (d.base_url !== undefined) updateFields.base_url = d.base_url
    if (d.provider_type !== undefined) updateFields.provider_type = d.provider_type
    if (d.api_key !== undefined && d.api_key !== "") {
      updateFields.api_key = encryptSecret(d.api_key)
      updateFields.healthy = true
      updateFields.consecutive_failures = 0
    }
    if (d.enabled !== undefined) updateFields.enabled = d.enabled

    if (Object.keys(updateFields).length > 0) {
      await sql`UPDATE providers SET ${sql(updateFields)} WHERE id = ${id}`
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
    // SSRF: re-validate the stored URL before making the test request
    const urlCheck = await validateSafeUrl(`${p.base_url.replace(/\/$/, "")}${p.provider_type === "anthropic-compatible" ? "" : "/models"}`, { allowHttpDev: process.env.NODE_ENV !== "production" })
    if (!urlCheck.safe) return jsonError(c, 400, "invalid_base_url", `Stored base_url blocked: ${urlCheck.error}`)
    const url = urlCheck.url!.toString()
    const headers: Record<string, string> = {}
    if (p.api_key) {
      // Decrypt before use — never expose raw stored value
      const rawKey = decryptSecret(p.api_key)
      headers.Authorization = `Bearer ${rawKey}`
      headers["api-key"] = rawKey
    }
    const start = Date.now()
    const res = await safeFetch(url, { headers, timeoutMs: 8000, maxRedirects: 1, allowHttpDev: process.env.NODE_ENV !== "production" })
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

adminApi.post("/providers/:id/reset-health", async (c) => {
  const session = c.var.session
  const id = c.req.param("id")
  try {
    await sql`
      UPDATE providers
      SET healthy = true,
          health_state = 'HEALTHY',
          consecutive_failures = 0,
          cooldown_until = NULL,
          last_failure_reason = NULL,
          last_success_at = now()
      WHERE id = ${id}
    `
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "provider.reset_health",
      resource: "provider",
      resourceId: id,
      ip: ip(c),
    })
    return c.json({ ok: true })
  } catch (err) {
    return jsonError(c, 500, "provider_reset_health_failed", err instanceof Error ? err.message : String(err))
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
  supports_fim: z.boolean().default(false),
  quality_score: z.coerce.number().int().min(0).max(100).optional().nullable(),
  tokenizer: z.string().optional().nullable().default("approx"),
  max_output_tokens: z.coerce.number().int().positive().optional().nullable(),
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
        supports_structured_outputs, supports_reasoning, supports_fim, quality_score, tokenizer, max_output_tokens,
        input_modalities, output_modalities, is_moderated,
        max_completion_tokens, expiration_date, openrouter_model_id, metadata_synced_at, enabled
      )
      VALUES (
        ${d.provider_id}, ${d.model_id}, ${d.label ?? null}, ${d.input_price_per_1m}, ${d.output_price_per_1m},
        ${d.input_cache_read_price_per_1m ?? null}, ${d.input_cache_write_price_per_1m ?? null}, ${d.request_price_flat ?? 0},
        ${d.context_window ?? null}, ${d.supports_tools}, ${d.supports_vision}, ${d.supports_json_mode},
        ${d.supports_structured_outputs}, ${d.supports_reasoning}, ${d.supports_fim ?? false}, ${d.quality_score ?? null},
        ${d.tokenizer ?? 'approx'}, ${d.max_output_tokens ?? null},
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
      supports_fim: "supports_fim",
      quality_score: "quality_score",
      tokenizer: "tokenizer",
      max_output_tokens: "max_output_tokens",
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
      // Build allowlisted object from (col -> value) pairs already vetted above
      const updateFields: Record<string, unknown> = {}
      for (let i = 0; i < sets.length; i++) updateFields[sets[i]] = params[i]
      await sql`UPDATE models SET ${sql(updateFields)} WHERE id = ${id}`
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
    // SSRF: validate stored URL before making outbound request
    const rawUrl = `${row.base_url.replace(/\/$/, "")}/chat/completions`
    const urlCheck = await validateSafeUrl(rawUrl, { allowHttpDev: process.env.NODE_ENV !== "production" })
    if (!urlCheck.safe) return jsonError(c, 400, "invalid_base_url", `Stored base_url blocked: ${urlCheck.error}`)
    const url = urlCheck.url!.toString()
    // Decrypt stored api key before use
    const rawKey = row.api_key ? decryptSecret(row.api_key) : ""
    const start = Date.now()
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (rawKey) {
      headers.Authorization = `Bearer ${rawKey}`
    }
    const res = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: row.model_id,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      timeoutMs: 8000,
      maxRedirects: 1,
      allowHttpDev: process.env.NODE_ENV !== "production",
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
  tier: z.enum(["trivial", "simple", "medium", "complex"]).optional(),
  tiers: z.array(z.enum(["trivial", "simple", "medium", "complex"])).optional(),
  model_id: z.string().uuid(),
  weight: z.coerce.number().min(0).default(1),
  enabled: z.boolean().default(true),
})

adminApi.post("/routing", async (c) => {
  const session = c.var.session
  const body = await c.req.json().catch(() => null)
  const parsed = routeCreateSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_payload")
  const d = parsed.data

  const targetTiers = d.tiers && d.tiers.length > 0 ? d.tiers : (d.tier ? [d.tier] : [])
  if (targetTiers.length === 0) {
    return jsonError(c, 400, "invalid_payload", "At least one tier is required")
  }

  try {
    const createdIds: string[] = []
    for (const t of targetTiers) {
      const [r] = await sql`
        INSERT INTO tier_routes (tier, model_id, weight, enabled)
        VALUES (${t}, ${d.model_id}, ${d.weight}, ${d.enabled})
        ON CONFLICT (tier, model_id) DO UPDATE SET weight = ${d.weight}, enabled = ${d.enabled}
        RETURNING id
      `
      createdIds.push(r.id)
    }
    await audit({
      actorId: session.userId,
      actorEmail: await actorEmailFor(session.userId),
      action: "route.create",
      resource: "routing",
      resourceId: createdIds[0],
      ip: ip(c),
      metadata: { tiers: targetTiers, model_id: d.model_id },
    })
    return c.json({ ok: true, ids: createdIds, id: createdIds[0] })
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
      const updateFields: Record<string, unknown> = {}
      for (let i = 0; i < sets.length; i++) updateFields[sets[i]] = params[i]
      await sql`UPDATE tier_routes SET ${sql(updateFields)} WHERE id = ${id}`
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

    // All WHERE clauses built from internal allowlist only — user input bound as $N parameters
    const rows = await sql`
      SELECT r.id, r.created_at, r.user_id, u.email AS user_email,
             r.model_label, r.status, r.reject_reason, r.cost_usd,
             r.input_tokens, r.output_tokens, r.cached_tokens,
             r.latency_ms, r.from_cache, r.ip
        FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
        WHERE TRUE
          ${f.from ? sql`AND r.created_at >= ${f.from}` : sql``}
          ${f.to ? sql`AND r.created_at <= ${f.to}` : sql``}
          ${f.user_id ? sql`AND r.user_id = ${f.user_id}` : sql``}
          ${f.provider ? sql`AND r.model_label LIKE ${'%' + f.provider + '%'}` : sql``}
          ${f.model ? sql`AND r.model_label LIKE ${'%' + f.model + '%'}` : sql``}
          ${f.status ? sql`AND r.status = ${f.status}` : sql``}
        ORDER BY r.created_at DESC
        LIMIT ${f.limit} OFFSET ${f.offset}
    `
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
      requestId: c.get("requestId") ?? c.req.header("x-request-id"),
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
      requestId: c.get("requestId") ?? c.req.header("x-request-id"),
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
      const updateFields: Record<string, unknown> = {}
      for (let i = 0; i < sets.length; i++) updateFields[sets[i]] = params[i]
      await sql`UPDATE combos SET ${sql(updateFields)} WHERE id = ${id}`
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
        const rawUrl = `${p.base_url.replace(/\/$/, "")}${p.provider_type === "anthropic-compatible" ? "" : "/models"}`
        const urlCheck = await validateSafeUrl(rawUrl, { allowHttpDev: process.env.NODE_ENV !== "production" })
        if (!urlCheck.safe) {
          results.push({ provider: p.name, ok: false, status: 400, latency_ms: 0 })
          continue
        }
        const headers: Record<string, string> = {}
        if (p.api_key) {
          const rawKey = decryptSecret(p.api_key)
          headers.Authorization = `Bearer ${rawKey}`
        }
        const start = Date.now()
        const res = await safeFetch(urlCheck.url!.toString(), { headers, timeoutMs: 6000, maxRedirects: 1, allowHttpDev: process.env.NODE_ENV !== "production" })
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
    // All WHERE clauses built from internal allowlist — user input bound as SQL parameters
    const rows = await sql`
      SELECT id, actor_id, actor_email, action, resource, resource_id, ip, result, metadata, created_at
        FROM audit_logs
        WHERE TRUE
          ${f.actor_id ? sql`AND actor_id = ${f.actor_id}` : sql``}
          ${f.resource ? sql`AND resource = ${f.resource}` : sql``}
          ${f.action ? sql`AND action LIKE ${'%' + f.action + '%'}` : sql``}
          ${f.result ? sql`AND result = ${f.result}` : sql``}
          ${f.from ? sql`AND created_at >= ${f.from}` : sql``}
          ${f.to ? sql`AND created_at <= ${f.to}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${f.limit} OFFSET ${f.offset}
    `
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

// ---------------------------------------------------------------------------
// Admin credit management
// ---------------------------------------------------------------------------

/**
 * GET /admin-api/users/:id/credits
 * Returns the user's current balance + last 100 transactions.
 */
adminApi.get("/users/:id/credits", async (c) => {
  const userId = c.req.param("id")
  try {
    // Verify user exists
    const userRows = await withDbResilience(() => sql`SELECT id, email FROM users WHERE id = ${userId}`)
    if (userRows.length === 0) return c.json({ error: "user_not_found" }, 404)

    const [balance, transactions] = await Promise.all([
      getBalance(userId),
      getTransactionHistory(userId, 100),
    ])

    return c.json({
      user: { id: userRows[0].id, email: userRows[0].email },
      balance,
      transactions,
    })
  } catch (err) {
    return c.json({ error: "credits_fetch_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * POST /admin-api/users/:id/credits/grant
 * Body: { amount_dt: number, note?: string }
 * Grants credits to a user and records an admin_grant transaction.
 */
adminApi.post("/users/:id/credits/grant", async (c) => {
  const userId = c.req.param("id")
  const adminSession = c.var.session

  const body = await c.req.json().catch(() => ({}))
  const amount_dt = Number(body.amount_dt)
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null

  if (!isValidPackage(amount_dt)) {
    return c.json({
      error: "invalid_amount",
      message: `amount_dt must be a multiple of 5, between 5 and 10000. Got: ${amount_dt}`,
    }, 400)
  }

  try {
    // Verify target user exists
    const userRows = await withDbResilience(() => sql`SELECT id, email FROM users WHERE id = ${userId}`)
    if (userRows.length === 0) return c.json({ error: "user_not_found" }, 404)

    const result = await addCredits(userId, amount_dt, "admin_grant", "completed", {
      adminNote: note ?? `Admin grant of ${amount_dt} DT`,
      createdBy: adminSession.userId,
    })

    // Audit trail
    const adminEmail = await actorEmailFor(adminSession.userId)
    await audit({
      actorId: adminSession.userId,
      actorEmail: adminEmail,
      action: "credits.grant",
      resource: "user",
      resourceId: userId,
      metadata: {
        amount_dt,
        note,
        new_balance_dt: result.new_balance_dt,
        transaction_id: result.transaction_id,
      },
    })

    return c.json({
      ok: true,
      transaction_id: result.transaction_id,
      amount_dt,
      new_balance_dt: result.new_balance_dt,
      new_balance_usd_value: Number((result.new_balance_dt / DT_PER_USD).toFixed(4)),
      user: { id: userRows[0].id, email: userRows[0].email },
    })
  } catch (err) {
    return c.json({ error: "grant_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * GET /admin-api/credits/transactions
 * Global credit ledger — all users, paginated, newest first.
 * Query params: limit (default 100), offset (default 0)
 */
adminApi.get("/credits/transactions", async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)))
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0))

  try {
    const rows = await withDbResilience(() => sql`
      SELECT
        ct.id,
        ct.user_id,
        u.email,
        ct.amount_dt,
        ct.type,
        ct.status,
        ct.admin_note,
        ct.payment_ref,
        ct.created_at,
        cb.email AS created_by_email
      FROM credit_transactions ct
      JOIN users u ON u.id = ct.user_id
      LEFT JOIN users cb ON cb.id = ct.created_by
      ORDER BY ct.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)

    const [countRow] = await withDbResilience(() => sql`SELECT COUNT(*) AS total FROM credit_transactions`)

    return c.json({
      transactions: rows.map((r: any) => ({
        id: r.id,
        user_id: r.user_id,
        email: r.email,
        amount_dt: Number(r.amount_dt),
        type: r.type,
        status: r.status,
        admin_note: r.admin_note ?? null,
        payment_ref: r.payment_ref ?? null,
        created_at: r.created_at,
        created_by_email: r.created_by_email ?? null,
      })),
      total: Number(countRow?.total ?? 0),
      limit,
      offset,
    })
  } catch (err) {
    return c.json({ error: "fetch_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ---------------------------------------------------------------------------
// Payment Demands (User Top-up Requests)
// ---------------------------------------------------------------------------

/**
 * GET /admin-api/payments/demands
 * Returns pending credit top-up requests / demands.
 */
adminApi.get("/payments/demands", async (c) => {
  try {
    const demands = await getPendingPaymentDemands()
    return c.json({ demands })
  } catch (err) {
    return c.json({ error: "fetch_demands_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * POST /admin-api/payments/demands/:id/confirm
 * Admin grants & confirms a user's pending payment demand.
 */
adminApi.post("/payments/demands/:id/confirm", async (c) => {
  const id = c.req.param("id")
  const adminSession = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const note = typeof body.note === "string" ? body.note.trim() : undefined

  try {
    const result = await confirmPaymentDemand(id, adminSession.userId, note)

    const adminEmail = await actorEmailFor(adminSession.userId)
    await audit({
      actorId: adminSession.userId,
      actorEmail: adminEmail,
      action: "payments.confirm",
      resource: "credit_transaction",
      resourceId: id,
      metadata: {
        amount_dt: result.amount_dt,
        user_id: result.user_id,
        new_balance_dt: result.new_balance_dt,
      },
    })

    return c.json({ ok: true, ...result })
  } catch (err) {
    return c.json({ error: "confirm_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * POST /admin-api/payments/demands/:id/reject
 * Admin rejects a user's pending payment demand.
 */
adminApi.post("/payments/demands/:id/reject", async (c) => {
  const id = c.req.param("id")
  const adminSession = c.var.session
  const body = await c.req.json().catch(() => ({}))
  const note = typeof body.note === "string" ? body.note.trim() : undefined

  try {
    const result = await rejectPaymentDemand(id, adminSession.userId, note)

    const adminEmail = await actorEmailFor(adminSession.userId)
    await audit({
      actorId: adminSession.userId,
      actorEmail: adminEmail,
      action: "payments.reject",
      resource: "credit_transaction",
      resourceId: id,
      metadata: { note },
    })

    return c.json(result)
  } catch (err) {
    return c.json({ error: "reject_failed", message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ---------------------------------------------------------------------------
// Flagged accounts (Suspicious accounts tab)
// ---------------------------------------------------------------------------

adminApi.get("/flagged-accounts", async (c) => {
  try {
    const rows = await sql`
      SELECT f.id, f.user_id, u.email, u.canonical_email, u.status as user_status,
             u.credits_frozen, u.credits_freeze_reason,
             f.flag_reason, f.risk_score, f.risk_level, f.signals, f.status,
             f.reviewed_by, f.reviewed_at, f.created_at
      FROM flagged_accounts f
      JOIN users u ON u.id = f.user_id
      ORDER BY f.created_at DESC
      LIMIT 100
    `
    return c.json({ flagged_accounts: rows })
  } catch (err) {
    return jsonError(c, 500, "flagged_accounts_failed", err instanceof Error ? err.message : String(err))
  }
})

const flaggedActionSchema = z.object({
  action: z.enum(["approve", "freeze_credits", "suspend"]),
})

adminApi.post("/flagged-accounts/:userId/action", async (c) => {
  const session = c.var.session
  const userId = c.req.param("userId")
  const body = await c.req.json().catch(() => ({}))
  const parsed = flaggedActionSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 400, "invalid_action")

  const action = parsed.data.action
  const adminEmail = await actorEmailFor(session.userId)

  try {
    const [user] = await sql`SELECT id, email, status, credits_frozen FROM users WHERE id = ${userId}`
    if (!user) return jsonError(c, 404, "user_not_found")

    if (action === "approve") {
      await sql`
        UPDATE flagged_accounts
        SET status = 'approved', reviewed_by = ${session.userId}, reviewed_at = now()
        WHERE user_id = ${userId}
      `
      await sql`
        UPDATE users
        SET credits_frozen = false, credits_freeze_reason = NULL
        WHERE id = ${userId}
      `
      await audit({
        actorId: session.userId,
        actorEmail: adminEmail,
        action: "abuse.account_approved",
        resource: "abuse",
        resourceId: userId,
        ip: ip(c),
        metadata: { target_email: user.email },
      })
      return c.json({ success: true, action: "approved" })
    }

    if (action === "freeze_credits") {
      await sql`
        UPDATE flagged_accounts
        SET status = 'frozen', reviewed_by = ${session.userId}, reviewed_at = now()
        WHERE user_id = ${userId}
      `
      await sql`
        UPDATE users
        SET credits_frozen = true, credits_freeze_reason = 'admin_frozen'
        WHERE id = ${userId}
      `
      await audit({
        actorId: session.userId,
        actorEmail: adminEmail,
        action: "abuse.account_frozen",
        resource: "abuse",
        resourceId: userId,
        ip: ip(c),
        metadata: { target_email: user.email },
      })
      return c.json({ success: true, action: "frozen" })
    }

    if (action === "suspend") {
      await sql`
        UPDATE flagged_accounts
        SET status = 'suspended', reviewed_by = ${session.userId}, reviewed_at = now()
        WHERE user_id = ${userId}
      `
      await sql`
        UPDATE users
        SET status = 'suspended', credits_frozen = true, credits_freeze_reason = 'admin_suspended'
        WHERE id = ${userId}
      `
      await revokeAllUserSessions(userId)
      invalidateActiveUserCache(userId)
      await audit({
        actorId: session.userId,
        actorEmail: adminEmail,
        action: "abuse.account_suspended",
        resource: "abuse",
        resourceId: userId,
        ip: ip(c),
        metadata: { target_email: user.email },
      })
      return c.json({ success: true, action: "suspended" })
    }

    return jsonError(c, 400, "invalid_action")
  } catch (err) {
    return jsonError(c, 500, "flagged_action_failed", err instanceof Error ? err.message : String(err))
  }
})

