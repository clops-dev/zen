import postgres from "postgres"
import { env } from "./env"

/** PostgreSQL / Neon connection pool.
 *
 * Why these specific options:
 * - `max: 10` — keep the pool small. Neon pooler computes are sensitive to
 *   per-connection CPU and the gateway's request rate is low enough that 10
 *   connections comfortably handle it. Higher values cause Neon to throttle
 *   us with "too many connections" when a burst arrives.
 * - `idle_timeout: 30` — close idle connections after 30 s. Neon pooler
 *   aggressively recycles backend connections; holding them open longer
 *   just yields more stale-connection errors on the next acquire.
 * - `max_lifetime: 60 * 30` (30 min) — hard upper bound on a single pooled
 *   connection. Neon closes server-side connections after its own idle /
 *   lifetime limit (often 5–15 min) without telling the client; this
 *   client-side cap forces the pool to cycle connections before the
 *   server does, eliminating "write CONNECTION_CLOSED" on the first query
 *   after a long quiet period.
 * - `connect_timeout: 10` — fail fast on cold-start rather than hanging.
 *   Neon's compute-node cold start can take several seconds; if the TCP
 *   handshake itself doesn't complete in 10 s we'd rather see the error
 *   and retry than block the request thread indefinitely.
 * - `keepalive: true` — enable TCP keepalive on each pooled socket. Stops
 *   intermediate load balancers (AWS NLB, Cloudflare) from silently
 *   dropping what they think is a dead connection.
 * - `prepare: false` — required when talking to Neon's pooler (the pgbouncer
 *   front-door does not support the extended query protocol's prepared
 *   statement names).
 * - `onnotice: () => {}` — Postgres NOTICE/RAISE messages would otherwise
 *   spam the logs during normal boot (migration 014 etc).
 * - `transform: { undefined: null }` — postgres-js maps JS `undefined` to a
 *   NULL by default, but only when this transform is enabled. Required for
 *   safe `UPDATE ... SET col = ${maybeUndefined}` patterns.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  keep_alive: 30,
  prepare: false,
  onnotice: () => {},
  transform: { undefined: null },
})

/** Errors that look like transient connection issues — Neon cold-start,
 * pooler recycling, network blips, DNS hiccups. We retry these because the
 * next attempt against the same query will normally succeed.
 *
 * Deliberately does NOT match PostgresError codes that are permanent
 * (constraint violations, syntax errors, etc.) — those will never recover
 * by retrying and the caller should see them immediately. */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as any
  const code = typeof e.code === "string" ? e.code : ""
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "57P03" || // cannot_connect_now (Neon wake-up)
    code === "08000" || // connection_exception
    code === "08003" || // connection_does_not_exist
    code === "08006" || // connection_failure
    code === "08001" || // sqlclient_unable_to_establish_sqlconnection
    code === "08004"    // sqlserver_rejected_establishment_of_sqlconnection
  ) return true
  const msg = typeof e.message === "string" ? e.message : ""
  if (/getaddrinfo|ENOTFOUND|compute node|connection terminated|connection ended|connection closed/i.test(msg)) return true
  if (msg.includes("write CONNECTION_CLOSED") || msg.includes("read CONNECTION_CLOSED")) return true
  return false
}

const DB_RETRY_MAX = 3
const DB_RETRY_BASE_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Run a query function, retrying transient connection failures a few times
 * with exponential backoff. Use for any read/write the request path depends
 * on. Migrations don't use this (migrate.ts has its own cold-start loop)
 * because each migration must succeed exactly once and retrying a
 * half-applied migration needs more care than this helper provides.
 *
 * After the final retry, the original error is re-thrown (with
 * `transientRetries` annotated for observability) so callers don't lose
 * the underlying error. */
export async function withDbResilience<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= DB_RETRY_MAX; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientDbError(err) || attempt === DB_RETRY_MAX) {
        if (attempt > 1) {
          ;(err as any).transientRetries = attempt - 1
        }
        throw err
      }
      const delay = DB_RETRY_BASE_MS * Math.pow(2, attempt - 1)
      console.warn(`[db] transient error (attempt ${attempt}/${DB_RETRY_MAX}), retrying in ${delay}ms:`, (err as any).message ?? err)
      await sleep(delay)
    }
  }
  throw lastErr
}

export type Role = "user" | "admin"
export type Tier = "free" | "pro" | "enterprise"
export type ComplexityTier = "trivial" | "simple" | "medium" | "complex"

export type UserRow = {
  id: string
  email: string
  password_hash: string
  role: Role
  created_at: Date
}

export type SubscriptionRow = {
  user_id: string
  tier: Tier
  status: "active" | "suspended"
  token_budget_monthly: number
  started_at: Date
  renewed_at: Date | null
}

export type ProviderRow = {
  id: string
  name: string
  base_url: string
  api_key: string
  enabled: boolean
  healthy: boolean
  consecutive_failures: number
  last_failure_at: Date | null
  created_at: Date
  /** Which upstream adapter to use. "openai-compatible" → /v1/chat/completions
   * via @ai-sdk/openai-compatible. "anthropic-compatible" → /messages via
   * @ai-sdk/anthropic (Bearer auth, anthropic-version header). Defaults to
   * "openai-compatible" for legacy rows that pre-date the column. */
  provider_type: "openai-compatible" | "anthropic-compatible"
}

export type ModelRow = {
  id: string
  provider_id: string
  model_id: string
  label: string | null
  input_price_per_1m: string
  output_price_per_1m: string
  context_window: number | null
  enabled: boolean
  created_at: Date
}
