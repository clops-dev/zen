-- Migration 017: Google OAuth support for the Zencode user portal.
--
-- What this does:
--   1. Adds google_id (unique) and avatar_url columns to users.
--   2. Makes password_hash nullable — Google-auth users have no password.
--   3. Enforces a check constraint: every row must have password_hash OR google_id
--      so we can never create a "ghost" account with neither auth method.
--   4. Adds an index on google_id for fast upsert lookups.
--
-- Existing rows (admin + any email/password users) are unaffected: they keep
-- their non-null password_hash and their google_id stays NULL — the constraint
-- is satisfied because password_hash IS NOT NULL for them.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Make password_hash nullable (was NOT NULL in migration 001).
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

-- Safety net: at least one auth method must be present.
ALTER TABLE users
  ADD CONSTRAINT users_has_auth
    CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL);

-- Fast lookup for the OAuth callback upsert.
CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id)
  WHERE google_id IS NOT NULL;

COMMIT;
