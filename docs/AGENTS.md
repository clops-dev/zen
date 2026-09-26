# AGENTS.md — Zen Gateway (read this before every task)

## What this project is
A standalone AI gateway: an OpenAI-compatible `/v1` API in front of many upstream providers, with complexity-tier routing, cross-model fallback, per-user prepaid credits, API keys, an admin SPA (`/admin2`) and a user portal SPA (`/zencode`). The goal of the current program of work is **Cursor-grade behavior** (stable model within a conversation, correct streaming and tool calls, low latency, no silent failures, working embeddings and autocomplete).

The plan lives in `docs/ROADMAP.md`. Items have IDs like `P2.3`. Each phase has its own prompt file. You are executing exactly one phase per session.

## Stack
Bun 1.3.14 · Hono 4 · TypeScript · `postgres` (postgres-js) against Neon (pool `max: 10`, `prepare: false`) · Vercel AI SDK `ai@^7` with `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` · zod 3 · bcryptjs · gpt-tokenizer (cl100k) · HAProxy in front · Docker/Compose.

## Repo map (names may drift; grep before assuming)
| Path | Role |
|---|---|
| `src/index.ts` | Boot: migrations, admin bootstrap, `Bun.serve`, graceful shutdown, idle timeout |
| `src/server.ts` | Hono app assembly, `/livez` `/readyz` `/healthz` `/version`, SPA serving |
| `src/routes/gateway.ts` | `/v1/chat/completions` (separate stream / non-stream fallback loops), `/v1/models`, `/v1/embeddings` (**stub returning zero vectors**), `/v1/embedding-models` |
| `src/routes/auth.ts`, `device-auth.ts`, `google-auth.ts`, `web.ts`, `user-api.ts` | Auth, device pairing, portal API |
| `src/routes/admin-api.ts` | Admin API (~2.1k lines, CRLF line endings) |
| `src/lib/complexity.ts` | Keyword classifier over the **last message only** |
| `src/lib/routing.ts` | `pickRoute`, tier walk, weighted random pick, **provider-level** health/breaker stored in Postgres (`reportRouteOutcome`) |
| `src/lib/ai-call.ts` | (~1.8k lines) AI SDK calls, SSE construction, 4 stream timers, `classifyProviderError` → `continue | skip_candidate | break_loop`, Anthropic prompt caching |
| `src/lib/message-normalizer.ts` | Rewrites incoming history (drops empty assistant turns, orphan tool results) |
| `src/lib/tokens.ts` | Token estimate using cl100k for every model |
| `src/lib/cache.ts` | Exact-match response cache in Postgres |
| `src/lib/quota.ts`, `credits.ts`, `pricing.ts` | Billing (DT credits; `DT_PER_USD`) |
| `src/lib/db.ts`, `migrate.ts` | Pool config; runs `migrations/*.sql` at boot |
| `src/lib/session.ts`, `password.ts`, `apikeys.ts` | HMAC cookie session (30 d, role inside), bcryptjs, sha256 API-key hashes |
| `src/middleware/*` | `api-key`, `rate-limit` (Postgres-backed, keyed by user+IP), `session-auth`, `request-id` |
| `migrations/001…020` | Applied migrations. **Never edit.** New ones start at `021` |
| `admin/`, `zencode/` | React SPAs (built with Vite) |
| `haproxy.cfg`, `docker-compose*.yml`, `Dockerfile`, `.github/workflows/ci.yml` | Deploy and CI |

## Current `/v1/chat/completions` lifecycle
`requireApiKey` (2 queries) → `rateLimit` (1 upsert) → zod parse (drops unknown params) → `checkQuota` (2 aggregate queries) → `classifyComplexity` → response-cache lookup (1–2 queries) → `countInputTokens` → `pickRoute` (1–5 queries) → `callStreaming` / `callNonStreaming` in a fallback loop (max 10 attempts) → background writes (usage, request log, credit deduction tx, provider outcome, cache set).

## Baseline facts (from a read-only audit; **verify before fixing**)
- All 170 tests are in `src/lib/*.test.ts`. There are none for routes or middleware.
- CI typecheck tolerates a baseline of 10 `tsc` errors (mostly `gateway.ts`).
- The audit was read-only. Any finding marked "by reading" in the roadmap must be **reproduced with a failing test first**. If you cannot reproduce it, say so in your report instead of "fixing" it.

## Hard rules
1. **Secrets:** never print, log, echo, commit or paste secret values (DB URLs, API keys, session secrets, passwords). Do not open `.env*` files. If you find a secret, report its file and line only.
2. **No irreversible or external actions without an explicit human "yes" in this session:** force-push, history rewrite (`git filter-repo`, BFG), deleting branches, dropping tables/columns, deleting data, rotating or revoking credentials, changing provider dashboards, sending email, deploying. Prepare the commands and a runbook instead.
3. **Never touch production.** Use the local Postgres from `docker-compose.dev.yml` and fake upstreams. Never run scripts in `scripts/` against a real `DATABASE_URL`.
4. **Migrations:** additive, idempotent, numbered `021+`, safe to run on every boot from several replicas. No destructive DDL. If a migration needs a human decision (for example, deduplicating rows), write the detection query and stop.
5. **Wire compatibility:** the `/v1` API must remain OpenAI-compatible. Don't break existing clients. Changes that alter response shapes need a test proving the old shape still works or a documented deprecation.
6. **Test first for bugs:** write a failing test, then the fix. Run the full suite before each commit.
7. **Small, traceable commits:** one roadmap item per commit, message `P2.1: <what>`. Don't mix refactors with behavior changes.
8. **No unrelated refactors** and no new dependencies without a one-line justification in the commit message. Prefer Bun/Node built-ins.
9. **Checkboxes:** tick an item in `docs/ROADMAP.md` only after you ran the command or test that proves its acceptance criterion, and paste the command in the report.
10. **If blocked or a decision is needed** (provider choice, pricing, product behavior), stop that item, record it under "Needs human decision", and continue with other items.
11. **Do not weaken** existing tests, timeouts, or security checks to make something pass.

## Commands
```bash
bun install --frozen-lockfile
bun run typecheck                 # count errors; never let the count go up
bun run test                      # sets short upstream timeouts, then `bun test`
bun test path/to/file.test.ts     # single file (export the timeout env vars from package.json's test script)
docker compose -f docker-compose.dev.yml up -d   # local Postgres for tests
bun run start                     # boots gateway on :8787
cd admin && bun run build         # admin SPA
```

## Session protocol (every phase)
1. Read this file, the phase prompt, and the matching section of `docs/ROADMAP.md`.
2. Record the baseline: `tsc` error count, test count and pass/fail, and any failing test you did not cause.
3. Create a branch `phase-<n>-<slug>`.
4. Work item by item: failing test → fix → suite green → commit.
5. Run the phase gate (acceptance commands in the phase prompt).
6. Write `docs/reports/phase-<n>.md` using the report format below. Do not merge. Do not push unless told to.

## Report format (`docs/reports/phase-<n>.md`)
- **Summary** (5 lines max)
- **Items** — for each ID: `done | partial | blocked | not reproducible`, files changed, the proving command and its output summary
- **Metrics** — before/after for any target metric you measured, with the method
- **Needs human decision**
- **Risks and rollout notes** (config/env changes, migrations, order of deploy)
- **Follow-ups you noticed but did not do**
- **Checked and found NOT a problem** (so the audit claim can be corrected)
