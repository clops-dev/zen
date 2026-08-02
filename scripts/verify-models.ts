/**
 * scripts/verify-models.ts
 *
 * Verifies every row in the `models` table against live provider APIs.
 * Usage:
 *   bun run verify-models          — dry-run report only
 *   bun run verify-models --fix    — generates a migration SQL file for MISMATCH rows
 */

import { sql } from "../src/lib/db"
import {
  detectProviderKind,
  modelsListUrl,
  normaliseRawModel,
  classifyRow,
  generateFixSql,
  type LocalModelRow,
  type NormalisedProviderModel,
  type VerificationResult,
} from "../src/lib/model-verifier"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const FIX_MODE = process.argv.includes("--fix")

// ---------------------------------------------------------------------------
// 1. Load all model rows from DB, joined to providers
// ---------------------------------------------------------------------------

const rows = await sql<
  (LocalModelRow & {
    provider_api_key: string
  })[]
>`
  SELECT
    m.id,
    m.model_id,
    m.label,
    m.input_price_per_1m,
    m.output_price_per_1m,
    m.context_window,
    m.supports_tools,
    m.supports_vision,
    m.supports_json_mode,
    p.name  AS provider_name,
    p.base_url AS provider_base_url,
    p.api_key AS provider_api_key
  FROM models m
  JOIN providers p ON p.id = m.provider_id
  ORDER BY p.name, m.model_id
`

if (rows.length === 0) {
  console.log("No model rows found in DB — nothing to verify.")
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. Group by provider and fetch live models-list once per provider
// ---------------------------------------------------------------------------

type ProviderGroup = {
  name: string
  baseUrl: string
  apiKey: string
  rows: (typeof rows)[number][]
}

const byProvider = new Map<string, ProviderGroup>()
for (const row of rows) {
  const key = row.provider_name
  if (!byProvider.has(key)) {
    byProvider.set(key, {
      name: row.provider_name,
      baseUrl: row.provider_base_url,
      apiKey: row.provider_api_key,
      rows: [],
    })
  }
  byProvider.get(key)!.rows.push(row)
}

// Fetch live model maps per provider
const liveMaps = new Map<string, Map<string, NormalisedProviderModel> | null>()

for (const [name, group] of byProvider) {
  const kind = detectProviderKind(group.baseUrl)
  const url = modelsListUrl(group.baseUrl, kind)

  if (!url) {
    liveMaps.set(name, null) // NOT_VERIFIABLE
    continue
  }

  try {
    console.log(`[verify] fetching ${url} for provider "${name}"...`)
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${group.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.error(`[verify] ${url} returned ${res.status} — marking provider as NOT_VERIFIABLE`)
      liveMaps.set(name, null)
      continue
    }
    const data = (await res.json()) as { data: Record<string, any>[] }
    const map = new Map<string, NormalisedProviderModel>()
    for (const item of data.data ?? []) {
      try {
        const normalised = normaliseRawModel(item, kind)
        map.set(normalised.id, normalised)
      } catch {
        // skip unparseable entries
      }
    }
    liveMaps.set(name, map)
    console.log(`[verify] got ${map.size} models from "${name}"`)
  } catch (err) {
    console.error(`[verify] failed to fetch from "${name}":`, err)
    liveMaps.set(name, null)
  }
}

// ---------------------------------------------------------------------------
// 3. Classify every row
// ---------------------------------------------------------------------------

const results: VerificationResult[] = []

for (const row of rows) {
  const liveMap = liveMaps.get(row.provider_name) ?? null
  results.push(classifyRow(row as LocalModelRow, liveMap))
}

// ---------------------------------------------------------------------------
// 4. Print report
// ---------------------------------------------------------------------------

const PAD = 40
const statusColor = (s: string) => {
  if (s === "OK") return `\x1b[32m${s}\x1b[0m`
  if (s === "MISMATCH") return `\x1b[33m${s}\x1b[0m`
  if (s === "NOT_FOUND") return `\x1b[31m${s}\x1b[0m`
  return `\x1b[2m${s}\x1b[0m`
}

console.log("\n" + "=".repeat(80))
console.log(" MODEL VERIFICATION REPORT")
console.log("=".repeat(80))

for (const r of results) {
  const label = `${r.providerName}/${r.modelId}`.padEnd(PAD)
  const statusStr = r.status.padEnd(16)
  process.stdout.write(`${label} ${statusColor(statusStr)}`)

  if (r.status === "MISMATCH") {
    const details = r.mismatches
      .map((m) => `${m.field}: ${m.local} → ${m.live}`)
      .join("  |  ")
    process.stdout.write(details)
  } else if (r.status === "NOT_VERIFIABLE") {
    process.stdout.write(r.reason ?? "")
  }
  process.stdout.write("\n")
}

console.log("=".repeat(80))

const counts = { OK: 0, MISMATCH: 0, NOT_FOUND: 0, NOT_VERIFIABLE: 0 }
for (const r of results) counts[r.status]++
console.log(
  `Summary: ${counts.OK} OK  |  ${counts.MISMATCH} MISMATCH  |  ${counts.NOT_FOUND} NOT FOUND  |  ${counts.NOT_VERIFIABLE} NOT VERIFIABLE`,
)

if (counts.NOT_FOUND > 0) {
  console.log("\n\x1b[31mNOT FOUND rows must be removed manually via the admin UI — they are never auto-deleted.\x1b[0m")
}

// ---------------------------------------------------------------------------
// 5. --fix: generate migration file
// ---------------------------------------------------------------------------

if (FIX_MODE) {
  const mismatchResults = results.filter((r) => r.status === "MISMATCH")
  if (mismatchResults.length === 0) {
    console.log("\n[fix] No MISMATCH rows — nothing to write.")
  } else {
    const sqlBlocks: string[] = [
      `-- Auto-generated by verify-models --fix at ${new Date().toISOString()}`,
      `-- Review carefully before applying!\n`,
    ]

    for (const r of mismatchResults) {
      const liveMap = liveMaps.get(r.providerName) ?? null
      if (!liveMap) continue
      const block = generateFixSql(r, liveMap)
      if (block) sqlBlocks.push(block)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const migrationsDir = join(fileURLToPath(import.meta.url), "..", "..", "migrations")
    const filename = join(migrationsDir, `${timestamp}_verify_models_fix.sql`)

    // find the next migration number
    const { readdirSync } = await import("node:fs")
    const existing = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
    const lastNum = existing.length > 0
      ? parseInt(existing[existing.length - 1].slice(0, 3), 10)
      : 0
    const nextNum = String(lastNum + 1).padStart(3, "0")
    const namedFile = join(migrationsDir, `${nextNum}_verify_models_fix.sql`)

    writeFileSync(namedFile, sqlBlocks.join("\n\n"))
    console.log(`\n[fix] Migration written to: ${namedFile}`)
    console.log("[fix] Review the file, then restart the server to apply it automatically via runMigrations().")
  }
}

await sql.end()
process.exit(0)
