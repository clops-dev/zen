import { describe, test, expect } from "bun:test"
import { isTransientDbError, withDbResilience } from "./db"

describe("isTransientDbError", () => {
  test("matches ECONNRESET", () => {
    expect(isTransientDbError({ code: "ECONNRESET", message: "read ECONNRESET" })).toBe(true)
  })

  test("matches ETIMEDOUT", () => {
    expect(isTransientDbError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe(true)
  })

  test("matches ENETUNREACH", () => {
    expect(isTransientDbError({ code: "ENETUNREACH", message: "connect ENETUNREACH" })).toBe(true)
  })

  test("matches EAI_AGAIN (DNS transient)", () => {
    expect(isTransientDbError({ code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN" })).toBe(true)
  })

  test("matches ENOTFOUND via message substring", () => {
    expect(isTransientDbError({ message: "getaddrinfo ENOTFOUND ep-foo.aws.neon.tech" })).toBe(true)
  })

  test("matches PostgresError 57P03 (Neon cannot_connect_now)", () => {
    expect(isTransientDbError({ code: "57P03", message: "the database system is starting up" })).toBe(true)
  })

  test("matches 08006 connection_failure", () => {
    expect(isTransientDbError({ code: "08006", message: "connection failure" })).toBe(true)
  })

  test("matches CONNECTION_CLOSED write message", () => {
    expect(isTransientDbError({ message: "write CONNECTION_CLOSED" })).toBe(true)
  })

  test("matches 'connection terminated' string", () => {
    expect(isTransientDbError({ message: "connection terminated unexpectedly" })).toBe(true)
  })

  test("does NOT match a unique_violation (permanent)", () => {
    expect(isTransientDbError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(false)
  })

  test("does NOT match a syntax error (permanent)", () => {
    expect(isTransientDbError({ code: "42601", message: "syntax error at or near..." })).toBe(false)
  })

  test("does NOT match a check_violation (permanent)", () => {
    expect(isTransientDbError({ code: "23514", message: "violates check constraint" })).toBe(false)
  })

  test("does NOT match null/undefined", () => {
    expect(isTransientDbError(null)).toBe(false)
    expect(isTransientDbError(undefined)).toBe(false)
  })

  test("does NOT match a plain string without error shape", () => {
    expect(isTransientDbError("just a string")).toBe(false)
  })
})

describe("withDbResilience", () => {
  test("returns the value when the first attempt succeeds", async () => {
    let calls = 0
    const result = await withDbResilience(async () => {
      calls++
      return 42
    })
    expect(result).toBe(42)
    expect(calls).toBe(1)
  })

  test("retries on transient errors and eventually succeeds", async () => {
    let calls = 0
    const result = await withDbResilience(async () => {
      calls++
      if (calls < 3) {
        const e: any = new Error("read ECONNRESET")
        e.code = "ECONNRESET"
        throw e
      }
      return "ok"
    })
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  test("does NOT retry on permanent errors (unique violation)", async () => {
    let calls = 0
    let caught: any
    try {
      await withDbResilience(async () => {
        calls++
        const e: any = new Error("duplicate key value")
        e.code = "23505"
        throw e
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(caught).toBeDefined()
    expect(caught.code).toBe("23505")
  })

  test("gives up after 3 attempts on persistent transient errors", async () => {
    let calls = 0
    let caught: any
    try {
      await withDbResilience(async () => {
        calls++
        const e: any = new Error("getaddrinfo ENOTFOUND")
        e.code = "ENOTFOUND"
        throw e
      })
    } catch (e) { caught = e }
    expect(calls).toBe(3)
    expect(caught).toBeDefined()
    expect(caught.code).toBe("ENOTFOUND")
  })

  test("transientRetries annotation is attached to the final error after retries", async () => {
    let caught: any
    try {
      await withDbResilience(async () => {
        const e: any = new Error("connection terminated")
        throw e
      })
    } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect(caught.transientRetries).toBe(2)
  })
})
