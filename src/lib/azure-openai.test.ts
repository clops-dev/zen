import { describe, expect, it } from "bun:test"
import {
  buildOpenAICompatibleModel,
  classifyAzureEndpoint,
  resolveOpenAICompatibleBaseUrl,
  chatCompletionsBodyToResponses,
} from "./ai-call"
import type { RouteTarget } from "./routing"

function target(partial: Partial<RouteTarget> & Pick<RouteTarget, "baseUrl" | "modelId" | "providerName">): RouteTarget {
  return {
    modelRowId: "test-row",
    providerId: "test-provider",
    inputPricePer1M: 0,
    outputPricePer1M: 0,
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: true,
    supportsJsonMode: true,
    providerType: "openai-compatible",
    apiKey: "secret-key-do-not-assert-value",
    label: `${partial.providerName}/${partial.modelId}`,
    ...partial,
  }
}

describe("classifyAzureEndpoint", () => {
  it("detects Foundry v1 and Azure OpenAI v1", () => {
    expect(classifyAzureEndpoint("https://x.services.ai.azure.com/openai/v1")).toBe("azure-v1")
    expect(classifyAzureEndpoint("https://x.openai.azure.com/openai/v1")).toBe("azure-v1")
  })

  it("detects classic Azure OpenAI roots", () => {
    expect(classifyAzureEndpoint("https://x.openai.azure.com")).toBe("azure-classic")
    expect(classifyAzureEndpoint("https://x.openai.azure.com/openai/deployments/gpt-4o")).toBe("azure-classic")
  })

  it("returns none for non-Azure hosts", () => {
    expect(classifyAzureEndpoint("https://openrouter.ai/api/v1")).toBe("none")
    expect(classifyAzureEndpoint("https://api.openai.com/v1")).toBe("none")
  })
})

describe("resolveOpenAICompatibleBaseUrl", () => {
  it("does NOT append /openai/deployments or api-version for Foundry v1", () => {
    const { baseUrl, azureKind } = resolveOpenAICompatibleBaseUrl(target({
      providerName: "azure-openai",
      baseUrl: "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com/openai/v1",
      modelId: "gpt-5.1-codex-mini",
    }))
    expect(azureKind).toBe("azure-v1")
    expect(baseUrl).toBe("https://mohamedaminkhelifa-1459-resource.services.ai.azure.com/openai/v1")
    expect(baseUrl).not.toContain("/openai/deployments/")
    expect(baseUrl).not.toContain("api-version")
  })

  it("does NOT append /openai/deployments or api-version for openai.azure.com/openai/v1", () => {
    const { baseUrl, azureKind } = resolveOpenAICompatibleBaseUrl(target({
      providerName: "azure-openai-v1",
      baseUrl: "https://myresource.openai.azure.com/openai/v1",
      modelId: "gpt-4o-mini",
    }))
    expect(azureKind).toBe("azure-v1")
    expect(baseUrl).toBe("https://myresource.openai.azure.com/openai/v1")
    expect(baseUrl).not.toContain("/openai/deployments/")
    expect(baseUrl).not.toContain("api-version")
  })

  it("normalizes Foundry root host to /openai/v1 (not classic deployments)", () => {
    const { baseUrl, azureKind } = resolveOpenAICompatibleBaseUrl(target({
      providerName: "foundry-v1",
      baseUrl: "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com",
      modelId: "gpt-5.1-codex-mini",
    }))
    expect(azureKind).toBe("azure-v1")
    expect(baseUrl.replace(/\/$/, "")).toBe(
      "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com/openai/v1",
    )
    expect(baseUrl).not.toContain("/openai/deployments/")
  })

  it("rewrites classic Azure roots to /openai/deployments/{model}?api-version", () => {
    const { baseUrl, azureKind } = resolveOpenAICompatibleBaseUrl(target({
      providerName: "azure-openai",
      baseUrl: "https://zencodeaiamine.openai.azure.com/",
      modelId: "gpt-4o",
    }))
    expect(azureKind).toBe("azure-classic")
    expect(baseUrl).toContain("/openai/deployments/gpt-4o")
    expect(baseUrl).toContain("api-version=2024-10-21")
  })

  it("leaves OpenRouter-style base URLs untouched", () => {
    const { baseUrl, azureKind } = resolveOpenAICompatibleBaseUrl(target({
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "openai/gpt-4o-mini",
    }))
    expect(azureKind).toBe("none")
    expect(baseUrl).toBe("https://openrouter.ai/api/v1")
  })
})

