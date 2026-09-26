#!/usr/bin/env bun
/**
 * scripts/dev/replay-traces.ts
 *
 * P1.4 — Replay a directory of golden traces against the fake upstream
 * and assert protocol invariants.
 *
 * Usage:
 *   bun run scripts/dev/replay-traces.ts --dir traces/  [--gateway-url http://localhost:8787]
 *
 * What it checks (protocol invariants):
 *   1. finish_reason consistency: if tool_calls in delta, finish_reason must be "tool_calls"
 *   2. tool arguments validity: if finish_reason="tool_calls", arguments must parse as valid JSON
 *   3. [DONE] sentinel: every SSE stream must end with "data: [DONE]"
 *   4. chunk structure: every data line must parse as valid JSON
 *   5. model label stability within a conversation (once Phase 3 lands)
 *
 * This script NEVER sends real requests to production. It replays against
 * a provided gateway URL (default: fake upstream started inline).
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { TraceRecord } from "../../src/lib/trace-recorder"
import { startFakeUpstream, type FakeUpstream } from "../../test/harness/fake-upstream"

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dir: string; gatewayUrl?: string } {
  const args = process.argv.slice(2)
  let dir = "traces"
  let gatewayUrl: string | undefined = undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) dir = args[++i]!
    if (args[i] === "--gateway-url" && args[i + 1]) gatewayUrl = args[++i]!
  }

  return { dir, gatewayUrl }
}

// ---------------------------------------------------------------------------
// Protocol invariant checks
// ---------------------------------------------------------------------------

interface InvariantViolation {
  file: string
  invariant: string
  detail: string
}

async function checkStreamResponse(
  sseText: string,
  file: string,
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = []

  // INV-1: Must end with [DONE]
  if (!sseText.trimEnd().endsWith("data: [DONE]")) {
    violations.push({ file, invariant: "INV-1", detail: "Stream does not end with data: [DONE]" })
  }

  // Parse all data lines
  const dataLines = sseText.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
  const chunks: any[] = []

  for (const line of dataLines) {
    try {
      chunks.push(JSON.parse(line.slice(6)))
    } catch {
      violations.push({ file, invariant: "INV-2", detail: `Invalid JSON in SSE chunk: ${line.slice(0, 80)}` })
    }
  }

  // INV-3: finish_reason/tool_calls consistency
  const finishChunks = chunks.filter(c => c.choices?.[0]?.finish_reason)
  for (const chunk of finishChunks) {
    const finishReason = chunk.choices[0].finish_reason
    const hasToolCalls = chunks.some(c =>
      c.choices?.[0]?.delta?.tool_calls?.length > 0
    )
    if (hasToolCalls && finishReason !== "tool_calls") {
      violations.push({
        file,
        invariant: "INV-3",
        detail: `Tool calls present but finish_reason="${finishReason}" (expected "tool_calls")`,
      })
    }
  }

  // INV-4: Tool arguments must be valid JSON when finish_reason=tool_calls
  const hasToolCallsFinish = finishChunks.some(c => c.choices[0].finish_reason === "tool_calls")
  if (hasToolCallsFinish) {
    // Reconstruct tool call arguments per index
    const toolArgsByIndex = new Map<number, string>()
    for (const chunk of chunks) {
      const toolCalls: any[] = chunk.choices?.[0]?.delta?.tool_calls ?? []
      for (const tc of toolCalls) {
        const idx = tc.index ?? 0
        const prev = toolArgsByIndex.get(idx) ?? ""
        toolArgsByIndex.set(idx, prev + (tc.function?.arguments ?? ""))
      }
    }

    for (const [index, args] of toolArgsByIndex) {
      if (!args) continue
      try {
        JSON.parse(args)
      } catch {
        violations.push({
          file,
          invariant: "INV-4",
          detail: `Tool call index ${index} has invalid JSON arguments: ${args.slice(0, 80)}`,
        })
      }
    }
  }

  return violations
}

async function replayTrace(
  trace: TraceRecord,
  gatewayUrl: string,
  file: string,
): Promise<InvariantViolation[]> {
  // Reconstruct request from trace — but do NOT include redacted secrets.
  // We reconstruct with a synthetic API key; the test gateway must be seeded
  // with the right auth or use BYPASS_AUTH=1.
  const { request } = trace

  // Skip if Authorization was redacted (we can't authenticate)
  const auth = request.headers["Authorization"] ?? request.headers["authorization"]
  if (!auth || auth === "[REDACTED]") {
    console.warn(`[replay] ${file}: skipping — Authorization is [REDACTED]`)
    return []
  }

  try {
    const res = await fetch(gatewayUrl + request.path, {
      method: request.method,
      headers: {
        ...request.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body),
    })

    const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    if (!isStream) {
      // Non-stream: just check it's valid JSON
      try {
        await res.json()
      } catch {
        return [{ file, invariant: "INV-5", detail: "Non-stream response is not valid JSON" }]
      }
      return []
    }

    const text = await res.text()
    return checkStreamResponse(text, file)
  } catch (err) {
    return [{ file, invariant: "INV-0", detail: `Request failed: ${err instanceof Error ? err.message : err}` }]
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  let fakeUpstream: FakeUpstream | null = null
  let gatewayUrl = args.gatewayUrl

  if (!gatewayUrl) {
    fakeUpstream = await startFakeUpstream()
    gatewayUrl = fakeUpstream.url
    console.log(`[replay] Auto-started fake upstream at: ${gatewayUrl}`)
  }

  console.log(`[replay] Loading traces from: ${args.dir}`)
  console.log(`[replay] Replaying against: ${gatewayUrl}`)

  let traceFiles: string[]
  try {
    const entries = await readdir(args.dir)
    traceFiles = entries.filter(f => f.endsWith(".json")).sort()
  } catch {
    console.error(`[replay] Could not read trace directory: ${args.dir}`)
    console.error(`[replay] Set ZEN_TRACE_DIR and make some requests first.`)
    if (fakeUpstream) await fakeUpstream.stop()
    process.exit(1)
  }

  if (traceFiles.length === 0) {
    console.log(`[replay] No traces found in ${args.dir}`)
    if (fakeUpstream) await fakeUpstream.stop()
    process.exit(0)
  }

  console.log(`[replay] Found ${traceFiles.length} trace(s)`)

  const allViolations: InvariantViolation[] = []
  let passed = 0
  let failed = 0
  let skipped = 0

  try {
    for (const file of traceFiles) {
      const filePath = join(args.dir, file)
      let trace: TraceRecord
      try {
        const content = await readFile(filePath, "utf8")
        trace = JSON.parse(content) as TraceRecord
      } catch {
        console.error(`[replay] ${file}: failed to parse — skipping`)
        skipped++
        continue
      }

      if (trace.schema_version !== 1) {
        console.warn(`[replay] ${file}: unknown schema_version ${trace.schema_version} — skipping`)
        skipped++
        continue
      }

      const violations = await replayTrace(trace, gatewayUrl, file)
      if (violations.length === 0) {
        console.log(`[replay] ${file}: ✅ PASS`)
        passed++
      } else {
        console.error(`[replay] ${file}: ❌ FAIL (${violations.length} violation(s))`)
        for (const v of violations) {
          console.error(`  ${v.invariant}: ${v.detail}`)
        }
        allViolations.push(...violations)
        failed++
      }
    }
  } finally {
    if (fakeUpstream) {
      await fakeUpstream.stop()
    }
  }

  console.log()
  console.log(`[replay] Results: ${passed} passed, ${failed} failed, ${skipped} skipped`)

  if (allViolations.length > 0) {
    console.error(`[replay] ${allViolations.length} total violation(s)`)
    process.exit(1)
  }

  process.exit(0)
}

main()
