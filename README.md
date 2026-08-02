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
- No per-model context-window enforcement yet — a very long conversation
  could get routed to a model that can't hold it. Worth adding once you've
  picked real models and know their context windows (register them via the
  `context_window` field in Models — the field exists, just isn't checked
  against message length yet).
- Rate limiting is per-user, Postgres-backed, 30 req/min by default
  (`src/routes/gateway.ts`) — adjust if that's wrong for your traffic shape.
