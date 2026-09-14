// Tiny fetch wrapper. Session cookie carries auth — credentials: "include"
// is what keeps the cookie across origins during Vite dev (proxy strips
// it via Set-Cookie). All responses are JSON unless 204.

export type ApiError = { error: string; message?: string }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiClientError("unauthorized", "Authentication required. Please log in.", 401)
    }
    if (res.status === 403) {
      throw new ApiClientError("forbidden", "Admin access required. Your account does not have admin permissions.", 403)
    }
    const err = body as ApiError | null
    const fallbackMsg = text?.startsWith("<")
      ? `HTTP ${res.status}: Server returned an error page`
      : (text || res.statusText)
    throw new ApiClientError(err?.error ?? `http_${res.status}`, err?.message ?? fallbackMsg, res.status)
  }
  return body as T
}

export class ApiClientError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ---------- types

export type Me = { user: { id: string; email: string; role: "admin" | "user" } }

export type Provider = {
  id: string
  name: string
  base_url: string
  provider_type: "openai-compatible" | "anthropic-compatible" | "custom"
  enabled: boolean
  healthy: boolean
  health_state?: "HEALTHY" | "DEGRADED" | "DOWN" | "RECOVERING"
  consecutive_failures: number
  last_failure_at: string | null
  cooldown_until?: string | null
  last_failure_reason?: string | null
  last_success_at?: string | null
  created_at: string
  has_key: boolean
  key_preview: string
  meta: Record<string, any>
}

export type Model = {
  id: string
  model_id: string
  label: string | null
  input_price_per_1m: string | number
  output_price_per_1m: string | number
  input_cache_read_price_per_1m?: string | number | null
  input_cache_write_price_per_1m?: string | number | null
  request_price_flat?: string | number | null
  context_window: number | null
  supports_tools: boolean
  supports_vision: boolean
  supports_json_mode: boolean
  supports_streaming: boolean
  supports_reasoning: boolean
  supports_structured_outputs?: boolean
  supports_embeddings: boolean
  input_modalities?: string[]
  output_modalities?: string[]
  is_moderated?: boolean
  max_completion_tokens?: number | null
  expiration_date?: string | null
  openrouter_model_id?: string | null
  metadata_synced_at?: string | null
  enabled: boolean
  created_at: string
  provider_name: string
  provider_id: string
  provider_base_url?: string
}

export type Route = {
  id: string
  tier: "trivial" | "simple" | "medium" | "complex"
  weight: number
  enabled: boolean
  model_id: string
  model_id_text: string
  label: string | null
  provider_id: string
  provider_name: string
  base_url: string
}

export type Combo = {
  id: string
  slug: string
  name: string
  description: string | null
  status: "active" | "archived" | "draft"
  routing_strategy:
    | "priority" | "weighted" | "round-robin" | "cost-optimized"
    | "latency-optimized" | "fallback" | "health"
  rate_limit_rpm: number
  monthly_token_cap: number
  monthly_cost_cap_usd: number | string
  is_template: boolean
  created_at: string
  updated_at: string
}

export type ComboFull = {
  combo: any
  providers: any[]
  models: any[]
}

export type User = {
  id: string
  email: string
  role: "admin" | "user"
  created_at: string
  active_keys: number
  last_login_at: string | null
  // Single Source of Truth Billing Fields
  credits_purchased: number
  credits_purchased_dt: number
  usage_cost: number
  remaining_credits: number
  remaining_credits_dt: number
  requests: number
  input_tokens: number
  output_tokens: number
  tokens: number
}

export type AdminBillingOverview = {
  total_credit_sales_dt: number
  total_credits_sold_usd: number
  total_ai_usage_cost_usd: number
  gross_margin_usd: number
  total_users: number
}

export function getAdminBilling() {
  return request<AdminBillingOverview>("/admin-api/billing")
}

export type ApiKeyRow = {
  id: string
  user_id: string
  key_prefix: string
  label: string | null
  created_at: string
  last_used_at: string | null
  revoked: boolean
  combo_id: string | null
  user_email: string
  combo_slug?: string | null
  combo_name?: string | null
}

export type RequestRow = {
  id: string
  created_at: string
  user_id: string
  user_email: string | null
  model_label: string
  status: "success" | "failure" | "rejected"
  reject_reason: string | null
  cost_usd: number | string
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  latency_ms: number | null
  from_cache: boolean
  ip: string | null
}

export type AuditEvent = {
  id: string
  actor_id: string | null
  actor_email: string | null
  action: string
  resource: string
  resource_id: string | null
  ip: string | null
  result: "success" | "failure" | "denied"
  metadata: Record<string, any>
  created_at: string
}

// ---------- endpoints

export const me = () => request<Me>("/admin-api/me")

