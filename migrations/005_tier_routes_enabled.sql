-- Add an `enabled` column to tier_routes so admins can temporarily turn a
-- route off (e.g. to A/B test a different model) without losing the
-- (tier, model_id, weight) configuration.
--
-- Defaults to true so existing rows keep working — no app-side data
-- migration needed. The gateway's getTierCandidates query is updated
-- to filter on this column.

ALTER TABLE tier_routes
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true;
