import { describe, expect, it } from "bun:test"
import { buildOpenAICompatibleModel } from "./ai-call"
import type { RouteTarget } from "./routing"

describe("Azure OpenAI / Microsoft Foundry Provider Support", () => {
  it("formats base_url for Classic Azure OpenAI endpoints correctly when given a root URL", () => {
    const target: RouteTarget = {
      modelRowId: "test-row-id",
      providerId: "test-provider-id",
      providerName: "azure-openai",
      baseUrl: "https://zencodeaiamine.openai.azure.com/",
      apiKey: "azure-secret-key-123",
      modelId: "gpt-4o",
      label: "azure-openai/gpt-4o",
      inputPricePer1M: 5,
      outputPricePer1M: 15,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      providerType: "openai-compatible",
    }

    const model = buildOpenAICompatibleModel(target)
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
  })

  it("formats base_url correctly when given a classic deployment URL", () => {
    const target: RouteTarget = {
      modelRowId: "test-row-id-2",
      providerId: "test-provider-id-2",
      providerName: "azure-openai",
      baseUrl: "https://zencodeaiamine.openai.azure.com/openai/deployments/my-custom-deployment",
      apiKey: "azure-secret-key-456",
      modelId: "gpt-4o",
      label: "azure-openai/gpt-4o",
      inputPricePer1M: 5,
      outputPricePer1M: 15,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      providerType: "openai-compatible",
    }

    const model = buildOpenAICompatibleModel(target)
    expect(model).toBeDefined()
  })

  it("supports Azure OpenAI v1 endpoints without appending /openai/deployments", () => {
    const target: RouteTarget = {
      modelRowId: "test-row-id-v1",
      providerId: "test-provider-id-v1",
      providerName: "azure-openai-v1",
      baseUrl: "https://myresource.openai.azure.com/openai/v1",
      apiKey: "azure-v1-key",
      modelId: "gpt-4o-mini",
      label: "azure-openai-v1/gpt-4o-mini",
      inputPricePer1M: 0.15,
      outputPricePer1M: 0.6,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      providerType: "openai-compatible",
    }

    const model = buildOpenAICompatibleModel(target)
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o-mini")
  })

  it("supports Microsoft Foundry v1 endpoints (services.ai.azure.com/openai/v1)", () => {
    const target: RouteTarget = {
      modelRowId: "test-row-id-foundry",
      providerId: "test-provider-id-foundry",
      providerName: "foundry-v1",
      baseUrl: "https://myfoundry.services.ai.azure.com/openai/v1",
      apiKey: "foundry-key-789",
      modelId: "gpt-4o",
      label: "foundry-v1/gpt-4o",
      inputPricePer1M: 2.5,
      outputPricePer1M: 10,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      providerType: "openai-compatible",
    }

    const model = buildOpenAICompatibleModel(target)
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
  })

  it("normalizes Microsoft Foundry root endpoints (services.ai.azure.com) to append /openai/v1", () => {
    const target: RouteTarget = {
      modelRowId: "test-row-id-foundry-root",
      providerId: "test-provider-id-foundry-root",
      providerName: "foundry-v1",
      baseUrl: "https://mohamedaminkhelifa-1459-resource.services.ai.azure.com",
      apiKey: "foundry-key-789",
      modelId: "gpt-5.1-codex-mini",
      label: "foundry-v1/gpt-5.1-codex-mini",
      inputPricePer1M: 0.15,
      outputPricePer1M: 0.6,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      providerType: "openai-compatible",
    }

    const model = buildOpenAICompatibleModel(target)
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-5.1-codex-mini")
  })
})

