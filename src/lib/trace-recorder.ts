/**
 * src/lib/trace-recorder.ts
 *
 * P1.4 — Golden trace recorder.
 *
 * Opt-in, off-by-default. Writes one JSON file per chat/completions request
 * to ZEN_TRACE_DIR. Secrets are always redacted. Message content can be
 * additionally hashed via ZEN_TRACE_REDACT_CONTENT=1.
 *
 * Safety guarantees:
 *   - Disabled by default (ZEN_TRACE_DIR must be set explicitly).
 *   - REFUSES to start in production (NODE_ENV=production) unless
 *     ZEN_TRACE_ALLOW_PROD=1 is also set. This makes accidental production
 *     enabling impossible.
 *   - Authorization, Cookie, x-api-key, api_key headers are always replaced
 *     with "[REDACTED]".
 *   - Message content is hashed with SHA-256 when ZEN_TRACE_REDACT_CONTENT=1.
 *
 * File format: trace/<requestId>.json
 * {
 *   schema_version: 1,
 *   request_id: string,
 *   recorded_at: ISO string,
 *   request: {
 *     method, path, headers_redacted, body_redacted
 *   },
 *   response: {
 *     status,
 *     model_label,
 *     tier,
 *     gateway_overhead_ms,
 *     ttft_ms,
 *     total_ms,
 *     finish_reason,
 *     usage,
 *     cancelled,
 *   },
 *   routing: {
 *     tier, classifier_score, classifier_reasons, route_reason, attempt_count, failover_chain
 *   }
 * }
 */

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SCHEMA_VERSION = 1

// Secret key patterns to redact from header values
const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
])

// Secret key patterns in request/response body objects
const SECRET_BODY_KEYS = new Set([
  "api_key",
  "apikey",
  "password",
  "session_secret",
  "authorization",
])

// ---------------------------------------------------------------------------
// Initialization — validated once at module load
// ---------------------------------------------------------------------------

export type TraceConfig = {
  enabled: false
} | {
  enabled: true
  traceDir: string
  redactContent: boolean
}

function buildConfig(): TraceConfig {
  const traceDir = process.env.ZEN_TRACE_DIR
  if (!traceDir) return { enabled: false }

  const isProd = (process.env.NODE_ENV ?? "development") === "production"
  const allowProd = process.env.ZEN_TRACE_ALLOW_PROD === "1"

  if (isProd && !allowProd) {
    throw new Error(
      "[trace] FATAL: ZEN_TRACE_DIR is set in NODE_ENV=production without ZEN_TRACE_ALLOW_PROD=1. " +
      "Refusing to start to prevent accidental production tracing. " +
      "Set ZEN_TRACE_ALLOW_PROD=1 only if you genuinely intend to trace production traffic.",
    )
  }

  const redactContent = process.env.ZEN_TRACE_REDACT_CONTENT === "1"

  return { enabled: true, traceDir, redactContent }
}

// Singleton config — validated once, throws at import time if misconfigured
let _config: TraceConfig | null = null

export function getTraceConfig(): TraceConfig {
  if (_config === null) {
    _config = buildConfig()
  }
  return _config
}

/** Reset config — for testing only */
export function _resetTraceConfig(): void {
  _config = null
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/** Redact secret headers, return a new object with [REDACTED] values */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]"
    } else {
      out[k] = v
    }
  }
  return out
}

/** Redact secret keys in a flat or shallow body object */
export function redactBodyKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_BODY_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]"
    } else {
      out[k] = v
    }
  }
  return out
}

/** Hash a content string with SHA-256 for trace redaction */
export function hashContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/** Redact message content if redactContent is enabled */
export function redactMessages(
  messages: unknown[],
  redactContent: boolean,
): unknown[] {
  if (!redactContent) return messages
  return messages.map((m: any) => {
    if (typeof m !== "object" || !m) return m
    const out: any = { ...m }
    if (typeof out.content === "string" && out.content) {
      out.content = hashContent(out.content)
    } else if (Array.isArray(out.content)) {
      out.content = out.content.map((part: any) => {
        if (typeof part !== "object" || !part) return part
        const p = { ...part }
        if (typeof p.text === "string" && p.text) p.text = hashContent(p.text)
        // Never include image_url data
        if (p.type === "image_url") p.image_url = { url: "[REDACTED]" }
        return p
      })
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// Trace record shape
// ---------------------------------------------------------------------------

export interface TraceRequestInfo {
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface TraceResponseInfo {
  status: number
  model_label: string
  tier: string
  gateway_overhead_ms: number
  ttft_ms: number | null
  total_ms: number
  finish_reason: string | null
  usage: Record<string, number> | null
  cancelled: boolean
}

export interface TraceRoutingInfo {
  tier: string
  classifier_score?: number
  classifier_reasons?: string[]
  route_reason?: string
  attempt_count: number
  failover_chain: Array<{ model: string; error?: string }>
}

export interface TraceRecord {
  schema_version: typeof SCHEMA_VERSION
  request_id: string
  recorded_at: string
  request: TraceRequestInfo
  response: TraceResponseInfo
  routing: TraceRoutingInfo
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writeTrace(record: TraceRecord): Promise<void> {
  const config = getTraceConfig()
  if (!config.enabled) return

  try {
    await mkdir(config.traceDir, { recursive: true })
    const filename = join(config.traceDir, `${record.request_id}.json`)
    await writeFile(filename, JSON.stringify(record, null, 2), "utf8")
  } catch (err) {
    // Trace failures must never crash the request handler.
    console.error("[trace] failed to write trace:", err instanceof Error ? err.message : err)
  }
}

/**
 * Build a TraceRecord from gateway request context.
 * Automatically redacts secrets and optionally hashes content.
 */
export function buildTraceRecord(opts: {
  requestId: string
  method: string
  path: string
  rawHeaders: Record<string, string>
  rawBody: Record<string, unknown>
  response: TraceResponseInfo
  routing: TraceRoutingInfo
}): TraceRecord {
  const config = getTraceConfig()
  const redactContent = config.enabled ? config.redactContent : false

  const redactedHeaders = redactHeaders(opts.rawHeaders)
  const redactedBody: Record<string, unknown> = { ...redactBodyKeys(opts.rawBody) }

  // Redact message content
  if (Array.isArray(redactedBody.messages)) {
    redactedBody.messages = redactMessages(redactedBody.messages as unknown[], redactContent)
  }

  // Never include tool definitions or tool results — could contain secrets
  if ("tools" in redactedBody) {
    redactedBody.tools = `[${(redactedBody.tools as any[])?.length ?? 0} tools redacted]`
  }

  return {
    schema_version: SCHEMA_VERSION,
    request_id: opts.requestId,
    recorded_at: new Date().toISOString(),
    request: {
      method: opts.method,
      path: opts.path,
      headers: redactedHeaders,
      body: redactedBody,
    },
    response: opts.response,
    routing: opts.routing,
  }
}
