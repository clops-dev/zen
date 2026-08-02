-- Combos: a reusable AI configuration bundle that ties together
-- providers, models, routing policy, request defaults, rate limits, and
-- budget caps. Combos are stamped onto API keys via api_keys.combo_id,
-- so a key's effective behaviour is "what combo says" unless the key
-- overrides it.
--
-- JSON columns hold structured config that evolves with the product
-- (extra routing strategies, extra limits) without forcing a schema
-- migration every time. The dashboard enforces a shape; the gateway
-- reads them lazily and tolerates unknown keys.
--
-- Idempotency: everything in this file uses IF NOT EXISTS / OR REPLACE
-- patterns so re-running on a partially-applied DB is safe.

CREATE TABLE IF NOT EXISTS combos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived', 'draft')),
  -- Provider ids — referenced as text/uuid arrays so the dashboard
  -- can show combo contents even if a provider row is deleted.
  -- postgres-js + tagged templates needs the ::uuid[] cast to keep the
  -- array element type stable; without it we get "invalid input syntax
  -- for type uuid" when binding a uuid.
  provider_ids    UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  model_ids       UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- Routing policy: 'priority' | 'weighted' | 'round-robin' |
  -- 'cost-optimized' | 'latency-optimized' | 'fallback' | 'health'
  routing_strategy TEXT NOT NULL DEFAULT 'fallback'
                  CHECK (routing_strategy IN
                         ('priority','weighted','round-robin',
                          'cost-optimized','latency-optimized',
                          'fallback','health')),
  -- Per-strategy weight table. JSON keeps the shape flexible
  -- (weighted: [{model_id,weight}]; priority: [{model_id,priority}];
  -- round-robin: ordered array of ids; the others ignore it).
  routing_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallback_chain  UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- Request defaults applied to every request that uses the combo.
  defaults        JSONB NOT NULL DEFAULT
                    jsonb_build_object(
                      'temperature',     0.2,
                      'top_p',           0.95,
                      'max_tokens',      4096,
                      'timeout_ms',      30000
                    ),
  -- Limits & budget
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,
  monthly_token_cap BIGINT NOT NULL DEFAULT 0, -- 0 = uncapped
  monthly_cost_cap_usd NUMERIC(12,4) NOT NULL DEFAULT 0, -- 0 = uncapped
  -- Security: who can use this combo. Empty means any authenticated
  -- user; otherwise a list of user ids whose API keys may attach.
  allowed_user_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- Whether this combo is featured as a starter template.
  is_template     BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS combos_status_idx ON combos (status);
CREATE INDEX IF NOT EXISTS combos_template_idx ON combos (is_template) WHERE is_template;

-- Optional link from api_keys to combos. NULL means "no combo — use
-- per-key settings". Keys created before this migration continue to
-- have combo_id NULL and behave exactly as before.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS combo_id UUID
    REFERENCES combos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS api_keys_combo_idx
  ON api_keys (combo_id) WHERE combo_id IS NOT NULL;

