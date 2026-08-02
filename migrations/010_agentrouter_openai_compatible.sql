-- Convert the AgentRouter provider row from anthropic-compatible
-- (https://agentrouter.org, no /v1) to openai-compatible
-- (https://agentrouter.org/v1), and seed it with the docs-verified
-- model slugs for the OpenAI-compatible path.
--
-- Why this migration exists
-- -------------------------
-- Migration 008_agentrouter_provider.sql registered AgentRouter as an
-- Anthropic-compatible provider at https://agentrouter.org (no /v1)
-- and seeded claude-opus-4-6/4-7/4-8. After live verification work,
-- we settled on the OpenAI-compatible path as the primary integration:
--
--   * Env var convention: AGENTROUTER_API_KEY (matches Mastra docs
--     and the @ai-sdk/openai-compatible adapter in OpenCode's config).
--   * base_url: https://agentrouter.org/v1
--   * Adapter: @ai-sdk/openai-compatible (existing path, no new code).
--   * Model slugs confirmed against AgentRouter's own docs
--     (Kilo Code page + OpenCode page — both list exactly gpt-5.5
--     and glm-5.2 for the OpenAI-compatible endpoint).
--
-- Per task spec ("do not guess"), all capability flags default to
-- safe values (false/null) because:
--   1. AgentRouter's docs don't publish a per-model capability
--      matrix (no Tools / Vision / Reasoning columns like other
--      provider docs do).
--   2. The /v1/models endpoint is WAF-blocked (Aliyun acw_tc cookie,
--      401 unauthorized_client_error) with every key we have, so we
--      can't pull live capability data.
--   3. Per the task spec: "if you cannot verify a field, leave it at
--      its safe default (false/null) rather than assuming it matches
--      a similarly-named model elsewhere."
--
-- What this migration does NOT do
-- --------------------------------
--   * Does NOT write any tier_routes rows. Per task spec, tier
--     enablement is gated on a live-verified
--     POST /v1/chat/completions completion — not just on registration.
--   * Does NOT set enabled=true. The row stays disabled until the
--     verification gate passes.
--   * Does NOT remove the anthropic-compatible provider_type from the
--     schema — it's still in the union (other vendors may need it
--     later; the /v1 path-rewrite is scoped to providerName ===
--     "agentrouter" so it won't bite).
--
-- Idempotency
-- -----------
-- All steps are safe to re-run. The CHECK constraints are dropped
-- before UPDATEd; the row conversion uses a WHERE name='agentrouter'
-- guard; model seeding uses ON CONFLICT (provider_id, model_id) DO
-- NOTHING.

BEGIN;

-- 1. Remove any tier_routes that pointed to the legacy anthropic-compatible
--    models (claude-opus-4-6/4-7/4-8) on the agentrouter row, and delete
--    those model rows themselves. FK on tier_routes.model_id → models.id
--    is ON DELETE CASCADE so we can drop tier_routes first or together.
DELETE FROM models
 WHERE provider_id IN (SELECT id FROM providers WHERE name = 'agentrouter');

-- 2. Relax the openai-compatible URL CHECK so we can move the row to
--    https://agentrouter.org/v1. Drop first, then re-add with the
--    wider URL set. NOT VALID + VALIDATE pattern matches migration 008.
ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_base_url_openai_compatible;

ALTER TABLE providers
  ADD CONSTRAINT providers_base_url_openai_compatible
  CHECK (
    provider_type <> 'openai-compatible'
    OR base_url = 'https://openrouter.ai/api/v1'
    OR base_url = 'https://agentrouter.org/v1'
  )
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_base_url_openai_compatible;

-- 3. Convert the agentrouter row to openai-compatible at /v1. Handles
--    both states (existing row from migration 008, or no row at all)
--    via a single conditional. We set enabled=false — the verification
--    gate (a successful /v1/chat/completions round-trip) is what flips
--    this to true, per the task spec.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM providers WHERE name = 'agentrouter') THEN
    UPDATE providers
       SET base_url     = 'https://agentrouter.org/v1',
           provider_type = 'openai-compatible',
           enabled      = false,
           healthy      = true,
           consecutive_failures = 0,
           last_failure_at = NULL,
           api_key      = COALESCE(NULLIF(api_key, ''), '')
     WHERE name = 'agentrouter';
  ELSE
    INSERT INTO providers (name, base_url, api_key, provider_type, enabled)
    VALUES ('agentrouter', 'https://agentrouter.org/v1', '', 'openai-compatible', false);
  END IF;
END $$;

-- 4. Seed the docs-verified openai-compatible model slugs. Both rows
--    verified against AgentRouter's own Kilo Code docs page and the
--    OpenCode docs example config. Capability flags are NULL/false
--    per task spec — see header comment for reasoning. Pricing left
--    at 0 (admins set from the dashboard). enabled=false so the
--    models aren't routable until an admin explicitly enables them
--    AND tier_routes is wired (which this migration intentionally
--    does NOT do).
INSERT INTO models (provider_id, model_id, label, input_price_per_1m, output_price_per_1m, context_window, supports_tools, supports_vision, supports_json_mode, enabled)
SELECT p.id, m.model_id, m.label, m.input_price_per_1m, m.output_price_per_1m, m.context_window, m.supports_tools, m.supports_vision, m.supports_json_mode, false
FROM providers p,
     (VALUES
       ('gpt-5.5'::TEXT, 'gpt-5.5'::TEXT, 0::NUMERIC, 0::NUMERIC, NULL::INTEGER, false, false, false),
       ('glm-5.2',      'glm-5.2',       0,            0,            NULL,          false, false, false)
     ) AS m(model_id, label, input_price_per_1m, output_price_per_1m, context_window, supports_tools, supports_vision, supports_json_mode)
WHERE p.base_url = 'https://agentrouter.org/v1'
  AND p.provider_type = 'openai-compatible'
ON CONFLICT (provider_id, model_id) DO NOTHING;

COMMIT;