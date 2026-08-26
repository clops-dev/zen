# zen-gateway

A standalone AI gateway: web login for your users, an admin dashboard to add
any OpenAI-compatible provider (OpenRouter, Groq, local Ollama, or anything
listed on [models.dev](https://models.dev)), complexity-based model routing
with fallback, per-user quotas, and API keys for CLI/machine access.

Comfortably supports ~100 users with the default settings below — no special
scaling work needed at that size.

## 1. Install

```bash
bun install
```

## 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:
- `DATABASE_URL` — your Postgres connection string.
- `SESSION_SECRET` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your admin login. Created automatically
  on first boot if no admin exists yet. Change the password via Postgres
  directly if you ever need to reset it (there's no "forgot password" flow
  in v1 — this is a single-operator tool, not a public SaaS yet).

No RSA keys, no separate JWT setup — this uses signed session cookies for the
web dashboard and simple API keys for machine access, both only needing
`SESSION_SECRET`.

## 3. Run

```bash
bun run start
```

First boot output should look like:
```
[migrate] applied 1 migration(s): 001_init.sql
[bootstrap] created admin account: you@example.com
[bootstrap] log in at /login with the ADMIN_EMAIL/ADMIN_PASSWORD from your .env
zen-gateway listening on :8787
```

## 4. Log in and add a provider

1. Open `http://localhost:8787/login`, log in with your admin credentials.
2. Go to **Providers** → add one. Any OpenAI-compatible chat completions
   endpoint works:

   | Provider | base_url | api_key |
   |---|---|---|
   | OpenRouter | `https://openrouter.ai/api/v1` | your OpenRouter key |
   | Groq | `https://api.groq.com/openai/v1` | your Groq key |
   | Local Ollama | `http://localhost:11434/v1` | leave blank |
   | Anything on models.dev | check the site for the base URL | as required |

3. Go to **Models** → register a specific model on that provider (the exact
   model id the provider's API expects — check models.dev or the provider's
   own docs). Fill in pricing here too; it feeds the cost tracking directly.
4. *(Optional)* Go to **Routing** → map complexity tiers to models. **You can
   skip this entirely at first** — with zero routes configured, the gateway
   falls back to any one enabled model, so you can verify everything works
   end-to-end before tuning which model handles what.

## 5. Create a real user and test

1. Open `http://localhost:8787/signup`, create a normal (non-admin) account.
2. Log into `/dashboard`, click **Create API key**, copy it — shown once.
3. Test the gateway directly:
   ```bash
   curl -X POST http://localhost:8787/v1/chat/completions \
     -H "Authorization: Bearer zen_xxxxx" \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
   ```
   Check the **Requests** tab in `/admin` — confirm a row shows up with
   `status: success` and the model you expect.
4. Try something complex ("build me a rest api with auth and a postgres
   backend") and confirm — once you've set up Routing — it lands on a
   different, pricier model. Check `reasons` behavior by watching which tier
   things land in over a few real prompts; the classifier in
   `src/lib/complexity.ts` is heuristic, tune `CODE_TASK_KEYWORDS` there
   against your real traffic.

## 6. Point your CLI at it

Your CLI needs three things: a base URL, an API key, and to speak the
OpenAI-compatible chat completions shape (which it already does).

**Base URL:** `http://localhost:8787/v1` (or your deployed URL).
**Auth:** `Authorization: Bearer <api key from step 5>` — a static header,
no login/refresh flow needed for the CLI.

If your CLI uses the OpenAI SDK or an OpenAI-compatible client config
(most coding CLIs do), it's typically one of:

```bash
# env vars, if your CLI reads these
export OPENAI_API_BASE="http://localhost:8787/v1"
export OPENAI_API_KEY="zen_xxxxx"
```

or a config file entry, e.g.:
```json
{
  "provider": {
    "baseURL": "http://localhost:8787/v1",
    "apiKey": "zen_xxxxx"
  }
}
```

Check your CLI's actual config format — I don't have that code in front of
me, so this is the general shape, not your exact file. The gateway's
`/v1/chat/completions` and `/v1/models` endpoints match the OpenAI API
shape closely enough that any OpenAI-compatible client should work without
CLI-side changes, since that's the whole point of standardizing on it here.

## What each part does

- `src/lib/complexity.ts` — scores a request as `trivial`/`simple`/`medium`/
  `complex` using keyword/length heuristics. No model call — the point is to
  avoid burning tokens deciding whether to burn tokens.
- `src/lib/routing.ts` — weighted pick across models mapped to a tier, with a
  circuit breaker per provider (3 consecutive failures → marked unhealthy,
  60s cooldown before retrying) and a last-resort fallback to any enabled
  model if nothing's configured for a tier.
- `src/lib/ai-call.ts` — the actual upstream call, via `@ai-sdk/openai-compatible`.
  Wraps the SDK's streaming/non-streaming output back into OpenAI-compatible
  responses so any OpenAI-style client (your CLI included) doesn't need to
  know this gateway exists underneath.
- `src/lib/quota.ts` — per-user monthly token budget, with soft degradation
  (caps which complexity tier you can be routed to as budget runs low,
  rather than a hard cutoff at zero).
- `src/lib/cache.ts` — exact-prompt response cache (1hr TTL). Repeat "hi"s
  cost nothing after the first.
- `src/routes/gateway.ts` — the actual `/v1/chat/completions`/`/v1/models`
  endpoints, tying all of the above together.
- `src/routes/admin.ts` — Overview / Users / Providers / Models / Routing /
  Requests. Server-rendered forms, no client JS.
- `src/routes/web.ts` — login, signup, and the per-user dashboard (their own
  tier/usage/API keys).

## Admin SPA (new)

The `/admin` HTML pages above remain the supported admin surface. In addition,
`/admin2` serves a new React + Tailwind control plane aimed at platform
engineers. It talks to a JSON API at `/admin-api/*` (session-cookie auth,
admin-only). The legacy HTML pages are untouched, so existing flows and
bookmarks keep working.

### Build & run

```bash
cd admin && bun install && bun run build && cd ..
bun run start
```

Then visit `http://localhost:8787/admin2`. The dev loop is `cd admin && bun
run dev` (Vite proxies `/admin-api` and `/v1/auth` to the running backend).

### Sections shipped

* **Dashboard** — 10 metrics (today, totals, success rate, avg latency,
  active providers/models/keys/users/combos, total spend) plus six charts
  (request volume 24h, success/failure ratio, top providers 7d, top models 7d,
  latency p50/p95, provider health cards).
* **Providers** — full CRUD on `providers` with sidecar `provider_meta` for
  the extended fields (organization, region, timeout, retry, rate limit,
  priority, weight, cost multiplier, custom headers). API keys are stored
  server-side; reads return only a `•••• (N chars)` preview, never the raw
  secret. Per-provider "Test connection" reaches `/models`.
* **Models** — registry CRUD with all six capability flags
  (Tools/Vision/JSON/Streaming/Reasoning/Embeddings), pricing, context window,
  enabled toggle, clone, and live ping via `/chat/completions`.
* **Routing** — Tier-by-tier view (Trivial/Simple/Medium/Complex) with
  add/toggle/delete on `tier_routes`. Reads `tier_routes` + joins model +
  provider for display.
* **Combos (NEW)** — the new feature. Bundles providers + models + routing
  strategy + fallback chain + request defaults + rate limits + budget caps.
  Seven starter templates seeded by migration `011_audit_and_combos.sql`
  (Cheapest AI, Premium AI, Coding Assistant, Reasoning Models, Vision
  Models, Local Ollama, Failover Gateway). CRUD + clone + archive + export
  (JSON download) + import (paste JSON) + per-provider test.
* **API Keys** — admin view of every user's `api_keys`. Create / rotate /
  revoke. Raw key shown exactly once after create / rotate via a copyable
  modal. Combo attach on create.
* **Requests** — paginated table over `ai_requests` with status /
  provider / model substring filters.
* **Users** — list, create, inline-edit tier/status, delete. Includes
  active-keys count and lifetime cost.
* **Audit Logs** — `audit_logs` viewer filtered by resource, action, result.
* **Settings** — runtime summary (active counts) + env exposure.

### New endpoints (`/admin-api/*`)

All admin-only via the existing `requireAdmin()` middleware. Every mutating
endpoint emits an `audit_logs` row.

```
GET    /admin-api/me                              current admin user
GET    /admin-api/dashboard/overview              metrics + chart series
GET    /admin-api/dashboard/providers/health      provider health cards

GET    /admin-api/users                           list users
POST   /admin-api/users                           create user
GET    /admin-api/users/:id                       user + usage + keys
PATCH  /admin-api/users/:id                       update role/tier/status
DELETE /admin-api/users/:id                       delete user

GET    /admin-api/providers                       list (api_key masked)
POST   /admin-api/providers                       create
PATCH  /admin-api/providers/:id                   update fields or api_key
POST   /admin-api/providers/:id/toggle            enable/disable
POST   /admin-api/providers/:id/test              live connectivity check
DELETE /admin-api/providers/:id                   delete

GET    /admin-api/models                          list
POST   /admin-api/models                          create
PATCH  /admin-api/models/:id                      update
POST   /admin-api/models/:id/clone                clone with `-copy` suffix
POST   /admin-api/models/:id/toggle               enable/disable
POST   /admin-api/models/:id/test                 live ping via chat/completions
DELETE /admin-api/models/:id                      delete

GET    /admin-api/routing                         list tier_routes joined to model + provider
POST   /admin-api/routing                         upsert route
PATCH  /admin-api/routing/:id                     update tier/weight
POST   /admin-api/routing/:id/toggle              enable/disable
DELETE /admin-api/routing/:id                     delete

GET    /admin-api/requests                        filterable, paginated
GET    /admin-api/requests/:id                    full row

GET    /admin-api/api-keys                        list across all users
POST   /admin-api/api-keys                        create (returns raw key once)
POST   /admin-api/api-keys/:id/revoke             revoke
POST   /admin-api/api-keys/:id/rotate             rotate (returns new key once)

GET    /admin-api/combos                          list
GET    /admin-api/combos/:id                      combo + provider/model join
POST   /admin-api/combos                          create
PATCH  /admin-api/combos/:id                      update
POST   /admin-api/combos/:id/clone                clone as draft
POST   /admin-api/combos/:id/archive              archive
GET    /admin-api/combos/:id/export               JSON export
POST   /admin-api/combos/import                   JSON import
POST   /admin-api/combos/:id/test                 per-provider connectivity
DELETE /admin-api/combos/:id                      delete

GET    /admin-api/audit                           filterable audit log
GET    /admin-api/settings                        runtime summary + env
```

### New tables (migration `011_audit_and_combos.sql`)

* `combos` — slug, name, description, status, `provider_ids uuid[]`,
  `model_ids uuid[]`, `routing_strategy`, `routing_config jsonb`,
  `fallback_chain uuid[]`, `defaults jsonb`, rate-limit / token-cap /
  cost-cap, `allowed_user_ids uuid[]`, `is_template`, `updated_at` trigger.
* `audit_logs` — append-only ledger with `actor_id`, `actor_email`,
  `action`, `resource`, `resource_id`, `ip`, `result`, `metadata jsonb`,
  three indexes (by actor, by resource, by recency).
* `provider_meta` — sidecar table for the extended provider fields the SPA
  edits (`organization`, `region`, `timeout_ms`, `retry_max`,
  `rate_limit_rpm`, `priority`, `weight`, `cost_multiplier`, `headers`),
  so we don't have to ALTER the canonical `providers` schema every time
  the SPA grows.
* `models.supports_streaming / supports_reasoning / supports_embeddings`
  — additive columns; default `true / false / false`.
* `api_keys.combo_id` — nullable FK to `combos(id) ON DELETE SET NULL`,
  lets a key inherit the combo's policy.

Seven starter combo templates are inserted by the migration.

## Known limitations, flagged not fixed

- `providers.api_key` is stored in plaintext in Postgres. Fine for a
  single-operator setup — restrict DB grants or add pgcrypto column
  encryption before giving anyone else DB access.
- No "forgot password" flow, no email verification on signup. Fine for ~100
  known users you're onboarding directly; add these before opening signup to
  the public internet.
- The classifier is unsupervised heuristics, not measured against your real
  traffic yet — expect some misroutes until you tune the keyword list.

## Known limitations, flagged not fixed

- `providers.api_key` is stored in plaintext in Postgres. Fine for a
  single-operator setup — restrict DB grants or add pgcrypto column
  encryption before giving anyone else DB access.
- No "forgot password" flow, no email verification on signup. Fine for ~100
  known users you're onboarding directly; add these before opening signup to
  the public internet.
- The classifier is unsupervised heuristics, not measured against your real
  traffic yet — expect some misroutes until you tune the keyword list.
- No per-model context-window enforcement yet — a very long conversation
  could get routed to a model that can't hold it. Worth adding once you've
  picked real models and know their context windows (register them via the
  `context_window` field in Models — the field exists, just isn't checked
  against message length yet).
- Rate limiting is per-user, Postgres-backed, 30 req/min by default
  (`src/routes/gateway.ts`) — adjust if that's wrong for your traffic shape.

---

## Production Operations

This section covers operating Zen Gateway in a production Docker/Compose environment.

### Architecture

```
                    Load Balancer (nginx / HAProxy / Caddy)
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
          Gateway VM1             Gateway VM2        (stateless replicas)
               │                       │
               └───────────┬───────────┘
                           ▼
                    Neon PostgreSQL                  (cloud-managed)
                           │
                      AI Providers
                    (OpenRouter, Groq, …)
```

**Database**: Production uses [Neon](https://neon.tech) managed PostgreSQL.
The `postgres:` service in `docker-compose.yml` is for **local development only**.

---

### Build

Build the Docker image with a deterministic tag:

```bash
# Build with git SHA + version (recommended for production)
GIT_SHA=$(git rev-parse --short HEAD)
VERSION=$(node -p "require('./package.json').version")

docker build \
  --build-arg VERSION="${VERSION}" \
  --build-arg GIT_SHA="${GIT_SHA}" \
  -t zen-gateway:${GIT_SHA} \
  -t zen-gateway:${VERSION} \
  .

# Verify the image was built correctly
docker inspect zen-gateway:${GIT_SHA} --format='{{.Config.User}}'
# Expected: bun  (non-root)
```

> **CI builds this automatically.** The CI pipeline (`.github/workflows/ci.yml`)
> tags every successful build with the git SHA and runs Trivy security scanning
> before the image is considered safe to deploy.

---

### Run

**Local development (with local Postgres):**

```bash
# Copy and fill in your config
cp .env.example .env.production
# Edit .env.production with real values

docker compose up
```

**Production (with Neon):**

```bash
# .env.production must contain your Neon DATABASE_URL
# Start gateway only — skip the local postgres service
docker compose up gateway
```

**With a pinned registry image (recommended for staging/prod):**

```bash
# Create an override file
cat > docker-compose.prod.yml <<EOF
services:
  gateway:
    image: ghcr.io/clops-dev/zen-gateway:abc1234   # replace with your SHA
    build: !reset null
EOF

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

### Stop

Graceful shutdown respects in-flight requests:

```bash
# Graceful stop — sends SIGTERM, waits up to 30s for drain, then SIGKILL
docker compose stop

# Or for a single container:
docker stop zen-gateway   # respects SHUTDOWN_DRAIN_MS (default: 25s)
```

**What happens on `docker stop`:**

```
docker stop
    ↓
SIGTERM received by Bun process
    ↓
Mark not-ready (/readyz returns 503 immediately)
    ↓
Sleep SHUTDOWN_DRAIN_MS (default 25s) — in-flight requests complete
    ↓
server.stop(true)  — close HTTP server
    ↓
sql.end()          — close Postgres pool (5s timeout)
    ↓
process.exit(0)
```

If a **second signal** arrives during the drain (e.g. operator impatience),
the process exits immediately with code 1.

> **Note**: Graceful shutdown behaviour is implemented in `src/index.ts` and
> verified by code review. Runtime validation on Linux requires Docker, which
> is not available in this environment — see Phase 2 Blocked Tests.

---

### Logs

```bash
# Follow structured JSON logs
docker compose logs -f gateway

# Last 100 lines
docker compose logs --tail=100 gateway

# Parse with jq (install separately)
docker compose logs -f gateway | jq -r '. | "\(.time) [\(.level)] \(.msg)"'

# Filter by level
docker compose logs -f gateway | jq 'select(.level == "error")'

# Filter by request ID (for debugging a specific request)
docker compose logs gateway | jq 'select(.request_id == "YOUR_REQUEST_ID")'
```

Log format (structured JSON, one line per event):

```json
{
  "time": "2026-08-19T12:00:00.000Z",
  "level": "info",
  "msg": "http_request",
  "env": "production",
  "service": "zen-gateway",
  "version": "1.0.0",
  "git_sha": "abc1234",
  "request_id": "a1b2c3d4...",
  "method": "POST",
  "path": "/v1/chat/completions",
  "ip": "10.0.0.1"
}
```

---

### Health

| Endpoint | Purpose | DB check | Used by |
|----------|---------|----------|---------|
| `/livez` | Liveness — process is alive | ❌ No | Docker healthcheck, orchestrator restart |
| `/readyz` | Readiness — can serve traffic | ✅ Yes | Load balancer traffic gate |
| `/healthz` | Legacy (backward compat) | ✅ Yes | Existing operators |
| `/version` | Build metadata | ❌ No | Ops verification after deploy |

**`/livez`** — Always returns `200 OK` if the process is running:
```json
{"ok": true, "timestamp": "2026-08-19T12:00:00.000Z"}
```

**`/readyz`** — Returns `200 OK` when ready, `503` when draining or DB is down:
```json
{"ready": true, "db": "ok", "timestamp": "2026-08-19T12:00:00.000Z"}
```
```json
{"ready": false, "reason": "draining_for_SIGTERM", "db": "unknown", "timestamp": "..."}
```

**`/version`** — Build identity for post-deploy verification:
```json
{
  "name": "zen-gateway",
  "version": "1.0.0",
  "git_sha": "abc1234",
  "node_env": "production",
  "bun": "1.3.14",
  "timestamp": "2026-08-19T12:00:00.000Z"
}
```

**`/healthz`** — Legacy endpoint, DB-coupled. Kept for backward compatibility.
New tooling should use `/readyz` instead.

---

### Configuration

All configuration is via environment variables. Set these in `.env.production`
(gitignored) or inject via your orchestrator.

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (Neon URL in production) | `postgresql://user:pass@host/db?sslmode=require` |
| `SESSION_SECRET` | ≥32-char hex string for cookie signing | `openssl rand -hex 32` |
| `ADMIN_EMAIL` | Bootstrap admin account email | `admin@yourdomain.com` |
| `ADMIN_PASSWORD` | Bootstrap admin password (≥8 chars) | `change-me-on-first-login` |

> ⚠️ `ADMIN_PASSWORD` is only used on first boot to create the admin account
> if no admin exists yet. After first login, change it via the dashboard.

#### Optional — AI Provider Bootstrap

These are convenience env vars for first-boot key seeding.
The admin dashboard is the source of truth once keys are set.

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Copied into the OpenRouter provider row on first boot if the row has no key yet |
| `ANTHROPIC_AUTH_TOKEN` | Copied into the agentrouter (Anthropic-compatible) provider row on first boot |
| `AGENTROUTER_API_KEY` | Copied into the agentrouter (OpenAI-compatible) provider row on first boot |
| `ANTHROPIC_BASE_URL` | Override base URL for the Anthropic-compatible agentrouter (default: `https://agentrouter.org`) |

#### Optional — Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | HTTP listen port |
| `LOG_LEVEL` | `info` | Log verbosity: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `BCRYPT_COST` | `12` | bcrypt cost factor for password hashing (4–15) |
| `DEFAULT_FREE_TOKEN_BUDGET` | `50000` | Monthly token budget for new free-tier users |
| `SHUTDOWN_DRAIN_MS` | `25000` | How long (ms) to drain in-flight requests after SIGTERM |
| `APP_URL` | `http://localhost:8787` | Public URL sent as `HTTP-Referer` to OpenRouter |
| `WEB_URL` | _(derived)_ | Public web URL for device auth verification links |
| `CORS_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated CORS origins for the admin SPA |

#### Optional — Upstream Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `UPSTREAM_TIMEOUT_MS_NON_STREAMING` | `30000` | Per-call deadline for non-streaming requests (ms) |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | TCP+TLS connect budget for streaming requests (ms) |
| `UPSTREAM_FIRST_TOKEN_TIMEOUT_MS` | `120000` | Time from request start to first token in stream (ms) |
| `UPSTREAM_IDLE_TIMEOUT_MS_STREAMING` | `120000` | Max silence between chunks in a stream (ms) |
| `UPSTREAM_MAX_STREAM_DURATION_MS` | `600000` | Hard max for any stream regardless of chunk activity (ms) |

#### Production-only

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Must point to Neon (or another managed PG) in production, not the local Compose PG |
| `NODE_ENV` | Set to `production` in the Dockerfile; do not override |
| `VERSION` + `GIT_SHA` | Set at Docker build time via `--build-arg`; do not override at runtime |

#### Development-only

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Can point to `postgresql://zen:zen@localhost:5432/zen` (local Compose PG) |
| `LOG_LEVEL=debug` | Verbose logging, includes stack traces in error logs |

---

### Database

**Production:** Zen Gateway uses [Neon](https://neon.tech) managed PostgreSQL.

**Migrations:** Run automatically on every boot via `src/lib/migrate.ts`.
The migration runner is idempotent — it tracks applied migrations in a
`schema_migrations` table and skips already-applied ones.

```
[migrate] applied 3 migration(s): 001_init.sql, 002_..., 003_...
```

Migration files live in `migrations/`. They are copied into the Docker image
and run by the gateway process on startup — you do not need a separate
migration step in your deploy pipeline.

**Local Postgres** (development only):

```bash
# Start local PG only
docker compose up postgres -d

# Connect with psql
docker exec -it zen-postgres psql -U zen -d zen

# Run migrations manually (requires a running gateway or bun env)
DATABASE_URL=postgresql://zen:zen@localhost:5432/zen bun run src/index.ts
```

---

### Troubleshooting

**Gateway exits immediately on startup:**

```
[migrate] FAILED: ECONNREFUSED
```

→ Database is not reachable. Check `DATABASE_URL` and ensure Neon/Postgres is up.
The gateway exits with code 1 if migrations fail — this is intentional.

**Gateway starts but `/readyz` returns 503:**

```json
{"ready": false, "reason": "db_unreachable"}
```

→ Migrations succeeded (DB was reachable at boot) but subsequent DB probes are failing.
Check your connection pool limit on Neon and network connectivity.

**`/livez` returns 200 but `/readyz` returns 503 during shutdown:**

This is correct behaviour. SIGTERM marks the gateway not-ready immediately
so the load balancer stops routing new requests. The gateway then drains for
`SHUTDOWN_DRAIN_MS` before exiting.

**Admin SPA (`/admin2`) shows "Built bundle not found":**

The admin SPA is built during `docker build`. If you're running the backend
directly (`bun run start`) without building the admin:

```bash
cd admin && bun install && bun run build && cd ..
bun run start
```

**High memory usage:**

The default limit is 1 GB. If you're handling many concurrent streams, increase
the limit in `docker-compose.yml` under `deploy.resources.limits.memory`.

**Session cookies not working after restart:**

If `SESSION_SECRET` changed, all existing sessions are invalidated. Users will
need to log in again. Keep `SESSION_SECRET` stable across deployments.

---

### Deployment

**Recommended production deployment flow:**

```
1. Push to main branch
       ↓
2. CI runs (GitHub Actions):
   - Secret scan
   - Typecheck
   - Tests
   - Docker build → tagged zen-gateway:<git-sha>
   - Trivy security scan
       ↓
3. (Phase 3) Push image to registry:
   ghcr.io/clops-dev/zen-gateway:<git-sha>
       ↓
4. Deploy to VM:
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d gateway
       ↓
5. Verify deployment:
   curl https://gateway.yourdomain.com/version
   curl https://gateway.yourdomain.com/readyz
       ↓
6. Update load balancer to route traffic to new instance
```

**Rollback:**

```bash
# Tag known-good image for reference
docker tag zen-gateway:<previous-sha> zen-gateway:rollback

# Update the override file to point to the previous SHA
# Edit docker-compose.prod.yml: image: ghcr.io/clops-dev/zen-gateway:<previous-sha>

# Re-deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d gateway

# Verify
curl https://gateway.yourdomain.com/version
```

Rollback is safe because:
1. Migrations are additive (no destructive DDL without careful review)
2. The gateway is stateless (sessions are in cookies, data is in Postgres)
3. Each deployment has an immutable git-SHA tag

---

### Security

- Provider API keys are stored in the Postgres `providers` table (plaintext).
  Restrict DB grants if you give others DB access, or add pgcrypto encryption.
- See `SECURITY.md` for a known credential exposure in the git history
  that requires immediate credential rotation.
