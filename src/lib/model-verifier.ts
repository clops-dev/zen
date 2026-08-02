/**
 * model-verifier.ts
 *
 * Pure comparison/matching logic for verifying local model rows against live
 * provider models-list endpoints. No DB access here — callers supply rows and
 * fetch results so this module is fully unit-testable without network or DB.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalModelRow = {
  id: string
  model_id: string
  label: string | null
  input_price_per_1m: string | number
  output_price_per_1m: string | number
  context_window: number | null
  supports_tools: boolean
  supports_vision: boolean
  supports_json_mode: boolean
  provider_name: string
  provider_base_url: string
}

/** Normalised shape we extract from any provider's live response */
export type NormalisedProviderModel = {
  id: string
  /** input price per 1M tokens (converted from whatever the provider gives) */
  inputPricePer1M: number
  /** output price per 1M tokens */
  outputPricePer1M: number
  contextLength: number | null
  supportsTools: boolean
  supportsVision: boolean
  supportsJsonMode: boolean
}

export type VerificationStatus =
  | "OK"
  | "MISMATCH"
  | "NOT_FOUND"
  | "NOT_VERIFIABLE"

export type FieldMismatch = {
  field: string
  local: string | number | boolean | null
  live: string | number | boolean | null
}

export type VerificationResult = {
  modelRowId: string
  modelId: string
  providerName: string
  status: VerificationStatus
  mismatches: FieldMismatch[]
  /** For NOT_VERIFIABLE rows */
  reason?: string
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

/** Groq: GET /openai/v1/models — one model per array entry */
export function normaliseGroqModel(raw: Record<string, any>): NormalisedProviderModel {
  // pricing fields are per-token strings; multiply by 1_000_000 for per-1M
  const promptPerToken = Number(raw.pricing?.prompt ?? 0)
  const completionPerToken = Number(raw.pricing?.completion ?? 0)

  const features: string[] = raw.supported_features ?? []
  const modalities: string[] = raw.input_modalities ?? []

  return {
    id: raw.id,
    inputPricePer1M: promptPerToken * 1_000_000,
    outputPricePer1M: completionPerToken * 1_000_000,
    contextLength: raw.context_window ?? raw.context_length ?? null,
    supportsTools: features.includes("tools"),
    supportsVision: modalities.includes("image"),
    supportsJsonMode: features.includes("json_mode"),
  }
}

/** OpenRouter: GET /api/v1/models — one model per array entry */
export function normaliseOpenRouterModel(raw: Record<string, any>): NormalisedProviderModel {
  // pricing fields are per-token strings; multiply by 1_000_000 for per-1M
  const promptPerToken = Number(raw.pricing?.prompt ?? 0)
  const completionPerToken = Number(raw.pricing?.completion ?? 0)

  const params: string[] = raw.supported_parameters ?? []
  const inputModalities: string[] = raw.architecture?.input_modalities ?? []

  return {
    id: raw.id,
    inputPricePer1M: promptPerToken * 1_000_000,
    outputPricePer1M: completionPerToken * 1_000_000,
    contextLength: raw.context_length ?? null,
    supportsTools: params.includes("tools"),
    supportsVision: inputModalities.includes("image"),
    supportsJsonMode: params.includes("response_format"),
  }
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export type ProviderKind = "groq" | "openrouter" | "unknown"

export function detectProviderKind(baseUrl: string): ProviderKind {
  const url = baseUrl.toLowerCase()
  if (url.includes("groq.com")) return "groq"
  if (url.includes("openrouter.ai")) return "openrouter"
  return "unknown"
}

export function modelsListUrl(baseUrl: string, kind: ProviderKind): string | null {
  if (kind === "groq") return "https://api.groq.com/openai/v1/models"
  if (kind === "openrouter") return "https://openrouter.ai/api/v1/models"
  return null
}

export function normaliseRawModel(
  raw: Record<string, any>,
  kind: ProviderKind,
): NormalisedProviderModel {
  if (kind === "groq") return normaliseGroqModel(raw)
  if (kind === "openrouter") return normaliseOpenRouterModel(raw)
  throw new Error(`No adapter for provider kind: ${kind}`)
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const PRICE_TOLERANCE = 0.01 // 1%

function priceMismatch(local: number, live: number): boolean {
  if (live === 0 && local === 0) return false
  if (live === 0) return local !== 0
  return Math.abs(local - live) / live > PRICE_TOLERANCE
}

/**
 * Compare a local DB row against the normalised live model.
 * Returns a list of field mismatches (empty = all OK).
 */
export function compareModel(
  local: LocalModelRow,
  live: NormalisedProviderModel,
): FieldMismatch[] {
  const mismatches: FieldMismatch[] = []

  const localInput = Number(local.input_price_per_1m)
  const localOutput = Number(local.output_price_per_1m)

  if (priceMismatch(localInput, live.inputPricePer1M)) {
    mismatches.push({
      field: "input_price_per_1m",
      local: localInput,
      live: live.inputPricePer1M,
    })
  }

  if (priceMismatch(localOutput, live.outputPricePer1M)) {
    mismatches.push({
      field: "output_price_per_1m",
      local: localOutput,
      live: live.outputPricePer1M,
    })
  }

  if (live.contextLength !== null) {
    if (local.context_window === null) {
      mismatches.push({
        field: "context_window",
        local: null,
        live: live.contextLength,
      })
    } else if (local.context_window !== live.contextLength) {
      mismatches.push({
        field: "context_window",
        local: local.context_window,
        live: live.contextLength,
      })
    }
  }

  if (local.supports_tools !== live.supportsTools) {
    mismatches.push({
      field: "supports_tools",
      local: local.supports_tools,
      live: live.supportsTools,
    })
  }

  if (local.supports_vision !== live.supportsVision) {
    mismatches.push({
      field: "supports_vision",
      local: local.supports_vision,
      live: live.supportsVision,
    })
  }

  if (local.supports_json_mode !== live.supportsJsonMode) {
    mismatches.push({
      field: "supports_json_mode",
      local: local.supports_json_mode,
      live: live.supportsJsonMode,
    })
  }

  return mismatches
}

/**
 * Classify a local row against a live lookup map (model_id → NormalisedProviderModel).
 * Pass `null` for liveMap when the provider is not verifiable.
 */
export function classifyRow(
  local: LocalModelRow,
  liveMap: Map<string, NormalisedProviderModel> | null,
): VerificationResult {
  if (liveMap === null) {
    return {
      modelRowId: local.id,
      modelId: local.model_id,
      providerName: local.provider_name,
      status: "NOT_VERIFIABLE",
      mismatches: [],
      reason: "Provider has no known live models-list endpoint — manual check required",
    }
  }

  const live = liveMap.get(local.model_id)
  if (!live) {
    return {
      modelRowId: local.id,
      modelId: local.model_id,
      providerName: local.provider_name,
      status: "NOT_FOUND",
      mismatches: [],
    }
  }

  const mismatches = compareModel(local, live)
  return {
    modelRowId: local.id,
    modelId: local.model_id,
    providerName: local.provider_name,
    status: mismatches.length > 0 ? "MISMATCH" : "OK",
    mismatches,
  }
}

// ---------------------------------------------------------------------------
// Migration SQL generation
// ---------------------------------------------------------------------------

export function generateFixSql(
  result: VerificationResult,
  liveMap: Map<string, NormalisedProviderModel>,
): string | null {
  if (result.status !== "MISMATCH") return null
  const live = liveMap.get(result.modelId)
  if (!live) return null

  const sets: string[] = []
  for (const m of result.mismatches) {
    const val = m.live
    if (typeof val === "boolean") {
      sets.push(`  ${m.field} = ${val}`)
    } else if (val === null) {
      sets.push(`  ${m.field} = NULL`)
    } else {
      sets.push(`  ${m.field} = ${val}`)
    }
  }

  if (sets.length === 0) return null

  return [
    `-- ${result.providerName} / ${result.modelId}`,
    `UPDATE models SET`,
    sets.join(",\n"),
    `WHERE id = '${result.modelRowId}';`,
  ].join("\n")
}
