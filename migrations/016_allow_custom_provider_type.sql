-- Migration 016: Allow 'custom' as a valid provider_type.
--
-- Why this migration exists:
-- Drops and recreates providers_provider_type_valid CHECK constraint to include 'custom'.

BEGIN;

ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_provider_type_valid;

ALTER TABLE providers
  ADD CONSTRAINT providers_provider_type_valid
  CHECK (provider_type IN ('openai-compatible', 'anthropic-compatible', 'custom'))
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_provider_type_valid;

COMMIT;
