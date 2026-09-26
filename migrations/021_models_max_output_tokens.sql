-- P2.12: Add max_output_tokens column to models table.
-- Nullable: NULL means "use context window heuristic" (contextWindow / 2, min 4096).
-- Additive and idempotent: safe to run from multiple replicas at boot.
ALTER TABLE models ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER;
