import { describe, test, expect } from "bun:test"
import {
  normaliseGroqModel,
  normaliseOpenRouterModel,
  compareModel,
  classifyRow,
  generateFixSql,
  type LocalModelRow,
  type NormalisedProviderModel,
} from "./model-verifier"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocal(overrides: Partial<LocalModelRow> = {}): LocalModelRow {
  return {
    id: "row-1",
    model_id: "some/model",
    label: null,
    input_price_per_1m: "0.59",
    output_price_per_1m: "0.79",
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_json_mode: true,
    provider_name: "groq",
    provider_base_url: "https://api.groq.com/openai/v1",
    ...overrides,
  }
}

function makeMap(model: NormalisedProviderModel): Map<string, NormalisedProviderModel> {
  return new Map([[model.id, model]])
}

// ---------------------------------------------------------------------------
// normaliseGroqModel
// ---------------------------------------------------------------------------

describe("normaliseGroqModel", () => {
  // Real shape from GET https://api.groq.com/openai/v1/models
  const RAW_GROQ = {
    id: "llama-3.3-70b-versatile",
    object: "model",
    created: 1733447754,
    owned_by: "Meta",
    active: true,
    context_window: 131072,
    context_length: 131072,
    pricing: {
      prompt: "0.00000059",
      completion: "0.00000079",
      image: "0",
      request: "0",
      input_cache_read: "0.000000295",
    },
    supported_sampling_parameters: ["temperature", "top_p", "stop", "seed", "max_tokens"],
    supported_features: ["tools", "json_mode"],
    input_modalities: ["text"],
    output_modalities: ["text"],
  }

  test("converts per-token pricing to per-1M", () => {
    const n = normaliseGroqModel(RAW_GROQ)
    expect(n.inputPricePer1M).toBeCloseTo(0.59, 4)
    expect(n.outputPricePer1M).toBeCloseTo(0.79, 4)
  })

  test("reads context_window", () => {
    const n = normaliseGroqModel(RAW_GROQ)
    expect(n.contextLength).toBe(131072)
  })

  test("detects tools support from supported_features", () => {
    const n = normaliseGroqModel(RAW_GROQ)
    expect(n.supportsTools).toBe(true)
  })

  test("detects json_mode from supported_features", () => {
    const n = normaliseGroqModel(RAW_GROQ)
    expect(n.supportsJsonMode).toBe(true)
  })

  test("detects no vision when input_modalities is text-only", () => {
    const n = normaliseGroqModel(RAW_GROQ)
    expect(n.supportsVision).toBe(false)
  })

  test("detects vision when input_modalities includes image", () => {
    const n = normaliseGroqModel({ ...RAW_GROQ, input_modalities: ["text", "image"] })
    expect(n.supportsVision).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normaliseOpenRouterModel
// ---------------------------------------------------------------------------

describe("normaliseOpenRouterModel", () => {
  // Real shape from GET https://openrouter.ai/api/v1/models
  const RAW_OPENROUTER = {
    id: "qwen/qwen3-coder:free",
    context_length: 131072,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "Other",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
    },
    supported_parameters: [
      "max_tokens",
      "temperature",
      "top_p",
      "tools",
      "tool_choice",
      "response_format",
    ],
  }

  test("converts per-token pricing to per-1M (free model = 0)", () => {
    const n = normaliseOpenRouterModel(RAW_OPENROUTER)
    expect(n.inputPricePer1M).toBe(0)
    expect(n.outputPricePer1M).toBe(0)
  })

  test("reads context_length", () => {
    const n = normaliseOpenRouterModel(RAW_OPENROUTER)
    expect(n.contextLength).toBe(131072)
  })

  test("detects tools from supported_parameters", () => {
    const n = normaliseOpenRouterModel(RAW_OPENROUTER)
    expect(n.supportsTools).toBe(true)
  })

  test("detects json_mode from response_format in supported_parameters", () => {
    const n = normaliseOpenRouterModel(RAW_OPENROUTER)
    expect(n.supportsJsonMode).toBe(true)
  })

  test("detects no vision when input_modalities is text-only", () => {
    const n = normaliseOpenRouterModel(RAW_OPENROUTER)
    expect(n.supportsVision).toBe(false)
  })

  test("detects vision when architecture.input_modalities includes image", () => {
    const n = normaliseOpenRouterModel({
      ...RAW_OPENROUTER,
      architecture: { ...RAW_OPENROUTER.architecture, input_modalities: ["text", "image"] },
    })
    expect(n.supportsVision).toBe(true)
  })

  test("model without tools in supported_parameters is not tool-capable", () => {
    const n = normaliseOpenRouterModel({ ...RAW_OPENROUTER, supported_parameters: ["max_tokens"] })
    expect(n.supportsTools).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// compareModel
// ---------------------------------------------------------------------------

describe("compareModel", () => {
  const LIVE: NormalisedProviderModel = {
    id: "some/model",
    inputPricePer1M: 0.59,
    outputPricePer1M: 0.79,
    contextLength: 131072,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
  }

  test("no mismatches when local matches live exactly", () => {
    const local = makeLocal()
    expect(compareModel(local, LIVE)).toHaveLength(0)
  })

  test("flags input_price_per_1m mismatch when local is 0 and live is nonzero", () => {
    const local = makeLocal({ input_price_per_1m: "0" })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "input_price_per_1m")).toBe(true)
  })

  test("flags output_price_per_1m mismatch", () => {
    const local = makeLocal({ output_price_per_1m: "0" })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "output_price_per_1m")).toBe(true)
  })

  test("does NOT flag price when both local and live are 0", () => {
    const live: NormalisedProviderModel = { ...LIVE, inputPricePer1M: 0, outputPricePer1M: 0 }
    const local = makeLocal({ input_price_per_1m: "0", output_price_per_1m: "0" })
    const ms = compareModel(local, live)
    expect(ms.some((m) => m.field.includes("price"))).toBe(false)
  })

  test("does NOT flag price within 1% tolerance", () => {
    const live: NormalisedProviderModel = { ...LIVE, inputPricePer1M: 0.5909 }
    const local = makeLocal({ input_price_per_1m: "0.59" })
    const ms = compareModel(local, live)
    expect(ms.some((m) => m.field === "input_price_per_1m")).toBe(false)
  })

  test("flags context_window when local is null and live has value", () => {
    const local = makeLocal({ context_window: null })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "context_window")).toBe(true)
    expect(ms.find((m) => m.field === "context_window")?.live).toBe(131072)
  })

  test("flags context_window mismatch", () => {
    const local = makeLocal({ context_window: 8192 })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "context_window")).toBe(true)
  })

  test("does NOT flag context_window when live has no value", () => {
    const live: NormalisedProviderModel = { ...LIVE, contextLength: null }
    const local = makeLocal({ context_window: null })
    const ms = compareModel(local, live)
    expect(ms.some((m) => m.field === "context_window")).toBe(false)
  })

  test("flags supports_tools false when live is true", () => {
    const local = makeLocal({ supports_tools: false })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "supports_tools")).toBe(true)
  })

  test("flags supports_vision true when live is false", () => {
    const local = makeLocal({ supports_vision: true })
    const ms = compareModel(local, LIVE)
    expect(ms.some((m) => m.field === "supports_vision")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// classifyRow
// ---------------------------------------------------------------------------

describe("classifyRow", () => {
  const LIVE: NormalisedProviderModel = {
    id: "some/model",
    inputPricePer1M: 0.59,
    outputPricePer1M: 0.79,
    contextLength: 131072,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
  }

  test("status OK when everything matches", () => {
    const result = classifyRow(makeLocal(), makeMap(LIVE))
    expect(result.status).toBe("OK")
    expect(result.mismatches).toHaveLength(0)
  })

  test("status MISMATCH when there are field differences", () => {
    const local = makeLocal({ input_price_per_1m: "0" })
    const result = classifyRow(local, makeMap(LIVE))
    expect(result.status).toBe("MISMATCH")
    expect(result.mismatches.length).toBeGreaterThan(0)
  })

  test("status NOT_FOUND when model_id absent from live map", () => {
    const local = makeLocal({ model_id: "openrouter/free" })
    const result = classifyRow(local, makeMap(LIVE))
    expect(result.status).toBe("NOT_FOUND")
  })

  test("status NOT_VERIFIABLE when liveMap is null", () => {
    const result = classifyRow(makeLocal(), null)
    expect(result.status).toBe("NOT_VERIFIABLE")
    expect(result.reason).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// generateFixSql
// ---------------------------------------------------------------------------

describe("generateFixSql", () => {
  const LIVE: NormalisedProviderModel = {
    id: "some/model",
    inputPricePer1M: 0.59,
    outputPricePer1M: 0.79,
    contextLength: 131072,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
  }

  test("returns null for OK rows", () => {
    const result = classifyRow(makeLocal(), makeMap(LIVE))
    expect(generateFixSql(result, makeMap(LIVE))).toBeNull()
  })

  test("generates UPDATE SQL for MISMATCH rows", () => {
    const local = makeLocal({ context_window: null, input_price_per_1m: "0" })
    const result = classifyRow(local, makeMap(LIVE))
    const sql = generateFixSql(result, makeMap(LIVE))
    expect(sql).not.toBeNull()
    expect(sql).toContain("UPDATE models SET")
    expect(sql).toContain("row-1")
    expect(sql).toContain("context_window")
    expect(sql).toContain("input_price_per_1m")
  })

  test("returns null for NOT_FOUND rows (never auto-delete)", () => {
    const local = makeLocal({ model_id: "openrouter/free" })
    const result = classifyRow(local, makeMap(LIVE))
    expect(generateFixSql(result, makeMap(LIVE))).toBeNull()
  })
})
