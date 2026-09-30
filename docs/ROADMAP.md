# Zen Gateway — Roadmap & Checklist to Cursor-Grade Behavior

**Repo:** `clops-dev/zen` · **Basis:** source audit of Sept 20, 2026 · **Estimated effort (solo dev):** ~8–10 weeks

## How to read this

Cursor's backend is proprietary, so "full accuracy" can't mean copying it. It means **matching its observable behavior**: a stable model within a session, correct streaming and tool calls, fast first token, no silent failures, and working autocomplete and embeddings. Every target below is measurable. If you can't measure it, you can't claim parity, so the eval harness (Phase 1) comes before the fixes.

Item IDs (`P2.3`) are meant to be copied into GitHub Issues. `[ ]` = todo, `[x]` = done.
Tags: 🔴 blocker · 🟠 high · 🟡 medium · 🟢 nice-to-have.

---

## 0. Target metrics (the definition of "accurate")

| # | Metric | Target | How measured |
|---|--------|--------|--------------|
| M1 | Gateway overhead before upstream dispatch (p95) | < 80 ms | Span timing, warm cache |
| M2 | Time to first token = upstream TTFT + gateway overhead (p95) | upstream + < 150 ms | Load test |
| M3 | Stream conformance with OpenAI SDK, Vercel AI SDK, opencode/kilo client | 100 % of suite | Conformance tests |
| M4 | Tool-call validity (valid JSON args, correct `index`, correct `finish_reason`) | ≥ 99.5 % | Golden traces + live sampling |
| M5 | Parallel tool calls reassembled correctly | 100 % | Conformance tests |
| M6 | Model stickiness inside a conversation (excluding failover) | 100 % | Log audit |
| M7 | Client cancel → upstream abort | < 1 s | Chaos test |
| M8 | Gateway-caused 5xx | < 0.1 % of requests | Metrics |
| M9 | Failover success when primary fails before first token | ≥ 99 % | Chaos test |
| M10 | Credit overdraw per request | 0 (hard reserve) | Billing tests |
| M11 | FIM autocomplete latency (p50 / p95) | < 350 ms / < 800 ms | Load test |
| M12 | Embeddings: non-zero, deterministic, correct dimension | 100 % | Unit + integration |
| M13 | Coding-task pass rate through the gateway vs. calling the best model directly | ≥ 90 % of direct | Task benchmark (Phase 1) |

---

## Phase 0 — Stop the bleeding (Day 0–1) 🔴

Goal: nothing sensitive is exposed and nothing can be abused for free.

- [ ] **P0.1** 🔴 Rotate **every** credential listed in `SECURITY.md`: Neon DB password, `SESSION_SECRET`, both AgentRouter keys, admin password. Rotating comes before any history rewrite.
- [ ] **P0.2** 🔴 Make the repo private now. Public exposure of live credentials is the emergency.
- [ ] **P0.3** 🔴 Purge `.env` from history (`git filter-repo --invert-paths --path .env`), force-push, and have collaborators re-clone.
- [ ] **P0.4** 🔴 Remove `node_modules/` from git (6,778 files, ~134 MB). Verify `.gitignore` works, and delete root scratch files (`test-*.ts`, `check_models.ts`) or move them to `scripts/`.
- [ ] **P0.5** 🔴 Make the CI gitleaks step blocking (remove `continue-on-error`). Add a pre-commit hook (gitleaks or `detect-secrets`).
- [ ] **P0.6** 🔴 Audit the Neon and provider dashboards for use of the leaked credentials (unknown IPs, unexpected spend).
- [ ] **P0.7** 🟠 Add signup protection *immediately*: per-IP throttle, disable the welcome credit until email is verified (or temporarily set it to 0).
- [ ] **P0.8** 🟠 Fix the misleading welcome bonus display (`WELCOME_DISPLAY_USD`).

**Exit criteria:** old credentials are dead, the repo is clean, and no anonymous path grants spendable credit.

---

## Phase 1 — Measure first: eval harness & observability (Week 1) 🔴

