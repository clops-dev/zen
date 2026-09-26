import { sql, withDbResilience } from "./db"
import type { ComplexityTier } from "./db"

const TIER_ORDER: ComplexityTier[] = ["trivial", "simple", "medium", "complex"]
const COOLDOWN_MS = 60_000
const FAILURE_THRESHOLD = 3

/** Raised by pickRoute when the request's input tokens exceed the largest
 * context window available in the configured fallback chain for this
 * request's tier. */
export class ContextWindowExceededError extends Error {
  readonly requiredTokens: number
  readonly largestAvailable: number
  readonly tier: ComplexityTier
  constructor(requiredTokens: number, largestAvailable: number, tier: ComplexityTier) {
    super(
      `conversation requires ${requiredTokens} tokens but the largest context window ` +
      `available for tier "${tier}" is ${largestAvailable}`,
    )
    this.name = "ContextWindowExceededError"
    this.requiredTokens = requiredTokens
    this.largestAvailable = largestAvailable
    this.tier = tier
  }
}

export class UnsupportedCapabilityError extends Error {
  readonly missingCapabilities: string[]
  readonly tier: ComplexityTier
  constructor(missingCapabilities: string[], tier: ComplexityTier) {
    super(`No models available for tier "${tier}" that support required capabilities: ${missingCapabilities.join(", ")}`)
    this.name = "UnsupportedCapabilityError"
    this.missingCapabilities = missingCapabilities
    this.tier = tier
  }
}

export class ExplicitModelCapabilityError extends Error {
  readonly missingCapabilities: string[]
  readonly requestedModel: string
  constructor(missingCapabilities: string[], requestedModel: string) {
    super(`Model "${requestedModel}" does not support required capabilities: ${missingCapabilities.join(", ")}`)
    this.name = "ExplicitModelCapabilityError"
    this.missingCapabilities = missingCapabilities
    this.requestedModel = requestedModel
  }
}

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
  inputCacheReadPricePer1M?: number | null
  inputCacheWritePricePer1M?: number | null
  requestPriceFlat?: number | null
  contextWindow: number | null
  supportsTools: boolean
  supportsVision: boolean
  supportsJsonMode: boolean
  providerType: "openai-compatible" | "anthropic-compatible" | "custom"
  qualityScore?: number | null
  tokenizer?: string | null
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
  input_cache_read_price_per_1m: string | null
  input_cache_write_price_per_1m: string | null
  request_price_flat: string | null
  context_window: number | null
  supports_tools: boolean
  supports_vision: boolean
  supports_json_mode: boolean
  weight: number
  provider_type: "openai-compatible" | "anthropic-compatible" | "custom"
  quality_score?: number | null
  tokenizer?: string | null
  healthy?: boolean
  health_state?: string
  last_failure_at?: string | Date | null
  cooldown_until?: string | Date | null
  mh_healthy?: boolean
  mh_health_state?: string
  mh_cooldown_until?: string | Date | null
}

export interface CachedModelHealth {
  healthy: boolean
  health_state: "HEALTHY" | "DEGRADED" | "DOWN" | "RECOVERING"
  cooldown_until: number | null
}

export const modelHealthCache = new Map<string, CachedModelHealth>()

function weightedPick<T extends { weight: number }>(items: T[]): T | null {
  if (items.length === 0) return null
  const total = items.reduce((s, i) => s + i.weight, 0)
  if (total <= 0) return items[0] ?? null
  if (process.env.DETERMINISTIC_ROUTING === "1") return items[0] ?? null
  let r = Math.random() * total
  for (const item of items) {
    r -= item.weight
    if (r <= 0) return item
  }
  return items[items.length - 1] ?? null
}

