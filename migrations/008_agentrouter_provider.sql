-- Add AgentRouter as a second supported provider.
-- AgentRouter exposes an Anthropic-compatible API at https://agentrouter.org
-- (NOT https://agentrouter.org/v1 — the Anthropic adapter appends /messages
-- to whatever baseURL it is given, so we must NOT inject /v1 here).
--
-- This migration:
--   1. Relaxes the providers_base_url_openrouter_only CHECK constraint so
--      AgentRouter's base URL is also accepted.
--   2. Adds a provider_type column so ai-call.ts can dispatch to the right
--      adapter. Existing rows default to 'openai-compatible'.
--   3. Tightens the base_url rules per provider_type:
--        - openai-compatible:     must be https://openrouter.ai/api/v1
--        - anthropic-compatible:  must be exactly https://agentrouter.org
--      This is a hard guarantee that AgentRouter cannot be accidentally
--      configured with a /v1 suffix or as an OpenAI-compatible provider.
--   4. Inserts a stub AgentRouter row so the admin UI / model registration
--      has something to anchor to. api_key is empty — the admin UI or
--      ANTHROPIC_AUTH_TOKEN env fills it on next boot.
--
-- Run inside sql.begin() in migrate.ts so this is a single transaction.

-- 1. Add the provider_type column. Default 'openai-compatible' keeps every
--    existing row on the OpenAI path without per-row updates.
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS provider_type TEXT NOT NULL DEFAULT 'openai-compatible';

-- 2. Drop the old single-tenant CHECK constraint, then add per-type rules.
--    Idempotent: drop first so retrying a partially-applied migration
--    succeeds instead of erroring on "constraint already exists".
ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_base_url_openrouter_only;

ALTER TABLE providers
  ADD CONSTRAINT providers_provider_type_valid
  CHECK (provider_type IN ('openai-compatible', 'anthropic-compatible'))
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_provider_type_valid;

-- OpenAI-compatible rows: must keep the existing OpenRouter URL exactly.
-- (Equivalent to the old providers_base_url_openrouter_only check.)
ALTER TABLE providers
  ADD CONSTRAINT providers_base_url_openai_compatible
  CHECK (
    provider_type <> 'openai-compatible'
    OR base_url = 'https://openrouter.ai/api/v1'
  )
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_base_url_openai_compatible;

-- Anthropic-compatible rows: must be exactly https://agentrouter.org —
-- no /v1, no trailing slash variants. The Anthropic adapter appends
-- /messages to whatever baseURL it is configured with, so the absolute
-- final URL is https://agentrouter.org/messages by construction.
ALTER TABLE providers
  ADD CONSTRAINT providers_base_url_anthropic_compatible
  CHECK (
    provider_type <> 'anthropic-compatible'
    OR base_url = 'https://agentrouter.org'
  )
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_base_url_anthropic_compatible;

-- 3. Insert a stub AgentRouter row if one doesn't already exist. Empty
--    api_key is fine — index.ts will fill it from ANTHROPIC_AUTH_TOKEN on
--    next boot if that env var is set, otherwise the admin UI does.
INSERT INTO providers (name, base_url, api_key, provider_type, enabled)
SELECT 'agentrouter', 'https://agentrouter.org', '', 'anthropic-compatible', true
WHERE NOT EXISTS (
  SELECT 1 FROM providers WHERE base_url = 'https://agentrouter.org'
);

-- 4. Seed the three Claude Opus models documented for AgentRouter's
--    Anthropic-compatible endpoint (https://agentrouter.org — no /v1).
--    Source: agentrouter.org/docs (claude-code.html, cline.html,
--    kilocode.html). The docs explicitly list claude-opus-4-6 as the
--    default and mention -4-7 and -4-8 as the other supported variants
--    on this endpoint. We seed with reasonable defaults — admins can
--    edit pricing / context_window / capabilities from the Models tab,
--    or add additional model ids beyond these three. NOT a hardcoded
--    default model — the gateway itself has no preferred model on
--    agentrouter; this just pre-populates the registry so the admin
--    UI is usable from the first request after the migration runs.
--
--    ON CONFLICT (provider_id, model_id) DO NOTHING makes this
--    idempotent: re-running the migration is safe, and any rows an
--    admin already added are preserved.
INSERT INTO models (provider_id, model_id, label, input_price_per_1m, output_price_per_1m, context_window, supports_tools, supports_vision, supports_json_mode, enabled)
SELECT p.id, m.model_id, m.label, m.input_price_per_1m, m.output_price_per_1m, m.context_window, m.supports_tools, m.supports_vision, m.supports_json_mode, true
FROM providers p,
     (VALUES
       ('claude-opus-4-6'::TEXT, 'claude-opus-4-6'::TEXT, 0::NUMERIC, 0::NUMERIC, 200000::INTEGER, true, true, true),
       ('claude-opus-4-7',    'claude-opus-4-7',         0,            0,            200000,        true, true, true),
       ('claude-opus-4-8',    'claude-opus-4-8',         0,            0,            200000,        true, true, true)
     ) AS m(model_id, label, input_price_per_1m, output_price_per_1m, context_window, supports_tools, supports_vision, supports_json_mode)
WHERE p.base_url = 'https://agentrouter.org'
  AND p.provider_type = 'anthropic-compatible'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- 5. Wire the seeded AgentRouter models into tier_routes so the gateway
--    can route to them immediately. Maps the default Claude Opus variant
--    (claude-opus-4-6, per the docs) to ALL four complexity tiers so the
--    gateway is usable end-to-end on first boot with no admin setup —
--    same behavior as the catch-all "any enabled model" fallback, but
--    explicit (so admins see it in the Tier Routing tab and can tune).
--
--    Models other than claude-opus-4-6 are seeded but NOT auto-routed —
--    admins add them per-tier from the Tier Routing tab once they're
--    happy with the default. Idempotent: re-running the migration
--    preserves existing tier_routes (the UNIQUE constraint skips
--    duplicates).
INSERT INTO tier_routes (tier, model_id, weight)
SELECT t.tier, m.id, 1.0
FROM models m
CROSS JOIN (VALUES ('trivial'), ('simple'), ('medium'), ('complex')) AS t(tier)
JOIN providers p ON p.id = m.provider_id
WHERE p.base_url = 'https://agentrouter.org'
  AND p.provider_type = 'anthropic-compatible'
  AND m.model_id = 'claude-opus-4-6'
ON CONFLICT (tier, model_id) DO NOTHING;
