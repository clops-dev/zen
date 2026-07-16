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
  Requests. All server-rendered forms, no client JS.
- `src/routes/web.ts` — login, signup, and the per-user dashboard (their own
  tier/usage/API keys).

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
