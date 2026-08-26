import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "./db"

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, "..", "..", "migrations")

// Neon pauses computes after 5 minutes of inactivity. The first query
// wakes it up — that takes a few hundred ms. If the connection attempt
// happens during the wake window (cold-start), the underlying socket
// call can time out with ECONNRESET / ETIMEDOUT / ENETUNREACH / EAI_AGAIN
// even though a moment later the same query would succeed. Retry the
// whole migration sequence a few times before giving up so a single
// cold-start race doesn't brick the boot.
const COLD_START_RETRIES = 3
const COLD_START_DELAY_MS = 1000

function isColdStartError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as any
  const code = typeof e.code === "string" ? e.code : ""
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    // Neon-specific: "Couldn't connect to compute node" surfaces as
    // a PostgresError with code 57P03 during the wake window.
    code === "57P03" ||
    // postgres-js sometimes surfaces DNS failures as a generic Error
    // whose message starts with "getaddrinfo".
    (typeof e.message === "string" && /getaddrinfo|ENOTFOUND|compute node/i.test(e.message))
  )
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runMigrations(): Promise<{ applied: string[] }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= COLD_START_RETRIES; attempt++) {
    try {
      return await runMigrationsOnce()
    } catch (err) {
      lastErr = err
      if (!isColdStartError(err) || attempt === COLD_START_RETRIES) {
        throw err
      }
      console.warn(
        `[migrate] cold-start on attempt ${attempt}/${COLD_START_RETRIES}, retrying in ${COLD_START_DELAY_MS}ms`,
      )
      await sleep(COLD_START_DELAY_MS)
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastErr
}

async function runMigrationsOnce(): Promise<{ applied: string[] }> {
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

  // Use a transactional advisory lock (lock key: 74839281) across the entire
  // migration sequence so that when N gateway replicas boot simultaneously,
  // exactly one node executes the migration check-and-apply transaction while
  // other nodes wait safely. The lock automatically releases on commit/abort.
  const newly: string[] = []
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(74839281)`

    const applied = await tx<{ filename: string }[]>`SELECT filename FROM schema_migrations`
    const appliedSet = new Set(applied.map((r) => r.filename))

    for (const file of files) {
      if (appliedSet.has(file)) continue
      const body = await readFile(path.join(migrationsDir, file), "utf8")
      try {
        await tx.unsafe(body)
      } catch (err) {
        const wrapped = new Error(
          `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        ;(wrapped as any).cause = err
        ;(wrapped as any).migrationFile = file
        throw wrapped
      }
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file}) ON CONFLICT (filename) DO NOTHING`
      newly.push(file)
      console.log(`[migrate] applied ${file}`)
    }
  })

  return { applied: newly }
}
