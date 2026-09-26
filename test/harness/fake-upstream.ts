/**
 * test/harness/fake-upstream.ts
 *
 * A lightweight OpenAI-compatible fake upstream server driven by named
 * scenarios. Tests select a scenario via the `x-scenario` request header
 * OR by using the scenario name as the model id.
 *
 * The server records every request it receives (headers, body, timing,
 * whether the client aborted) so tests can assert on what was sent.
 *
 * Usage:
 *   const fake = await startFakeUpstream()
 *   // point a provider at fake.url
 *   const req = fake.lastRequest()
 *   await fake.stop()
 *
 * Scenarios:
 *   ok_stream               — Normal streaming response with finish_reason=stop
 *   ok_nonstream            — Normal non-streaming response
 *   tool_call_single        — Single tool call, finish_reason=tool_calls
 *   tool_calls_parallel     — Two parallel tool calls with correct indices
 *   tool_call_args_split    — Tool call arguments split across multiple chunks
 *   rate_limited_429        — 429 with Retry-After: 1
 *   server_error_500        — 500 Internal Server Error
 *   slow_first_token_2000   — 2 s delay before first token
 *   stall_mid_stream        — Sends one chunk then stalls indefinitely
 *   disconnect_mid_stream   — Sends one chunk then closes TCP abruptly
 *   empty_output            — finish_reason=stop but no content
 *   malformed_tool_args     — Tool call with invalid JSON in arguments
 *   double_encoded_tool_args— Tool call with double-JSON-encoded arguments
 *   usage_missing           — Normal response body but no usage field
 *   huge_response           — ~64 KB of content
 */

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  /** True if the client closed the connection before we finished writing */
  clientAborted: boolean
  /** Unix ms when we received the request */
  receivedAt: number
  /** Unix ms when we started writing the response */
  respondedAt: number | null
}

export interface FakeUpstream {
  /** Base URL of the fake upstream, e.g. http://127.0.0.1:PORT */
  url: string
  /** All requests received so far, in order */
  requests: RecordedRequest[]
  /** Convenience: the most-recently received request */
  lastRequest(): RecordedRequest | undefined
  /** Clear the recorded requests list */
  reset(): void
  /** Stop the server */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
}

function sseRaw(text: string): Uint8Array {
  return encoder.encode(text)
}

const DONE = encoder.encode("data: [DONE]\n\n")

function baseChunk(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  }
}