Goal: every later change is validated by numbers, not by feel.

### 1A. Conformance & regression tests
- [x] **P1.1** 🔴 Build a **fake upstream** server (OpenAI-compatible) that can script: normal stream, tool call, parallel tool calls, 429, 500, slow first token, mid-stream disconnect, empty output, malformed tool args.
- [x] **P1.2** 🔴 Add route-level tests for `POST /v1/chat/completions` (stream and non-stream) against the fake upstream, run with the **real client libraries**: `openai` Node SDK, Vercel `ai` SDK, and your actual CLI client.
- [x] **P1.3** 🔴 Add tests for auth, rate limit, quota/credits, and signup/login. Today only `lib/` has tests, and none of the gateway route, auth, credits or admin-api is covered.
- [x] **P1.4** 🟠 Record **golden traces** of real agent sessions from the CLI (request bodies, with secrets redacted) and replay them in CI against the fake upstream.
- [x] **P1.5** 🟠 Set the CI typecheck baseline to **0 errors** (fix the 10 known errors in `gateway.ts` and the normalizer test) and add a coverage gate on `routes/` and `middleware/`.

### 1B. Task-level accuracy benchmark
- [x] **P1.6** 🟠 Create a benchmark of 30–50 real coding tasks (edit a file, fix a failing test, multi-file refactor, tool-heavy exploration). Score: pass/fail, number of turns, tool errors.
- [x] **P1.7** 🟠 Run it three ways: best model direct, through the gateway, and through the gateway with the router forced to each tier. Record the baseline (M13).

### 1C. Observability
- [x] **P1.8** 🟠 Emit one structured log line per request with: request id, user, **route decision + reason**, tier, model, attempt count, TTFT, total latency, tokens, cost, cancel flag, failover chain.
- [x] **P1.9** 🟠 Add metrics (Prometheus or OpenTelemetry): TTFT histogram, per-stage latency (auth, rate-limit, quota, cache, routing, upstream), failover count, cancel count, tokens, cost, per-model error rate.
- [x] **P1.10** 🟡 Add tracing spans per stage so you can see the ≥ 7 sequential DB round-trips before dispatch.
- [x] **P1.11** 🟡 Build a dashboard and alerts: TTFT p95, error rate, provider/model health, spend per hour, signup rate.

**Exit criteria:** you have a baseline number for M1–M13 and a red/green CI on protocol behavior.

---

## Phase 2 — Wire-protocol correctness (Week 1–2) 🔴

Goal: any OpenAI-compatible agent client works without workarounds.

### 2A. Streaming and tool calls
- [ ] **P2.1** 🔴 Stream tool calls **incrementally**: first chunk carries `id`, `type: "function"`, `function.name`, `arguments: ""`; later chunks carry argument fragments. Use the SDK's tool-input start/delta/end stream parts (check exact part names against your installed `ai@7`).
- [ ] **P2.2** 🔴 Use a **per-tool-call `index`** (0, 1, 2…) instead of the hard-coded `index: 0`. Add a parallel-tool-call test (M5).
- [ ] **P2.3** 🔴 Emit correct `finish_reason` (`tool_calls`, `stop`, `length`, `content_filter`) on the final chunk.
- [ ] **P2.4** 🟠 Support `stream_options.include_usage`, and always include `usage` in the last chunk when requested.
- [ ] **P2.5** 🟠 Include `id`, `object`, `created`, `model` on **every** chunk, including cache-hit chunks. Replace `chatcmpl-${Date.now()}` with a UUID.
- [ ] **P2.6** 🟠 **Mid-stream errors:** send an OpenAI-style SSE error event followed by `[DONE]` instead of tearing down the connection with `controller.error`.
- [ ] **P2.7** 🟠 Never fail over to another model after the first token has been sent. Fail over only before commit.

