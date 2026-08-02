import { sql } from "./db"

export type AuditAction =
  // auth
  | "auth.login"
  | "auth.logout"
  | "auth.login_failed"
  // user mgmt
  | "user.create"
  | "user.update"
  | "user.disable"
  | "user.enable"
  | "user.delete"
  // provider mgmt
  | "provider.create"
  | "provider.update"
  | "provider.update_key"
  | "provider.enable"
  | "provider.disable"
  | "provider.delete"
  | "provider.test"
  // model mgmt
  | "model.create"
  | "model.update"
  | "model.enable"
  | "model.disable"
  | "model.delete"
  // routing
  | "route.create"
  | "route.update"
  | "route.enable"
  | "route.disable"
  | "route.delete"
  // combos
  | "combo.create"
  | "combo.update"
  | "combo.archive"
  | "combo.clone"
  | "combo.export"
  | "combo.import"
  | "combo.delete"
  // api keys
  | "api_key.create"
  | "api_key.revoke"
  | "api_key.rotate"
  // system
  | "system.bootstrap"
  | "system.migration_applied"

export type AuditResource =
  | "user"
  | "provider"
  | "model"
  | "routing"
  | "combo"
  | "api_key"
  | "system"
  | "auth"

export type AuditResult = "success" | "failure" | "denied"

export type AuditInput = {
  actorId?: string | null
  actorEmail?: string | null
  action: AuditAction
  resource: AuditResource
  resourceId?: string | null
  ip?: string | null
  result?: AuditResult
  metadata?: Record<string, unknown>
}

/** Best-effort audit write. Audit failures must NEVER crash the
 * surrounding handler — the user's action already succeeded (or
 * failed visibly) and surfacing a database error here would be
 * confusing. Log and swallow. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const result = input.result ?? "success"
    const metadata = input.metadata ?? {}
    // postgres-js's sql.json() expects a JSONValue. Cast at the boundary
    // — metadata is `Record<string, unknown>` because we accept arbitrary
    // typed application data, but the actual values are JSON-safe.
    await sql`
      INSERT INTO audit_logs
        (actor_id, actor_email, action, resource, resource_id, ip, result, metadata)
      VALUES
        (${input.actorId ?? null},
         ${input.actorEmail ?? null},
         ${input.action},
         ${input.resource},
         ${input.resourceId ?? null},
         ${input.ip ?? null},
         ${result},
         ${sql.json(metadata as Record<string, any>)})
    `
  } catch (err) {
    console.error("[audit] failed to record event:", err)
  }
}

/** Resolve the actor's email from the users table for denormalised
 * audit display. Used when the actor_id is known but the display
 * string isn't — keeps audit rows readable even if the user row is
 * later deleted. Returns null on lookup failure. */
export async function actorEmailFor(actorId: string | null | undefined): Promise<string | null> {
  if (!actorId) return null
  try {
    const rows = await sql`SELECT email FROM users WHERE id = ${actorId} LIMIT 1`
    return rows[0]?.email ?? null
  } catch {
    return null
  }
}
