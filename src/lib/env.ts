import { z } from "zod"

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8787),
  SESSION_SECRET: z.string().min(32, "must be at least 32 chars — generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),

  // Bootstrap admin — created automatically on first run if no admin exists.
  // Change the password via the dashboard after first login.
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),

  // Default monthly token budget for new free-tier signups.
  DEFAULT_FREE_TOKEN_BUDGET: z.coerce.number().int().positive().default(50000),

  // First-boot bootstrap for the OpenRouter API key. The admin UI is
  // still the source of truth (per-provider api_key is stored in
  // Postgres and used per request by routing.ts). This env var is just
  // a convenience: if no OpenRouter provider row has a key set on boot,
  // src/index.ts copies this value into the providers table so the
  // gateway is usable from the first request without an extra admin
  // step. Optional — leave blank if you'll set the key via the admin UI.
  OPENROUTER_API_KEY: z.string().optional(),

  // First-boot bootstrap for the AgentRouter (Anthropic-compatible) API
  // key. Same semantics as OPENROUTER_API_KEY above: copied into the
  // AgentRouter provider row on boot only if that row has no api_key
  // yet, and never overwrites a key set via the admin UI. Optional.
  // Kept for the legacy anthropic-compatible row; the current
  // openai-compatible registration at /v1 uses AGENTROUTER_API_KEY
  // below instead.
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),

  // Base URL for the AgentRouter (Anthropic-compatible) provider.
  // Must NOT have a trailing /v1 — the Anthropic SDK appends /messages
  // to whatever baseURL it is given, so injecting /v1 here would break
  // the final endpoint. The migration 008_agentrouter_provider.sql
  // hard-codes the row's base_url to https://agentrouter.org; this env
  // var is only here to allow operators to point at a different
  // deployment (mirror, staging) without a code change. Optional.
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  // First-boot bootstrap for the AgentRouter (OpenAI-compatible) API
  // key. Copied into the agentrouter provider row on boot only if that
  // row has no api_key yet, and never overwrites a key set via the
  // admin UI. Optional. The current registration uses the
  // OpenAI-compatible endpoint at https://agentrouter.org/v1 with the
  // @ai-sdk/openai-compatible adapter (see migration
  // 010_agentrouter_openai_compatible.sql for the row definition).
  AGENTROUTER_API_KEY: z.string().optional(),

  // Public URL of this gateway. Sent as the HTTP-Referer header on
  // every upstream request to OpenRouter. OpenRouter uses this for
  // attribution and to keep free-tier callers from being deprioritized.
  // Must be a URL — OpenRouter rejects malformed values.
  APP_URL: z.string().url().default("http://192.168.253.155:8787"),

  // Public web URL used by the device auth flow to build the browser-facing
  // verification_url returned to the CLI. Optional — device-auth.ts falls back
  // to constructing it from the incoming request's host/protocol, which works
  // fine for local dev. Set this explicitly once deployed so the CLI always
  // gets the real public URL, not an internal/load-balancer hostname.
  WEB_URL: z.string().url().optional(),
})

const parsed = envSchema.parse(process.env)

/** Read a positive integer env var with a fallback. Used for runtime-tunable
 * values where reading on every access (not at module load) matters — lets
 * tests and operational tooling override these without restarting. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// Per-upstream-call timeouts. Non-streaming uses a single fixed deadline
// (UPSTREAM_TIMEOUT_MS_NON_STREAMING). Streaming uses FOUR independent timers:
//   1. UPSTREAM_CONNECT_TIMEOUT_MS — TCP+TLS handshake to the provider must
//      complete in this window. Fires only before the first byte arrives.
//      Default: 10 000 ms (10 s). Anything longer means the provider is
//      unreachable from this network.
//   2. UPSTREAM_FIRST_TOKEN_TIMEOUT_MS — time from request start to the
//      FIRST valid output chunk (text, reasoning, or tool call). Fires
//      only before the first byte arrives. Catches a healthy TCP
//      connection where the provider then hangs processing the request
//      (e.g. model warming, queueing on a slow path). Default: 120 000 ms
//      (2 min) — long enough for genuinely slow reasoning models, short
//      enough to fall back before the user gives up.
//   3. UPSTREAM_IDLE_TIMEOUT_MS_STREAMING — gap between any two valid
//      chunks. Resets on every chunk. Catches a stream that goes silent
//      mid-flight (provider timeout, network stall, dead request).
//      Default: 120 000 ms (2 min). Replaces the historical 30s value
//      that killed healthy long-reasoning responses.
//   4. UPSTREAM_MAX_STREAM_DURATION_MS — never resets. Hard backstop
//      against genuinely runaway/looping responses regardless of chunk
//      activity. Default: 600 000 ms (10 min). Must be >
//      UPSTREAM_IDLE_TIMEOUT_MS_STREAMING.
//
// The three "before first byte" timers (connect, first-token, non-stream
// deadline) all raise UpstreamTimeoutError with a `rejectReason` tag so the
// gateway's classifier / dashboard can tell them apart. The idle and
// max-duration timers continue to do so as well.
export const env = {
  ...parsed,
  get UPSTREAM_TIMEOUT_MS_NON_STREAMING() {
    return intEnv("UPSTREAM_TIMEOUT_MS_NON_STREAMING", 30_000)
  },
  /** @deprecated Streaming no longer uses a fixed deadline; kept for backward
   * compat only. The four streaming timers (connect / firstToken / idle /
   * max_duration) are the source of truth. */
  get UPSTREAM_TIMEOUT_MS_STREAMING() {
    return intEnv("UPSTREAM_TIMEOUT_MS_STREAMING", 60_000)
  },
  /** Streaming connect timeout (ms). TCP+TLS handshake budget before the
   * first byte. Default: 10 000 ms (10 s). */
  get UPSTREAM_CONNECT_TIMEOUT_MS() {
    return intEnv("UPSTREAM_CONNECT_TIMEOUT_MS", 10_000)
  },
  /** Streaming first-token timeout (ms). Time from request start to the
   * first valid chunk (text, reasoning, or tool call). Default: 120 000 ms
   * (2 min). */
  get UPSTREAM_FIRST_TOKEN_TIMEOUT_MS() {
    return intEnv("UPSTREAM_FIRST_TOKEN_TIMEOUT_MS", 120_000)
  },
  /** Streaming idle timeout (ms). Gap between any two valid chunks; resets
   * on every chunk. Default: 120 000 ms (2 min). */
  get UPSTREAM_IDLE_TIMEOUT_MS_STREAMING() {
    return intEnv("UPSTREAM_IDLE_TIMEOUT_MS_STREAMING", 120_000)
  },
  /** Streaming max-duration backstop (ms). Never resets. Default: 600 000
   * ms (10 min). Must be > UPSTREAM_IDLE_TIMEOUT_MS_STREAMING. */
  get UPSTREAM_MAX_STREAM_DURATION_MS() {
    return intEnv("UPSTREAM_MAX_STREAM_DURATION_MS", 600_000)
  },
}
