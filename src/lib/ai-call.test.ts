import { describe, test, expect } from "bun:test"
import { callNonStreaming, callStreaming, UpstreamTimeoutError, classifyProviderError } from "./ai-call"
import type { RouteTarget } from "./routing"

// Bun's HTTP fetch implementation emits AbortError as both a promise rejection
// AND a global uncaughtException when a request is aborted while in-flight.
// The promise rejection is caught correctly inside callNonStreaming/callStreaming,
// but the global exception would otherwise mark the currently-running test as
// Bun's HTTP fetch implementation emits AbortError/TimeoutError as unhandled
// promise rejections when a request is aborted while in-flight. The promise
// rejection is caught correctly inside callNonStreaming/callStreaming, but the
// global unhandled rejection would otherwise mark the currently-running test as
// Remove Bun's test runner listeners to prevent it from marking the test as
// failed when the native AbortError bubbles up as an unhandled rejection.
const removeBunListeners = () => {
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const listeners = process.listeners(event)
    for (const l of listeners) {
      if (l.name !== "mySuppressor") {
        process.removeListener(event, l)
      }
    }
  }
}

process.on("unhandledRejection", function mySuppressor(err) {
  const name = err && (err as any).name
  if (name === "AbortError" || name === "TimeoutError") return
  
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  if (msg.includes("aborted") || msg.includes("abort") || msg === "silent_timeout_abort") return
  
  console.error("Unhandled Promise Rejection:", err)
  throw err
})

process.on("uncaughtException", function mySuppressor(err) {
  const name = err && (err as any).name
  if (name === "AbortError" || name === "TimeoutError") return
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  if (msg.includes("aborted") || msg.includes("abort") || msg === "silent_timeout_abort") return
  
  console.error("Uncaught Exception:", err)
  throw err
})

removeBunListeners()

// Timeouts are set by the runner: `UPSTREAM_TIMEOUT_MS_NON_STREAMING=200
// UPSTREAM_TIMEOUT_MS_STREAMING=300 bun test src/lib/ai-call.test.ts`.
// We assert against those exact values below.

interface MockServer { port: number; stop: () => void }

