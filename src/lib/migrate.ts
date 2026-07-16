import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "./db"

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, "..", "..", "migrations")

export async function runMigrations(): Promise<{ applied: string[] }> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    )
  `

  let files: string[]
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()
  } catch (cause) {
    throw new Error(
      `migrations directory not found at ${migrationsDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  const applied = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`
  const appliedSet = new Set(applied.map((r) => r.filename))

  const newly: string[] = []
  for (const file of files) {
    if (appliedSet.has(file)) continue
    const body = await readFile(path.join(migrationsDir, file), "utf8")
    await sql.unsafe(body)
    await sql`INSERT INTO schema_migrations (filename) VALUES (${file}) ON CONFLICT (filename) DO NOTHING`
    newly.push(file)
    console.log(`[migrate] applied ${file}`)
  }

  return { applied: newly }
}
