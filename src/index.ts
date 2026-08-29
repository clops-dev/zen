import app from "./server"
import { env } from "./lib/env"
import { runMigrations } from "./lib/migrate"
import { sql } from "./lib/db"
import { hashPassword } from "./lib/password"
import { log } from "./lib/logger"
import { setReady } from "./lib/readiness"

/** Format any thrown value into a useful single-line string. Used by
 * boot-time bootstrap handlers so we never log "[stage] failed:
 * undefined" when an Error has no message but has a stack (postgres-js
 * `cachedError` stubs) or vice versa. Pure & sync — safe to call in
 * any catch block. */
function formatError(err: unknown): string {
  if (err == null) return String(err)
  if (typeof err === "string") return err
  if (err instanceof Error) {
    const parts: string[] = []
    if (err.message) parts.push(err.message)
    const code = (err as any).code
    if (typeof code === "string" && code) parts.push(`code=${code}`)
    if (parts.length === 0 && err.stack) {
      // No .message but a stack — render the first stack line so the
      // log is at least informative.
      return err.stack.split("\n")[0]
    }
    return parts.join(" ")
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

try {
  const { applied } = await runMigrations()
  console.log(
    applied.length === 0
      ? "[migrate] no pending migrations"
      : `[migrate] applied ${applied.length} migration(s): ${applied.join(", ")}`,
  )
} catch (err) {
  // Robust error formatting. `postgres-js` errors come in several shapes:
  //   - PostgresError: has .code ("42P01"), .message, .query, .severity
  //   - Socket errors: has .code ("ECONNREFUSED"), .errno, .message
  //   - cachedError perf stubs: Error with empty message and a 4-line
  //     stack captured at Query construction time. The real failure is
  //     only visible via `String(err)` or by walking cause/underlying
  //     fields.
  // Render every variant usefully so we never log "[migrate] FAILED:
  // undefined" again.
  const parts: string[] = []
  if (err && typeof err === "object") {
    const e = err as any
    if (typeof e.message === "string" && e.message) parts.push(e.message)
    if (typeof e.code === "string" && e.code) parts.push(`code=${e.code}`)
    if (typeof e.severity === "string" && e.severity) parts.push(`severity=${e.severity}`)
    if (typeof e.query === "string" && e.query) parts.push(`query=${e.query.slice(0, 200)}`)
    if (typeof e.errno === "number") parts.push(`errno=${e.errno}`)
    if (typeof e.stack === "string" && e.stack) parts.push(`stack=${e.stack.split("\n").slice(0, 6).join(" | ")}`)
  }
  const detail = parts.length > 0 ? parts.join(" ") : String(err)
  console.error(`[migrate] FAILED: ${detail}`)
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
  console.error("[bootstrap] failed to create admin account:", formatError(err))
}

// First-boot bootstrap for the OpenRouter key. Idempotent: only writes
// when the OpenRouter row exists (the migration guarantees this after
// 006_openrouter_only.sql runs) AND has an empty api_key. Never
// overwrites a key set via the admin UI — Postgres is the source of
// truth. Safe to run on every boot.
try {
  if (env.OPENROUTER_API_KEY) {
    const updated = await sql`
      UPDATE providers
         SET api_key  = ${env.OPENROUTER_API_KEY},
             enabled  = true,
             healthy  = true
       WHERE base_url = 'https://openrouter.ai/api/v1'
         AND (api_key IS NULL OR api_key = '')
    `
    if (updated.length > 0) {
      console.log(`[bootstrap] copied OPENROUTER_API_KEY from env into the openrouter provider row`)
    }
  }
} catch (err) {
  console.error("[bootstrap] failed to seed OPENROUTER_API_KEY:", formatError(err))
}

// First-boot bootstrap for the AgentRouter (Anthropic-compatible) key.
// Mirrors the OPENROUTER_API_KEY pattern: only writes when the
// agentrouter provider row has an empty api_key, and never overwrites a
// key set via the admin UI. The base_url filter guarantees we never
// touch a non-agentrouter row even if a custom ANTHROPIC_BASE_URL is
// also set (the migration pins agentrouter's base_url to the canonical
// https://agentrouter.org value). LEGACY path — migration 010
// converted the agentrouter row to openai-compatible at /v1, so this
// query no longer matches anything in production; kept here so a
// operator who re-applies migration 008 (or runs the system against a
// pre-010 DB) still gets the anthropic-compatible bootstrap behavior.
try {
  if (env.ANTHROPIC_AUTH_TOKEN) {
    const updated = await sql`
      UPDATE providers
         SET api_key      = ${env.ANTHROPIC_AUTH_TOKEN},
             enabled      = true,
             healthy      = true
       WHERE base_url     = 'https://agentrouter.org'
         AND provider_type = 'anthropic-compatible'
         AND (api_key IS NULL OR api_key = '')
    `
    if (updated.length > 0) {
      console.log(`[bootstrap] copied ANTHROPIC_AUTH_TOKEN from env into the agentrouter provider row`)
    }
  }
} catch (err) {
  console.error("[bootstrap] failed to seed ANTHROPIC_AUTH_TOKEN:", formatError(err))
}

// First-boot bootstrap for the AgentRouter (OpenAI-compatible) key.
// Only writes when the openai-compatible agentrouter row at /v1 has an
// empty api_key, never overwrites a key set via the admin UI. Sets
// enabled=true once a key is present — but admins still need to
// explicitly add tier_routes entries (this migration does NOT do that
// for them) before any request will actually route to agentrouter.
// enabled=true here is the convention "row is configured and ready";
// reachability is gated on a live /v1/chat/completions verification
// that admin runs via the dashboard.
try {
  if (env.AGENTROUTER_API_KEY) {
    const updated = await sql`
      UPDATE providers
         SET api_key      = ${env.AGENTROUTER_API_KEY},
             enabled      = true,
             healthy      = true
       WHERE base_url     = 'https://agentrouter.org/v1'
         AND provider_type = 'openai-compatible'
         AND (api_key IS NULL OR api_key = '')
    `
    if (updated.length > 0) {
      console.log(`[bootstrap] copied AGENTROUTER_API_KEY from env into the agentrouter (openai-compatible) provider row`)
    }
  }
} catch (err) {
  console.error("[bootstrap] failed to seed AGENTROUTER_API_KEY:", formatError(err))
}

console.log(`zen-gateway listening on :${env.PORT}`)

// Bun's idleTimeout is in SECONDS (default: 10s). We must set it explicitly
// so the socket-level timeout always sits above the app-level idle abort window
// (UPSTREAM_IDLE_TIMEOUT_MS_STREAMING). Without this, Bun kills the socket
// before the app's own abort signal fires — producing "stream cancelled by
// client" for any stream that takes longer than 10 s between chunks.
//
// Formula: ceil(idle_ms / 1000) + 15s buffer
//   e.g. default 30 000 ms idle → 30 + 15 = 45 s
//
// Sized against the IDLE timeout, NOT UPSTREAM_MAX_STREAM_DURATION_MS — the
// idle timer fires first in the stall case; Bun's timeout is only a
// last-resort backstop well above both app-level timers.
const bunIdleTimeoutSeconds = Math.ceil(env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING / 1000) + 15

// ---------------------------------------------------------------------------
// Graceful shutdown.
//
// On SIGTERM (orchestrator stop / docker stop / kubectl delete pod) or
// SIGINT (Ctrl-C in dev) we:
//   1. Mark this replica not-ready so the load balancer pulls us out of
//      rotation immediately. /readyz starts returning 503.
//   2. Sleep for SHUTDOWN_DRAIN_MS so any in-flight request has a chance
//      to finish. New requests during this window get a 503 from /readyz
//      (the LB already pulled us out, but in case any request sneaks in
//      via keep-alive on an existing connection).
//   3. Close the Postgres pool. Any subsequent query fails fast, which
//      is the correct behaviour — we're exiting.
//   4. process.exit(0) with the configured code.
//
// SHUTDOWN_DRAIN_MS must be less than the orchestrator's
// terminationGracePeriodSeconds (Compose default: 10s, Kubernetes
// default: 30s). The 25s default fits both.
//
// If a second signal arrives during the drain, exit immediately so the
// orchestrator doesn't have to SIGKILL us.
// ---------------------------------------------------------------------------
const SHUTDOWN_DRAIN_MS = (() => {
  const raw = process.env.SHUTDOWN_DRAIN_MS
  if (!raw) return 25_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 25_000
})()

let shuttingDown = false
function installShutdown(server: { stop: (closeActiveConnections?: boolean) => Promise<void> }) {
  const onSignal = (signal: NodeJS.Signals | "SIGINT") => {
    if (shuttingDown) {
      console.warn(`[shutdown] received second ${signal}, forcing exit`)
      process.exit(1)
    }
    shuttingDown = true
    setReady(false, `draining_for_${signal}`)
    console.log(`[shutdown] ${signal} received, draining for ${SHUTDOWN_DRAIN_MS}ms`)
    const drainTimer = setTimeout(async () => {
      try {
        await server.stop(true)
        console.log("[shutdown] server stopped")
      } catch (err) {
        console.error("[shutdown] server.stop failed:", err)
      }
      try {
        await sql.end({ timeout: 5 })
        console.log("[shutdown] postgres pool closed")
      } catch (err) {
        console.error("[shutdown] postgres pool close failed:", err)
      }
      console.log("[shutdown] exit 0")
      process.exit(0)
    }, SHUTDOWN_DRAIN_MS)
    // Don't keep the event loop alive just for the drain timer.
    drainTimer.unref()
  }
  process.on("SIGTERM", () => onSignal("SIGTERM"))
  process.on("SIGINT", () => onSignal("SIGINT"))
}

let appServer: any
let currentPort = env.PORT
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    appServer = Bun.serve({
      port: currentPort,
      fetch: app.fetch,
      idleTimeout: bunIdleTimeoutSeconds,
    })
    log.info(`zen-gateway listening on :${currentPort}`)
    break
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" || /in use/i.test(err?.message ?? "")) {
      log.warn(`port ${currentPort} in use, retrying on :${currentPort + 1}`)
      currentPort++
    } else {
      throw err
    }
  }
}

if (appServer) {
  installShutdown(appServer)
}


