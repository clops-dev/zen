import { describe, test, expect } from "bun:test"
import { Hono } from "hono"
import { csrfProtection } from "./csrf"
import { SESSION_COOKIE } from "../lib/session"

describe("CSRF Protection Middleware", () => {
  const app = new Hono()
  app.use("*", csrfProtection())
  app.post("/test-post", (c) => c.json({ ok: true }))
  app.get("/test-get", (c) => c.json({ ok: true }))

  test("allows GET requests unconditionally", async () => {
    const res = await app.request("http://localhost:8787/test-get", {
      method: "GET",
      headers: { Origin: "http://evil.com" },
    })
    expect(res.status).toBe(200)
  })

  test("allows POST requests without session cookie (e.g. API keys / public endpoints)", async () => {
    const res = await app.request("http://localhost:8787/test-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(200)
  })

  test("allows state-changing request with valid session cookie and matching Origin", async () => {
    const res = await app.request("http://localhost:8787/test-post", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=valid_session_token`,
        Origin: "http://localhost:8787",
      },
    })
    expect(res.status).toBe(200)
  })

  test("blocks cross-origin POST with valid cookie when Origin differs (403)", async () => {
    const res = await app.request("http://localhost:8787/test-post", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=valid_session_token`,
        Origin: "http://attacker-site.com",
      },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe("csrf_rejected")
  })

  test("blocks request when Sec-Fetch-Site is cross-site", async () => {
    const res = await app.request("http://localhost:8787/test-post", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=valid_session_token`,
        "Sec-Fetch-Site": "cross-site",
      },
    })
    expect(res.status).toBe(403)
  })

  test("blocks request with mismatched Referer when Origin is omitted", async () => {
    const res = await app.request("http://localhost:8787/test-post", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=valid_session_token`,
        Referer: "http://evil.org/attack-page",
      },
    })
    expect(res.status).toBe(403)
  })
})