### 2B. Cancellation
- [ ] **P2.8** 🔴 Propagate client cancel from the outer `ReadableStream.cancel()` to the inner reader and the upstream `AbortController`. Also handle `c.req.raw.signal`. Verify with a chaos test that upstream aborts in < 1 s (M7).
- [ ] **P2.9** 🟠 Bill only tokens actually generated up to abort, using upstream usage if available and otherwise an estimate.

### 2C. Request parameters (stop silently dropping them)
- [ ] **P2.10** 🔴 Pass through or explicitly reject: `stop`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `n`, `user`, `parallel_tool_calls`, `response_format`, `reasoning_effort` / `reasoning`, `max_completion_tokens`, `logit_bias`. Unknown params should be **passed through or return a clear 400**, never silently stripped.
- [ ] **P2.11** 🟠 Implement `response_format` (`json_object`, `json_schema`) and set `requiresJsonMode` in routing when used. It exists in the router today, but the gateway never sets it.
- [ ] **P2.12** 🟠 Map `max_tokens` / `max_completion_tokens` per model, with a default derived from the model's real max output, not a blanket 16384.
- [ ] **P2.13** 🟡 Reasoning models: stream `reasoning_content`, and for Anthropic extended thinking with tools, preserve thinking blocks (and signatures) across tool turns.
- [ ] **P2.14** 🟡 Vision: validate `image_url` (data URLs, size caps), route to vision-capable models only.

### 2D. Message normalization
- [ ] **P2.15** 🟠 Stop **silently deleting** messages. Repair minimally and log every mutation. Fix the root cause (model hopping, see Phase 3) instead of patching each provider's strictness.
- [ ] **P2.16** 🟡 Don't replay `reasoning` parts as plain assistant text into the next model's context.

### 2E. Response cache
- [ ] **P2.17** 🔴 **Bypass the response cache** whenever `tools` are present, `temperature > 0`, or the request is part of an agent loop.
- [ ] **P2.18** 🔴 If you keep it for simple chat: key on model + tools + params + user/tenant, and never store empty content or tool-call responses.
- [ ] **P2.19** 🟡 Consider dropping the response cache entirely and investing in **provider prompt caching** (Phase 3) and an **embeddings cache** (Phase 6), which are the caches that actually help.

**Exit criteria:** M3, M4, M5, M7 green in CI.

---

## Phase 3 — Routing: consistent model behavior (Week 2–3) 🔴

Goal: the user experiences one coherent assistant per conversation.

- [ ] **P3.1** 🔴 **Sticky routing.** Derive a conversation key (`x-session-id` header if present, otherwise hash of api-key id + system prompt + first user message). Store `conversation → model` in memory (or Redis for multiple replicas) with a ~1 h TTL. Reuse the model on every turn unless it fails.
- [ ] **P3.2** 🔴 Replace the last-message keyword classifier for agent traffic. If `tools` are present, route to the **agent tier** (a tool-capable, strong model) and stop scoring tool output. Keep a cheap classifier only for tool-less one-shot chat.
- [ ] **P3.3** 🔴 Fix the classifier's substring matching (word boundaries) for the tool-less path, and score the last **user** message, not the last message.
- [ ] **P3.4** 🟠 Expose **stable model aliases** in `/v1/models` (`zen/auto`, `zen/fast`, `zen/smart`, `zen/reasoning`, plus explicit ids). Honor an explicit `model`, and if you must substitute after a failure, say so in a response header (`x-zen-model-substituted: true`) and log it.
- [ ] **P3.5** 🟠 Make explicit-model requests go through the **capability checks** (tools, vision, JSON, context) and health checks, not just context.
- [ ] **P3.6** 🟠 **Per-model** circuit breaker, not per-provider. One model's 429 must not take down the whole provider.
- [ ] **P3.7** 🟠 Honor `Retry-After` and parse provider-specific quota errors, including free-tier daily caps, to set cooldowns accurately.
- [ ] **P3.8** 🟠 Add a **total deadline** per request (for example 45–60 s to first token across all fallbacks) instead of up to 10 attempts × 120 s.
- [ ] **P3.9** 🟠 Put a quality score, capability set, context window, max output and price on each model in the catalog. Route by *capability and score*, not just tier and random weight.
- [ ] **P3.10** 🟡 Reduce `MAX_FALLBACK_ATTEMPTS` (10 is excessive) and log the full failover chain (P1.8).
- [ ] **P3.11** 🟡 Shadow-evaluate routes: send a sample of traffic to two models and compare, using the Phase 1 benchmark.
- [ ] **P3.12** 🟡 Use each model's **real tokenizer** (or the provider's count endpoint) for context checks instead of `cl100k` for everything. Keep a safety margin, and return a clear 413.