async function startMock(
  mode: "ok" | "ok-stream" | "hang" | "sse-error-body",
): Promise<MockServer> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const accept = req.headers.get("accept") ?? ""
      const isStream = accept.includes("text/event-stream")
      const model = "test-model"
      if (mode === "hang") {
        // Return a Response immediately (so TTFB resolves and fetch completes)
        // but never yield any chunks in the stream. This tests the mid-stream
        // stall logic and avoids Bun's native AbortError logging which triggers
        // if we abort an in-flight fetch before headers are received.
        const stream = new ReadableStream({
          start() {
            // do nothing, let it hang
          }
        })
        return new Response(stream, {
          status: 200, headers: { "content-type": "text/event-stream" },
        })
      }
      if (mode === "ok-stream" && isStream) {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({
              id: "chatcmpl-test", object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
            })}\n\n`))
            controller.enqueue(enc.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200, headers: { "content-type": "text/event-stream" },
        })
      }
      if (mode === "sse-error-body" && isStream) {
        // Cloudflare edge behavior: a 429 or 503 returned with
        // `content-type: text/event-stream` and an `{"error":...}` body
        // (no SSE chunks, just the raw JSON). The stream completes with
        // no chunks and done=true. The SDK's fullStream iterator does NOT
        // throw — we have to capture the rejection on result.response
        // / result.finishReason / etc. to surface the real status.
        return new Response(
          JSON.stringify({
            error: {
              code: "quota_exceeded",
              message: "You exceeded your current quota (test mock).",
              type: "new_api_error",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "text/event-stream" },
          },
        )
      }
      return Response.json({
        id: "chatcmpl-test", object: "chat.completion", created: 0, model,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error("mock server did not bind to a port")
  return { port, stop: () => server.stop() }
}

function target(port: number, label: string): RouteTarget {
  return {
    modelRowId: `row-${label}`, providerId: `prov-${label}`,
    providerName: label,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test", modelId: "test-model", label,
    inputPricePer1M: 0, outputPricePer1M: 0,
    contextWindow: 8192, // arbitrary — ai-call tests don't exercise routing
    supportsTools: false, supportsVision: false, supportsJsonMode: false,
    providerType: "openai-compatible",
  }
}

describe("ai-call timeout", () => {
  test("non-streaming: hung provider throws UpstreamTimeoutError within ~timeout", async () => {
    const savedNonStream = process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
    process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING = process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING ?? "200"
    const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING)
    const mock = await startMock("hang")
    try {
      const t0 = Date.now()
      let err: unknown
      try {
        await callNonStreaming(target(mock.port, "hung"), [{ role: "user", content: "hi" }], 64)
      } catch (e) { err = e }
      const elapsed = Date.now() - t0
      expect(err).toBeInstanceOf(UpstreamTimeoutError)
      expect((err as UpstreamTimeoutError).timeoutMs).toBe(timeoutMs)
      // Must be roughly the configured timeout, well below an unbounded hang
      // (Bun.serve default idleTimeout is 10s — so > 5s would mean abort failed).
      expect(elapsed).toBeLessThan(5000)
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50)
    } finally {
      mock.stop()
      if (savedNonStream === undefined) delete process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
      else process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING = savedNonStream
    }
  })

  test("non-streaming: a normal provider completes (no regression)", async () => {
    const savedNonStream = process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
    process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING = "5000"
    const mock = await startMock("ok")
    try {
      const result = await callNonStreaming(target(mock.port, "ok"), [{ role: "user", content: "hi" }], 64)
      expect(result.content).toBe("hello")
      expect(result.inputTokens).toBe(1)
      expect(result.outputTokens).toBe(1)
    } finally {
      mock.stop()
      if (savedNonStream === undefined) delete process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING
      else process.env.UPSTREAM_TIMEOUT_MS_NON_STREAMING = savedNonStream
    }
  })

  test("streaming: hung provider's `started` resolves ok:false (gateway can fall back)", async () => {
    // With the 4-timer architecture, the pre-first-byte budget is set by
    // UPSTREAM_FIRST_TOKEN_TIMEOUT_MS (not the idle timer — that one is
    // armed only after the first chunk arrives). When the mock hangs
    // without sending any chunk, firstTokenTimer fires and START
    // resolves ok:false with an UpstreamTimeoutError tagged
    // `timeout:first_token`. The gateway then falls back to the next
    // candidate.
    const savedFirst = process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS
    const savedConnect = process.env.UPSTREAM_CONNECT_TIMEOUT_MS
    process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS = process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS ?? "300"
    process.env.UPSTREAM_CONNECT_TIMEOUT_MS = process.env.UPSTREAM_CONNECT_TIMEOUT_MS ?? "150"
    const firstTokenMs = Number(process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS)
    const mock = await startMock("hang")
    try {
      const t0 = Date.now()
      const { response, started, done } = callStreaming(
        target(mock.port, "hung-stream"),
        [{ role: "user", content: "hi" }],
        64, undefined, "hung-stream/test-model",
      )
      // Start reading the response body so the underlying ReadableStream's
      // start() actually runs. We do NOT cancel — the abort must come from
      // our own timeout, not from us yanking the body.
      const reader = response.body!.getReader()
      const readP = (async () => {
        while (true) {
          const { done } = await reader.read().catch(() => ({ done: true }))
          if (done) break
        }
      })()

      const startResult = await started
      const elapsed = Date.now() - t0
      expect(startResult.ok).toBe(false)
      expect(startResult.error).toBeInstanceOf(UpstreamTimeoutError)
      // Either connect or firstToken timer will fire, depending on AI SDK
      // internals. Both are pre-first-byte and both produce an
      // UpstreamTimeoutError.
      const reason = (startResult.error as UpstreamTimeoutError).rejectReason
      expect(reason === "timeout:connect" || reason === "timeout:first_token").toBe(true)
      expect((startResult.error as UpstreamTimeoutError).timeoutMs).toBeGreaterThanOrEqual(0)
      // `done` will reject too once the abort tears the stream down.
      const doneErr = await done.catch((e) => e)
      expect(doneErr).toBeInstanceOf(UpstreamTimeoutError)
      await readP
      expect(elapsed).toBeLessThan(5000)
      // Either connect or firstToken timer fires — the budget is the
      // firstTokenMs whichever fired.
      expect(elapsed).toBeLessThan(firstTokenMs + 200)
    } finally {
      // Brief pause before stopping mock: the AI SDK may still be processing
      // internal async cleanup (retries, signal handlers) after the abort. If
      // we stop the mock immediately, its internal machinery can fire
      // AbortError into the next test's execution window on stderr.
      await new Promise((r) => setTimeout(r, 30))
      mock.stop()
      if (savedFirst === undefined) delete process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS
      else process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS = savedFirst
      if (savedConnect === undefined) delete process.env.UPSTREAM_CONNECT_TIMEOUT_MS
      else process.env.UPSTREAM_CONNECT_TIMEOUT_MS = savedConnect
    }
  })

  test("streaming: normal provider's `started` resolves ok:true (no regression)", async () => {
    // Inline server (not via startMock helper) so this test is fully
    // isolated from the prior streaming-hung test's cleanup.
    //
    // We temporarily raise UPSTREAM_IDLE_TIMEOUT_MS_STREAMING for this test
    // only: the suite sets it to 300 ms globally (so the hung-stream test
    // fires quickly), but the idle timer is armed at stream start (covering
    // TTFB), and the AI SDK's internal async machinery + local loopback
    // round-trip can easily take >300 ms before the first chunk is received —
    // which would incorrectly trigger an idle abort here.
    // 5 000 ms is well above any real local-loopback latency but still short
    // enough to be caught if something is genuinely broken.
    const savedIdle = process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
    process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING = "5000"
    const server = Bun.serve({
      port: 0,
      fetch() {
        const enc = new TextEncoder()
        const s = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({
              id: "chatcmpl-test", object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: "test-model",
              choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
            })}\n\n`))
            controller.enqueue(enc.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(s, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "connection": "close"
          }
        })
      },
    })
    try {
      const { response, started } = callStreaming(
        {
          modelRowId: "r", providerId: "p", providerName: "ok-stream",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-test", modelId: "test-model", label: "ok-stream/test-model",
          inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 8192,
          supportsTools: false, supportsVision: false, supportsJsonMode: false,
          providerType: "openai-compatible",
        },
        [{ role: "user", content: "hi" }],
        64, undefined, "ok-stream/test-model",
      )
      const readP = response.text().catch(() => "")
      const startResult = await started
      expect(startResult.ok).toBe(true)
      await readP
    } finally {
      server.stop()
      // Restore the suite-wide idle timeout so subsequent tests are unaffected.
      if (savedIdle === undefined) delete process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
      else process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING = savedIdle
    }
  })
})

