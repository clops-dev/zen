import { describe, expect, it } from "bun:test"
import { buildOpenAICompatibleModel } from "./ai-call"
import type { RouteTarget } from "./routing"

describe("Azure OpenAI Provider Support", () => {
  it("formats base_url for Azure OpenAI endpoints correctly when given a root URL", () => {
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

  it("formats base_url correctly when given a deployment URL", () => {
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
})
