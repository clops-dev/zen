-- Migration 014: Persistent Circuit Breaker, Automatic Recovery, User Spending Caps, and Correlation Request IDs.

BEGIN;

-- Add persistent health state and tracking columns to providers table
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS health_state TEXT NOT NULL DEFAULT 'HEALTHY'
    CHECK (health_state IN ('HEALTHY', 'DEGRADED', 'DOWN', 'RECOVERING')),
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;

-- Add spending cap columns to subscriptions table
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS spending_cap_usd NUMERIC(12,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spending_cap_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spending_cap_period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (spending_cap_period IN ('monthly'));

-- Add correlation request_id to ai_requests table
ALTER TABLE ai_requests
  ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS ai_requests_request_id_idx ON ai_requests (request_id) WHERE request_id IS NOT NULL;

COMMIT;