describe("chatCompletionsBodyToResponses", () => {
  it("maps messages→input and max_tokens→max_output_tokens", () => {
    const out = chatCompletionsBodyToResponses({
      model: "gpt-5.1-codex-mini",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    })
    expect(out).toEqual({
      model: "gpt-5.1-codex-mini",
      max_output_tokens: 64,
      input: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    })
    expect(out).not.toHaveProperty("messages")
    expect(out).not.toHaveProperty("max_tokens")
  })
})

describe("Azure OpenAI / Microsoft Foundry Provider Support", () => {
  it("formats base_url for Classic Azure OpenAI endpoints correctly when given a root URL", () => {
    const model = buildOpenAICompatibleModel(target({
      providerName: "azure-openai",
      baseUrl: "https://zencodeaiamine.openai.azure.com/",
      modelId: "gpt-4o",
    }))
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
  })

  it("formats base_url correctly when given a classic deployment URL", () => {
    const model = buildOpenAICompatibleModel(target({
      providerName: "azure-openai",
      baseUrl: "https://zencodeaiamine.openai.azure.com/openai/deployments/my-custom-deployment",
      modelId: "gpt-4o",
    }))
    expect(model).toBeDefined()
  })

  it("supports Azure OpenAI v1 endpoints without appending /openai/deployments", () => {
    const model = buildOpenAICompatibleModel(target({
      providerName: "azure-openai-v1",
      baseUrl: "https://myresource.openai.azure.com/openai/v1",
      modelId: "gpt-4o-mini",
    }))
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o-mini")
  })

  it("supports Microsoft Foundry v1 endpoints (services.ai.azure.com/openai/v1)", () => {
    const model = buildOpenAICompatibleModel(target({
      providerName: "foundry-v1",
      baseUrl: "https://myfoundry.services.ai.azure.com/openai/v1",
      modelId: "gpt-4o",
    }))
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
  })

  it("Azure v1: outbound request uses /responses with input + max_output_tokens, api-key auth, no deployments path", async () => {
    const captures: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const prevFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
      const rawHeaders = init?.headers ?? {}
      const headers: Record<string, string> = {}
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[String(k).toLowerCase()] = String(v)
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v)
      }
      let body: any = init?.body
      if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { /* keep */ }
      }
      captures.push({ url, headers, body })

      return new Response(JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 1,
        model: body?.model,
        output: [{ type: "message", content: [{ type: "output_text", text: "Hello there! How can I help you today?" }] }],
        usage: { input_tokens: 2, output_tokens: 8, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      const model = buildOpenAICompatibleModel(target({
        providerName: "azure-openai",
        baseUrl: "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com/openai/v1",
        modelId: "gpt-5.1-codex-mini",
        apiKey: "azure-test-key",
      }))
      const { generateText } = await import("ai")
      const result = await generateText({
        model,
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 64,
        maxRetries: 0,
      })
      expect(result.text).toContain("Hello there")

      expect(captures.length).toBe(1)
      const req = captures[0]
      expect(req.url).toBe(
        "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com/openai/v1/responses",
      )
      expect(req.url).not.toContain("/openai/deployments/")
      expect(req.url).not.toContain("api-version")
      expect(req.url).not.toContain("/chat/completions")

      expect(req.headers["api-key"]).toBe("azure-test-key")
      expect(req.headers["authorization"]).toBeUndefined()

      expect(req.body.model).toBe("gpt-5.1-codex-mini")
      expect(req.body.input).toEqual([{ role: "user", content: "hi" }])
      expect(req.body.max_output_tokens).toBe(64)
      expect(req.body).not.toHaveProperty("messages")
      expect(req.body).not.toHaveProperty("max_tokens")
    } finally {
      globalThis.fetch = prevFetch
    }
  })

  it("Azure openai.azure.com/openai/v1 also rewrites to /responses without api-version", async () => {
    const captures: string[] = []
    const prevFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
      captures.push(url)
      let body: any = init?.body
      if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { /* keep */ }
      }
      return new Response(JSON.stringify({
        id: "resp_2",
        object: "response",
        created_at: 1,
        model: body?.model ?? "gpt-4o-mini",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      const model = buildOpenAICompatibleModel(target({
        providerName: "azure-openai-v1",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
        modelId: "gpt-4o-mini",
      }))
      const { generateText } = await import("ai")
      await generateText({
        model,
        messages: [{ role: "user", content: "hi" }],
        maxRetries: 0,
      })
      expect(captures).toEqual(["https://myresource.openai.azure.com/openai/v1/responses"])
    } finally {
      globalThis.fetch = prevFetch
    }
  })
})
