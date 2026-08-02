-- Add the three Claude Opus models documented for AgentRouter's
-- Anthropic-compatible endpoint (https://agentrouter.org — no /v1),
-- wire claude-opus-4-6 into all four complexity tiers, and ensure the
-- anthropic-compatible CHECK constraint permits exactly
-- https://agentrouter.org (no /v1, no trailing slash variants).
--
-- Migration 008_agentrouter_provider.sql created the agentrouter row
-- but its model/tier-route seed didn't reach production because that
-- file was edited after the first deployment had already applied it.
-- This follow-up migration is idempotent: re-running it on a fresh DB
-- that already has the models in place is a no-op (ON CONFLICT
-- (provider_id, model_id) DO NOTHING, ON CONFLICT (tier, model_id)
-- DO NOTHING).
--
-- Source for the model list:
--   https://agentrouter.org/docs/claude-code.html     (claude-opus-4-6 default)
--   https://agentrouter.org/docs/cline.html          (claude-opus-4-6, -4-7, -4-8)
--   https://agentrouter.org/docs/kilocode.html       (claude-opus-4-6, -4-7, -4-8)

-- 1. Seed the three Claude Opus models onto the agentrouter provider row.
--    ON CONFLICT skips rows that already exist (e.g. a previous admin
--    manually added gpt-5.5 or other Anthropic-compatible models — those
--    are preserved). Prices are 0 (admin sets them from the dashboard);
--    context_window 200000 matches Claude Opus 4 series defaults; all
--    capabilities (tools/vision/json) are on per Anthropic SDK defaults.
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

-- 2. Wire claude-opus-4-6 (the documented default) into all four tiers.
--    Same semantics as the original migration's tier-route seed. Other
--    Anthropic-compatible models (claude-opus-4-7, claude-opus-4-8) are
--    seeded but NOT auto-routed — admins add them per-tier from the
--    Tier Routing tab once they're happy with the default.
INSERT INTO tier_routes (tier, model_id, weight)
SELECT t.tier, m.id, 1.0
FROM models m
CROSS JOIN (VALUES ('trivial'), ('simple'), ('medium'), ('complex')) AS t(tier)
JOIN providers p ON p.id = m.provider_id
WHERE p.base_url = 'https://agentrouter.org'
  AND p.provider_type = 'anthropic-compatible'
  AND m.model_id = 'claude-opus-4-6'
ON CONFLICT (tier, model_id) DO NOTHING;

-- 3. Ensure the anthropic-compatible CHECK constraint actually exists.
--    On a DB that ran the original 008 migration before its model
--    seeding was finalized, the provider_type / base_url constraints
--    should still be present (the migration created them in earlier
--    ALTER TABLE statements), but be defensive: re-add them if a
--    previous partial run left the DB without them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'providers_base_url_anthropic_compatible'
      AND table_name = 'providers'
  ) THEN
    ALTER TABLE providers
      ADD CONSTRAINT providers_base_url_anthropic_compatible
      CHECK (
        provider_type <> 'anthropic-compatible'
        OR base_url = 'https://agentrouter.org'
      )
      NOT VALID;
    ALTER TABLE providers VALIDATE CONSTRAINT providers_base_url_anthropic_compatible;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'providers_base_url_openai_compatible'
      AND table_name = 'providers'
  ) THEN
    ALTER TABLE providers
      ADD CONSTRAINT providers_base_url_openai_compatible
      CHECK (
        provider_type <> 'openai-compatible'
        OR base_url = 'https://openrouter.ai/api/v1'
      )
      NOT VALID;
    ALTER TABLE providers VALIDATE CONSTRAINT providers_base_url_openai_compatible;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'providers_provider_type_valid'
      AND table_name = 'providers'
  ) THEN
    ALTER TABLE providers
      ADD CONSTRAINT providers_provider_type_valid
      CHECK (provider_type IN ('openai-compatible', 'anthropic-compatible'))
      NOT VALID;
    ALTER TABLE providers VALIDATE CONSTRAINT providers_provider_type_valid;
  END IF;
END $$;