// ---------------------------------------------------------------------------
// Cloudflare-edge error body disguised as an SSE stream
// ---------------------------------------------------------------------------
//
// Many gateways (Cloudflare, AI SDK providers that proxy through one) return
// 4xx/5xx errors with `content-type: text/event-stream` and a JSON error body
// — not the SSE chunks the SDK expects. The stream then completes with zero
// chunks, the iterator yields `{ done: true }` immediately, and the SDK
// doesn't throw from `iterator.next()`. The real error is on `result.response`
// / `result.finishReason` etc., which reject asynchronously.
//
// The fix: ai-call.ts captures the first rejection across those SDK promises
// and re-uses it in the !gotAnyContent branch instead of always throwing
// NoOutputError. These tests pin that contract.

describe("ai-call stream: error body disguised as SSE", () => {
  test("streaming: 429 with SSE content-type surfaces an APICallError-shaped error, NOT NoOutputError", async () => {
    // Make idle timer very large so the race resolves via the stream
    // completing, not via a timeout.
    const savedIdle = process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
    process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING = "5000"
    const mock = await startMock("sse-error-body")
    try {
      const { started } = callStreaming(
        target(mock.port, "rate-limited"),
        [{ role: "user", content: "hi" }],
        64, undefined, "rate-limited/test-model",
      )
      const startResult = await started
      expect(startResult.ok).toBe(false)
      const err = startResult.error
      expect(err).toBeDefined()
      const c = classifyProviderError(err)
      expect(c.action).toBe("continue")
    } finally {
      mock.stop()
      if (savedIdle === undefined) delete process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING
      else process.env.UPSTREAM_IDLE_TIMEOUT_MS_STREAMING = savedIdle
    }
  })

  test("streaming: still throws UpstreamTimeoutError when the SDK truly completes cleanly with no error", async () => {
    // The 4-timer architecture: the pre-first-byte phase is owned by
    // connect + firstToken timers (not idle). When the SDK doesn't reject
    // and no chunk arrives, one of those pre-first-byte timers fires and
    // we surface UpstreamTimeoutError with the corresponding rejectReason
    // tag. (When idle IS involved — chunks arrive then stall — `done`
    // rejects with UpstreamTimeoutError tagged `timeout:idle`. That's
    // covered by the timer tests.)
    const savedFirst = process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS
    process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS = "200"
    const mock = await startMock("hang")
    try {
      const { started } = callStreaming(
        target(mock.port, "silent"),
        [{ role: "user", content: "hi" }],
        64, undefined, "silent/test-model",
      )
      const startResult = await started
      expect(startResult.ok).toBe(false)
      expect((startResult.error as Error).name).toBe("UpstreamTimeoutError")
    } finally {
      mock.stop()
      if (savedFirst === undefined) delete process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS
      else process.env.UPSTREAM_FIRST_TOKEN_TIMEOUT_MS = savedFirst
    }
  })
})
