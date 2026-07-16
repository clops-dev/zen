import { sql } from "./db"
import type { ComplexityTier } from "./db"

const TIER_ORDER: ComplexityTier[] = ["trivial", "simple", "medium", "complex"]
const COOLDOWN_MS = 60_000
const FAILURE_THRESHOLD = 3

export interface RouteTarget {
  modelRowId: string
  providerId: string
  providerName: string
  baseUrl: string
  apiKey: string
  modelId: string
  label: string // "provider_name/model_id", used in logs and the ai_requests ledger
  inputPricePer1M: number
  outputPricePer1M: number
}

interface Candidate {
  model_row_id: string
  provider_id: string
  provider_name: string
  base_url: string
  api_key: string
  model_id: string
  input_price_per_1m: string
  output_price_per_1m: string
  weight: number
}

function weightedPick<T extends { weight: number }>(items: T[]): T | null {
  const total = items.reduce((s, i) => s + i.weight, 0)
  if (total <= 0) return null
  let r = Math.random() * total
  for (const item of items) {
    r -= item.weight
    if (r <= 0) return item
  }
  return items[items.length - 1] ?? null
}

async function getTierCandidates(tier: ComplexityTier): Promise<Candidate[]> {
  const now = Date.now()
  const rows = await sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      tr.weight::float8 AS weight,
      p.healthy, p.last_failure_at
    FROM tier_routes tr
    JOIN models m ON m.id = tr.model_id
    JOIN providers p ON p.id = m.provider_id
    WHERE tr.tier = ${tier} AND m.enabled = true AND p.enabled = true
  ` as any
  return rows.filter(
    (r: any) => r.healthy || (r.last_failure_at && now - new Date(r.last_failure_at).getTime() > COOLDOWN_MS),
  )
}

/** Last-resort: any enabled, healthy model on any enabled provider, regardless
 * of tier_routes. Makes the gateway work the moment you've added one
 * provider + one model, before you've configured per-tier routing. */
async function getAnyCandidate(): Promise<Candidate[]> {
  const now = Date.now()
  const rows = await sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      1::float8 AS weight,
      p.healthy, p.last_failure_at
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = true AND p.enabled = true
  ` as any
  return rows.filter(
    (r: any) => r.healthy || (r.last_failure_at && now - new Date(r.last_failure_at).getTime() > COOLDOWN_MS),
  )
}

function toTarget(c: Candidate): RouteTarget {
  return {
    modelRowId: c.model_row_id,
    providerId: c.provider_id,
    providerName: c.provider_name,
    baseUrl: c.base_url,
    apiKey: c.api_key,
    modelId: c.model_id,
    label: `${c.provider_name}/${c.model_id}`,
    inputPricePer1M: Number(c.input_price_per_1m),
    outputPricePer1M: Number(c.output_price_per_1m),
  }
}

/**
 * Picks a target for the given complexity tier, escalating upward through
 * tiers if nothing is healthy there, then falling back to ANY enabled model
 * anywhere if tier_routes has nothing configured at all.
 *
 * Returns null only if there is truly no usable provider/model configured
 * anywhere — callers should surface a clear "no providers configured" error
 * in that case, not a generic 500.
 */
export async function pickRoute(startTier: ComplexityTier, maxTier: ComplexityTier = "complex"): Promise<RouteTarget | null> {
  const startIdx = TIER_ORDER.indexOf(startTier)
  const maxIdx = Math.min(TIER_ORDER.indexOf(maxTier), TIER_ORDER.length - 1)

  for (let i = startIdx; i <= maxIdx; i++) {
    let candidates: Candidate[]
    try {
      candidates = await getTierCandidates(TIER_ORDER[i])
    } catch (err) {
      console.error("[routing] tier_routes query failed:", err)
      candidates = []
    }
    while (candidates.length) {
      const pick = weightedPick(candidates)
      if (!pick) break
      return toTarget(pick)
    }
  }

  // Nothing configured for any tier — fall back to anything at all.
  try {
    const any = await getAnyCandidate()
    const pick = weightedPick(any)
    if (pick) return toTarget(pick)
  } catch (err) {
    console.error("[routing] fallback query failed:", err)
  }

  return null
}

export async function reportRouteOutcome(providerId: string, success: boolean): Promise<void> {
  try {
    if (success) {
      await sql`UPDATE providers SET healthy = true, consecutive_failures = 0 WHERE id = ${providerId}`
      return
    }
    await sql`
      UPDATE providers
      SET consecutive_failures = consecutive_failures + 1,
          last_failure_at = now(),
          healthy = (consecutive_failures + 1) < ${FAILURE_THRESHOLD}
      WHERE id = ${providerId}
    `
  } catch (err) {
    console.error("[routing] failed to report outcome:", err)
  }
}