-- audit_logs: append-only record of admin / system actions. Written
-- from src/lib/audit.ts on every successful (and failed) admin
-- mutation + critical system event. Powers the Audit Logs dashboard
-- tab — required for compliance review on a multi-operator gateway.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL actor for system-initiated events (boots, health flips, etc).
  -- Otherwise the user id of whoever made the change.
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,                       -- denormalized: rows outlive their actor
  action      TEXT NOT NULL,              -- e.g. 'provider.create', 'combo.delete'
  resource    TEXT NOT NULL,              -- 'provider' | 'model' | 'routing' | 'combo' | 'api_key' | 'user' | 'system'
  resource_id TEXT,                       -- uuid as text — different resources use different id types
  ip          TEXT,
  result      TEXT NOT NULL DEFAULT 'success'
              CHECK (result IN ('success', 'failure', 'denied')),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common query shapes: by actor (per-user history), by resource (what
-- happened to X?), by time (recent). These cover the Audit Logs
-- filter UI without a full-table scan.
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx
  ON audit_logs (resource, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx
  ON audit_logs (created_at DESC);

-- provider_meta: sidecar table for the extended provider fields
-- (organization, region, timeout_ms, retry_max, rate_limit_rpm,
-- priority, weight, cost_multiplier, headers) that the admin SPA
-- edits. Kept in a separate table so we don't have to ALTER the
-- canonical providers schema every time the SPA adds a field.
-- ON DELETE CASCADE mirrors providers — removing a provider removes
-- its meta. (api) JSONB keeps the shape flexible for future fields.
CREATE TABLE IF NOT EXISTS provider_meta (
  provider_id UUID PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Model capability columns added in 002 are real BOOLEAN columns,
-- not JSONB. The SPA's "Streaming / Reasoning / Embeddings" toggles
-- need explicit columns; safe-default false. Idempotent.
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS supports_streaming   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_reasoning   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_embeddings  BOOLEAN NOT NULL DEFAULT false;

-- Combos: also surface a basic ledger-style audit trail. Recency
-- tuple only — primary read path is "when did this combo last change".
-- We deliberately do NOT add a separate trigger system here; the
-- audit_logs INSERT happens from application code (src/lib/audit.ts)
-- so the UI can render consistent metadata.

-- updated_at trigger for combos so the dashboard can show "edited
-- 3 minutes ago" without comparing values.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS combos_set_updated_at ON combos;
CREATE TRIGGER combos_set_updated_at
  BEFORE UPDATE ON combos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed starter templates — these exercise every routing strategy the
-- UI advertises so the dashboard's "Templates" section is non-empty
-- on first boot. Inserted via ON CONFLICT DO NOTHING so re-applying
-- the migration is a no-op and an admin's edits to the same slug
-- aren't clobbered.
INSERT INTO combos (slug, name, description, status, routing_strategy, is_template, defaults)
VALUES
  ('cheapest-ai',
   'Cheapest AI',
   'Routes every request to the lowest-cost enabled model on the cheapest enabled provider. Good background tier for bulk/casual traffic.',
   'active', 'cost-optimized', true,
   jsonb_build_object('temperature', 0.2, 'top_p', 0.95, 'max_tokens', 2048, 'timeout_ms', 20000)),

  ('premium-ai',
   'Premium AI',
   'Routes exclusively to top-tier models (Claude Opus / GPT-5.x). Reserved for traffic where quality dominates cost.',
   'active', 'priority', true,
   jsonb_build_object('temperature', 0.3, 'top_p', 0.92, 'max_tokens', 8000, 'timeout_ms', 60000)),

  ('coding-assistant',
   'Coding Assistant',
   'Tool-calling capable models with large context windows. Optimised for repo-aware completion and refactor tasks.',
   'active', 'latency-optimized', true,
   jsonb_build_object('temperature', 0.1, 'top_p', 0.9,  'max_tokens', 8192, 'timeout_ms', 45000)),

  ('reasoning-models',
   'Reasoning Models',
   'Strict priority routing to reasoning-tuned models. Higher latency, lower throughput — use for hard problems only.',
   'active', 'priority', true,
   jsonb_build_object('temperature', 0.4, 'top_p', 0.9,  'max_tokens', 16000, 'timeout_ms', 120000)),

  ('vision-models',
   'Vision Models',
   'Vision-capable models only. Filters the registry to models with supports_vision=true at lookup time.',
   'active', 'fallback', true,
   jsonb_build_object('temperature', 0.2, 'top_p', 0.95, 'max_tokens', 4096, 'timeout_ms', 45000)),

  ('local-ollama',
   'Local Ollama',
   'Routes only to providers whose base_url starts with http://, intended for a local Ollama instance. Keeps traffic off the open internet.',
   'active', 'health', true,
   jsonb_build_object('temperature', 0.2, 'top_p', 0.95, 'max_tokens', 4096, 'timeout_ms', 60000)),

  ('failover-gateway',
   'Failover Gateway',
   'Round-robin across all enabled providers and models with an explicit fallback chain. Maximises availability for production traffic.',
   'active', 'fallback', true,
   jsonb_build_object('temperature', 0.2, 'top_p', 0.95, 'max_tokens', 4096, 'timeout_ms', 60000))
ON CONFLICT (slug) DO NOTHING;
