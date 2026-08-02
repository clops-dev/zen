import { sql } from "./db"
import type { ComplexityTier } from "./db"

const TIER_ORDER: ComplexityTier[] = ["trivial", "simple", "medium", "complex"]
const COOLDOWN_MS = 60_000
const FAILURE_THRESHOLD = 3

/** Raised by pickRoute when the request's input tokens exceed the largest
 * context window available in the configured fallback chain for this
 * request's tier. The gateway catches this in its try/catch fallback loop
 * and surfaces a 413-ish response — never a raw provider 400. The exact
 * required/available token numbers are attached so the client can decide
 * what to do (truncate, summarize, split into sub-tasks, etc.). */
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
  /** Provider's advertised context window in tokens. null = unknown (we
   * skip the context check for that model). */
  contextWindow: number | null
  supportsTools: boolean
  supportsVision: boolean
  supportsJsonMode: boolean
  /** Which upstream adapter to use. "openai-compatible" routes through
   * @ai-sdk/openai-compatible (chat completions, /v1/chat/completions).
   * "anthropic-compatible" routes through @ai-sdk/anthropic (messages,
   * /messages, Bearer auth, anthropic-version header). Selected at the
   * provider row level (providers.provider_type) and surfaced here so
   * ai-call.ts can dispatch without re-querying the DB. */
  providerType: "openai-compatible" | "anthropic-compatible"
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
  context_window: number | null
  supports_tools: boolean
  supports_vision: boolean
  supports_json_mode: boolean
  weight: number
  provider_type: "openai-compatible" | "anthropic-compatible"
}

/** Deterministic weighted pick for tests; non-deterministic in prod unless
 * DETERMINISTIC_ROUTING=1 is set. Extracted so unit tests can assert which
 * candidate is chosen from a fixed list. */
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

async function getTierCandidates(tier: ComplexityTier): Promise<Candidate[]> {
  const now = Date.now()
  const rows = await sql<Candidate[]>`
    SELECT
      m.id AS model_row_id, p.id AS provider_id, p.name AS provider_name,
      p.base_url, p.api_key, m.model_id,
      m.input_price_per_1m, m.output_price_per_1m, m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      p.provider_type,
      tr.weight::float8 AS weight,
      p.healthy, p.last_failure_at
    FROM tier_routes tr
    JOIN models m ON m.id = tr.model_id
    JOIN providers p ON p.id = m.provider_id
    WHERE tr.tier = ${tier} AND tr.enabled = true AND m.enabled = true AND p.enabled = true
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
      m.input_price_per_1m, m.output_price_per_1m, m.context_window,
      m.supports_tools, m.supports_vision, m.supports_json_mode,
      p.provider_type,
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
    contextWindow: c.context_window,
    supportsTools: c.supports_tools,
    supportsVision: c.supports_vision,
    supportsJsonMode: c.supports_json_mode,
    providerType: c.provider_type,
  }
}

/** Default reserve needed to leave room for a model's response on top
 * of input. The larger of: 20% of the context window, or 2048 tokens
 * (some tool-call schemas and short answers legitimately need that much
 * output headroom). Exported so tests can verify the math. */
export function defaultReserveFor(contextWindow: number): number {
  return Math.max(2048, Math.floor(contextWindow * 0.2))
}

/** Pure helper: does this candidate leave enough room for `requiredTokens`
 * plus a reserve for output? `context_window: null` means unknown — we
 * skip the check (don't block on missing data). Tracks the largest
 * context window seen in `largestSink.value` for the caller's error
 * reporting. Exported for direct unit testing without a DB. */
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

/**
 * Picks a target for the given complexity tier, escalating upward through
 * tiers if nothing is healthy there, then falling back to ANY enabled model
 * anywhere if tier_routes has nothing configured at all.
 *
 * `excludeModelRowIds` — model rows already tried and failed in THIS
 * request (not persisted, just for one fallback loop in gateway.ts). This
 * is what turns "multiple models on one tier" into real per-request
 * fallback: exclude the one that just failed, pick again.
 *
 * `requiredTokens` — caller-computed upper bound on input tokens for this
 * request. Candidates whose context window (minus reserve for output)
 * cannot fit `requiredTokens` are filtered out. If no candidate in the
 * entire fallback chain (start tier through `maxTier`, then the catch-all
 * "any model" set) has a sufficient context window, throws
 * ContextWindowExceededError rather than silently picking a too-small
 * model. Pass `undefined` to skip the check (legacy callers; not used by
 * the gateway).
 *
 * Returns null only if there is truly no usable, untried provider/model
 * configured anywhere AND no context-window check was requested.
 */
export async function pickRoute(
  startTier: ComplexityTier,
  maxTier: ComplexityTier = "complex",
  excludeModelRowIds: Set<string> = new Set(),
  requirements: RouteRequirements = {},
): Promise<RouteTarget | null> {
  const startIdx = TIER_ORDER.indexOf(startTier)
  const maxIdx = Math.min(TIER_ORDER.indexOf(maxTier), TIER_ORDER.length - 1)

  // Tracks the largest context window seen across the entire fallback
  // chain, used for the error message when nothing fits. Includes the
  // catch-all "any model" set so the error reflects the true maximum.
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
    candidates = validCandidates

    while (candidates.length) {
      const pick = weightedPick(candidates)
      if (!pick) break
      return toTarget(pick)
    }
  }

  // Nothing configured for any tier — fall back to anything at all, still
  // respecting exclusions so this doesn't just re-return the same failed model.
  try {
    let any = await getAnyCandidate()
    const validAny: Candidate[] = []
    for (const c of any) {
      const isExcluded = excludeModelRowIds.has(c.model_row_id)
      if (fits(c, isExcluded) && !isExcluded) {
        validAny.push(c)
      }
    }
    const pick = weightedPick(validAny)
    if (pick) return toTarget(pick)
  } catch (err) {
    console.error("[routing] fallback query failed:", err)
  }

  // If the caller asked for a context check and the chain had at least one
  // candidate but none fit, raise the typed error. (If largestSink.value
  // is null it means we found NO models at all — keep the existing null
  // return so the gateway can produce its "no providers configured" 503.)
  if (requirements.requiredTokens !== undefined && largestSink.value !== null) {
    throw new ContextWindowExceededError(requirements.requiredTokens, largestSink.value, startTier)
  }
  
  if (!anyCapable && missingCaps.size > 0 && largestSink.value === null) {
    throw new UnsupportedCapabilityError(Array.from(missingCaps), startTier)
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
