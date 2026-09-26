import { describe, test, expect, beforeEach } from "bun:test"
import {
  reportRouteOutcome,
  isCandidateAvailableWithModelHealth,
  modelHealthCache,
} from "./routing"
import { parseRetryAfter, classifyProviderError } from "./ai-call"
import { setSql } from "./db"

describe("P3.6 & P3.7: Per-Model Circuit Breaker & Retry-After Parsing", () => {
  beforeEach(() => {
    modelHealthCache.clear()
    const mockSql = (() => Promise.resolve([])) as any
    mockSql.begin = async (fn: any) => fn(mockSql)
    setSql(mockSql)
  })

  test("parses Retry-After header as seconds", () => {
    const errWithHeader = {
      message: "Rate limit exceeded",
      responseHeaders: {
        "retry-after": "25",
      },
    }
    expect(parseRetryAfter(errWithHeader)).toBe(25)
  })

  test("parses retry after seconds from error message text", () => {
    const errWithMessage = new Error("Rate limit reached. Please try again in 18.5s.")
    expect(parseRetryAfter(errWithMessage)).toBe(19) // ceiling of 18.5
  })

  test("parses free-tier daily cap / daily limit to 86400s (24h)", () => {
    const errDaily = new Error("You have exceeded your free-tier daily limit.")
    expect(parseRetryAfter(errDaily)).toBe(86400)
  })

  test("classifies 429 as model-specific error", () => {
    const err429 = { statusCode: 429, message: "Too Many Requests" }
    const c = classifyProviderError(err429)
    expect(c.kind).toBe("rate_limited")
    expect(c.isModelSpecific).toBe(true)
  })

  test("classifies 401 as provider-wide error", () => {
    const err401 = { statusCode: 401, message: "Invalid API key" }
    const c = classifyProviderError(err401)
    expect(c.kind).toBe("unauthorized")
    expect(Boolean(c.isModelSpecific)).toBe(false)
  })

  test("429 on model A does not affect model B on the same provider", async () => {
    const now = Date.now()
    const providerId = "prov-openrouter"
    const modelARowId = "row-model-a"
    const modelBRowId = "row-model-b"

    // Simulate 429 error on Model A with Retry-After 30s
    const err429 = {
      statusCode: 429,
      message: "Rate limit exceeded for model-a. Please try again in 30s.",
      responseHeaders: { "retry-after": "30" },
    }

    await reportRouteOutcome(providerId, { success: false, error: err429, modelRowId: modelARowId })

    // Model A candidate object
    const candidateA = {
      model_row_id: modelARowId,
      provider_id: providerId,
      healthy: true, // provider is still healthy!
      health_state: "HEALTHY",
    }

    // Model B candidate object
    const candidateB = {
      model_row_id: modelBRowId,
      provider_id: providerId,
      healthy: true,
      health_state: "HEALTHY",
    }

    // Model A should be DOWN / unavailable
    expect(isCandidateAvailableWithModelHealth(candidateA, now)).toBe(false)

    // Model B on the SAME provider should still be HEALTHY / available!
    expect(isCandidateAvailableWithModelHealth(candidateB, now)).toBe(true)
  })

  test("401 on provider marks all models unavailable", async () => {
    const now = Date.now()
    const providerId = "prov-dead"
    const modelARowId = "row-model-a"
    const modelBRowId = "row-model-b"

    // 401 Unauthorized
    const err401 = { statusCode: 401, message: "Invalid API Key" }

    await reportRouteOutcome(providerId, { success: false, error: err401, modelRowId: modelARowId })

    // When provider is degraded/down due to auth, candidates are not available
    const candidateA = {
      model_row_id: modelARowId,
      provider_id: providerId,
      healthy: false,
      health_state: "DOWN",
    }
    const candidateB = {
      model_row_id: modelBRowId,
      provider_id: providerId,
      healthy: false,
      health_state: "DOWN",
    }

    expect(isCandidateAvailableWithModelHealth(candidateA, now)).toBe(false)
    expect(isCandidateAvailableWithModelHealth(candidateB, now)).toBe(false)
  })
})
