CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier                 TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  token_budget_monthly BIGINT NOT NULL DEFAULT 50000,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  renewed_at           TIMESTAMPTZ
);

-- CLI/API auth. Users log into the web dashboard with email+password (session
-- cookie); the CLI authenticates with one of these instead — long-lived,
-- no refresh-token dance needed for a machine client.
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     TEXT UNIQUE NOT NULL,   -- sha256 of the actual key; the raw key is shown once, at creation
  key_prefix   TEXT NOT NULL,          -- first 8 chars, shown in the UI so users can tell keys apart
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked      BOOLEAN NOT NULL DEFAULT false
);

-- One row per configured provider account: a base URL + API key pointing at
-- any OpenAI-compatible chat completions endpoint (OpenRouter, Groq, a local
-- Ollama instance, Together, Fireworks, DeepSeek direct, etc — anything
-- listed on models.dev works here, since @ai-sdk/openai-compatible only
-- needs baseURL + apiKey).
--
-- SECURITY: api_key is stored in plaintext. Fine for a single-operator
-- setup; restrict this table's DB grants or add pgcrypto column encryption
-- before adding other admins.
CREATE TABLE IF NOT EXISTS providers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT UNIQUE NOT NULL,   -- your own label, e.g. "openrouter-main", "groq-key2", "ollama-local"
  base_url             TEXT NOT NULL,          -- e.g. https://openrouter.ai/api/v1, http://localhost:11434/v1
  api_key              TEXT NOT NULL DEFAULT '', -- empty string is valid for providers that don't require one (e.g. local Ollama)
  enabled              BOOLEAN NOT NULL DEFAULT true,
  healthy              BOOLEAN NOT NULL DEFAULT true,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A specific model on a specific provider account.
CREATE TABLE IF NOT EXISTS models (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id            TEXT NOT NULL,   -- the id the provider's API expects, e.g. "llama-3.3-70b-versatile"
  label               TEXT,            -- optional display name
  input_price_per_1m  NUMERIC(10,4) NOT NULL DEFAULT 0,
  output_price_per_1m NUMERIC(10,4) NOT NULL DEFAULT 0,
  context_window      INTEGER,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

-- Which models serve each complexity tier the classifier assigns to an
-- incoming request, and at what weight (for load balancing across models
-- mapped to the same tier).
CREATE TABLE IF NOT EXISTS tier_routes (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier     TEXT NOT NULL CHECK (tier IN ('trivial', 'simple', 'medium', 'complex')),
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  weight   NUMERIC(4,2) NOT NULL DEFAULT 1,
  UNIQUE (tier, model_id)
);

-- Immutable ledger — one row per attempt, including rejected/failed ones.
CREATE TABLE IF NOT EXISTS ai_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip            TEXT,
  model_label   TEXT NOT NULL,   -- "provider_name/model_id", human-readable in logs
  prompt_hash   TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('success', 'failure', 'rejected')),
  reject_reason TEXT,
  from_cache    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_requests_user_id_idx ON ai_requests (user_id);
CREATE INDEX IF NOT EXISTS ai_requests_created_at_idx ON ai_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS monthly_usage (
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month               DATE NOT NULL,
  total_input_tokens  BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cached_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost_usd      NUMERIC(14,8) NOT NULL DEFAULT 0,
  request_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS response_cache (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_hash   TEXT UNIQUE NOT NULL,
  model_label   TEXT NOT NULL,
  response_text TEXT NOT NULL,
  usage_json    JSONB NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS response_cache_expires_at_idx ON response_cache (expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           TEXT NOT NULL DEFAULT 'unknown',
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ip, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_windows_window_idx ON rate_limit_windows (window_start);
