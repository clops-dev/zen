/**
 * Helper to fetch model metadata from OpenRouter's public Models API
 * GET https://openrouter.ai/api/v1/model/{author}/{slug}
 */

export interface OpenRouterFetchedMetadata {
  label: string
  context_window: number | null
  input_price_per_1m: number
  output_price_per_1m: number
  input_cache_read_price_per_1m: number | null
  input_cache_write_price_per_1m: number | null
  request_price_flat: number
  supports_tools: boolean
  supports_structured_outputs: boolean
  supports_reasoning: boolean
  supports_vision: boolean
  supports_json_mode: boolean
  input_modalities: string[]
  output_modalities: string[]
  is_moderated: boolean
  max_completion_tokens: number | null
  expiration_date: string | null
  openrouter_model_id: string
  metadata_synced_at: string
  overrides_warning: string | null
}

export async function fetchOpenRouterModelMetadata(modelId: string): Promise<OpenRouterFetchedMetadata> {
  const parts = modelId.split("/")
  if (parts.length < 2) {
    throw new Error("Invalid OpenRouter model ID format. Expected 'author/slug' (e.g. anthropic/claude-3.5-sonnet).")
  }
  const author = parts[0]
  const slug = parts.slice(1).join("/")
  const url = `https://openrouter.ai/api/v1/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`

  let res: Response
  try {
    res = await fetch(url)
  } catch (cause) {
    throw new Error(`Failed to reach OpenRouter API: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  if (res.status === 404) {
    const err = new Error(`OpenRouter model not found: '${modelId}'`)
    ;(err as any).statusCode = 404
    throw err
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const err = new Error(`OpenRouter API returned HTTP ${res.status}: ${text || res.statusText}`)
    ;(err as any).statusCode = res.status
    throw err
  }

  const json = await res.json().catch(() => null)
  const data = json?.data
  if (!data) {
    throw new Error("OpenRouter response contained no model data.")
  }

  const promptPrice = Number(data.pricing?.prompt ?? 0)
  const completionPrice = Number(data.pricing?.completion ?? 0)
  const inputPricePer1M = promptPrice * 1_000_000
  const outputPricePer1M = completionPrice * 1_000_000

  let cacheReadPrice: number | null = null
  if (data.pricing?.input_cache_read != null) {
    const rawCacheRead = Number(data.pricing.input_cache_read)
    if (rawCacheRead > 0) {
      cacheReadPrice = rawCacheRead * 1_000_000
    } else if (inputPricePer1M === 0 && data.pricing.input_cache_read === "0") {
      cacheReadPrice = 0
    }
  }

  let cacheWritePrice: number | null = null
  if (data.pricing?.input_cache_write != null) {
    const rawCacheWrite = Number(data.pricing.input_cache_write)
    if (rawCacheWrite > 0) {
      cacheWritePrice = rawCacheWrite * 1_000_000
    } else if (inputPricePer1M === 0 && data.pricing.input_cache_write === "0") {
      cacheWritePrice = 0
    }
  }

  const requestPriceFlat = Number(data.pricing?.request ?? 0)

  const params: string[] = Array.isArray(data.supported_parameters) ? data.supported_parameters : []
  const inputModalities: string[] = Array.isArray(data.architecture?.input_modalities) ? data.architecture.input_modalities : []
  const outputModalities: string[] = Array.isArray(data.architecture?.output_modalities) ? data.architecture.output_modalities : []

  const hasOverrides = Array.isArray(data.pricing?.overrides) && data.pricing.overrides.length > 0
  const overridesWarning = hasOverrides
    ? "Note: this model has conditional pricing overrides not reflected in the stored per-1M rates — cost tracking will be approximate"
    : null

  return {
    label: data.name ?? data.id,
    context_window: data.context_length ?? null,
    input_price_per_1m: inputPricePer1M,
    output_price_per_1m: outputPricePer1M,
    input_cache_read_price_per_1m: cacheReadPrice,
    input_cache_write_price_per_1m: cacheWritePrice,
    request_price_flat: requestPriceFlat,
    supports_tools: params.includes("tools"),
    supports_structured_outputs: params.includes("structured_outputs"),
    supports_reasoning: params.includes("reasoning"),
    supports_vision: inputModalities.includes("image"),
    supports_json_mode: params.includes("response_format") || params.includes("structured_outputs"),
    input_modalities: inputModalities,
    output_modalities: outputModalities,
    is_moderated: Boolean(data.top_provider?.is_moderated),
    max_completion_tokens: data.top_provider?.max_completion_tokens ?? null,
    expiration_date: data.expiration_date ?? null,
    openrouter_model_id: data.canonical_slug ?? data.id,
    metadata_synced_at: new Date().toISOString(),
    overrides_warning: overridesWarning,
  }
}
