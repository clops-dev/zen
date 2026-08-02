-- Lock the providers table to OpenRouter as the single upstream.
-- Multi-model routing across OpenRouter's catalog is still free to use
-- (e.g. tier_routes can map the same OpenRouter provider to many model_ids).
-- What changes: you can no longer add Groq, Ollama, direct-Nvidia, or any
-- other base_url — only https://openrouter.ai/api/v1 is allowed. Even raw
-- INSERTs/UPDATEs that try to set a different base_url are rejected by the
-- CHECK constraint below.
--
-- This file is run inside sql.begin() in migrate.ts so the DO block and
-- ALTER TABLE statements execute as a single transaction.

-- 1. Backfill/update existing rows to point at OpenRouter.
--    If we already have an OpenRouter row (base_url matches), keep its
--    api_key as-is. Otherwise, if any other row has a non-empty api_key,
--    promote it (assume it was an OpenRouter key registered under the
--    wrong base_url). All other rows get the OpenRouter base_url and an
--    empty api_key — the admin will set it via the admin UI or via
--    OPENROUTER_API_KEY on next boot.

DO $$
DECLARE
  openrouter_url  CONSTANT TEXT := 'https://openrouter.ai/api/v1';
  has_existing    BOOLEAN;
  fallback_key    TEXT;
  disabled_count  INTEGER := 0;
  reassigned_count INTEGER := 0;
  disabled_models INTEGER := 0;
  r               RECORD;
BEGIN
  SELECT EXISTS(SELECT 1 FROM providers WHERE base_url = openrouter_url) INTO has_existing;

  -- Pick the best api_key to keep: prefer the one already on an OpenRouter
  -- row, else the first non-empty key from any other row.
  IF has_existing THEN
    SELECT api_key INTO fallback_key FROM providers
      WHERE base_url = openrouter_url AND api_key <> ''
      ORDER BY created_at ASC LIMIT 1;
  END IF;
  IF fallback_key IS NULL OR fallback_key = '' THEN
    SELECT api_key INTO fallback_key FROM providers
      WHERE api_key <> '' AND base_url <> openrouter_url
      ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- Update all rows that are NOT OpenRouter.
  FOR r IN SELECT * FROM providers WHERE base_url <> openrouter_url LOOP
    -- If we have an OpenRouter row already, merge: disable this row and
    -- reassign its models to the existing OpenRouter row. We also
    -- rewrite base_url to the OpenRouter URL so the CHECK constraint
    -- (added below) accepts this row even when disabled.
    IF has_existing THEN
      UPDATE models
         SET provider_id = (SELECT id FROM providers WHERE base_url = openrouter_url ORDER BY created_at ASC LIMIT 1),
             enabled     = false
       WHERE provider_id = r.id;
      UPDATE providers
         SET base_url = openrouter_url,
             enabled  = false
       WHERE id = r.id;
      disabled_count := disabled_count + 1;
    ELSE
      -- No OpenRouter row yet: turn THIS row into one.
      UPDATE providers
         SET base_url = openrouter_url,
             name     = COALESCE(NULLIF(name, ''), 'openrouter'),
             api_key  = COALESCE(NULLIF(fallback_key, ''), api_key)
       WHERE id = r.id;
      has_existing := true; -- so subsequent non-OpenRouter rows are merged
    END IF;
  END LOOP;

  -- If no rows existed at all, insert a stub OpenRouter row so the rest
  -- of the system (admin UI, model registration) has something to anchor
  -- to. Empty api_key is fine — the admin UI or OPENROUTER_API_KEY env
  -- fills it in on next boot.
  IF NOT EXISTS(SELECT 1 FROM providers WHERE base_url = openrouter_url) THEN
    INSERT INTO providers (name, base_url, api_key, enabled)
    VALUES ('openrouter', openrouter_url, '', true);
  END IF;

  -- Disable any model rows whose provider_id is now a disabled provider,
  -- so they don't silently 502 on the next request. (FK still holds
  -- because the provider row exists — just turned off.)
  UPDATE models SET enabled = false
   WHERE provider_id IN (SELECT id FROM providers WHERE enabled = false);

  GET DIAGNOSTICS disabled_models = ROW_COUNT;

  RAISE NOTICE 'openrouter lock-in migration: disabled % non-OpenRouter providers, disabled % orphan models',
    disabled_count, disabled_models;
END $$;

-- 2. Add the CHECK constraint. Done after the backfill so we don't
--    reject the rows we're about to update. NOT VALID first so existing
--    rows aren't re-verified (cheap on large tables), then VALIDATE
--    since we just rewrote them all.
--
--    Idempotent: drop the constraint first if a previous run left it
--    behind (e.g. the run that created it but failed VALIDATE). Without
--    this, retrying the migration after a partial failure errors with
--    "constraint ... already exists" instead of finishing the job.
ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_base_url_openrouter_only;

ALTER TABLE providers
  ADD CONSTRAINT providers_base_url_openrouter_only
  CHECK (base_url = 'https://openrouter.ai/api/v1')
  NOT VALID;

ALTER TABLE providers
  VALIDATE CONSTRAINT providers_base_url_openrouter_only;