export const login = async (email: string, password: string) => {
  // Re-use the existing JSON /v1/auth/login — sets the session cookie.
  const res = await fetch("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiClientError(body?.error ?? "login_failed", body?.message ?? "Login failed", res.status)
  return body
}

export const logout = async () => {
  await fetch("/v1/auth/logout", { method: "POST", credentials: "include" })
}

export const dashboardOverview = () => request<any>("/admin-api/dashboard/overview")
export const providerHealth = () => request<{ providers: any[] }>("/admin-api/dashboard/providers/health")

export const listProviders = () => request<{ providers: Provider[] }>("/admin-api/providers")
export const createProvider = (body: any) => request<{ id: string; name: string }>("/admin-api/providers", { method: "POST", body: JSON.stringify(body) })
export const updateProvider = (id: string, body: any) => request<{ ok: true }>(`/admin-api/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) })
export const toggleProvider = (id: string) => request<{ ok: true; enabled: boolean }>(`/admin-api/providers/${id}/toggle`, { method: "POST" })
export const testProvider = (id: string) => request<{ ok: boolean; status: number; latency_ms: number }>(`/admin-api/providers/${id}/test`, { method: "POST" })
export const resetProviderHealth = (id: string) => request<{ ok: true }>(`/admin-api/providers/${id}/reset-health`, { method: "POST" })
export const deleteProvider = (id: string) => request<{ ok: true }>(`/admin-api/providers/${id}`, { method: "DELETE" })

export const listModels = () => request<{ models: Model[] }>("/admin-api/models")
export const createModel = (body: any) => request<{ id: string }>("/admin-api/models", { method: "POST", body: JSON.stringify(body) })
export const updateModel = (id: string, body: any) => request<{ ok: true }>(`/admin-api/models/${id}`, { method: "PATCH", body: JSON.stringify(body) })
export const cloneModel = (id: string) => request<{ id: string }>(`/admin-api/models/${id}/clone`, { method: "POST" })
export const toggleModel = (id: string) => request<{ ok: true; enabled: boolean }>(`/admin-api/models/${id}/toggle`, { method: "POST" })
export const testModel = (id: string) => request<{ ok: boolean; status: number; latency_ms: number }>(`/admin-api/models/${id}/test`, { method: "POST" })
export const deleteModel = (id: string) => request<{ ok: true }>(`/admin-api/models/${id}`, { method: "DELETE" })
export const fetchOpenRouterMetadata = (providerId: string, modelId: string) =>
  request<{ ok: true; metadata: any }>("/admin-api/models/openrouter-fetch", {
    method: "POST",
    body: JSON.stringify({ provider_id: providerId, model_id: modelId }),
  })
export const refreshModelMetadata = (id: string) =>
  request<{ ok: true; metadata: any }>(`/admin-api/models/${id}/refresh`, { method: "POST" })


export const listRoutes = () => request<{ routes: Route[] }>("/admin-api/routing")
export const createRoute = (body: any) => request<{ id: string }>("/admin-api/routing", { method: "POST", body: JSON.stringify(body) })
export const toggleRoute = (id: string) => request<{ ok: true; enabled: boolean }>(`/admin-api/routing/${id}/toggle`, { method: "POST" })
export const deleteRoute = (id: string) => request<{ ok: true }>(`/admin-api/routing/${id}`, { method: "DELETE" })

export const listCombos = () => request<{ combos: Combo[] }>("/admin-api/combos")
export const getCombo = (id: string) => request<ComboFull>(`/admin-api/combos/${id}`)
export const createCombo = (body: any) => request<{ id: string }>("/admin-api/combos", { method: "POST", body: JSON.stringify(body) })
export const updateCombo = (id: string, body: any) => request<{ ok: true }>(`/admin-api/combos/${id}`, { method: "PATCH", body: JSON.stringify(body) })
export const cloneCombo = (id: string) => request<{ id: string; slug: string }>(`/admin-api/combos/${id}/clone`, { method: "POST" })
export const archiveCombo = (id: string) => request<{ ok: true }>(`/admin-api/combos/${id}/archive`, { method: "POST" })
export const exportCombo = (id: string) => request<any>(`/admin-api/combos/${id}/export`)
export const importCombo = (body: any) => request<{ id: string; slug: string }>("/admin-api/combos/import", { method: "POST", body: JSON.stringify(body) })
export const testCombo = (id: string) => request<{ results: { provider: string; ok: boolean; status: number; latency_ms: number }[] }>(`/admin-api/combos/${id}/test`, { method: "POST" })
export const deleteCombo = (id: string) => request<{ ok: true }>(`/admin-api/combos/${id}`, { method: "DELETE" })

export const listUsers = () => request<{ users: User[] }>("/admin-api/users")
export const createUser = (body: any) => request<{ id: string }>("/admin-api/users", { method: "POST", body: JSON.stringify(body) })
export const updateUser = (id: string, body: any) => request<{ ok: true }>(`/admin-api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) })
export const deleteUser = (id: string) => request<{ ok: true }>(`/admin-api/users/${id}`, { method: "DELETE" })

