/**
 * Structured JSON logger for Zen Gateway.
 *
 * Why: production deployments aggregate logs into centralised systems
 * (Loki, ELK, CloudWatch). The aggregator indexes and queries by JSON
 * fields, not by human-readable strings. Mixing human log lines with JSON
 * makes queries impossible.
 *
 * Contract:
 *   - Every log call emits one line of valid JSON on stdout/stderr.
 *   - `level` is required; other fields are open.
 *   - The pino-style fields `time`, `level`, `msg` are added automatically.
 *   - Errors are serialised with their `name`, `message`, and (in dev)
 *     their stack. NEVER serialise API keys or other secrets — see
 *     `safeLog` below.
 *
 * Replace by stripping the `console.*` calls and routing through here
 * once Phase 4 (observability) lands and you wire a real log shipper.
 */

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

const LEVEL_RANK: Record<Level, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
}

function readLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase()
  return LEVEL_RANK[raw as Level] ?? LEVEL_RANK.info
}

const ENV = process.env.NODE_ENV ?? "development"
const MIN_LEVEL = readLevel()

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < MIN_LEVEL) return
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    env: ENV,
    service: "zen-gateway",
    version: process.env.VERSION ?? undefined,
    git_sha: process.env.GIT_SHA ?? undefined,
    ...(fields ?? {}),
  }
  // Drop undefined values so the JSON stays compact.
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined) delete entry[k]
  }
  const line = JSON.stringify(entry)
  if (level === "error" || level === "fatal") {
    console.error(line)
  } else {
    console.log(line)
  }
}

/** Safe-shape helper. Trims `Authorization` / `Cookie` / `api_key` /
 * `session` / known-secret fields so a log line can never accidentally
 * exfiltrate a credential. Use this on any object you didn't construct
 * yourself before passing it to the logger. */
export function safeLog<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase()
    if (
      lk === "authorization" ||
      lk === "cookie" ||
      lk === "set-cookie" ||
      lk === "api_key" ||
      lk === "apikey" ||
      lk === "session" ||
      lk === "session_secret" ||
      lk === "password" ||
      lk === "x-api-key"
    ) {
      out[k] = "[REDACTED]"
    } else {
      out[k] = v
    }
  }
  return out
}

function errFields(err: unknown): Record<string, unknown> {
  if (!err) return {}
  if (err instanceof Error) {
    const fields: Record<string, unknown> = { err_name: err.name, err_msg: err.message }
    if ((err as any).code) fields.err_code = (err as any).code
    if (ENV !== "production" && err.stack) fields.err_stack = err.stack.split("\n").slice(0, 8).join(" | ")
    return fields
  }
  return { err: String(err) }
}

export const log = {
  trace: (msg: string, fields?: Record<string, unknown>) => emit("trace", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>, err?: unknown) =>
    emit("error", msg, { ...(fields ?? {}), ...errFields(err) }),
  fatal: (msg: string, fields?: Record<string, unknown>, err?: unknown) =>
    emit("fatal", msg, { ...(fields ?? {}), ...errFields(err) }),
}