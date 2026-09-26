-- Migration 022: Routing enhancements for Phase 3
-- Additive and idempotent: safe to run from multiple replicas at boot.

-- 1. P3.4: Stable model aliases table
CREATE TABLE IF NOT EXISTS model_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias TEXT NOT NULL UNIQUE,
  target_model_id UUID REFERENCES models(id) ON DELETE SET NULL,
  target_tier TEXT CHECK (target_tier IS NULL OR target_tier IN ('trivial', 'simple', 'medium', 'complex', 'agent')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed stable aliases if not existing
INSERT INTO model_aliases (alias, target_tier, description)
VALUES
  ('zen/auto', NULL, 'Automatic routing based on complexity or agent detection'),
  ('zen/fast', 'simple', 'Fast response tier for quick edits and low complexity tasks'),
  ('zen/smart', 'complex', 'Smart tier for complex architecture, reasoning and coding'),
  ('zen/reasoning', 'complex', 'Deep reasoning models for difficult tasks')
ON CONFLICT (alias) DO NOTHING;

-- 2. P3.6: Per-model health and circuit breaker table
CREATE TABLE IF NOT EXISTS model_health (
  model_id UUID PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  healthy BOOLEAN NOT NULL DEFAULT true,
  health_state TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (health_state IN ('HEALTHY', 'DEGRADED', 'DOWN', 'RECOVERING')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  last_failure_reason TEXT
);

-- 3. P3.9: Model catalog metadata columns
ALTER TABLE models ADD COLUMN IF NOT EXISTS quality_score INTEGER CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100));
ALTER TABLE models ADD COLUMN IF NOT EXISTS supports_fim BOOLEAN DEFAULT FALSE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS tokenizer TEXT DEFAULT 'approx';