export const listApiKeys = () => request<{ keys: ApiKeyRow[] }>("/admin-api/api-keys")
export const createApiKey = (body: any) => request<{ id: string; api_key: string; prefix: string; created_at: string }>("/admin-api/api-keys", { method: "POST", body: JSON.stringify(body) })
export const revokeApiKey = (id: string) => request<{ ok: true }>(`/admin-api/api-keys/${id}/revoke`, { method: "POST" })
export const rotateApiKey = (id: string) => request<{ id: string; api_key: string; prefix: string; created_at: string }>(`/admin-api/api-keys/${id}/rotate`, { method: "POST" })

export type WalletUser = {
  id: string
  email: string
  role: "admin" | "user"
  tier: string
  subscription_status: string
  subscription_price_usd: string
  usage_cost_usd: string
  net_income_usd: string
  total_requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  last_active_at: string | null
}

export type WalletTotals = {
  accumulated_users: number
  active_users: number
  total_revenue_dt?: string
  total_revenue_usd?: string
  total_subscription_income_usd: string
  total_credit_revenue_usd?: string
  total_usage_cost_usd: string
  total_net_income_usd: string
  profit_margin_pct?: number
  dt_per_usd?: number
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  avg_income_per_user_usd: string
  avg_cost_per_user_usd: string
}

export type WalletSummary = {
  totals: WalletTotals
  users: WalletUser[]
  transactions?: AdminCreditTransaction[]
}

export const listRequests = (q: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") usp.set(k, String(v))
  return request<{ requests: RequestRow[] }>(`/admin-api/requests?${usp.toString()}`)
}

export const listAudit = (q: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") usp.set(k, String(v))
  return request<{ events: AuditEvent[] }>(`/admin-api/audit?${usp.toString()}`)
}

export const walletSummary = () => request<WalletSummary>("/admin-api/wallet/summary")

export const settings = () => request<any>("/admin-api/settings")

// ---------------------------------------------------------------------------
// Admin credit management & Payments
// ---------------------------------------------------------------------------

export type AdminCreditBalance = {
  balance_dt: number
  balance_usd_value: number
  updated_at: string
}

export type AdminCreditTransaction = {
  id: string
  user_id: string
  email: string
  amount_dt: number
  amount_usd?: number
  type: 'purchase' | 'admin_grant' | 'usage' | 'refund' | 'adjustment'
  status: 'pending' | 'completed' | 'failed' | 'reversed'
  admin_note: string | null
  payment_ref: string | null
  created_at: string
  created_by_email: string | null
}

export type UserCreditsResponse = {
  user: { id: string; email: string }
  balance: AdminCreditBalance
  transactions: AdminCreditTransaction[]
}

export type GrantCreditsResponse = {
  ok: boolean
  transaction_id: string
  amount_dt: number
  new_balance_dt: number
  new_balance_usd_value: number
  user: { id: string; email: string }
}

export type GlobalTransactionsResponse = {
  transactions: AdminCreditTransaction[]
  total: number
  limit: number
  offset: number
}

export type PaymentDemand = {
  id: string
  user_id: string
  email: string
  amount_dt: number
  amount_usd: number
  type: string
  status: string
  admin_note: string | null
  payment_ref: string | null
  created_at: string
}

/** Get a user's credit balance and last 100 transactions. */
export const getUserCredits = (userId: string) =>
  request<UserCreditsResponse>(`/admin-api/users/${userId}/credits`)

/** Grant credits to a user. amount_dt must be a multiple of 5. */
export const grantUserCredits = (userId: string, amount_dt: number, note?: string) =>
  request<GrantCreditsResponse>(`/admin-api/users/${userId}/credits/grant`, {
    method: 'POST',
    body: JSON.stringify({ amount_dt, note: note ?? null }),
  })

/** Global credit ledger, all users, paginated. */
export const listCreditTransactions = (limit = 100, offset = 0) =>
  request<GlobalTransactionsResponse>(
    `/admin-api/credits/transactions?limit=${limit}&offset=${offset}`
  )

/** List pending user top-up demands. */
export const listPaymentDemands = () =>
  request<{ demands: PaymentDemand[] }>("/admin-api/payments/demands")

/** Confirm and grant a pending user payment demand. */
export const confirmPaymentDemand = (id: string, note?: string) =>
  request<{ ok: boolean; transaction_id: string; amount_dt: number; new_balance_dt: number }>(
    `/admin-api/payments/demands/${id}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    }
  )

/** Reject a pending user payment demand. */
export const rejectPaymentDemand = (id: string, note?: string) =>
  request<{ ok: boolean; transaction_id: string }>(
    `/admin-api/payments/demands/${id}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    }
  )