export function isCandidateAvailableWithModelHealth(r: any, now: number): boolean {
  // 1. Check provider availability
  const provState = r.health_state ?? (r.healthy ? "HEALTHY" : "DOWN")
  let provAvailable = false
  if (provState === "HEALTHY" || provState === "DEGRADED" || provState === "RECOVERING") {
    provAvailable = true
  } else if (r.cooldown_until && now >= new Date(r.cooldown_until).getTime()) {
    provAvailable = true
  } else if (!r.cooldown_until && r.last_failure_at && now - new Date(r.last_failure_at).getTime() > COOLDOWN_MS) {
    provAvailable = true
  }
  if (!provAvailable) return false

  // 2. Check in-memory model health cache
  const modelId = r.model_row_id || r.id
  if (modelId && modelHealthCache.has(modelId)) {
    const mh = modelHealthCache.get(modelId)!
    if (mh.health_state === "DOWN" || !mh.healthy) {
      if (mh.cooldown_until && now >= mh.cooldown_until) {
        mh.healthy = true
        mh.health_state = "RECOVERING"
        return true
      }
      return false
    }
    return true
  }

  // 3. Check DB model_health columns if present
  if (r.mh_health_state !== undefined) {
    const mhState = r.mh_health_state ?? (r.mh_healthy !== false ? "HEALTHY" : "DOWN")
    if (mhState === "HEALTHY" || mhState === "DEGRADED" || mhState === "RECOVERING") return true
    if (r.mh_cooldown_until && now >= new Date(r.mh_cooldown_until).getTime()) return true
    return false
  }

  return true
}

export const isCandidateAvailable = isCandidateAvailableWithModelHealth

async function getTierCandidates(tier: ComplexityTier): Promise<Candidate[]> {
  const now = Date.now()
  const rows = await withDbResilience(() => sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
      m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      m.quality_score, m.tokenizer,
      p.provider_type,
      tr.weight::float8 AS weight,
      p.healthy, p.health_state, p.last_failure_at, p.cooldown_until,
      mh.healthy AS mh_healthy, mh.health_state AS mh_health_state, mh.cooldown_until AS mh_cooldown_until
    FROM tier_routes tr
    JOIN models m ON m.id = tr.model_id
    JOIN providers p ON p.id = m.provider_id
    LEFT JOIN model_health mh ON mh.model_id = m.id
    WHERE tr.tier = ${tier} AND tr.enabled = true AND m.enabled = true AND p.enabled = true
  `).catch(async () => {
    // Fallback if model_health table or metadata columns are not yet in DB schema
    return sql<Candidate[]>`
      SELECT
        m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
        p.base_url, p.api_key, m.model_id,
        m.input_price_per_1m, m.output_price_per_1m,
        m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
        m.context_window,
        m.supports_tools, m.supports_vision, m.supports_json_mode,
        p.provider_type,
        tr.weight::float8 AS weight,
        p.healthy, p.health_state, p.last_failure_at, p.cooldown_until
      FROM tier_routes tr
      JOIN models m ON m.id = tr.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE tr.tier = ${tier} AND tr.enabled = true AND m.enabled = true AND p.enabled = true
    `
  }) as any
  return rows.filter((r: any) => isCandidateAvailableWithModelHealth(r, now))
}

async function getAnyCandidate(): Promise<Candidate[]> {
  const now = Date.now()
  const rows = await withDbResilience(() => sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
      m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      m.quality_score, m.tokenizer,
      p.provider_type,
      1::float8 AS weight,
      p.healthy, p.health_state, p.last_failure_at, p.cooldown_until,
      mh.healthy AS mh_healthy, mh.health_state AS mh_health_state, mh.cooldown_until AS mh_cooldown_until
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    LEFT JOIN model_health mh ON mh.model_id = m.id
    WHERE m.enabled = true AND p.enabled = true
  `).catch(async () => {
    return sql<Candidate[]>`
      SELECT
        m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
        p.base_url, p.api_key, m.model_id,
        m.input_price_per_1m, m.output_price_per_1m,
        m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
        m.context_window,
        m.supports_tools, m.supports_vision, m.supports_json_mode,
        p.provider_type,
        1::float8 AS weight,
        p.healthy, p.health_state, p.last_failure_at, p.cooldown_until
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = true AND p.enabled = true
    `
  }) as any
  const available = rows.filter((r: any) => isCandidateAvailableWithModelHealth(r, now))
  if (available.length === 0 && rows.length > 0) {
    return rows
  }
  return available
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
    inputCacheReadPricePer1M: c.input_cache_read_price_per_1m != null ? Number(c.input_cache_read_price_per_1m) : null,
    inputCacheWritePricePer1M: c.input_cache_write_price_per_1m != null ? Number(c.input_cache_write_price_per_1m) : null,
    requestPriceFlat: c.request_price_flat != null ? Number(c.request_price_flat) : 0,
    contextWindow: c.context_window,
    supportsTools: c.supports_tools,
    supportsVision: c.supports_vision,
    supportsJsonMode: c.supports_json_mode,
    providerType: c.provider_type,
    qualityScore: c.quality_score != null ? Number(c.quality_score) : null,
    tokenizer: c.tokenizer ?? null,
  }
}