**Exit criteria:** M6 = 100 %, and M13 does not regress against the Phase 1 baseline.

---

## Phase 4 — Latency (Week 3–4) 🟠

Goal: gateway overhead < 80 ms (M1) with a warm process.

Today's hot path does ≥ 7 sequential DB round-trips before dispatch: API-key lookup, `last_used_at` write, rate-limit upsert, two billing aggregates, cache read, tier queries.

- [ ] **P4.1** 🟠 **Config snapshot in memory:** providers, models, tier routes, capabilities. Refresh every 5–10 s, or invalidate via Postgres `LISTEN/NOTIFY` for multi-replica.
- [ ] **P4.2** 🟠 **API-key cache:** hash → user, TTL 15–30 s. Revoke must invalidate (NOTIFY) or accept the short TTL. Do `last_used_at` updates in batches, not per request.
- [ ] **P4.3** 🟠 **Balance in memory** with async settlement (see Phase 5) instead of two aggregate queries over `ai_requests` and `credit_transactions` per call.
- [ ] **P4.4** 🟠 **Rate limiting in memory** (token bucket per user, per replica) or Redis. Not a Postgres write per request.
- [ ] **P4.5** 🟠 Never `SELECT api_key` in the routing hot path. Resolve the route first, then fetch the decrypted key from an in-memory cache (see P6.7).
- [ ] **P4.6** 🟠 Move all writes off the critical path in batches: usage, request log, route outcome, `last_used`. Buffer and flush every 1–2 s.
- [ ] **P4.7** 🟠 **Co-locate** the gateway and the database in the same region, and use a Neon pooled endpoint. Measure DB RTT and log it. Disable scale-to-zero on the production compute (or keep it warm).
- [ ] **P4.8** 🟡 Raise the pool size deliberately (10 is tiny for many concurrent agents) and set a pool-wait metric.
- [ ] **P4.9** 🟠 **Provider prompt caching:** keep the prompt prefix stable (system prompt + tool definitions first, deterministic ordering), set Anthropic `cache_control` breakpoints on the stable prefix, and rely on sticky routing (P3.1) so caches actually hit. Record cached tokens for billing.
- [ ] **P4.10** 🟡 Replace bcryptjs with native `Bun.password` (argon2id) so logins don't block the streaming event loop.
- [ ] **P4.11** 🟡 Use HTTP keep-alive / connection reuse to upstreams, and consider pre-warming connections to your top providers.
- [ ] **P4.12** 🟢 Load-test with k6 or similar: 100 concurrent agent streams, mixed short and long, then record M1/M2.

**Exit criteria:** M1 and M2 met under load.

---

## Phase 5 — Billing, abuse & auth hardening (Week 4–5) 🟠

### 5A. Billing you can trust
- [ ] **P5.1** 🔴 **Single source of truth:** `user_credits` is authoritative. Remove the derived "purchased − SUM(cost)" gate.
- [ ] **P5.2** 🔴 **Reserve → settle:** before dispatch, atomically `UPDATE user_credits SET balance = balance - :reserve WHERE balance >= :reserve`. The reserve is estimated from input tokens + capped `max_tokens` at the model's prices. After completion, settle: refund the difference or charge the overage.
- [ ] **P5.3** 🟠 Make the ledger **idempotent** with a unique constraint on `request_id` per usage row, so retries and replays can't double-charge.
- [ ] **P5.4** 🟠 Add a nightly reconciliation job: ledger vs. balance vs. upstream invoices.
- [ ] **P5.5** 🟠 Use a proper `NUMERIC` money type and consistent units. Fix the DT/USD comment (4 vs 3) so code and docs agree.
- [ ] **P5.6** 🟡 Add per-user monthly/daily spend caps and an admin alert on anomalies.

