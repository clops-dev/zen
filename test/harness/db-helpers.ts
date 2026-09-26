/**
 * test/harness/db-helpers.ts
 *
 * Test-database utilities. Every test suite that needs a real Postgres
 * connection should:
 *
 *   const db = await createTestDb()
 *   // use db.sql for raw queries
 *   // use db.seedUser(), db.seedApiKey(), db.seedProvider(), etc.
 *   afterAll(() => db.cleanup())
 *
 * The helpers use the TEST_DATABASE_URL env var (defaults to DATABASE_URL).
 * Tests run in their own schema named "test_<random>" and cleaned up after.
 * That avoids conflicts when tests run in parallel.
 *
 * IMPORTANT: do NOT use the default sql pool from src/lib/db.ts here — that
 * pool uses the production DATABASE_URL. Instead we create a fresh connection
 * so tests can point at a separate schema.
 */

import postgres from "postgres"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { generateApiKey, hashApiKey } from "../../src/lib/apikeys"
import { hashPassword } from "../../src/lib/password"
import { addCredits } from "../../src/lib/credits"

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, "..", "..", "migrations")

export interface SeedUser {
  id: string
  email: string
  rawApiKey: string
}

export interface SeedProvider {
  id: string
  baseUrl: string
}

export interface TestDb {
  /** Raw postgres.js connection — use for assertions / setup */
  sql: ReturnType<typeof postgres>
  /** The schema name used by this test run */
  schema: string
  /** Seed a test user with credits and an API key. Returns the raw key. */
  seedUser(opts?: {
    email?: string
    password?: string
    creditsDt?: number
    role?: "user" | "admin"
  }): Promise<SeedUser>
  /** Seed a provider pointing at fakeUpstreamUrl */
  seedProvider(opts: {
    fakeUpstreamUrl: string
    name?: string
    providerType?: "openai-compatible" | "anthropic-compatible"
  }): Promise<SeedProvider>
  /** Seed a model on a provider and register it in tier_routes */
  seedModel(opts: {
    providerId: string
    modelId?: string
    label?: string
    tier?: "trivial" | "simple" | "medium" | "complex"
    contextWindow?: number
    supportsTools?: boolean
    inputPricePer1M?: number
    outputPricePer1M?: number
  }): Promise<string> // returns model row id
  /** Drop the test schema and close the connection */
  cleanup(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const dbUrl = process.env.TEST_DATABASE_URL
  if (!dbUrl) {
    throw new Error("TEST_DATABASE_URL must be set to run database integration tests.")
  }

  const schema = `test_${Math.random().toString(36).slice(2, 10)}`

  // 1. Run all migrations using a dedicated max: 1 connection so raw BEGIN/COMMIT is safe
  const migrationSql = postgres(dbUrl, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    connection: { search_path: `${schema},public` },
  })

  try {
    await migrationSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await migrationSql.unsafe(`SET search_path TO "${schema}", public`)

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()
    for (const file of files) {
      const body = await readFile(path.join(migrationsDir, file), "utf8")
      await migrationSql.unsafe(body)
    }
  } finally {
    await migrationSql.end({ timeout: 5 })
  }

  // 2. Open pooled connection for test queries and assertions
  const sql = postgres(dbUrl, {
    max: 5,
    idle_timeout: 10,
    max_lifetime: 60,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    transform: { undefined: null },
    // Run all queries in our isolated schema
    connection: { search_path: `${schema},public` },
  })

  async function seedUser(opts: {
    email?: string
    password?: string
    creditsDt?: number
    role?: "user" | "admin"
  } = {}): Promise<SeedUser> {
    const email = opts.email ?? `test-${Math.random().toString(36).slice(2)}@example.com`
    const password = opts.password ?? "testpassword123"
    const role = opts.role ?? "user"
    const hash = await hashPassword(password)
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, ${role}) RETURNING id
    `
    const userId = row.id

    // Ensure credits row exists
    await sql`
      INSERT INTO user_credits (user_id, balance_dt) VALUES (${userId}, 0)
      ON CONFLICT (user_id) DO NOTHING
    `

    // Grant credits if requested
    if ((opts.creditsDt ?? 100) > 0) {
      // Direct INSERT into credit_transactions rather than going through addCredits
      // (which uses the global sql pool, not our test schema)
      const dt = opts.creditsDt ?? 100
      await sql`
        INSERT INTO credit_transactions (user_id, amount_dt, direction, type, status)
        VALUES (${userId}, ${dt}, 'credit', 'admin_grant', 'completed')
      `
      await sql`
        INSERT INTO user_credits (user_id, balance_dt)
        VALUES (${userId}, ${dt})
        ON CONFLICT (user_id) DO UPDATE SET balance_dt = user_credits.balance_dt + ${dt}
      `
    }

    // Generate API key
    const { raw, hash: keyHash, prefix } = generateApiKey()
    await sql`
      INSERT INTO api_keys (user_id, key_hash, key_prefix) VALUES (${userId}, ${keyHash}, ${prefix})
    `

    return { id: userId, email, rawApiKey: raw }
  }

  async function seedProvider(opts: {
    fakeUpstreamUrl: string
    name?: string
    providerType?: "openai-compatible" | "anthropic-compatible"
  }): Promise<SeedProvider> {
    const name = opts.name ?? `fake-provider-${Math.random().toString(36).slice(2)}`
    const providerType = opts.providerType ?? "openai-compatible"
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO providers (name, base_url, api_key, enabled, healthy, provider_type)
      VALUES (${name}, ${opts.fakeUpstreamUrl + "/v1"}, 'fake-key', true, true, ${providerType})
      RETURNING id
    `
    return { id: row.id, baseUrl: opts.fakeUpstreamUrl + "/v1" }
  }

  async function seedModel(opts: {
    providerId: string
    modelId?: string
    label?: string
    tier?: "trivial" | "simple" | "medium" | "complex"
    contextWindow?: number
    supportsTools?: boolean
    inputPricePer1M?: number
    outputPricePer1M?: number
  }): Promise<string> {
    const modelId = opts.modelId ?? "fake/ok"
    const label = opts.label ?? `fake/${modelId}`
    const tier = opts.tier ?? "simple"
    const contextWindow = opts.contextWindow ?? 128000
    const supportsTools = opts.supportsTools ?? true
    const inputPricePer1M = opts.inputPricePer1M ?? 0.001
    const outputPricePer1M = opts.outputPricePer1M ?? 0.001

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO models (provider_id, model_id, label, context_window, supports_tools, supports_vision, supports_json_mode, input_price_per_1m, output_price_per_1m, enabled)
      VALUES (${opts.providerId}, ${modelId}, ${label}, ${contextWindow}, ${supportsTools}, true, true, ${inputPricePer1M}, ${outputPricePer1M}, true)
      ON CONFLICT (provider_id, model_id) DO UPDATE SET enabled = true
      RETURNING id
    `
    const modelRowId = row.id

    await sql`
      INSERT INTO tier_routes (tier, model_id, weight)
      VALUES (${tier}, ${modelRowId}, 1)
      ON CONFLICT (tier, model_id) DO NOTHING
    `

    return modelRowId
  }

  async function cleanup(): Promise<void> {
    try {
      // Drop schema with CASCADE to remove all objects
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await sql.end({ timeout: 3 })
    }
  }

  return { sql, schema, seedUser, seedProvider, seedModel, cleanup }
}