export function defaultReserveFor(contextWindow: number): number {
  return Math.max(2048, Math.min(8192, Math.floor(contextWindow * 0.2)))
}

export function candidateFitsContext(
  candidate: Pick<Candidate, "context_window">,
  requiredTokens: number | undefined,
  largestSink: { value: number | null },
): boolean {
  if (requiredTokens === undefined || candidate.context_window == null) return true
  const reserve = defaultReserveFor(candidate.context_window)
  const usable = candidate.context_window - reserve
  if (largestSink.value === null || candidate.context_window > largestSink.value) {
    largestSink.value = candidate.context_window
  }
  return requiredTokens <= usable
}

export interface RouteRequirements {
  requiredTokens?: number
  requiresTools?: boolean
  requiresVision?: boolean
  requiresJsonMode?: boolean
}

export async function findCandidateByModel(modelName: string): Promise<Candidate | null> {
  const clean = modelName.trim().toLowerCase().replace(/^zen\//, "")
  const now = Date.now()
  const rows = await withDbResilience(() => sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
      m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      m.quality_score, m.tokenizer,
      p.provider_type,
      1::float8 AS weight,
      p.healthy, p.health_state, p.last_failure_at, p.cooldown_until,
      mh.healthy AS mh_healthy, mh.health_state AS mh_health_state, mh.cooldown_until AS mh_cooldown_until
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    LEFT JOIN model_health mh ON mh.model_id = m.id
    WHERE m.enabled = true AND p.enabled = true
      AND (
        lower(m.model_id) = ${clean}
        OR lower(concat(p.name, '/', m.model_id)) = ${clean}
        OR lower(coalesce(m.label, '')) = ${clean}
      )
    ORDER BY p.healthy DESC, m.created_at ASC
    LIMIT 1
  `).catch(async () => {
    return sql<Candidate[]>`
      SELECT
        m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
        p.base_url, p.api_key, m.model_id,
        m.input_price_per_1m, m.output_price_per_1m,
        m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
        m.context_window,
        m.supports_tools, m.supports_vision, m.supports_json_mode,
        p.provider_type,
        1::float8 AS weight,
        p.healthy, p.health_state, p.last_failure_at, p.cooldown_until
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = true AND p.enabled = true
        AND (
          lower(m.model_id) = ${clean}
          OR lower(concat(p.name, '/', m.model_id)) = ${clean}
          OR lower(coalesce(m.label, '')) = ${clean}
        )
      ORDER BY p.healthy DESC, m.created_at ASC
      LIMIT 1
    `
  }) as any
  const available = rows.filter((r: any) => isCandidateAvailableWithModelHealth(r, now))
  return available[0] ?? rows[0] ?? null
}

export async function findCandidateByRowId(modelRowId: string): Promise<Candidate | null> {
  const now = Date.now()
  const rows = await withDbResilience(() => sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m,
      m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
      m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      m.quality_score, m.tokenizer,
      p.provider_type,
      1::float8 AS weight,
      p.healthy, p.health_state, p.last_failure_at, p.cooldown_until,
      mh.healthy AS mh_healthy, mh.health_state AS mh_health_state, mh.cooldown_until AS mh_cooldown_until
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    LEFT JOIN model_health mh ON mh.model_id = m.id
    WHERE m.id = ${modelRowId} AND m.enabled = true AND p.enabled = true
    LIMIT 1
  `).catch(async () => {
    return sql<Candidate[]>`
      SELECT
        m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
        p.base_url, p.api_key, m.model_id,
        m.input_price_per_1m, m.output_price_per_1m,
        m.input_cache_read_price_per_1m, m.input_cache_write_price_per_1m, m.request_price_flat,
        m.context_window,
        m.supports_tools, m.supports_vision, m.supports_json_mode,
        p.provider_type,
        1::float8 AS weight,
        p.healthy, p.health_state, p.last_failure_at, p.cooldown_until
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.id = ${modelRowId} AND m.enabled = true AND p.enabled = true
      LIMIT 1
    `
  }) as any
  const c = rows[0] ?? null
  if (c && isCandidateAvailableWithModelHealth(c, now)) {
    return c
  }
  return null
}

export interface AliasResolution {
  alias: string
  targetModelId?: string | null
  targetTier?: ComplexityTier | null
}

export async function findAliasTarget(aliasName: string): Promise<AliasResolution | null> {
  const clean = aliasName.trim().toLowerCase()
  try {
    const rows = await withDbResilience(() => sql<any[]>`
      SELECT alias, target_model_id, target_tier
      FROM model_aliases
      WHERE lower(alias) = ${clean}
      LIMIT 1
    `)
    if (rows && rows.length > 0) {
      return {
        alias: rows[0].alias,
        targetModelId: rows[0].target_model_id,
        targetTier: rows[0].target_tier as ComplexityTier | null,
      }
    }
  } catch {
    // If table doesn't exist yet or query fails, fall back to built-in aliases
  }
  if (clean === "zen/auto" || clean === "auto") {
    return { alias: "zen/auto", targetTier: null }
  }
  if (clean === "zen/fast") {
    return { alias: "zen/fast", targetTier: "simple" }
  }
  if (clean === "zen/smart" || clean === "zen/reasoning") {
    return { alias: clean, targetTier: "complex" }
  }
  return null
}

export async function pickRoute(
  startTier: ComplexityTier,
  maxTier: ComplexityTier = "complex",
  excludeModelRowIds: Set<string> = new Set(),
  requirements: RouteRequirements = {},
  requestedModel?: string,
  pinnedModelRowId?: string,
): Promise<RouteTarget | null> {
  const now = Date.now()
  const largestSink: { value: number | null } = { value: null }
  const missingCaps = new Set<string>()
  let anyCapable = false

  const fits = (c: Candidate, isExcluded: boolean): boolean => {
    let fitsCapabilities = true
    if (requirements.requiresTools && !c.supports_tools) { missingCaps.add('tools'); fitsCapabilities = false }
    if (requirements.requiresVision && !c.supports_vision) { missingCaps.add('vision'); fitsCapabilities = false }
    if (requirements.requiresJsonMode && !c.supports_json_mode) { missingCaps.add('json_mode'); fitsCapabilities = false }

    if (fitsCapabilities) {
      anyCapable = true
    }

    if (!fitsCapabilities) return false
    if (isExcluded) return false

    return candidateFitsContext(c, requirements.requiredTokens, largestSink)
  }

  // 1. P3.1: Check pinned model first if conversation has affinity
  if (pinnedModelRowId && !excludeModelRowIds.has(pinnedModelRowId)) {
    const pinnedCandidate = await findCandidateByRowId(pinnedModelRowId)
    if (pinnedCandidate && isCandidateAvailableWithModelHealth(pinnedCandidate, now)) {
      if (fits(pinnedCandidate, false)) {
        return toTarget(pinnedCandidate)
      }
    }
  }

  // 2. P3.4 & P3.5: Handle aliases and explicit model requests
  let effectiveStartTier = startTier
  if (requestedModel) {
    const norm = requestedModel.trim().toLowerCase()
    const alias = await findAliasTarget(norm)
    if (alias) {
      if (alias.targetTier) {
        effectiveStartTier = alias.targetTier
      }
      if (alias.targetModelId) {
        const explicit = await findCandidateByRowId(alias.targetModelId)
        if (explicit) {
          if (requirements.requiresTools && !explicit.supports_tools) throw new ExplicitModelCapabilityError(['tools'], requestedModel)
          if (requirements.requiresVision && !explicit.supports_vision) throw new ExplicitModelCapabilityError(['vision'], requestedModel)
          if (requirements.requiresJsonMode && !explicit.supports_json_mode) throw new ExplicitModelCapabilityError(['json_mode'], requestedModel)
          if (!candidateFitsContext(explicit, requirements.requiredTokens, largestSink)) {
            throw new ContextWindowExceededError(requirements.requiredTokens!, explicit.context_window ?? 0, effectiveStartTier)
          }
          if (isCandidateAvailableWithModelHealth(explicit, now) && !excludeModelRowIds.has(explicit.model_row_id)) {
            return toTarget(explicit)
          }
        }
      }
    } else if (norm !== "auto" && norm !== "zen/auto" && norm !== "default") {
      const explicit = await findCandidateByModel(requestedModel)
      if (explicit) {
        if (requirements.requiresTools && !explicit.supports_tools) throw new ExplicitModelCapabilityError(['tools'], requestedModel)
        if (requirements.requiresVision && !explicit.supports_vision) throw new ExplicitModelCapabilityError(['vision'], requestedModel)
        if (requirements.requiresJsonMode && !explicit.supports_json_mode) throw new ExplicitModelCapabilityError(['json_mode'], requestedModel)
        if (!candidateFitsContext(explicit, requirements.requiredTokens, largestSink)) {
          throw new ContextWindowExceededError(requirements.requiredTokens!, explicit.context_window ?? 0, effectiveStartTier)
        }
        if (isCandidateAvailableWithModelHealth(explicit, now) && !excludeModelRowIds.has(explicit.model_row_id)) {
          return toTarget(explicit)
        }
      }
    }
  }

  // 3. Normal tier walk
  const startIdx = TIER_ORDER.indexOf(effectiveStartTier)
  const maxIdx = Math.min(TIER_ORDER.indexOf(maxTier), TIER_ORDER.length - 1)

  for (let i = startIdx; i <= maxIdx; i++) {
    let candidates: Candidate[]
    try {
      candidates = await getTierCandidates(TIER_ORDER[i])
    } catch (err) {
      console.error("[routing] tier_routes query failed:", err)
      candidates = []
    }

    const validCandidates: Candidate[] = []
    for (const c of candidates) {
      const isExcluded = excludeModelRowIds.has(c.model_row_id)
      if (fits(c, isExcluded) && !isExcluded) {
        validCandidates.push(c)
      }
    }

    if (validCandidates.length > 0) {
      // P3.9: Route within a tier by capability, then by quality_score, then weighted random ONLY among equals
      const maxQuality = Math.max(...validCandidates.map(c => c.quality_score ?? 0))
      const topEquals = validCandidates.filter(c => (c.quality_score ?? 0) === maxQuality)
      const pick = weightedPick(topEquals)
      if (pick) return toTarget(pick)
    }
  }

  // 4. Fallback to any model
  try {
    let any = await getAnyCandidate()
    const validAny: Candidate[] = []
    for (const c of any) {
      const isExcluded = excludeModelRowIds.has(c.model_row_id)
      if (fits(c, isExcluded) && !isExcluded) {
        validAny.push(c)
      }
    }
    if (validAny.length > 0) {
      const maxQuality = Math.max(...validAny.map(c => c.quality_score ?? 0))
      const topEquals = validAny.filter(c => (c.quality_score ?? 0) === maxQuality)
      const pick = weightedPick(topEquals)
      if (pick) return toTarget(pick)
    }
  } catch (err) {
    console.error("[routing] fallback query failed:", err)
  }

  if (requirements.requiresTools && missingCaps.has('tools') && !anyCapable) {
    throw new UnsupportedCapabilityError(['tools'], effectiveStartTier)
  }

  if (requirements.requiredTokens !== undefined && largestSink.value !== null) {
    throw new ContextWindowExceededError(requirements.requiredTokens, largestSink.value, effectiveStartTier)
  }
  return null
}

export type RouteOutcomeOpts = {
  success: boolean
  error?: unknown
  retryAfterSeconds?: number
  modelRowId?: string
}

export async function reportRouteOutcome(
  providerId: string,
  outcome: boolean | RouteOutcomeOpts,
  modelRowId?: string,
): Promise<void> {
  const isSuccess = typeof outcome === "boolean" ? outcome : outcome.success
  const err = typeof outcome === "boolean" ? undefined : outcome.error
  const mid = modelRowId || (typeof outcome === "object" ? outcome.modelRowId : undefined)

  try {
    if (isSuccess) {
      if (mid) {
        modelHealthCache.set(mid, { healthy: true, health_state: "HEALTHY", cooldown_until: null })
        await withDbResilience(() => sql`
          INSERT INTO model_health (model_id, healthy, health_state, consecutive_failures, last_success_at, cooldown_until, last_failure_reason)
          VALUES (${mid}, true, 'HEALTHY', 0, now(), NULL, NULL)
          ON CONFLICT (model_id) DO UPDATE
          SET healthy = true, health_state = 'HEALTHY', consecutive_failures = 0, last_success_at = now(), cooldown_until = NULL, last_failure_reason = NULL
        `).catch(() => {})
      }

      await withDbResilience(() => sql`
        UPDATE providers
        SET healthy = true,
            health_state = 'HEALTHY',
            consecutive_failures = 0,
            last_success_at = now(),
            cooldown_until = NULL,
            last_failure_reason = NULL
        WHERE id = ${providerId}
      `).catch(() => {})
      return
    }

    let isTransient = true
    let isAuthError = false
    let reasonLabel = "unknown_failure"
    let isModelSpecific = false
    let retryAfterSec = typeof outcome === "object" ? outcome.retryAfterSeconds : undefined

    if (err) {
      const { classifyProviderError } = await import("./ai-call")
      const c = classifyProviderError(err)
      reasonLabel = `${c.kind}${c.statusCode ? ` (${c.statusCode})` : ""}`
      retryAfterSec = retryAfterSec ?? c.retryAfterSeconds
      isModelSpecific = !!c.isModelSpecific

      if (c.action === "break_loop" && !c.isModelSpecific) {
        isTransient = false
      } else if (c.action === "skip_candidate" && (c.kind === "unauthorized" || c.kind === "forbidden")) {
        isAuthError = true
      }
    }

    if (!isTransient && !isAuthError) {
      return
    }

    const cooldownMs = retryAfterSec ? retryAfterSec * 1000 : COOLDOWN_MS
    const cooldownIntervalSeconds = Math.ceil(cooldownMs / 1000)

    // P3.6: If the failure is model-specific (e.g. 429 rate limit or quota exceeded),
    // mark ONLY model_health. The provider row remains HEALTHY and other models continue serving traffic!
    if (isModelSpecific && mid) {
      modelHealthCache.set(mid, {
        healthy: false,
        health_state: "DOWN",
        cooldown_until: Date.now() + cooldownMs,
      })
      await withDbResilience(() => sql`
        INSERT INTO model_health (model_id, healthy, health_state, consecutive_failures, last_failure_at, cooldown_until, last_failure_reason)
        VALUES (${mid}, false, 'DOWN', 1, now(), now() + (${cooldownIntervalSeconds + " seconds"})::interval, ${reasonLabel})
        ON CONFLICT (model_id) DO UPDATE
        SET healthy = false,
            health_state = 'DOWN',
            consecutive_failures = model_health.consecutive_failures + 1,
            last_failure_at = now(),
            cooldown_until = now() + (${cooldownIntervalSeconds + " seconds"})::interval,
            last_failure_reason = ${reasonLabel}
      `).catch(() => {})
      return
    }

    if (isAuthError) {
      await withDbResilience(() => sql`
        UPDATE providers
        SET healthy = false,
            health_state = 'DEGRADED',
            consecutive_failures = consecutive_failures + 1,
            last_failure_at = now(),
            last_failure_reason = ${reasonLabel}
        WHERE id = ${providerId}
      `).catch(() => {})
      return
    }

    await withDbResilience(() => sql`
      UPDATE providers
      SET consecutive_failures = consecutive_failures + 1,
          last_failure_at = now(),
          last_failure_reason = ${reasonLabel},
          health_state = CASE
            WHEN (consecutive_failures + 1) >= ${FAILURE_THRESHOLD} OR health_state = 'RECOVERING' THEN 'DOWN'
            ELSE 'DEGRADED'
          END,
          healthy = CASE
            WHEN (consecutive_failures + 1) >= ${FAILURE_THRESHOLD} OR health_state = 'RECOVERING' THEN false
            ELSE true
          END,
          cooldown_until = CASE
            WHEN (consecutive_failures + 1) >= ${FAILURE_THRESHOLD} OR health_state = 'RECOVERING'
              THEN now() + (${cooldownIntervalSeconds + " seconds"})::interval
            ELSE cooldown_until
          END
      WHERE id = ${providerId}
    `).catch(() => {})
  } catch (err) {
    console.error("[routing] failed to report outcome:", err)
  }
}