### 5B. Abuse resistance
- [ ] **P5.7** 🔴 Signup: email verification, lowercase/normalize emails, disposable-domain blocklist, per-IP throttle, CAPTCHA (Turnstile), and consider granting free credit only after verification or via Google OAuth.
- [ ] **P5.8** 🟠 Rate limits keyed **per user / API key**, not per (user, IP). Trust `X-Forwarded-For` only from your proxy: strip client-supplied values in HAProxy (`http-request del-header X-Forwarded-For`) and set it from `src`.
- [ ] **P5.9** 🟠 Limit **concurrent streams per user** and tokens per minute, not just requests per minute, and raise the request limit for legitimate agent loops (30/min is too low).
- [ ] **P5.10** 🟠 Login throttling and lockout; use a dummy hash for unknown emails so response time doesn't reveal accounts. Make the signup response non-enumerating.
- [ ] **P5.11** 🟡 Wrap user + credits creation in **one transaction** and rely on a unique index on `lower(email)` to close the check-then-insert race.

### 5C. Sessions & secrets
- [ ] **P5.12** 🟠 Session versioning (`token_version` on the user) so demotion, deletion and password change revoke sessions. Read the role from the DB (short cache) rather than trusting the cookie for 30 days.
- [ ] **P5.13** 🟠 **Encrypt provider API keys at rest** (AES-GCM with a master key from the environment or a KMS, with a key id for rotation).
- [ ] **P5.14** 🟡 Add CSRF protection for cookie-authenticated mutating admin endpoints (custom header or double-submit token), even with `SameSite=Lax`.
- [ ] **P5.15** 🟡 Tighten static file serving (`startsWith(dir + path.sep)`) and add security headers (CSP, HSTS, `X-Content-Type-Options`).

**Exit criteria:** M10 = 0, and a scripted signup-farming attempt fails.

---

## Phase 6 — Missing product surface (Week 5–8) 🟠

### 6A. Embeddings (codebase search)
- [ ] **P6.1** 🔴 Replace the stub that returns zero vectors. Options: OpenAI `text-embedding-3-small`, Voyage, or a local model (bge / nomic via Ollama). Until then, return **501** so clients fail loudly.
- [ ] **P6.2** 🟠 Support batching (many inputs per request), the `dimensions` parameter, correct `usage`, per-model dimension in `/embedding-models`, and a **content-hash cache** (this cache is safe and valuable).
- [ ] **P6.3** 🟠 Separate rate limit and billing for embeddings, since indexing a repo is bursty.
- [ ] **P6.4** 🟡 Test: identical inputs give identical vectors, different inputs give non-identical vectors, dimension is correct (M12).

### 6B. Autocomplete (FIM)
- [ ] **P6.5** 🟠 Add `POST /v1/completions` with `prompt` + `suffix`, `stop`, `max_tokens`, streaming. Route to a fast code model that supports fill-in-the-middle.
- [ ] **P6.6** 🟠 Dedicated fast path: no cache lookup, no heavy classification, small timeout, own rate limit. Target M11.
- [ ] **P6.7** 🟡 Handle rapid cancel (client cancels on every keystroke) without leaking upstream requests.

### 6C. Protocol reach
- [ ] **P6.8** 🟡 Add an Anthropic-native `POST /v1/messages` endpoint (with correct streaming events) for clients that speak it.
- [ ] **P6.9** 🟢 Consider the OpenAI Responses API if your clients need it.
- [ ] **P6.10** 🟡 `/v1/models` should return OpenAI-standard fields (`created`, `owned_by`) plus context window, max output, and capabilities.

