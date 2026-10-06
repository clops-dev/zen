-- Migration 025: RFC 8628 OAuth 2.0 Device Authorization Grant enhancements
-- Additive and idempotent: safe to run from multiple replicas at boot.

ALTER TABLE device_auth_requests
  ADD COLUMN IF NOT EXISTS user_code TEXT,
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS poll_interval INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS poll_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS user_confirmed_at TIMESTAMPTZ;

-- Update status check constraint to include 'claimed'
DO $$
BEGIN
  ALTER TABLE device_auth_requests DROP CONSTRAINT IF EXISTS device_auth_requests_status_check;
  ALTER TABLE device_auth_requests ADD CONSTRAINT device_auth_requests_status_check
    CHECK (status IN ('pending', 'approved', 'claimed', 'expired'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- Fast unique lookup on user_code
CREATE UNIQUE INDEX IF NOT EXISTS device_auth_user_code_idx
  ON device_auth_requests (user_code) WHERE user_code IS NOT NULL;

-- Index for pending device requests per IP
CREATE INDEX IF NOT EXISTS device_auth_ip_status_idx
  ON device_auth_requests (ip_address, status);
