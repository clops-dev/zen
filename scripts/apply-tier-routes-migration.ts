/**
 * scripts/apply-tier-routes-migration.ts
 *
 * Applies migrations/005_tier_routes_enabled.sql to the live DB. Equivalent
 * to the gateway's auto-migration on startup, but callable manually so you
 * can apply it before restarting the server (or to confirm it's already
 * applied). Idempotent — uses CREATE ... IF NOT EXISTS, ALTER TABLE will
 * fail loudly if the column already exists, which is the desired behavior.
 */
import { sql } from "../src/lib/db"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const migration = readFileSync(path.join(here, "..", "migrations", "005_tier_routes_enabled.sql"), "utf8")

try {
  await sql.unsafe(migration)
  await sql`INSERT INTO schema_migrations (filename) VALUES ('005_tier_routes_enabled.sql') ON CONFLICT DO NOTHING`
  console.log("[migrate] applied 005_tier_routes_enabled.sql")
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("already exists")) {
    console.log("[migrate] 005_tier_routes_enabled.sql already applied (column exists)")
  } else {
    console.error("[migrate] FAILED:", msg)
    process.exit(1)
  }
}

// Verify the column is present
const cols = await sql<{ column_name: string }[]>`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'tier_routes' AND column_name = 'enabled'
`
if (cols.length === 0) {
  console.error("[migrate] verification failed: no 'enabled' column on tier_routes")
  process.exit(1)
}
console.log("[migrate] verified: tier_routes.enabled column exists")

// Quick stats
const stats = await sql<{ enabled: boolean; count: string }[]>`
  SELECT enabled, COUNT(*)::text AS count FROM tier_routes GROUP BY enabled ORDER BY enabled DESC
`
for (const s of stats) console.log(`[migrate] tier_routes: ${s.enabled ? "enabled" : "DISABLED"} = ${s.count}`)
