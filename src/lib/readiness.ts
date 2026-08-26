/**
 * Readiness / liveness state for graceful shutdown.
 *
 * Liveness (`/livez`): the process is alive and can answer HTTP. Does
 *   NOT depend on the database — a transient Postgres outage should
 *   never cause the orchestrator to restart an otherwise-healthy
 *   gateway.
 *
 * Readiness (`/readyz`): the process can serve user traffic. Goes
 *   false during graceful shutdown so the load balancer stops sending
 *   new requests, and goes false if a hard dependency (Postgres) is
 *   unreachable for an extended period.
 *
 * The Postgres liveness check used here is intentionally lightweight
 * (`SELECT 1` with a short timeout) — readiness is about "should the LB
 * route to me", not "is the DB healthy", which is its own operational
 * question.
 */

import { sql, withDbResilience } from "./db"
import { log } from "./logger"

type ReadyState = { ready: boolean; reason?: string; since?: number }

let state: ReadyState = { ready: true }
const listeners = new Set<(s: ReadyState) => void>()

/** Mark this instance as not ready (or ready). Idempotent. Logs every
 * transition at info level so a shutdown is auditable. */
export function setReady(ready: boolean, reason?: string): void {
  const prev = state
  if (prev.ready === ready && prev.reason === reason) return
  state = { ready, reason, since: Date.now() }
  log.info("ready_state_change", { ready, reason, prev_ready: prev.ready })
  for (const cb of listeners) {
    try { cb(state) } catch { /* ignore listener errors */ }
  }
}

export function isReady(): ReadyState {
  return state
}

/** Probe the database with a short timeout. Returns true if Postgres is
 * answering; false otherwise. The error is swallowed (logged once) — the
 * caller decides what to do with the boolean. */
async function probeDb(timeoutMs = 1500): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.race([
      withDbResilience(() => sql`SELECT 1`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("readyz: db probe timed out")), timeoutMs)),
    ])
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/** Used by the /readyz handler. If the instance was marked not ready
 * (e.g. SIGTERM received, drain started) we return false immediately —
 * the LB should pull this replica out of rotation. If the instance IS
 * ready, we still probe the DB; a hard DB outage means this replica
 * cannot serve traffic right now. */
export async function readyz(): Promise<{ ready: boolean; reason?: string; db?: string; db_error?: string }> {
  const s = isReady()
  if (!s.ready) {
    return { ready: false, reason: s.reason ?? "not_ready", db: "unknown" }
  }
  const probe = await probeDb()
  if (!probe.ok) {
    return { ready: false, reason: "db_unreachable", db: "error", db_error: probe.error }
  }
  return { ready: true, db: "ok" }
}