function textChunk(id: string, model: string, content: string, finish_reason: string | null = null) {
  return {
    ...baseChunk(id, model),
    choices: [{ index: 0, delta: { content }, finish_reason }],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Scenario handlers — each returns a Response
// ---------------------------------------------------------------------------

type ScenarioHandler = (req: Request, rec: RecordedRequest) => Response | Promise<Response>

const scenarios: Record<string, ScenarioHandler> = {
  // --- happy paths --------------------------------------------------------

  ok_stream: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/ok"
    const chunks = [
      sse(textChunk(id, model, "Hello")),
      sse(textChunk(id, model, " world")),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
          await sleep(5)
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  ok_nonstream: (_req, rec) => {
    rec.respondedAt = Date.now()
    return Response.json({
      id: `chatcmpl-fake-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake/ok",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  },

  tool_call_single: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/tools"
    const tcId = "call_abc123"
    const chunks = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: tcId, type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"loc" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "ation\":\"Tokyo\"}" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
          await sleep(5)
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  tool_calls_parallel: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/tools"
    // Two tool calls with correct indices 0 and 1
    const chunks = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p0", type: "function", function: { name: "func_a", arguments: "" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_p1", type: "function", function: { name: "func_b", arguments: "" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"x\":1}" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{\"y\":2}" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
          await sleep(5)
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  tool_call_args_split: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/tools"
    const tcId = "call_split"
    // Arguments split across many small chunks
    const argParts = ["{", "\"ke", "y\":", "\"va", "lue", "\"}"]
    const chunks: Uint8Array[] = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: tcId, type: "function", function: { name: "noop", arguments: "" } }] }, finish_reason: null }] }),
      ...argParts.map(p => sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] }, finish_reason: null }] })),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
          await sleep(2)
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  // --- error paths --------------------------------------------------------

  rate_limited_429: (_req, rec) => {
    rec.respondedAt = Date.now()
    return Response.json(
      { error: { message: "Rate limit exceeded", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } },
      { status: 429, headers: { "Retry-After": "1", "x-ratelimit-reset-requests": String(Math.floor(Date.now() / 1000) + 1) } },
    )
  },

  server_error_500: (_req, rec) => {
    rec.respondedAt = Date.now()
    return Response.json(
      { error: { message: "Internal server error", type: "server_error", code: "server_error" } },
      { status: 500 },
    )
  },

  slow_first_token_2000: async (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/slow"
    const stream = new ReadableStream({
      async start(ctrl) {
        await sleep(2000)
        rec.respondedAt = Date.now()
        try {
          ctrl.enqueue(sse(textChunk(id, model, "slow")))
          ctrl.enqueue(sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }))
          ctrl.enqueue(DONE)
        } catch { /* client aborted */ }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  stall_mid_stream: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/stall"
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        try { ctrl.enqueue(sse(textChunk(id, model, "first"))) } catch { return }
        // Stall forever — the caller's idle/connect timer should fire
        await sleep(300_000)
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  disconnect_mid_stream: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/disconnect"
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        try { ctrl.enqueue(sse(textChunk(id, model, "first"))) } catch { return }
        await sleep(50)
        // Close the stream abruptly
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  empty_output: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/empty"
    const chunks = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  malformed_tool_args: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/malformed"
    // Arguments are invalid JSON
    const chunks = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "badtool", arguments: "" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{not valid json!!!" } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  double_encoded_tool_args: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/double"
    // Arguments are double-JSON-encoded (stringified JSON inside a JSON string)
    const innerArgs = JSON.stringify({ location: "Tokyo" })
    const doubleEncoded = JSON.stringify(innerArgs) // "\"{\\"location\\":\\"Tokyo\\"}\""
    const chunks = [
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_dbl", type: "function", function: { name: "get_weather", arguments: doubleEncoded } }] }, finish_reason: null }] }),
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  usage_missing: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/nousage"
    const chunks = [
      sse(textChunk(id, model, "Hello")),
      // Final chunk deliberately omits the usage field
      sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      DONE,
    ]
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        for (const c of chunks) {
          try { ctrl.enqueue(c) } catch { return }
          await sleep(5)
        }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },

  huge_response: (_req, rec) => {
    const id = `chatcmpl-fake-${Date.now()}`
    const model = "fake/huge"
    const hugeContent = "x".repeat(64 * 1024)
    const stream = new ReadableStream({
      async start(ctrl) {
        rec.respondedAt = Date.now()
        try {
          ctrl.enqueue(sse(textChunk(id, model, hugeContent)))
          ctrl.enqueue(sse({ ...baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 16384, total_tokens: 16394 } }))
          ctrl.enqueue(DONE)
        } catch { /* client aborted */ }
        ctrl.close()
      },
      cancel() { rec.clientAborted = true },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startFakeUpstream(port = 0): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = []

  function resolveScenario(req: Request, body: any): string {
    // Header wins; fall back to the model field in the body
    const header = req.headers.get("x-scenario")
    if (header && header in scenarios) return header
    const model: string = body?.model ?? ""
    if (model in scenarios) return model
    // Accept "slow_first_token" prefix (e.g. "slow_first_token_500")
    if (model.startsWith("slow_first_token")) return "slow_first_token_2000"
    return "ok_stream"
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      // Models endpoint — required for SDK initialization
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "fake/ok", object: "model", owned_by: "fake" }] })
      }

      // Parse body once (clone so we can read it again if needed)
      let body: unknown = null
      try {
        const text = await req.text()
        body = text ? JSON.parse(text) : null
      } catch { /* non-JSON body */ }

      const rec: RecordedRequest = {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries()),
        body,
        clientAborted: false,
        receivedAt: Date.now(),
        respondedAt: null,
      }
      requests.push(rec)

      const scenarioName = resolveScenario(req, body)
      const handler = scenarios[scenarioName] ?? scenarios.ok_stream!

      try {
        return await handler(req, rec)
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 })
      }
    },
  })

  const url = `http://127.0.0.1:${server.port}`

  return {
    url,
    requests,
    lastRequest: () => requests[requests.length - 1],
    reset() { requests.splice(0) },
    async stop() { await server.stop() },
  }
}
