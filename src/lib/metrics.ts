/**
 * src/lib/metrics.ts
 *
 * P1.8–P1.11 — In-process Prometheus-text-format metrics.
 *
 * Tiny implementation — no external dependency. Works under Bun.
 * Guards the /metrics endpoint with METRICS_BEARER_TOKEN env var.
 *
 * Metrics exposed:
 *   Counters:
 *     zen_requests_total{status, tier, stream}
 *     zen_failovers_total{kind}
 *     zen_cancellations_total
 *     zen_tokens_total{direction}        — input / output / cached
 *     zen_cost_usd_total
 *   Histograms (buckets: 50, 100, 200, 500, 1000, 2000, 5000, 10000 ms):
 *     zen_ttft_ms
 *     zen_gateway_overhead_ms
 *     zen_stage_duration_ms{stage}       — auth, quota, cache, routing, upstream_connect
 *     zen_request_total_ms
 *
 * Thread safety: JS is single-threaded, so plain object mutations are safe.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Counter {
  type: "counter"
  name: string
  help: string
  values: Map<string, number>
}

interface Histogram {
  type: "histogram"
  name: string
  help: string
  buckets: number[]
  counts: Map<string, number[]>
  sums: Map<string, number>
  totals: Map<string, number>
}

type Metric = Counter | Histogram

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000] // ms

function makeCounter(name: string, help: string): Counter {
  return { type: "counter", name, help, values: new Map() }
}

function makeHistogram(name: string, help: string): Histogram {
  return { type: "histogram", name, help, buckets: BUCKETS, counts: new Map(), sums: new Map(), totals: new Map() }
}

const registry: Metric[] = []

function register<T extends Metric>(m: T): T {
  registry.push(m)
  return m
}

// ---------------------------------------------------------------------------
// Metric instances
// ---------------------------------------------------------------------------

export const counters = {
  requests: register(makeCounter("zen_requests_total", "Total gateway requests by status/tier/stream")),
  failovers: register(makeCounter("zen_failovers_total", "Upstream failovers by error kind")),
  cancellations: register(makeCounter("zen_cancellations_total", "Client-cancelled requests")),
  tokens: register(makeCounter("zen_tokens_total", "Tokens by direction (input/output/cached)")),
  cost: register(makeCounter("zen_cost_usd_total", "Total cost in USD")),
}

export const histograms = {
  ttft: register(makeHistogram("zen_ttft_ms", "Time to first token (ms)")),
  overhead: register(makeHistogram("zen_gateway_overhead_ms", "Gateway overhead before upstream (ms)")),
  stageDuration: register(makeHistogram("zen_stage_duration_ms", "Per-stage latency (ms) by stage label")),
  requestTotal: register(makeHistogram("zen_request_total_ms", "Total request duration (ms)")),
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

export function incCounter(m: Counter, labels: Record<string, string>, by = 1): void {
  const key = labelsKey(labels)
  m.values.set(key, (m.values.get(key) ?? 0) + by)
  // Store labels alongside the key so we can reconstruct them
  ;(m as any)._labelsCache ??= new Map<string, Record<string, string>>()
  ;(m as any)._labelsCache.set(key, labels)
}

export function observeHistogram(h: Histogram, labels: Record<string, string>, valueMs: number): void {
  const key = labelsKey(labels)
  if (!h.counts.has(key)) {
    h.counts.set(key, new Array(h.buckets.length + 1).fill(0))
    h.sums.set(key, 0)
    h.totals.set(key, 0)
    ;(h as any)._labelsCache ??= new Map<string, Record<string, string>>()
  }
  ;(h as any)._labelsCache.set(key, labels)
  const counts = h.counts.get(key)!
  for (let i = 0; i < h.buckets.length; i++) {
    if (valueMs <= h.buckets[i]!) counts[i]++
  }
  counts[h.buckets.length]++ // +Inf bucket
  h.sums.set(key, (h.sums.get(key) ?? 0) + valueMs)
  h.totals.set(key, (h.totals.get(key) ?? 0) + 1)
}

function labelsKey(labels: Record<string, string>): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(",")
}

// ---------------------------------------------------------------------------
// Convenience: record a complete request
// ---------------------------------------------------------------------------

export interface RequestMetrics {
  status: "success" | "failure" | "rejected"
  tier: string
  stream: boolean
  cancelled: boolean
  ttftMs: number | null
  overheadMs: number
  totalMs: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  failoverChain: Array<{ kind: string }>
}

export function recordRequestMetrics(m: RequestMetrics): void {
  // Counter: requests by status/tier/stream
  incCounter(counters.requests, {
    status: m.status,
    tier: m.tier,
    stream: String(m.stream),
  })

  // Failovers
  for (const fo of m.failoverChain) {
    incCounter(counters.failovers, { kind: fo.kind })
  }

  // Cancellations
  if (m.cancelled) {
    incCounter(counters.cancellations, {})
  }

  // Tokens
  incCounter(counters.tokens, { direction: "input" }, m.inputTokens)
  incCounter(counters.tokens, { direction: "output" }, m.outputTokens)
  incCounter(counters.tokens, { direction: "cached" }, m.cachedTokens)

  // Cost
  incCounter(counters.cost, {}, m.costUsd)

  // Histograms
  if (m.ttftMs !== null) {
    observeHistogram(histograms.ttft, {}, m.ttftMs)
  }
  observeHistogram(histograms.overhead, {}, m.overheadMs)
  observeHistogram(histograms.requestTotal, {}, m.totalMs)
}

export function recordStageMs(stage: string, ms: number): void {
  observeHistogram(histograms.stageDuration, { stage }, ms)
}

// ---------------------------------------------------------------------------
// Prometheus text format serialization
// ---------------------------------------------------------------------------

function labelsStr(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ""
  return "{" + entries.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",") + "}"
}

function serializeCounter(m: Counter): string {
  const lines: string[] = [
    `# HELP ${m.name} ${m.help}`,
    `# TYPE ${m.name} counter`,
  ]
  const labelsCache: Map<string, Record<string, string>> = (m as any)._labelsCache ?? new Map()
  for (const [key, value] of m.values) {
    const labels = labelsCache.get(key) ?? {}
    lines.push(`${m.name}${labelsStr(labels)} ${value}`)
  }
  if (m.values.size === 0) {
    // Emit a zero so dashboards know the metric exists
    lines.push(`${m.name} 0`)
  }
  return lines.join("\n")
}

function serializeHistogram(h: Histogram): string {
  const lines: string[] = [
    `# HELP ${h.name} ${h.help}`,
    `# TYPE ${h.name} histogram`,
  ]
  const labelsCache: Map<string, Record<string, string>> = (h as any)._labelsCache ?? new Map()
  for (const [key, counts] of h.counts) {
    const labels = labelsCache.get(key) ?? {}
    for (let i = 0; i < h.buckets.length; i++) {
      const bucketLabels = { ...labels, le: String(h.buckets[i]) }
      lines.push(`${h.name}_bucket${labelsStr(bucketLabels)} ${counts[i]}`)
    }
    const infLabels = { ...labels, le: "+Inf" }
    lines.push(`${h.name}_bucket${labelsStr(infLabels)} ${counts[h.buckets.length]}`)
    lines.push(`${h.name}_sum${labelsStr(labels)} ${h.sums.get(key) ?? 0}`)
    lines.push(`${h.name}_count${labelsStr(labels)} ${h.totals.get(key) ?? 0}`)
  }
  if (h.counts.size === 0) {
    // Emit empty zero-count histogram
    for (const b of h.buckets) {
      lines.push(`${h.name}_bucket{le="${b}"} 0`)
    }
    lines.push(`${h.name}_bucket{le="+Inf"} 0`)
    lines.push(`${h.name}_sum 0`)
    lines.push(`${h.name}_count 0`)
  }
  return lines.join("\n")
}

/** Generate Prometheus text format output for all metrics */
export function renderMetrics(): string {
  return registry.map(m => {
    if (m.type === "counter") return serializeCounter(m)
    if (m.type === "histogram") return serializeHistogram(m)
    return ""
  }).filter(Boolean).join("\n\n") + "\n"
}

// ---------------------------------------------------------------------------
// Stage timer helper
// ---------------------------------------------------------------------------

/**
 * Returns a function that, when called, records the elapsed time
 * since startStageTimer() was called for a given stage.
 */
export function startStageTimer(stage: string): () => number {
  const start = Date.now()
  return () => {
    const ms = Date.now() - start
    recordStageMs(stage, ms)
    return ms
  }
}

// ---------------------------------------------------------------------------
// Server-Timing header builder
// ---------------------------------------------------------------------------

export interface StageResult {
  stage: string
  ms: number
}

export function buildServerTimingHeader(stages: StageResult[]): string {
  return stages.map(({ stage, ms }) => `${stage};dur=${ms}`).join(", ")
}
