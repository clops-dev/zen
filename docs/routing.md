# Routing

Each chat request is routed in this order:

1. A conversation key is derived from `x-session-id`; when absent it is a SHA-256 hash of API-key id, normalized system prompt, and first user message.
2. The local `ConversationAffinityStore` is checked. A healthy pinned model that meets the request's context and capability requirements wins.
3. Agent traffic (a `tools` request, tool result, or assistant `tool_calls`) uses `AGENT_TIER`; other requests classify the last user message.
4. Candidates are filtered for provider/model health, tools, vision, JSON mode, and usable context.
5. The highest `quality_score` wins; weighted random selection is used only between equally scored candidates.
6. Before first output, failed candidates are recorded in the failover chain and another candidate is tried, subject to `MAX_FALLBACK_ATTEMPTS` and `REQUEST_DEADLINE_MS`.

The in-memory affinity store is a sliding one-hour TTL LRU (10,000 entries by default). It is intentionally per process: with round-robin traffic across N replicas, affinity is only reliable for consecutive requests that reach the same replica. Replace `ConversationAffinityStore` with a shared implementation (for example Redis) before relying on affinity across replicas. As a temporary deployment option, configure HAProxy stickiness by API key; do not use this as a substitute for shared affinity when API keys are shared by several conversations.

## Client-visible headers

- `x-zen-model`: selected provider/model label.
- `x-zen-model-switched: true`: a prior conversation pin could not serve the request and a new model was pinned.
- `x-zen-model-substituted: true`: an explicit non-alias model request fell back after it could not be served.
- `x-zen-model-requested`: the explicit requested model when substitution occurs.

## Configuration

- `AGENT_TIER` (`complex` by default): tier for agent/tool traffic.
- `REQUEST_DEADLINE_MS` (`60000`): total pre-first-token deadline across fallback attempts. Each attempt is capped to the remaining budget.
- `MAX_FALLBACK_ATTEMPTS` (`4`): maximum candidates attempted before first output.
- `SHADOW_ROUTE_SAMPLE_RATE` (`0`): reserved for future shadow evaluation; no duplicate calls are made in this phase.
- `DETERMINISTIC_ROUTING=1`: test-only deterministic choice among equal-quality candidates.

Model aliases are stored in `model_aliases`: `zen/auto`, `zen/fast`, `zen/smart`, and `zen/reasoning`. Model metadata includes quality score, FIM support, tokenizer, and max output capacity. Token counts are estimates: `o200k` and `cl100k` use local tokenizers; Anthropic/Gemini use a 1.15 multiplier and `approx` uses 1.25.
