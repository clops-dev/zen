import { sql } from "./db"

export type AuditAction =
  // auth
  | "auth.login"
  | "auth.logout"
  | "auth.logout_all"
  | "auth.login_failed"
  | "auth.signup"
  | "auth.password_change"
  | "auth.password_reset_requested"
  | "auth.password_reset_completed"
  | "auth.mfa_enabled"
  | "auth.mfa_disabled"
  | "auth.welcome_grant"
  | "auth.email_verified"
  // abuse detection
  | "abuse.welcome_grant_blocked"
  | "abuse.signup_spike"
  | "abuse.failed_login_spike"
  | "abuse.disposable_email_attempt"
  | "abuse.disposable_email_spike"
  | "abuse.high_risk_signup_blocked"
  | "abuse.device_id_collision"
  | "abuse.account_approved"
  | "abuse.account_frozen"
  | "abuse.account_suspended"
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
  | "provider.reset_health"
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
  // credits
  | "credits.grant"
  | "credits.adjustment"
  // payments
  | "payments.confirm"
  | "payments.reject"
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
  | "credit_transaction"
  | "system"
  | "auth"
  | "abuse"

export type AuditResult = "success" | "failure" | "denied"

export type AuditInput = {
  actorId?: string | null
  actorEmail?: string | null
  action: AuditAction
  resource: AuditResource
  resourceId?: string | null
  ip?: string | null
  requestId?: string | null
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
    const metadata = { ...(input.metadata ?? {}), ...(input.requestId ? { request_id: input.requestId } : {}) }
    const jsonMeta = typeof (sql as any).json === "function" ? (sql as any).json(metadata) : JSON.stringify(metadata)
    try {
      await sql`
        INSERT INTO audit_logs
          (actor_id, actor_email, action, resource, resource_id, ip, request_id, result, metadata)
        VALUES
          (${input.actorId ?? null},
           ${input.actorEmail ?? null},
           ${input.action},
           ${input.resource},
           ${input.resourceId ?? null},
           ${input.ip ?? null},
           ${input.requestId ?? null},
           ${result},
           ${jsonMeta})
      `
    } catch {
      // Fallback if request_id column does not exist in an older schema
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
           ${jsonMeta})
      `
    }
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
