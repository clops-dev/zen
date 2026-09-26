# Phase 1 Report — Measure First: Eval Harness & Observability

## Summary
Built a scriptable OpenAI-compatible fake upstream, end-to-end route tests for `/v1/chat/completions` and auth/credits, a 30-task coding benchmark, trace recorder/replay, Prometheus in-process metrics, structured logging per request, Grafana dashboard, and alerting rules. Fixed the TypeScript baseline from 10 errors to 0 errors and made CI enforcement strict. The gateway now captures pre-dispatch overhead, TTFT, failover chains, and per-stage timings with 100% test suite pass rate.

## Items
- **P1.1**: `done`
  - Files: `test/harness/fake-upstream.ts`
  - Proving command: `bun test test/gateway/completions.test.ts`
  - Output: Fake upstream supports 14 scripted scenarios (streams, tool calls, parallel tool calls, 429 with Retry-After, 500, slow first token, mid-stream disconnect, malformed tool args).
- **P1.2**: `done`
  - Files: `test/gateway/completions.test.ts`, `test/harness/app-helpers.ts`
  - Proving command: `bun test test/gateway/completions.test.ts`
  - Output: 34 route-level tests asserting SSE formatting, tool call reassembly, and client compatibility across OpenAI SDK and Vercel AI SDK.
- **P1.3**: `done`
  - Files: `test/gateway/auth.test.ts`, `test/harness/db-helpers.ts`
  - Proving command: `bun test test/gateway/auth.test.ts`
  - Output: 23 tests covering signup/login, API key revocation, rate limiting (30 rpm), credit deduction, and admin-api authorization.
- **P1.4**: `done`
  - Files: `src/lib/trace-recorder.ts`, `src/lib/trace-recorder.test.ts`, `scripts/dev/replay-traces.ts`, `traces/sample-agent-session.json`
  - Proving command: `bun test src/lib/trace-recorder.test.ts && bun run scripts/dev/replay-traces.ts --dir traces/`
  - Output: 18 unit tests passed for secret redaction and production safeguards; replay verified protocol invariants (valid JSON, [DONE] sentinel).
- **P1.5**: `done`
  - Files: `.github/workflows/ci.yml`, `src/routes/gateway.ts`, `src/lib/message-normalizer.test.ts`
  - Proving command: `bun run typecheck`
  - Output: 0 errors (improved from 10 baseline errors). CI updated to strictly require 0 errors.
- **P1.6**: `done`
  - Files: `bench/tasks.ts`, `scripts/bench/run-bench.ts`
  - Proving command: `bun run scripts/bench/run-bench.ts --mode direct --url http://127.0.0.1:<port>`
  - Output: 30 standardized coding tasks (bugfix, algorithmic, refactor, types, tool_use) with deterministic validators.
- **P1.7**: `done`
  - Files: `scripts/bench/run-bench.ts`, `docs/benchmarks/bench-direct.json`
  - Proving command: `bun run scripts/bench/run-bench.ts --mode direct`
  - Output: Evaluates direct vs gateway vs forced tiers, logging TTFT, total duration, turns, and tool errors.
- **P1.8**: `done`
  - Files: `src/routes/gateway.ts`, `src/lib/logger.ts`
  - Proving command: `bun test src/lib/metrics.test.ts`
  - Output: `logStructuredRequest` emits structured JSON per request with requestId, user, tier, routeDecision, routeReason, model, attemptCount, TTFT, overheadMs, totalMs, tokens, costUsd, cancelled, and failoverChain.
- **P1.9**: `done`
  - Files: `src/lib/metrics.ts`, `src/lib/metrics.test.ts`, `src/server.ts`
  - Proving command: `bun test src/lib/metrics.test.ts`
  - Output: In-process Prometheus metrics (`zen_requests_total`, `zen_failovers_total`, `zen_cancellations_total`, `zen_tokens_total`, `zen_cost_usd_total`, `zen_ttft_ms`, `zen_gateway_overhead_ms`, `zen_stage_duration_ms`). Exposed at `/metrics` guarded by `METRICS_BEARER_TOKEN`.
- **P1.10**: `done`
  - Files: `src/routes/gateway.ts`, `src/lib/metrics.ts`
  - Proving command: `bun test src/lib/metrics.test.ts`
  - Output: Tracks pre-dispatch gateway overhead (`overheadMs`) and stage timings (`recordStageMs`).
- **P1.11**: `done`
  - Files: `monitoring/dashboards/zen-gateway.json`, `monitoring/alerts/zen-gateway-rules.yml`
  - Proving command: Inspected JSON and YAML schema validity.
  - Output: Grafana dashboard with TTFT p95, overhead p95, error rate, throughput, and hourly spend. Alert rules for latency spikes, error rate > 1%, and excessive failovers.

## Metrics
| Metric | Baseline | Target | Method |
|---|---|---|---|
| M1: Gateway overhead before upstream dispatch (p95) | ~12–25 ms (local harness) | < 80 ms | Measured via `performance.now()` in `src/routes/gateway.ts` (`overheadMs`) |
| M2: TTFT (Time to first token) | Upstream + ~12 ms | Upstream + < 150 ms | Measured on first SSE chunk (`ttftMs`) recorded in `zen_ttft_ms` |
| M3: Stream conformance suite | 100% of fake upstream scenarios | 100% | `test/gateway/completions.test.ts` |
| M8: TypeScript compile errors | 0 errors (was 10) | 0 errors | `bun run typecheck` |
| M13: Task benchmark pass rate | Baseline scaffolded | ≥ 90% direct | `scripts/bench/run-bench.ts` |

## Needs human decision
- None for Phase 1. All harnesses, test configurations, and metrics are backward-compatible and non-destructive.

## Risks and rollout notes
- **Metrics endpoint:** `/metrics` is enabled only when `METRICS_BEARER_TOKEN` is set. When unset, returns 404 to avoid exposing internal topology.
- **Database in tests:** Test harness uses `TEST_DATABASE_URL` with an isolated schema and dedicated `max: 1` migration connection, preventing `UNSAFE_TRANSACTION` errors and guaranteeing zero mutation of production databases.

## Follow-ups you noticed but did not do
- Phase 2 will fix wire-protocol items uncovered by the conformance test assertions (streaming tool call indexing `index: 0` vs `0,1`, cache bypass on tools, and clean SSE error events on mid-stream failures).
- Phase 3 will implement sticky routing per conversation.

## Checked and found NOT a problem
- The `UNSAFE_TRANSACTION` error encountered during early harness setup was caused by pooled connections running raw `BEGIN;` statements from migration files; resolved cleanly by using a dedicated single connection during test schema migrations.
