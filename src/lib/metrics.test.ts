/**
 * src/lib/metrics.test.ts
 *
 * Unit tests for Prometheus in-process metrics (P1.8/P1.9).
 */

import { describe, test, expect } from "bun:test"
import {
  counters,
  histograms,
  incCounter,
  observeHistogram,
  recordRequestMetrics,
  recordStageMs,
  renderMetrics,
} from "./metrics"

describe("Prometheus in-process metrics", () => {
  test("incCounter increments by default value of 1", () => {
    const before = counters.requests.values.get('status="success",stream="false",tier="simple"') ?? 0
    incCounter(counters.requests, { status: "success", tier: "simple", stream: "false" })
    const after = counters.requests.values.get('status="success",stream="false",tier="simple"') ?? 0
    expect(after).toBe(before + 1)
  })

  test("incCounter increments by specified amount", () => {
    const before = counters.tokens.values.get('direction="input"') ?? 0
    incCounter(counters.tokens, { direction: "input" }, 42)
    const after = counters.tokens.values.get('direction="input"') ?? 0
    expect(after).toBe(before + 42)
  })

  test("observeHistogram updates buckets, sum, and count", () => {
    observeHistogram(histograms.ttft, {}, 150)
    // 150ms should fall into bucket 200 (index 2), 500, 1000, 2000, 5000, 10000, and +Inf
    const counts = histograms.ttft.counts.get("")
    expect(counts).toBeDefined()
    expect(histograms.ttft.sums.get("")).toBeGreaterThanOrEqual(150)
    expect(histograms.ttft.totals.get("")).toBeGreaterThanOrEqual(1)
  })

  test("recordRequestMetrics updates all request-level metrics", () => {
    recordRequestMetrics({
      status: "success",
      tier: "complex",
      stream: true,
      cancelled: false,
      ttftMs: 250,
      overheadMs: 45,
      totalMs: 1200,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 50,
      costUsd: 0.002,
      failoverChain: [{ kind: "rate_limit" }],
    })

    expect(counters.failovers.values.get('kind="rate_limit"')).toBeGreaterThanOrEqual(1)
    expect(counters.cost.values.get("")).toBeGreaterThan(0)
  })

  test("recordStageMs records stage histogram", () => {
    recordStageMs("routing", 12)
    recordStageMs("quota", 5)
    expect(histograms.stageDuration.totals.get('stage="routing"')).toBeGreaterThanOrEqual(1)
    expect(histograms.stageDuration.totals.get('stage="quota"')).toBeGreaterThanOrEqual(1)
  })

  test("renderMetrics outputs valid Prometheus text format", () => {
    const output = renderMetrics()
    expect(output).toContain("# TYPE zen_requests_total counter")
    expect(output).toContain("# TYPE zen_ttft_ms histogram")
    expect(output).toContain("# TYPE zen_gateway_overhead_ms histogram")
    expect(output).toContain("zen_requests_total")
    expect(output.endsWith("\n")).toBe(true)
  })
})
