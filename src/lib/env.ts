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
  APP_URL: z.string().url().default("http://localhost:8787"),

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

// Per-upstream-call timeout. Non-streaming uses a fixed deadline. Streaming
// uses two independent timers:
//   - UPSTREAM_IDLE_TIMEOUT_MS_STREAMING: reset on every chunk — aborts if the
//     provider goes silent for this long mid-stream (stall / hang).
//   - UPSTREAM_MAX_STREAM_DURATION_MS: never resets — hard backstop against a
//     genuinely runaway/looping response regardless of chunk activity.
// Both must be > 0; gateway treats all timeouts as retryable (same as a 5xx).
export const env = {
  ...parsed,
  get UPSTREAM_TIMEOUT_MS_NON_STREAMING() {
    return intEnv("UPSTREAM_TIMEOUT_MS_NON_STREAMING", 30_000)
  },
  /** @deprecated Streaming no longer uses a fixed deadline; kept for backward
   * compat and for the Bun idleTimeout calculation fallback only. */
  get UPSTREAM_TIMEOUT_MS_STREAMING() {
    return intEnv("UPSTREAM_TIMEOUT_MS_STREAMING", 60_000)
  },
  /** Idle timeout for streaming calls (ms). The abort timer resets on every
   * received chunk, so a slow-but-healthy stream is never killed for just
   * running long — only for going silent. Default: 30 000 ms (30 s). */
  get UPSTREAM_IDLE_TIMEOUT_MS_STREAMING() {
    return intEnv("UPSTREAM_IDLE_TIMEOUT_MS_STREAMING", 30_000)
  },
  /** Absolute backstop for streaming calls (ms). Never resets regardless of
   * chunk activity — kills genuinely runaway/looping responses. Must be >
   * UPSTREAM_IDLE_TIMEOUT_MS_STREAMING. Default: 300 000 ms (5 min). */
  get UPSTREAM_MAX_STREAM_DURATION_MS() {
    return intEnv("UPSTREAM_MAX_STREAM_DURATION_MS", 300_000)
  },
}
