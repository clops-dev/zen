/**
 * scripts/seed-unorouter.ts
 *
 * One-shot: registers the unorouter provider account and inserts a row in
 * `models` for every :free model exposed by https://api.unorouter.com/v1/models.
 *
 * Usage:
 *   bun run scripts/seed-unorouter.ts
 *
 * Re-running is safe: the provider row uses ON CONFLICT (name) DO NOTHING,
 * and each model row uses ON CONFLICT (provider_id, model_id) DO NOTHING.
 *
 * After running:
 *   1. Open /admin/providers in the dashboard and set the API key for the
 *      `unorouter` row (the seed inserts a placeholder; the real key never
 *      lives in source).
 *   2. For each model you actually want to use, open /admin/models and
 *      set `context_window` + the capability checkboxes. The free catalog
 *      doesn't expose context windows via /v1/models — you have to look
 *      each one up on https://unorouter.com/en/models.
 *   3. Map models to complexity tiers in /admin/routing. Without a route,
 *      the gateway still works (it falls back to any enabled model) but
 *      you lose tier-aware control.
 *
 * Why this exists: the dashboard's "Add model" form is one row at a time.
 * Adding 134 models by hand would take most of an afternoon. This script
 * does it in a few seconds; you still curate the per-model metadata in
 * the UI afterwards.
 */
import { sql } from "../src/lib/db"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE_URL = "https://api.unorouter.com/v1"
const PROVIDER_NAME = "unorouter"
const API_KEY_ENV = "UNOROUTER_API_KEY"

const here = fileURLToPath(import.meta.url)
const cachePath = join(here, "..", ".unorouter-models-cache.json")

interface ProviderModel { id: string }

// ---------------------------------------------------------------------------
// 1. Fetch the catalog (cached on disk for 24h so re-runs don't re-hit the API)
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000

async function fetchCatalog(): Promise<ProviderModel[]> {
  const apiKey = process.env[API_KEY_ENV]
  if (!apiKey) {
    throw new Error(
      `set ${API_KEY_ENV} before running. The script uses it once to call ` +
      `https://api.unorouter.com/v1/models and never writes it anywhere.`,
    )
  }

  // Try cache first
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: number; models: ProviderModel[] }
    if (Date.now() - cached.fetchedAt < ONE_DAY_MS) {
      console.log(`[seed] using cached catalog (${cached.models.length} models, ${Math.round((Date.now() - cached.fetchedAt) / 60_000)}m old)`)
      return cached.models
    }
  } catch {
    // no cache or unreadable — fetch fresh
  }

  console.log("[seed] fetching https://api.unorouter.com/v1/models ...")
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) {
    throw new Error(`unorouter /models returned ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { data: ProviderModel[] }
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), models: body.data }, null, 2))
  console.log(`[seed] cached ${body.data.length} models to ${cachePath}`)
  return body.data
}

// ---------------------------------------------------------------------------
// 2. Insert / upsert the provider row
// ---------------------------------------------------------------------------

async function ensureProvider(): Promise<string> {
  // Use a placeholder key. The user replaces it via the admin form afterwards —
  // the real key is never in source / git / env files.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO providers (name, base_url, api_key)
    VALUES (${PROVIDER_NAME}, ${BASE_URL}, '__SET_ME_IN_ADMIN_DASHBOARD__')
    ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url
    RETURNING id
  `
  const id = rows[0]?.id
  if (!id) throw new Error("failed to insert/find provider row")
  console.log(`[seed] provider row: ${PROVIDER_NAME} (id=${id})`)
  return id
}

// ---------------------------------------------------------------------------
// 3. Insert one row per :free model. Paid models are skipped — the user can
//    add those by hand if they want any.
// ---------------------------------------------------------------------------

async function seedModels(providerId: string, all: ProviderModel[]): Promise<{ inserted: number; skipped: number; paid: number }> {
  const free = all.filter((m) => m.id.endsWith(":free"))
  let inserted = 0
  let skipped = 0

  for (const m of free) {
    const res = await sql`
      INSERT INTO models (
        provider_id, model_id, label, input_price_per_1m, output_price_per_1m,
        context_window, enabled
      )
      VALUES (
        ${providerId}, ${m.id}, ${m.id}, 0, 0, NULL, true
      )
      ON CONFLICT (provider_id, model_id) DO NOTHING
      RETURNING id
    `
    if (res.length > 0) inserted++
    else skipped++
  }

  const paid = all.length - free.length
  return { inserted, skipped, paid }
}

// ---------------------------------------------------------------------------
// 4. Print a summary + a follow-up checklist
// ---------------------------------------------------------------------------

async function main() {
  const catalog = await fetchCatalog()
  const providerId = await ensureProvider()
  const { inserted, skipped, paid } = await seedModels(providerId, catalog)

  console.log("")
  console.log("=".repeat(72))
  console.log(`  Inserted: ${inserted} new model rows`)
  console.log(`  Skipped:  ${skipped} (already in DB)`)
  console.log(`  Paid:     ${paid} (excluded — add by hand if you want any)`)
  console.log("=".repeat(72))
  console.log("")
  console.log("Next steps:")
  console.log(`  1. Open the admin dashboard → Providers → ${PROVIDER_NAME} → edit`)
  console.log("     and replace the placeholder API key with your real unorouter key.")
  console.log("  2. Open Models. Each row needs:")
  console.log("       - context_window  (look it up on https://unorouter.com/en/models)")
  console.log("       - supports_tools / supports_vision / supports_json_mode checkboxes")
  console.log("  3. Open Routing to map specific models to complexity tiers.")
  console.log("     Without routes, the gateway still works — falls back to any enabled model.")
  console.log("")
}

await main()
