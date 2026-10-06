-- Migration 024: Normalize user emails and add case-insensitive unique index.
-- Additive and idempotent: safe to run from multiple replicas at boot.

DO $$
DECLARE
  dup_count INTEGER;
  dup_list TEXT;
BEGIN
  -- 1. Check for duplicates when compared case-insensitively with lower(trim(email))
  SELECT count(*), string_agg(lem, ', ') INTO dup_count, dup_list
  FROM (
    SELECT lower(trim(email)) AS lem
    FROM users
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  ) dups;

  -- 2. Handle duplicates safely: report them without deleting data
  IF dup_count > 0 THEN
    RAISE WARNING 'Duplicate emails detected in users table (% group(s): %). Skipping lower(email) unique index creation and email rewrite to prevent data loss. Resolve duplicates manually.', dup_count, dup_list;
  ELSE
    -- 3. In-place update existing non-normalized emails
    UPDATE users
    SET email = lower(trim(email))
    WHERE email != lower(trim(email));

    -- 4. Create unique index on lower(email)
    CREATE UNIQUE INDEX IF NOT EXISTS users_lower_email_idx ON users (lower(email));
  END IF;
END $$;
