#!/usr/bin/env bun
/**
 * scripts/bench/run-bench.ts
 *
 * P1.6 / P1.7 — Task-level accuracy benchmark runner.
 *
 * Evaluates coding tasks across:
 *   1. Direct model endpoint (e.g. OpenAI/Anthropic/custom upstream)
 *   2. Gateway (automatic complexity routing)
 *   3. Gateway with tier override (trivial, simple, medium, complex)
 *
 * Usage:
 *   bun run scripts/bench/run-bench.ts [--mode gateway|direct|tier] [--tier simple] [--url http://localhost:8787] [--api-key zen_...]
 */

import { BENCH_TASKS, type BenchTask } from "../../bench/tasks"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

interface BenchArgs {
  mode: "gateway" | "direct" | "tier"
  tier?: string
  url: string
  apiKey: string
  model?: string
  outputDir: string
}

function parseArgs(): BenchArgs {
  const args = process.argv.slice(2)
  let mode: "gateway" | "direct" | "tier" = "gateway"
  let tier: string | undefined = undefined
  let url = process.env.BENCH_GATEWAY_URL ?? "http://localhost:8787"
  let apiKey = process.env.BENCH_API_KEY ?? "zen_test_key"
  let model: string | undefined = undefined
  let outputDir = "docs/benchmarks"

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) mode = args[++i] as any
    if (args[i] === "--tier" && args[i + 1]) tier = args[++i]
    if (args[i] === "--url" && args[i + 1]) url = args[++i]!
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i]!
    if (args[i] === "--model" && args[i + 1]) model = args[++i]
    if (args[i] === "--output-dir" && args[i + 1]) outputDir = args[++i]!
  }

  return { mode, tier, url, apiKey, model, outputDir }
}

interface TaskResult {
  taskId: string
  name: string
  category: string
  difficulty: string
  passed: boolean
  error?: string
  ttftMs: number | null
  totalMs: number
  turns: number
  toolErrors: number
}

async function runTask(task: BenchTask, cfg: BenchArgs): Promise<TaskResult> {
  const t0 = performance.now()
  let ttftMs: number | null = null
  let turns = 1
  let toolErrors = 0
  let passed = false
  let errorMsg: string | undefined

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    }
    if (cfg.tier) {
      headers["x-force-tier"] = cfg.tier
    }

    const body: Record<string, unknown> = {
      messages: [
        ...(task.systemPrompt ? [{ role: "system", content: task.systemPrompt }] : []),
        { role: "user", content: task.prompt },
      ],
      stream: true,
    }
    if (cfg.model) {
      body.model = cfg.model
    }

    const res = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      return {
        taskId: task.id,
        name: task.name,
        category: task.category,
        difficulty: task.difficulty,
        passed: false,
        error: `HTTP ${res.status}: ${errText.slice(0, 100)}`,
        ttftMs: null,
        totalMs: performance.now() - t0,
        turns: 1,
        toolErrors: 1,
      }
    }

    // Read SSE stream
    const reader = res.body?.getReader()
    let responseText = ""
    const decoder = new TextDecoder()

    if (reader) {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (ttftMs === null) {
          ttftMs = Math.round(performance.now() - t0)
        }
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const data = JSON.parse(line.slice(6))
              const delta = data.choices?.[0]?.delta?.content
              if (delta) responseText += delta
            } catch {
              // ignore parse errors on partial chunks
            }
          }
        }
      }
    }

    const val = task.validate(responseText)
    passed = val.passed
    errorMsg = val.error
  } catch (err: any) {
    passed = false
    errorMsg = err.message || String(err)
    toolErrors++
  }

  const totalMs = Math.round(performance.now() - t0)
  return {
    taskId: task.id,
    name: task.name,
    category: task.category,
    difficulty: task.difficulty,
    passed,
    error: errorMsg,
    ttftMs,
    totalMs,
    turns,
    toolErrors,
  }
}

async function main() {
  const cfg = parseArgs()
  console.log(`[bench] Running ${BENCH_TASKS.length} tasks in mode: ${cfg.mode}${cfg.tier ? ` (tier: ${cfg.tier})` : ""}`)
  console.log(`[bench] Target URL: ${cfg.url}`)

  const results: TaskResult[] = []

  for (let i = 0; i < BENCH_TASKS.length; i++) {
    const task = BENCH_TASKS[i]!
    process.stdout.write(`[bench] [${i + 1}/${BENCH_TASKS.length}] ${task.id} ... `)
    const res = await runTask(task, cfg)
    results.push(res)
    console.log(res.passed ? "PASS" : `FAIL (${res.error ?? "validation failed"})`)
  }

  const passCount = results.filter((r) => r.passed).length
  const passRate = (passCount / results.length) * 100
  const avgTtft = results.filter((r) => r.ttftMs !== null).reduce((acc, r) => acc + (r.ttftMs ?? 0), 0) / (results.length || 1)
  const avgTotal = results.reduce((acc, r) => acc + r.totalMs, 0) / (results.length || 1)

  console.log("\n==================== BENCHMARK RESULTS ====================")
  console.log(`Mode:            ${cfg.mode}`)
  console.log(`Passed:          ${passCount}/${results.length} (${passRate.toFixed(1)}%)`)
  console.log(`Avg TTFT:        ${Math.round(avgTtft)} ms`)
  console.log(`Avg Latency:     ${Math.round(avgTotal)} ms`)
  console.log("===========================================================\n")

  // Write output JSON report
  await mkdir(cfg.outputDir, { recursive: true })
  const reportPath = join(cfg.outputDir, `bench-${cfg.mode}${cfg.tier ? `-${cfg.tier}` : ""}.json`)
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        config: cfg,
        summary: {
          totalTasks: results.length,
          passed: passCount,
          passRate: passRate.toFixed(2) + "%",
          avgTtftMs: Math.round(avgTtft),
          avgTotalMs: Math.round(avgTotal),
        },
        results,
      },
      null,
      2,
    ),
  )
  console.log(`[bench] Report written to: ${reportPath}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[bench] Fatal error:", err)
    process.exit(1)
  })
}
