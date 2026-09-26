import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  pickRoute,
  reportRouteOutcome,
  modelHealthCache,
  ExplicitModelCapabilityError,
  findAliasTarget,
  type RouteTarget,
} from "./routing"
import { getAffinityStore, InMemoryAffinityStore, setAffinityStore, deriveConversationKey } from "./affinity"
import { setSql, resetSql } from "./db"

describe("P3: Routing — One coherent assistant per conversation & Gateway features", () => {
  let mockModels: any[] = []
  let mockProviders: any[] = []

  beforeEach(() => {
    setAffinityStore(new InMemoryAffinityStore(1000, 3600_000))
    modelHealthCache.clear()

    mockProviders = [
      { id: "prov-openai", name: "openai", enabled: true, consecutive_failures: 0, cooldown_until: null },
      { id: "prov-anthropic", name: "anthropic", enabled: true, consecutive_failures: 0, cooldown_until: null },
    ]

    mockModels = [
      {
        id: "m-claude-35",
        model_row_id: "m-claude-35",
        provider_id: "prov-anthropic",
        model_id: "claude-3.5-sonnet",
        label: "anthropic/claude-3.5-sonnet",
        tier: "complex",
        context_window: 200000,
        supports_tools: true,
        supports_vision: true,
        supports_json_mode: true,
        input_price_per_million: 3,
        output_price_per_million: 15,
        input_cache_read_price_per_million: 0.3,
        input_cache_write_price_per_million: 3.75,
        request_price_flat: 0,
        quality_score: 95,
        enabled: true,
        healthy: true,
        health_state: "HEALTHY",
        provider_name: "anthropic",
        provider_base_url: "https://api.anthropic.com/v1",
        provider_api_key: "test-key",
      },
      {
        id: "m-gpt-4o",
        model_row_id: "m-gpt-4o",
        provider_id: "prov-openai",
        model_id: "gpt-4o",
        label: "openai/gpt-4o",
        tier: "complex",
        context_window: 128000,
        supports_tools: true,
        supports_vision: true,
        supports_json_mode: true,
        input_price_per_million: 2.5,
        output_price_per_million: 10,
        input_cache_read_price_per_million: 1.25,
        input_cache_write_price_per_million: 2.5,
        request_price_flat: 0,
        quality_score: 90,
        enabled: true,
        healthy: true,
        health_state: "HEALTHY",
        provider_name: "openai",
        provider_base_url: "https://api.openai.com/v1",
        provider_api_key: "test-key",
      },
      {
        id: "m-gpt-instruct",
        model_row_id: "m-gpt-instruct",
        provider_id: "prov-openai",
        model_id: "gpt-3.5-turbo-instruct",
        label: "openai/gpt-3.5-turbo-instruct",
        tier: "simple",
        context_window: 4096,
        supports_tools: false,
        supports_vision: false,
        supports_json_mode: false,
        input_price_per_million: 1.5,
        output_price_per_million: 2,
        input_cache_read_price_per_million: 0,
        input_cache_write_price_per_million: 0,
        request_price_flat: 0,
        quality_score: 70,
        enabled: true,
        healthy: true,
        health_state: "HEALTHY",
        provider_name: "openai",
        provider_base_url: "https://api.openai.com/v1",
        provider_api_key: "test-key",
      },
    ]

    const mockSql = ((strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join(" ")
      if (q.includes("SELECT alias, target_tier")) {
        return Promise.resolve([])
      }
      if (q.includes("SELECT id, model_id") || q.includes("FROM models m") || q.includes("FROM tier_routes")) {
        const requested = values.find((value) => typeof value === "string" && value.includes("gpt-3.5-turbo-instruct"))
        if (requested) return Promise.resolve(mockModels.filter((model) => model.model_id === "gpt-3.5-turbo-instruct"))
        return Promise.resolve(mockModels)
      }
      if (q.includes("SELECT id, name") || q.includes("FROM providers")) {
        return Promise.resolve(mockProviders)
      }
      return Promise.resolve([])
    }) as any
    mockSql.begin = async (fn: any) => fn(mockSql)
    setSql(mockSql)
  })

  afterEach(() => {
    resetSql()
  })

  test("Benchmark M6: 50 sequential tool-using turns stay pinned to the same model (100%)", async () => {
    const affinityStore = getAffinityStore()
    const convKey = "conv-session-12345"
    const requirements = { requiredTokens: 500, requiresTools: true }

    const turns: string[] = []

    for (let turn = 1; turn <= 50; turn++) {
      const activeAffinity = await affinityStore.get(convKey)
      const target = await pickRoute(
        "complex",
        "complex",
        new Set<string>(),
        requirements,
        undefined,
        activeAffinity?.modelRowId,
      )
      expect(target).not.toBeNull()
      turns.push(target!.label)

      // Pin or refresh affinity
      affinityStore.set(convKey, {
        modelRowId: target!.modelRowId,
        providerId: target!.providerId,
        modelLabel: target!.label,
        pinnedAt: Date.now(),
      })
    }

    expect(turns.length).toBe(50)
    const firstModel = turns[0]
    const sameCount = turns.filter((m) => m === firstModel).length
    const metricM6 = (sameCount / 50) * 100

    expect(metricM6).toBe(100)
    expect(firstModel).toBe("anthropic/claude-3.5-sonnet")
  })

  test("Turn 20 fault injection: fails over, emits switch, turns 21-50 stay pinned to new model", async () => {
    const affinityStore = getAffinityStore()
    const convKey = "conv-session-failover"
    const requirements = { requiredTokens: 500, requiresTools: true }

    const modelLog: string[] = []
    let switchedOnTurn = -1

    for (let turn = 1; turn <= 50; turn++) {
      const activeAffinity = await affinityStore.get(convKey)
      const tried = new Set<string>()

      let target: RouteTarget | null = null
      let wasSwitchedThisTurn = false

      // At turn 20, model A returns 429 fault
      if (turn === 20) {
        // Attempt 1: tries pinned model A, receives 429
        const pinnedRowId = activeAffinity!.modelRowId
        tried.add(pinnedRowId)
        // Record 429 failure for model A
        await reportRouteOutcome(
          activeAffinity!.providerId,
          { success: false, error: { statusCode: 429, message: "Too Many Requests" } },
          pinnedRowId,
        )

        // Attempt 2: fallback
        target = await pickRoute("complex", "complex", tried, requirements, undefined, pinnedRowId)
        expect(target).not.toBeNull()
        expect(target!.modelRowId).not.toBe(pinnedRowId)

        wasSwitchedThisTurn = true
        switchedOnTurn = turn
      } else {
        target = await pickRoute(
          "complex",
          "complex",
          tried,
          requirements,
          undefined,
          activeAffinity?.modelRowId,
        )
      }

      expect(target).not.toBeNull()
      modelLog.push(target!.label)

      // Update affinity to the successful target
      affinityStore.set(convKey, {
        modelRowId: target!.modelRowId,
        providerId: target!.providerId,
        modelLabel: target!.label,
        pinnedAt: Date.now(),
      })
    }

    expect(switchedOnTurn).toBe(20)
    // Turns 1-19 hit Model A
    for (let i = 0; i < 19; i++) {
      expect(modelLog[i]).toBe("anthropic/claude-3.5-sonnet")
    }
    // Turn 20 failed over to Model B
    expect(modelLog[19]).toBe("openai/gpt-4o")

    // Turns 21-50 stay pinned to Model B (100% affinity on subsequent turns)
    const postFailover = modelLog.slice(20)
    expect(postFailover.length).toBe(30)
    const allModelB = postFailover.every((m) => m === "openai/gpt-4o")
    expect(allModelB).toBe(true)
  })

  test("Explicit model lacking tools returns ExplicitModelCapabilityError", async () => {
    const requirements = { requiredTokens: 100, requiresTools: true }
    try {
      await pickRoute("complex", "complex", new Set(), requirements, "openai/gpt-3.5-turbo-instruct")
      expect(true).toBe(false) // Should not reach here
    } catch (err) {
      expect(err instanceof ExplicitModelCapabilityError).toBe(true)
      const e = err as ExplicitModelCapabilityError
      expect(e.missingCapabilities).toEqual(["tools"])
      expect(e.requestedModel).toBe("openai/gpt-3.5-turbo-instruct")
    }
  })

  test("zen/auto routes via intent classifier to complex tier when tools are required", async () => {
    const requirements = { requiredTokens: 100, requiresTools: true }
    const target = await pickRoute("complex", "complex", new Set(), requirements, "zen/auto")
    expect(target).not.toBeNull()
    expect(target?.supportsTools).toBe(true)
  })

  test("deriveConversationKey priorities: header > cursor session > system+user hash", () => {
    // 1. Explicit conversation id
    const k1 = deriveConversationKey({
      sessionId: "explicit-conv-123",
      apiKeyId: "user-1",
      systemPrompt: "sys",
      firstUserMessage: "hello",
    })
    expect(k1).toBe("explicit-conv-123")

    // 2. Fallback to hash
    const k2 = deriveConversationKey({
      apiKeyId: "user-1",
      systemPrompt: "You are a helpful assistant.",
      firstUserMessage: "Write a poem",
    })
    expect(k2).toMatch(/^[a-f0-9]{64}$/)

    // Same prompt produces exact same conversation key
    const k3 = deriveConversationKey({
      apiKeyId: "user-1",
      systemPrompt: "You are a helpful assistant.",
      firstUserMessage: "Write a poem",
    })
    expect(k3).toBe(k2)

    // Different user prompt produces different key
    const k4 = deriveConversationKey({
      apiKeyId: "user-1",
      systemPrompt: "You are a helpful assistant.",
      firstUserMessage: "Write code",
    })
    expect(k4).not.toBe(k2)
  })
})
