import app from "./server"
import { env } from "./lib/env"
import { runMigrations } from "./lib/migrate"
import { sql } from "./lib/db"
import { hashPassword } from "./lib/password"

try {
  const { applied } = await runMigrations()
  console.log(
    applied.length === 0
      ? "[migrate] no pending migrations"
      : `[migrate] applied ${applied.length} migration(s): ${applied.join(", ")}`,
  )
} catch (err) {
  console.error("[migrate] FAILED:", err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
}

// Bootstrap: create the admin account from env vars if no admin exists yet.
// Safe to leave this running on every boot — it's a no-op once an admin exists.
try {
  const existing = await sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`
  if (existing.length === 0) {
    const hash = await hashPassword(env.ADMIN_PASSWORD)
    const [adminUser] = await sql`
      INSERT INTO users (email, password_hash, role) VALUES (${env.ADMIN_EMAIL}, ${hash}, 'admin')
      ON CONFLICT (email) DO UPDATE SET role = 'admin'
      RETURNING id
    `
    await sql`
      INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
      VALUES (${adminUser.id}, 'enterprise', 'active', 999999999)
      ON CONFLICT (user_id) DO NOTHING
    `
    console.log(`[bootstrap] created admin account: ${env.ADMIN_EMAIL}`)
    console.log(`[bootstrap] log in at /login with the ADMIN_EMAIL/ADMIN_PASSWORD from your .env`)
  }
} catch (err) {
  console.error("[bootstrap] failed to create admin account:", err instanceof Error ? err.message : err)
}

console.log(`zen-gateway listening on :${env.PORT}`)

export default {
  port: env.PORT,
  fetch: app.fetch,
}
