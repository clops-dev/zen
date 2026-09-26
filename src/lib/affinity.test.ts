import { describe, test, expect, beforeEach } from "bun:test"
import {
  deriveConversationKey,
  InMemoryAffinityStore,
  type AffinityEntry,
} from "./affinity"

describe("P3.1: Conversation Affinity & Sticky Routing", () => {
  let store: InMemoryAffinityStore

  beforeEach(() => {
    store = new InMemoryAffinityStore(100, 3600_000)
  })

  test("derives key from x-session-id header when present", () => {
    const key = deriveConversationKey({
      sessionId: "session-abc-123",
      apiKeyId: "key-1",
      systemPrompt: "You are a helpful assistant",
      firstUserMessage: "hello",
    })
    expect(key).toBe("session-abc-123")
  })

  test("derives deterministic hash key when x-session-id is absent", () => {
    const key1 = deriveConversationKey({
      apiKeyId: "key-1",
      systemPrompt: "You are a helpful assistant",
      firstUserMessage: "hello",
    })
    const key2 = deriveConversationKey({
      apiKeyId: "key-1",
      systemPrompt: "You are a helpful assistant",
      firstUserMessage: "hello",
    })
    const key3 = deriveConversationKey({
      apiKeyId: "key-1",
      systemPrompt: "You are a helpful assistant",
      firstUserMessage: "different message",
    })

    expect(key1).toBe(key2)
    expect(key1).not.toBe(key3)
    expect(key1).toMatch(/^[a-f0-9]{64}$/)
  })

  test("stores and retrieves pinned affinity entry with sliding TTL", () => {
    store.set("conv-1", {
      modelRowId: "row-1",
      providerId: "prov-1",
      modelLabel: "anthropic/claude-3-5-sonnet",
      pinnedAt: Date.now(),
    })

    const entry = store.get("conv-1")
    expect(entry).not.toBeNull()
    expect(entry?.modelRowId).toBe("row-1")
    expect(entry?.modelLabel).toBe("anthropic/claude-3-5-sonnet")
  })

  test("evicts least recently used entries when capacity is exceeded", () => {
    const smallStore = new InMemoryAffinityStore(2, 3600_000)
    smallStore.set("conv-1", { modelRowId: "row-1", providerId: "prov-1", modelLabel: "model-1", pinnedAt: Date.now() })
    smallStore.set("conv-2", { modelRowId: "row-2", providerId: "prov-1", modelLabel: "model-2", pinnedAt: Date.now() })
    
    // conv-1 accessed, making conv-2 the LRU
    smallStore.get("conv-1")

    // Adding conv-3 should evict conv-2
    smallStore.set("conv-3", { modelRowId: "row-3", providerId: "prov-1", modelLabel: "model-3", pinnedAt: Date.now() })

    expect(smallStore.get("conv-1")).not.toBeNull()
    expect(smallStore.get("conv-2")).toBeNull()
    expect(smallStore.get("conv-3")).not.toBeNull()
  })

  test("expires entries after TTL", async () => {
    const shortTtlStore = new InMemoryAffinityStore(10, 50) // 50ms TTL
    shortTtlStore.set("conv-exp", { modelRowId: "row-1", providerId: "prov-1", modelLabel: "model-1", pinnedAt: Date.now() })

    expect(shortTtlStore.get("conv-exp")).not.toBeNull()
    await new Promise((r) => setTimeout(r, 60))
    expect(shortTtlStore.get("conv-exp")).toBeNull()
  })
})
