-- Pairs a CLI's "zen login" with a browser-based login. The CLI gets a
-- device_code, opens the browser to approve it, then polls until approved.
-- This never becomes a persistent credential itself — once approved, a
-- normal long-lived api_keys row is minted and its raw value is handed to
-- the CLI exactly once via poll, then wiped. No new auth mechanism, just a
-- nicer front door onto the existing api_keys system.
CREATE TABLE IF NOT EXISTS device_auth_requests (
  device_code  TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired')),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  raw_key_once TEXT, -- populated on approval, deleted the instant the CLI's poll picks it up
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS device_auth_requests_expires_idx ON device_auth_requests (expires_at);