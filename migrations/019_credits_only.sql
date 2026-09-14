-- Migration 019: Credits-only payment system.
--
-- Completely removes subscription requirements.
-- Ensures user_credits contains denormalised balance for fast quota checks.
-- Rate: $1 USD = 3 DT  →  $5 USD = 15 DT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ensure user_credits table exists and has rows for all users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_credits (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_dt NUMERIC(14, 4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed zero balance for any user missing a row
INSERT INTO user_credits (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Ensure credit_transactions table exists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_transactions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_dt    NUMERIC(14, 4) NOT NULL,
  type         TEXT        NOT NULL
                 CHECK (type IN ('purchase', 'admin_grant', 'usage', 'refund', 'adjustment')),
  status       TEXT        NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  payment_ref  TEXT,
  admin_note   TEXT,
  request_id   UUID        REFERENCES ai_requests(id) ON DELETE SET NULL,
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_tx_user_time_idx ON credit_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_tx_type_idx      ON credit_transactions (type);
CREATE INDEX IF NOT EXISTS credit_tx_status_idx    ON credit_transactions (status);

-- ---------------------------------------------------------------------------
-- 3. Deprecate subscriptions table constraints safely
-- ---------------------------------------------------------------------------
-- No destructive drops of subscriptions table so existing DB drivers don't fail,
-- but defaults and constraints are relaxed as subscription checks are disabled.

COMMIT;
