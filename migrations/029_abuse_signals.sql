-- 029_abuse_signals.sql
-- Layered signup-abuse protection: device fingerprinting, risk scoring,
-- grant tombstones, and per-account freeze flags.
--
-- Additive and idempotent. Safe to run from multiple replicas at boot.
-- All PII is hashed before storage. Retention policy: 90 days for signals,
-- indefinite for tombstones (needed for re-registration dedup).

-- 1. Abuse signals — one row per signup or login event.
--    Stores hashes, never raw values. Used for risk scoring.
--    Privacy policy: raw IPs and device IDs are never written to this table;
--    only salted hashes and network-level aggregates. Rows purged after 90 days.
CREATE TABLE IF NOT EXISTS abuse_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        TEXT NOT NULL,        -- 'signup' | 'login' | 'verify_email'
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  canonical_email   TEXT,                 -- dedup key (dots/+tags stripped for gmail)

  -- IP signals — stored as salted HMAC hashes, never raw
  ip_hash           TEXT,                 -- HMAC-SHA256(raw_ip, ABUSE_SALT)
  network24_hash    TEXT,                 -- HMAC-SHA256(x.x.x.0/24, ABUSE_SALT)  [IPv4]
  network64_hash    TEXT,                 -- HMAC-SHA256(x:x:x:x::/64, ABUSE_SALT) [IPv6]

  -- Device signals
  device_id_hash    TEXT,                 -- HMAC-SHA256(device_id, ABUSE_SALT) from X-Zen-Device-ID header
  fingerprint_hash  TEXT,                 -- HMAC-SHA256(coarse UA+OS+lang+tz+screen, ABUSE_SALT)

  -- Outcome
  risk_score        INTEGER NOT NULL DEFAULT 0,
  risk_level        TEXT NOT NULL DEFAULT 'low',  -- 'low' | 'medium' | 'high'
  welcome_granted   BOOLEAN NOT NULL DEFAULT false,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at       TIMESTAMPTZ,
  purge_after       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE INDEX IF NOT EXISTS abuse_signals_user_idx       ON abuse_signals (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_ip_hash_idx    ON abuse_signals (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_net24_idx      ON abuse_signals (network24_hash, created_at) WHERE network24_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_net64_idx      ON abuse_signals (network64_hash, created_at) WHERE network64_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_device_idx     ON abuse_signals (device_id_hash, created_at) WHERE device_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_fp_idx         ON abuse_signals (fingerprint_hash, created_at) WHERE fingerprint_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS abuse_signals_purge_idx      ON abuse_signals (purge_after);
CREATE INDEX IF NOT EXISTS abuse_signals_email_idx      ON abuse_signals (canonical_email) WHERE canonical_email IS NOT NULL;

-- 2. Device grant tombstones — persisted forever.
--    Ensures: at most 1 welcome grant per device_id_hash and per canonical_email_hash,
--    even if the original account is deleted.
--    Also used to freeze credits when a device re-appears under a new account.
CREATE TABLE IF NOT EXISTS grant_tombstones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tombstone_type    TEXT NOT NULL,          -- 'device' | 'email'
  hash_value        TEXT NOT NULL UNIQUE,   -- device_id_hash or canonical_email_hash
  first_user_id     UUID,                   -- original user (may be NULL if deleted)
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tombstone_type, hash_value)
);

CREATE INDEX IF NOT EXISTS grant_tombstones_hash_idx ON grant_tombstones (hash_value);
CREATE INDEX IF NOT EXISTS grant_tombstones_type_hash_idx ON grant_tombstones (tombstone_type, hash_value);

-- 3. Flagged accounts — used by admin Suspicious tab.
--    Written by the risk scorer; cleared by admin approve/freeze/suspend actions.
CREATE TABLE IF NOT EXISTS flagged_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_reason   TEXT NOT NULL,         -- human-readable summary of matched signals
  risk_score    INTEGER NOT NULL,
  risk_level    TEXT NOT NULL,         -- 'medium' | 'high'
  signals       JSONB NOT NULL DEFAULT '{}',  -- matched signal details for admin UI
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'frozen' | 'suspended'
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)  -- one active flag per user; ON CONFLICT UPDATE
);

CREATE INDEX IF NOT EXISTS flagged_accounts_status_idx ON flagged_accounts (status, created_at);
CREATE INDEX IF NOT EXISTS flagged_accounts_user_idx   ON flagged_accounts (user_id);

-- 4. credit_freeze column on users — set when re-evaluation detects same device
--    on multiple accounts. Credits cannot be used while frozen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_frozen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_freeze_reason TEXT;

-- 5. welcome_grants: upgrade ip_address to ip_hash for privacy.
--    (Old ip_address column kept for backward compat on existing rows; new rows use ip_hash.)
ALTER TABLE welcome_grants ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE welcome_grants ADD COLUMN IF NOT EXISTS device_id_hash TEXT;
