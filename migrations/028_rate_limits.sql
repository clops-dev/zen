-- 028_rate_limits.sql
-- Distributed multi-replica rate limiting (by user and IP independently)
-- and active stream concurrency limits. Additive and idempotent.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

-- Concurrency tracking for active streaming requests
CREATE TABLE IF NOT EXISTS active_stream_slots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS active_stream_slots_key_idx ON active_stream_slots (key, expires_at);
