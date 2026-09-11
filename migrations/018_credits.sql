-- Migration 018: Prepaid credits system.
--
-- Replaces the subscription-tier model for normal users with a
-- prepaid DT-credit system. Key design choices:
--
--   1. user_credits holds the denormalised running balance for fast CLI checks.
--      A CHECK constraint ensures balance never goes negative at the DB level.
--
--   2. credit_transactions is the immutable ledger — one row per event.
--      balance is always derivable from SUM(amount_dt) but the denormalised
--      user_credits row is the authoritative fast-path.
--
--   3. Usage deductions are linked back to the ai_requests row so the ledger
--      is fully auditable (every credit consumed maps to a real request).
--
--   4. admin_grant / adjustment rows carry an admin_note and created_by so
--      operators can see exactly who granted what and why.
--
-- Rate: $1 USD of AI tokens = 4 DT  →  1 DT = $0.25 AI usage value.
-- Packages must be multiples of 5 DT (enforced at the application layer).

BEGIN;

-- ---------------------------------------------------------------------------
-- user_credits — one row per user, denormalised balance for fast reads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_credits (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_dt NUMERIC(14, 4) NOT NULL DEFAULT 0
               CHECK (balance_dt >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a zero-balance row for every existing user so the join in credits.ts
-- never misses. New users get their row created in the signup flows.
INSERT INTO user_credits (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- credit_transactions — immutable ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_transactions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Positive = credit added, negative = credit consumed
  amount_dt    NUMERIC(14, 4) NOT NULL,

  -- Transaction origin
  type         TEXT        NOT NULL
                 CHECK (type IN (
                   'purchase',     -- user bought credits via payment
                   'admin_grant',  -- admin manually added credits
                   'usage',        -- AI request consumed credits
                   'refund',       -- reversal of a purchase or usage charge
                   'adjustment'    -- generic admin correction (e.g. promo)
                 )),

  -- Lifecycle for purchase flows; usage/grant are always 'completed'
  status       TEXT        NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),

  -- Payment provider reference (future Stripe PaymentIntent id, etc.)
  payment_ref  TEXT,

  -- Free-text note set by admins on grant / adjustment rows
  admin_note   TEXT,

  -- Links a usage deduction back to the specific AI request
  request_id   UUID        REFERENCES ai_requests(id) ON DELETE SET NULL,

  -- Who created this row (populated for admin_grant / adjustment)
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_tx_user_time_idx ON credit_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_tx_type_idx      ON credit_transactions (type);
CREATE INDEX IF NOT EXISTS credit_tx_status_idx    ON credit_transactions (status);
CREATE INDEX IF NOT EXISTS credit_tx_request_idx   ON credit_transactions (request_id)
  WHERE request_id IS NOT NULL;

COMMIT;
