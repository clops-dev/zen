-- 026_session_and_account_state.sql
-- Enforce account state, server-side sessions, TOTP MFA, and audit logging.

-- 1. Account status column on users (active, suspended, deleted)
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted'));
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

-- 2. Server-side sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT UNIQUE NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash       TEXT,
  ua_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash) WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- 3. TOTP MFA secrets and recovery codes
CREATE TABLE IF NOT EXISTS user_mfa (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret   TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT false,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_mfa_recovery_codes_user_idx ON user_mfa_recovery_codes (user_id) WHERE NOT used;

-- 4. Audit logs request_id column
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS audit_logs_request_id_idx ON audit_logs (request_id) WHERE request_id IS NOT NULL;
