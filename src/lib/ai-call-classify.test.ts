import { describe, test, expect } from "bun:test"
import { classifyProviderError, UpstreamTimeoutError, NoOutputError } from "./ai-call"

/** Build a fake APICallError-shaped object. We don't import the real class
 * because the AI SDK guards the constructor — easier and just as faithful
 * to test the classifier against the structural shape it actually inspects
 * at runtime. */
function apiCallError(status: number, message = `upstream returned ${status}`): Error {
  const e = new Error(message)
  Object.defineProperty(e, "constructor", { value: { name: "APICallError" } })
  ;(e as any).statusCode = status
  return e
}

describe("classifyProviderError — action=continue (try next model)", () => {
  test("HTTP 429 (rate limited) → continue", () => {
    const c = classifyProviderError(apiCallError(429))
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("rate_limited")
    if ("statusCode" in c) expect(c.statusCode).toBe(429)
  })

  test("HTTP 500/502/503/504 → continue with kind=server_error", () => {
    for (const s of [500, 502, 503, 504]) {
      const c = classifyProviderError(apiCallError(s))
      expect(c.action).toBe("continue")
      expect(c.kind).toBe("server_error")
    }
  })

  test("HTTP 408 (provider-side request timeout) → continue with kind=timeout", () => {
    const c = classifyProviderError(apiCallError(408))
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("timeout")
  })

  test("UpstreamTimeoutError → continue with kind=timeout", () => {
    const c = classifyProviderError(new UpstreamTimeoutError(5000))
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("timeout")
  })

  test("AI SDK TimeoutError name → continue with kind=timeout", () => {
    const e = new Error("request timed out")
    Object.defineProperty(e, "name", { value: "TimeoutError" })
    expect(classifyProviderError(e)).toEqual({ action: "continue", kind: "timeout" })
  })

  test("fetch TypeError with 'fetch failed' → continue with kind=network", () => {
    const c = classifyProviderError(new TypeError("fetch failed"))
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("network")
  })

  test("ECONNREFUSED code → continue with kind=network", () => {
    const e = new Error("connect ECONNREFUSED 127.0.0.1:443")
    ;(e as any).code = "ECONNREFUSED"
    const c = classifyProviderError(e)
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("network")
  })

  test("cause.ECONNREFUSED is detected on the wrapper error → continue with kind=network", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:443")
    ;(cause as any).code = "ECONNREFUSED"
    const e = new Error("upstream fetch failed", { cause })
    expect(classifyProviderError(e).kind).toBe("network")
  })

  test("ENOTFOUND → continue with kind=network", () => {
    const e = new Error("getaddrinfo ENOTFOUND api.openai.com")
    ;(e as any).code = "ENOTFOUND"
    expect(classifyProviderError(e).kind).toBe("network")
  })

  test("truly unknown error falls back to continue (safer than bail)", () => {
    const c = classifyProviderError(new Error("???"))
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("unknown")
  })

  test("null/undefined → continue with kind=unknown", () => {
    expect(classifyProviderError(null).action).toBe("continue")
    expect(classifyProviderError(undefined).action).toBe("continue")
  })

  test("plain string error → continue with kind=unknown", () => {
    expect(classifyProviderError("something broke").action).toBe("continue")
  })

  test("NoOutputError (stream completed cleanly but emitted nothing) → continue with kind=no_output", () => {
    const c = classifyProviderError(new NoOutputError())
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("no_output")
  })

  test("NoOutputError is NOT mis-classified as timeout, network, or unknown", () => {
    const c = classifyProviderError(new NoOutputError())
    expect(c.kind).not.toBe("timeout")
    expect(c.kind).not.toBe("network")
    expect(c.kind).not.toBe("unknown")
  })
})

describe("classifyProviderError — action=skip_candidate (this model is dead, try next)", () => {
  // The "candidate" bucket: the request is fine, this particular
  // (provider, model) combination can't serve it. Loop continues, but the
  // ledger should mark it as non_retryable_for_candidate.

  test("HTTP 401 (provider rejected our key) → skip_candidate, kind=unauthorized", () => {
    const c = classifyProviderError(apiCallError(401, "Invalid API key"))
    expect(c.action).toBe("skip_candidate")
    expect(c.kind).toBe("unauthorized")
    if ("statusCode" in c) expect(c.statusCode).toBe(401)
  })

  test("HTTP 403 (provider rejected our permissions/account) → skip_candidate, kind=forbidden", () => {
    const c = classifyProviderError(apiCallError(403, "Your account does not have access to this model"))
    expect(c.action).toBe("skip_candidate")
    expect(c.kind).toBe("forbidden")
  })

  test("HTTP 404 (unknown model id on this provider) → skip_candidate, kind=not_found", () => {
    const c = classifyProviderError(apiCallError(404, "The model 'foo' does not exist"))
    expect(c.action).toBe("skip_candidate")
    expect(c.kind).toBe("not_found")
  })
})

