import postgres from "postgres"
import { env } from "./env"

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  prepare: false,
})

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
