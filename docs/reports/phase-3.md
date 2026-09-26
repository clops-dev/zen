# Phase 3 report

## Summary

Implemented local conversation affinity, agent-tier routing, alias/catalog metadata, per-model health, bounded fallback, and tokenizer-aware context estimates. Routing now preserves a healthy model pin and re-pins after failover. The Phase 3 unit suite and full repository suite pass. Shadow evaluation was deliberately deferred behind its zero-valued flag.

## Items

- **P3.1 done** — `src/lib/affinity.ts`, `src/lib/routing.ts`, `src/routes/gateway.ts`, `src/lib/routing-affinity.test.ts`; `bun test src/lib/routing-affinity.test.ts` reports 5 pass, including 50/50 pinned turns and a turn-20 429 re-pin.
- **P3.2–P3.3 done** — `src/lib/complexity.ts`, `src/lib/complexity.test.ts`, `src/lib/env.ts`, `src/routes/gateway.ts`; `bun run test` reports agent detection and 64 labeled prompts. Legacy accuracy: 89.1% (57/64); current accuracy: 92.2% (59/64).
- **P3.4–P3.5 done** — `migrations/022_routing_enhancements.sql`, `src/lib/routing.ts`, `src/routes/gateway.ts`, `src/lib/routing-capabilities.test.ts`; aliases are exposed and explicit-model capability failures are precise 400s.
- **P3.6–P3.7 done** — `migrations/022_routing_enhancements.sql`, `src/lib/routing.ts`, `src/lib/ai-call.ts`, `src/lib/routing-health.test.ts`; 429 is model-local and 401 remains provider-wide; retry-after and daily-cap cooldown parsing are covered.
- **P3.8, P3.10 done** — `src/routes/gateway.ts`, `src/lib/ai-call.ts`, `src/lib/env.ts`; default deadline is 60 s, attempts are capped by remaining budget, default attempts are 4, and the error response includes the failover chain.
- **P3.9 done** — migration, admin API, and admin Models form add/edit quality score, max output, FIM support, and tokenizer; router selects quality first and weights only equal-quality candidates.
- **P3.11 partial** — flag is present at default 0; shadow calls intentionally not implemented to avoid unbilled duplicate upstream requests before an internal-cost metric exists.
- **P3.12 done** — `src/lib/tokens.ts`, `src/lib/tokens.test.ts`, `src/lib/routing.ts`, `src/routes/gateway.ts`; o200k/cl100k plus conservative provider multipliers and actionable 413 responses are covered.

## Metrics

- M6 unit benchmark: 100% (50/50) before a forced failure; post-429 turns 21–50 all remained on the re-pinned model.
- Classifier fixture accuracy: 89.1% legacy to 92.2% current, measured by `src/lib/complexity.test.ts`.
- Normalizer benchmark-trace counters and M13 could not be measured: the required Phase 1 benchmark/local integration harness was not configured in this run.

## Needs human decision

- Choose and operate a shared affinity store before using multiple round-robin replicas.
- Decide whether to fund and retain shadow traffic/internal-cost metrics for P3.11.

## Risks and rollout notes

- Apply migration 022 before deploying code; it is additive/idempotent. Repeated-boot verification could not run because Docker is unavailable in this environment.
- Configure HAProxy API-key stickiness only as a temporary per-replica affinity aid; it does not replace shared storage.
- New environment flags are documented in `docs/routing.md`.

## Follow-ups you noticed but did not do

- Integration acceptance tests requiring local Postgres/fake upstreams remain skipped in this environment.
- The local Docker CLI is unavailable, so migration repeated-boot acceptance could not be exercised.
- Run the Phase 1 M13 benchmark and normalizer trace comparison with its configured harness.

## Checked and found NOT a problem

- `bun run typecheck` is clean.
- `bun run test` completed with 224 pass, 57 skipped, and 0 failures.
