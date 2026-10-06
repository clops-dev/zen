-- 027_anti_abuse.sql
-- Email verification, welcome-grant dedup, and auth rate-limiting tables.
-- Additive and idempotent. Safe to run from multiple replicas at boot.

-- 1. Email verification tokens
--    Single-use, hashed, 24 h TTL.
CREATE TABLE IF NOT EXISTS email_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx  ON email_verifications (user_id) WHERE NOT used;
CREATE INDEX IF NOT EXISTS email_verifications_token_idx ON email_verifications (token_hash) WHERE NOT used;
CREATE INDEX IF NOT EXISTS email_verifications_expires_idx ON email_verifications (expires_at);

-- 2. Track which canonical emails / IPs have already claimed the welcome bonus
--    to prevent multi-account farming.
CREATE TABLE IF NOT EXISTS welcome_grants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_email  TEXT NOT NULL,    -- gmail-style canonical (dots/+tags stripped)
  ip_address       TEXT NOT NULL,    -- raw IP (not hashed — needed for window checks)
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS welcome_grants_canonical_email_idx ON welcome_grants (canonical_email);
CREATE INDEX IF NOT EXISTS welcome_grants_ip_idx ON welcome_grants (ip_address, granted_at);

-- 3. Per-endpoint auth rate limiting with lockout
--    One row per (key_type, key_value) e.g. ('ip', '1.2.3.4') or ('email', 'user@example.com')
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_type      TEXT NOT NULL,        -- 'ip' | 'email'
  key_value     TEXT NOT NULL,        -- the IP or normalised email
  endpoint      TEXT NOT NULL,        -- 'signup' | 'login' | 'verify_email' | 'password_reset'
  attempt_count INTEGER NOT NULL DEFAULT 1,
  locked_until  TIMESTAMPTZ,          -- NULL = not locked
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_type, key_value, endpoint)
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_lookup_idx ON auth_rate_limits (key_type, key_value, endpoint);
CREATE INDEX IF NOT EXISTS auth_rate_limits_cleanup_idx ON auth_rate_limits (updated_at);

-- 4. email_verified column on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- 5. canonical_email column for uniqueness dedup (stores gmail-normalised form)
ALTER TABLE users ADD COLUMN IF NOT EXISTS canonical_email TEXT;

-- Backfill canonical_email from email (we'll normalise properly in code)
UPDATE users SET canonical_email = email WHERE canonical_email IS NULL;

-- Index for fast canonical lookup (not UNIQUE yet — handled in code with conflict detection)
CREATE UNIQUE INDEX IF NOT EXISTS users_canonical_email_idx ON users (canonical_email) WHERE canonical_email IS NOT NULL;

-- 6. Password reset tokens (single-use, hashed, short-lived)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour')
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx   ON password_reset_tokens (user_id) WHERE NOT used;
CREATE INDEX IF NOT EXISTS password_reset_tokens_token_idx  ON password_reset_tokens (token_hash) WHERE NOT used;
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens (expires_at);
