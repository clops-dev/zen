import { describe, expect, test, mock } from "bun:test"
import { fetchOpenRouterModelMetadata } from "./openrouter"

describe("fetchOpenRouterModelMetadata", () => {
  test("throws error when model ID is missing author", async () => {
    expect(fetchOpenRouterModelMetadata("claude-3.5-sonnet")).rejects.toThrow("Invalid OpenRouter model ID format")
  })

  test("correctly parses pricing, capabilities, and metadata for a standard model", async () => {
    const fakeData = {
      data: {
        id: "anthropic/claude-3.5-sonnet",
        name: "Anthropic: Claude 3.5 Sonnet",
        context_length: 200000,
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
        pricing: {
          prompt: "0.000003",
          completion: "0.000015",
          input_cache_read: "0.0000003",
          input_cache_write: "0.00000375",
          request: "0",
        },
        top_provider: {
          is_moderated: true,
          max_completion_tokens: 8192,
        },
        supported_parameters: ["tools", "structured_outputs", "reasoning"],
        canonical_slug: "anthropic/claude-3.5-sonnet",
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      return new Response(JSON.stringify(fakeData), { status: 200 })
    }) as any

    try {
      const meta = await fetchOpenRouterModelMetadata("anthropic/claude-3.5-sonnet")
      expect(meta.label).toBe("Anthropic: Claude 3.5 Sonnet")
      expect(meta.context_window).toBe(200000)
      expect(meta.input_price_per_1m).toBeCloseTo(3.0, 4)
      expect(meta.output_price_per_1m).toBeCloseTo(15.0, 4)
      expect(meta.input_cache_read_price_per_1m).toBeCloseTo(0.3, 4)
      expect(meta.input_cache_write_price_per_1m).toBeCloseTo(3.75, 4)
      expect(meta.request_price_flat).toBe(0)
      expect(meta.supports_tools).toBe(true)
      expect(meta.supports_structured_outputs).toBe(true)
      expect(meta.supports_reasoning).toBe(true)
      expect(meta.supports_vision).toBe(true)
      expect(meta.is_moderated).toBe(true)
      expect(meta.max_completion_tokens).toBe(8192)
      expect(meta.openrouter_model_id).toBe("anthropic/claude-3.5-sonnet")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("handles free model with :free suffix correctly", async () => {
    const fakeData = {
      data: {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "NVIDIA: Nemotron 3 Super 120B (free)",
        context_length: 131072,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: {
          prompt: "0",
          completion: "0",
          input_cache_read: "0",
          request: "0",
        },
        supported_parameters: ["tools"],
        canonical_slug: "nvidia/nemotron-3-super-120b-a12b:free",
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fakeData), { status: 200 })) as any

    try {
      const meta = await fetchOpenRouterModelMetadata("nvidia/nemotron-3-super-120b-a12b:free")
      expect(meta.input_price_per_1m).toBe(0)
      expect(meta.output_price_per_1m).toBe(0)
      expect(meta.input_cache_read_price_per_1m).toBe(0)
      expect(meta.supports_tools).toBe(true)
      expect(meta.supports_vision).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws 404 error when OpenRouter returns 404", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: "Model not found" }), { status: 404 })) as any

    try {
      await expect(fetchOpenRouterModelMetadata("fake/nonexistent-model")).rejects.toThrow("OpenRouter model not found")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
