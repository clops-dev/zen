/**
 * src/lib/trace-recorder.test.ts
 *
 * Unit tests for the trace recorder.
 * P1.4 — verifies:
 *   - Refuses to start in production without ZEN_TRACE_ALLOW_PROD=1
 *   - Redacts headers and body keys
 *   - Hashes message content when ZEN_TRACE_REDACT_CONTENT=1
 *   - No secrets/content appear in a canary-string test
 */

import { describe, test, expect, afterEach } from "bun:test"
import {
  getTraceConfig,
  _resetTraceConfig,
  redactHeaders,
  redactBodyKeys,
  hashContent,
  redactMessages,
  buildTraceRecord,
} from "./trace-recorder"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

afterEach(() => {
  _resetTraceConfig()
})

// ---------------------------------------------------------------------------
// P1.4 — production guard
// ---------------------------------------------------------------------------

describe("production guard", () => {
  test("disabled when ZEN_TRACE_DIR is not set", () => {
    withEnv({ ZEN_TRACE_DIR: undefined, NODE_ENV: "development" }, () => {
      _resetTraceConfig()
      const config = getTraceConfig()
      expect(config.enabled).toBe(false)
    })
  })

  test("enabled in development with ZEN_TRACE_DIR set", () => {
    withEnv({ ZEN_TRACE_DIR: "/tmp/traces", NODE_ENV: "development" }, () => {
      _resetTraceConfig()
      const config = getTraceConfig()
      expect(config.enabled).toBe(true)
    })
  })

  test("THROWS in production without ZEN_TRACE_ALLOW_PROD", () => {
    withEnv({ ZEN_TRACE_DIR: "/tmp/traces", NODE_ENV: "production", ZEN_TRACE_ALLOW_PROD: undefined }, () => {
      _resetTraceConfig()
      expect(() => getTraceConfig()).toThrow(/production.*ZEN_TRACE_ALLOW_PROD/)
    })
  })

  test("allowed in production WITH ZEN_TRACE_ALLOW_PROD=1", () => {
    withEnv({ ZEN_TRACE_DIR: "/tmp/traces", NODE_ENV: "production", ZEN_TRACE_ALLOW_PROD: "1" }, () => {
      _resetTraceConfig()
      const config = getTraceConfig()
      expect(config.enabled).toBe(true)
    })
  })

  test("canary: ZEN_TRACE_DIR set but production without override → THROWS (prevents silent production tracing)", () => {
    withEnv({ ZEN_TRACE_DIR: "/tmp/traces", NODE_ENV: "production", ZEN_TRACE_ALLOW_PROD: undefined }, () => {
      _resetTraceConfig()
      let threw = false
      try { getTraceConfig() } catch { threw = true }
      expect(threw).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

describe("redactHeaders", () => {
  test("redacts authorization header", () => {
    const h = redactHeaders({ Authorization: "Bearer sk-secret123", "Content-Type": "application/json" })
    expect(h["Authorization"]).toBe("[REDACTED]")
    expect(h["Content-Type"]).toBe("application/json")
  })

  test("redacts cookie header", () => {
    const h = redactHeaders({ Cookie: "session=abc123; other=val" })
    expect(h["Cookie"]).toBe("[REDACTED]")
  })

  test("redacts x-api-key (case-insensitive)", () => {
    const h = redactHeaders({ "X-Api-Key": "my-key" })
    expect(h["X-Api-Key"]).toBe("[REDACTED]")
  })

  test("preserves non-secret headers", () => {
    const h = redactHeaders({ "X-Request-Id": "req-123", "User-Agent": "test/1.0" })
    expect(h["X-Request-Id"]).toBe("req-123")
    expect(h["User-Agent"]).toBe("test/1.0")
  })
})

describe("redactBodyKeys", () => {
  test("redacts api_key field", () => {
    const b = redactBodyKeys({ api_key: "secret", model: "gpt-4" })
    expect(b["api_key"]).toBe("[REDACTED]")
    expect(b["model"]).toBe("gpt-4")
  })

  test("redacts password field", () => {
    const b = redactBodyKeys({ password: "hunter2", email: "test@example.com" })
    expect(b["password"]).toBe("[REDACTED]")
    expect(b["email"]).toBe("test@example.com")
  })
})

describe("redactMessages", () => {
  test("preserves content when redactContent=false", () => {
    const msgs = [{ role: "user", content: "hello world" }]
    const out = redactMessages(msgs, false)
    expect((out[0] as any).content).toBe("hello world")
  })

  test("hashes string content when redactContent=true", () => {
    const msgs = [{ role: "user", content: "secret prompt" }]
    const out = redactMessages(msgs, true)
    expect((out[0] as any).content).toMatch(/^sha256:/)
    expect((out[0] as any).content).not.toContain("secret")
  })

  test("hashes text parts in array content", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "my secret" }] }]
    const out = redactMessages(msgs, true)
    const part = (out[0] as any).content[0]
    expect(part.text).toMatch(/^sha256:/)
  })

  test("redacts image_url data", () => {
    const msgs = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/..." } }] }]
    const out = redactMessages(msgs, true)
    const part = (out[0] as any).content[0]
    expect(part.image_url.url).toBe("[REDACTED]")
  })
})

// ---------------------------------------------------------------------------
// buildTraceRecord — canary test: no secret appears in output
// ---------------------------------------------------------------------------

describe("buildTraceRecord", () => {
  const CANARY = "MY_SECRET_API_KEY_XYZ"

  test("canary: authorization header not in trace output", () => {
    const record = buildTraceRecord({
      requestId: "test-req-1",
      method: "POST",
      path: "/v1/chat/completions",
      rawHeaders: {
        Authorization: `Bearer ${CANARY}`,
        "Content-Type": "application/json",
      },
      rawBody: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      response: {
        status: 200,
        model_label: "fake/ok",
        tier: "simple",
        gateway_overhead_ms: 10,
        ttft_ms: 150,
        total_ms: 500,
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        cancelled: false,
      },
      routing: {
        tier: "simple",
        attempt_count: 1,
        failover_chain: [],
      },
    })

    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(CANARY)
    expect(serialized).toContain("[REDACTED]")
  })

  test("canary: message content not in trace when redact enabled", () => {
    withEnv({ ZEN_TRACE_DIR: "/tmp/traces", NODE_ENV: "development", ZEN_TRACE_REDACT_CONTENT: "1" }, () => {
      _resetTraceConfig()
      const SECRET_CONTENT = "This is a very secret prompt"
      const record = buildTraceRecord({
        requestId: "test-req-2",
        method: "POST",
        path: "/v1/chat/completions",
        rawHeaders: { Authorization: "Bearer token" },
        rawBody: {
          model: "gpt-4",
          messages: [{ role: "user", content: SECRET_CONTENT }],
        },
        response: {
          status: 200,
          model_label: "fake/ok",
          tier: "simple",
          gateway_overhead_ms: 10,
          ttft_ms: null,
          total_ms: 200,
          finish_reason: "stop",
          usage: null,
          cancelled: false,
        },
        routing: { tier: "simple", attempt_count: 1, failover_chain: [] },
      })

      const serialized = JSON.stringify(record)
      expect(serialized).not.toContain(SECRET_CONTENT)
      expect(serialized).toContain("sha256:")
    })
  })

  test("record has correct schema_version and structure", () => {
    const record = buildTraceRecord({
      requestId: "req-shape-test",
      method: "POST",
      path: "/v1/chat/completions",
      rawHeaders: {},
      rawBody: { model: "gpt-4", messages: [] },
      response: {
        status: 200,
        model_label: "fake/ok",
        tier: "simple",
        gateway_overhead_ms: 5,
        ttft_ms: 100,
        total_ms: 300,
        finish_reason: "stop",
        usage: null,
        cancelled: false,
      },
      routing: { tier: "simple", attempt_count: 1, failover_chain: [{ model: "fake/ok" }] },
    })

    expect(record.schema_version).toBe(1)
    expect(record.request_id).toBe("req-shape-test")
    expect(record.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record.request.method).toBe("POST")
    expect(record.response.model_label).toBe("fake/ok")
    expect(record.routing.failover_chain).toHaveLength(1)
  })
})