describe("classifyProviderError — action=break_loop (the request itself is bad, return to client)", () => {
  // The "request" bucket: trying any other model would fail identically
  // because the request itself is wrong.

  test("HTTP 400 (malformed request) → break_loop, kind=bad_request", () => {
    const c = classifyProviderError(apiCallError(400, "tools[0].function.parameters: invalid schema"))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("bad_request")
    if ("statusCode" in c) expect(c.statusCode).toBe(400)
  })

  test("HTTP 422 (semantic invalid request) → break_loop, kind=invalid_request", () => {
    const c = classifyProviderError(apiCallError(422, "Unprocessable Entity"))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("invalid_request")
  })

  test("other 4xx (e.g. 410 Gone) → break_loop, kind=other_client_error", () => {
    const c = classifyProviderError(apiCallError(410))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("other_client_error")
  })

  test("HTTP 451 (legal block) → break_loop", () => {
    const c = classifyProviderError(apiCallError(451))
    expect(c.action).toBe("break_loop")
  })

  test("'unsupported parameter' message (no status code) → break_loop, kind=unsupported", () => {
    const c = classifyProviderError(new Error("Unsupported parameter: response_format"))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("unsupported")
  })

  test("'unknown tool' message → break_loop, kind=unsupported", () => {
    const c = classifyProviderError(new Error("Unknown tool: get_weather"))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("unsupported")
  })

  test("'invalid parameter' message → break_loop, kind=unsupported", () => {
    const c = classifyProviderError(new Error("invalid parameter: top_p"))
    expect(c.action).toBe("break_loop")
    expect(c.kind).toBe("unsupported")
  })
})

describe("classifyProviderError — robustness", () => {
  test("APICallError with no statusCode and no recognizable message falls through to continue/unknown", () => {
    const e = new Error("???")
    Object.defineProperty(e, "constructor", { value: { name: "APICallError" } })
    const c = classifyProviderError(e)
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("unknown")
  })

  test("port numbers like 443 in a network error are NOT mistaken for a status", () => {
    // "127.0.0.1:443" contains "443" but it's a port, not an HTTP status.
    // The classifier must recognize this as a network error first.
    const e = new Error("connect ECONNREFUSED 127.0.0.1:443")
    ;(e as any).code = "ECONNREFUSED"
    const c = classifyProviderError(e)
    expect(c.action).toBe("continue")
    expect(c.kind).toBe("network")
  })
})

describe("classifyProviderError — the split is the whole point", () => {
  // These cases together assert the split: 4xx is not monolithic, it splits
  // into "skip this one, try the next" (401/403/404) vs "the request is
  // bad, give up" (400/422/unsupported).

  test("401/403/404 all → skip_candidate (loop continues)", () => {
    for (const s of [401, 403, 404]) {
      const c = classifyProviderError(apiCallError(s))
      expect(c.action).toBe("skip_candidate")
    }
  })

  test("400/422/other-4xx/unsupported-message all → break_loop (request is bad)", () => {
    for (const s of [400, 422, 410, 451]) {
      const c = classifyProviderError(apiCallError(s))
      expect(c.action).toBe("break_loop")
    }
    const c = classifyProviderError(new Error("Unsupported parameter: foo"))
    expect(c.action).toBe("break_loop")
  })

  test("retryable 5xx/429/network/timeout/no_output all → continue (loop continues)", () => {
    for (const s of [429, 500, 502, 503, 504, 408]) {
      const c = classifyProviderError(apiCallError(s))
      expect(c.action).toBe("continue")
    }
    const c = classifyProviderError(new UpstreamTimeoutError(5000))
    expect(c.action).toBe("continue")
    const noOutput = classifyProviderError(new NoOutputError())
    expect(noOutput.action).toBe("continue")
  })
})