### 6D. Context & long sessions
- [ ] **P6.11** 🟠 Return a precise, actionable 413 (`context_length_exceeded`, with limits) so the client can compact and retry.
- [ ] **P6.12** 🟡 Optional server-side context helpers: token-count endpoint, and a compaction/summarization endpoint the client can call.

**Exit criteria:** M11 and M12 met, and codebase indexing works end to end from the CLI.

---

## Phase 7 — Engineering hygiene & operations (ongoing) 🟡

- [ ] **P7.1** 🟡 Split `admin-api.ts` (2,111 lines) and `ai-call.ts` (1,828 lines) into modules (`streaming/`, `providers/`, `errors/`, `admin/*`). Normalize line endings (`.gitattributes`).
- [ ] **P7.2** 🟡 Replace hand-built `sql.unsafe` UPDATE builders with a typed helper. Columns are whitelisted today, so this isn't exploitable, but it's fragile.
- [ ] **P7.3** 🟡 Verify migrations take a Postgres **advisory lock** so two replicas booting together can't race. Add a down/rollback story for risky migrations.
- [ ] **P7.4** 🟡 HAProxy: terminate TLS, enable HTTP/2, keep long timeouts for streams, and set proper forwarded headers.
- [ ] **P7.5** 🟡 Deploy strategy: blue/green or canary with automatic rollback on M8 regression. Use feature flags for routing changes.
- [ ] **P7.6** 🟡 Fix doc drift: remove the duplicated README section, remove or implement `CORS_ALLOWED_ORIGINS`, and document the real endpoints and headers.
- [ ] **P7.7** 🟡 Docker: don't ship devDependencies in the runtime image (`bun install --production` in a separate stage).
- [ ] **P7.8** 🟡 Runbooks: provider outage, quota exhaustion, DB failover, credential rotation, abuse spike.
- [ ] **P7.9** 🟢 SBOM and dependency update automation (Renovate/Dependabot).

---

## Client-side items (outside this repo, but they decide the "Cursor feel")

The gateway can only *stop hurting* the experience. These live in the CLI/IDE client (`zencode`). Track them separately:

- [ ] **C1** Codebase indexing: tree-sitter chunking, embeddings via P6.1, a local vector store, and incremental re-indexing on file change.
- [ ] **C2** Reliable **edit application**: search/replace or unified-diff format, plus a fast "apply" step with validation and retry.
- [ ] **C3** Context assembly and **compaction**: relevant files, recent edits, rules files, and summarization when near the context limit.
- [ ] **C4** Checkpoints and undo for every agent step.
- [ ] **C5** Tool sandboxing and permission prompts (terminal, file writes, network).
- [ ] **C6** Diff review UX, inline autocomplete (P6.5), and MCP support.
- [ ] **C7** Send a stable `x-session-id` so the gateway's sticky routing (P3.1) is exact rather than heuristic.

---

## Suggested sprint plan

| Sprint | Focus | Phases |
|--------|-------|--------|
| Day 0–1 | Security emergency | 0 |
| Week 1 | Harness, observability, first protocol fixes | 1, start 2 |
| Week 2 | Protocol correctness + sticky routing | 2, start 3 |
| Week 3 | Routing quality + hot-path latency | 3, 4 |
| Week 4 | Latency finish + billing/abuse | 4, 5 |
| Week 5–6 | Auth hardening + embeddings | 5, 6A |
| Week 7–8 | FIM, Anthropic-native endpoint, context helpers | 6B–D |
| Ongoing | Hygiene, ops, benchmarks | 7 |

## Definition of done: "Cursor-grade v1"

Ship only when **all** are true:

- [ ] Phase 0 complete and credentials rotated.
- [ ] M3, M4, M5, M6, M7 pass in CI on every PR.
- [ ] M1, M2, M8, M9 hold under the load test.
- [ ] M10 = 0 and the signup-farming test fails.
- [ ] M12 passes, and the CLI indexes a real repo through the gateway.
- [ ] M13 ≥ 90 % of direct-to-best-model on the task benchmark.
- [ ] A week of production traffic with no silent failure classes: every failure has a logged reason and a client-visible error.
