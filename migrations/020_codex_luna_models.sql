-- Migration 020: Fix pricing for codex-5.1 and luna-5.6 models.
--
-- These models exist in the DB but have zero-value pricing, which means
-- calcCost() returns 0 and deductCredits() is never called — users get
-- free AI access.
--
-- This migration sets real pricing on these models so the gateway's
-- billing pipeline charges users correctly on every request.
--
-- Pricing references (update to match your provider's current pricing):
--   codex-5.1  — OpenAI o3-class reasoning model, est. $15/$60 per 1M tokens
--   luna-5.6   — Anthropic Sonnet-class model,   est. $3/$15  per 1M tokens
--
-- NOTE: If these model IDs differ from what's in your DB, adjust the
-- WHERE clause model_id values accordingly.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Set pricing on codex-5.1
-- ---------------------------------------------------------------------------

UPDATE models
SET input_price_per_1m  = 15.0,   -- $15.00 per 1M input tokens
    output_price_per_1m = 60.0    -- $60.00 per 1M output tokens
WHERE model_id = 'codex-5.1'
  AND (input_price_per_1m = 0 OR output_price_per_1m = 0);

-- If the model doesn't exist yet under any provider, this INSERT creates it.
-- Adjust provider_id lookup to whichever provider hosts codex-5.1.
INSERT INTO models (
  provider_id,
  model_id,
  label,
  input_price_per_1m,
  output_price_per_1m,
  context_window,
  supports_tools,
  supports_vision,
  supports_json_mode,
  enabled
)
SELECT
  p.id,
  'codex-5.1',
  'codex-5.1',
  15.0,
  60.0,
  128000,
  false,
  false,
  false,
  true
FROM providers p
WHERE p.enabled = true
  AND NOT EXISTS (
    SELECT 1 FROM models m WHERE m.model_id = 'codex-5.1' AND m.provider_id = p.id
  )
ORDER BY p.created_at ASC
LIMIT 1;

-- ---------------------------------------------------------------------------
-- 2. Set pricing on luna-5.6
-- ---------------------------------------------------------------------------

UPDATE models
SET input_price_per_1m  = 3.0,    -- $3.00 per 1M input tokens
    output_price_per_1m = 15.0    -- $15.00 per 1M output tokens
WHERE model_id = 'luna-5.6'
  AND (input_price_per_1m = 0 OR output_price_per_1m = 0);

INSERT INTO models (
  provider_id,
  model_id,
  label,
  input_price_per_1m,
  output_price_per_1m,
  context_window,
  supports_tools,
  supports_vision,
  supports_json_mode,
  enabled
)
SELECT
  p.id,
  'luna-5.6',
  'luna-5.6',
  3.0,
  15.0,
  200000,
  true,
  true,
  true,
  true
FROM providers p
WHERE p.enabled = true
  AND NOT EXISTS (
    SELECT 1 FROM models m WHERE m.model_id = 'luna-5.6' AND m.provider_id = p.id
  )
ORDER BY p.created_at ASC
LIMIT 1;

-- ---------------------------------------------------------------------------
-- 3. Wire into tier_routes if not already present (complex tier as default)
-- ---------------------------------------------------------------------------

INSERT INTO tier_routes (tier, model_id, weight)
SELECT 'complex', m.id, 1.0
FROM models m
WHERE m.model_id IN ('codex-5.1', 'luna-5.6')
  AND m.enabled = true
ON CONFLICT (tier, model_id) DO NOTHING;

COMMIT;
