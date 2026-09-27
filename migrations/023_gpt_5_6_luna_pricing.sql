-- Correct GPT-5.6 Luna pricing. Migration 020 used the non-existent
-- `luna-5.6` model ID, leaving the actual `gpt-5.6-luna` route unpriced.
-- Prices are USD per 1M tokens: $0.20 input, $0.02 cached input, $1.20 output.
-- This is idempotent and intentionally updates existing rows so stale $0
-- or legacy prices cannot make billing undercharge requests.

UPDATE models
SET input_price_per_1m = 0.2,
    output_price_per_1m = 1.2,
    input_cache_read_price_per_1m = 0.02
WHERE model_id = 'gpt-5.6-luna'
  AND (
    input_price_per_1m IS DISTINCT FROM 0.2
    OR output_price_per_1m IS DISTINCT FROM 1.2
    OR input_cache_read_price_per_1m IS DISTINCT FROM 0.02
  );
