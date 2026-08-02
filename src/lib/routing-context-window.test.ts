import { describe, test, expect } from "bun:test"
import {
  ContextWindowExceededError,
  candidateFitsContext,
  defaultReserveFor,
} from "./routing"

describe("candidateFitsContext", () => {
  test("returns true when no requiredTokens is set (legacy callers)", () => {
    const sink = { value: null as number | null }
    // even with a tiny context window, undefined requiredTokens means "skip"
    expect(candidateFitsContext({ context_window: 100 }, undefined, sink)).toBe(true)
    // and we don't update largestSink
    expect(sink.value).toBe(null)
  })

  test("returns true when context_window is null (unknown → don't block)", () => {
    const sink = { value: null as number | null }
    expect(candidateFitsContext({ context_window: null }, 1_000_000, sink)).toBe(true)
    // unknown windows are not eligible to be the "largest seen" either
    expect(sink.value).toBe(null)
  })

  test("returns true when requiredTokens fits inside window minus reserve", () => {
    const sink = { value: null as number | null }
    // 32k window, reserve = 6553, usable = 26615. 1000 fits.
    expect(candidateFitsContext({ context_window: 32768 }, 1000, sink)).toBe(true)
    expect(sink.value).toBe(32768)
  })

  test("returns false when requiredTokens exceeds window minus reserve", () => {
    const sink = { value: null as number | null }
    // 8k window, reserve = 2048, usable = 6144. 10000 doesn't fit.
    expect(candidateFitsContext({ context_window: 8192 }, 10_000, sink)).toBe(false)
    expect(sink.value).toBe(8192)
  })

  test("largestSink tracks the max across multiple checks", () => {
    const sink = { value: null as number | null }
    candidateFitsContext({ context_window: 8192 }, 1_000_000, sink) // doesn't fit
    candidateFitsContext({ context_window: 32768 }, 1_000_000, sink) // doesn't fit
    candidateFitsContext({ context_window: 200000 }, 1_000_000, sink) // doesn't fit
    expect(sink.value).toBe(200000)
  })

  test("largestSink only updates when a real (non-null) window is seen", () => {
    const sink = { value: 4096 as number | null }
    candidateFitsContext({ context_window: null }, 1_000_000, sink) // null, no update
    expect(sink.value).toBe(4096)
  })
})

describe("ContextWindowExceededError", () => {
  test("carries required/available/tier fields for the gateway to surface", () => {
    const err = new ContextWindowExceededError(50_000, 200_000, "complex")
    expect(err.name).toBe("ContextWindowExceededError")
    expect(err.requiredTokens).toBe(50_000)
    expect(err.largestAvailable).toBe(200_000)
    expect(err.tier).toBe("complex")
    expect(err.message).toContain("50000")
    expect(err.message).toContain("200000")
    expect(err).toBeInstanceOf(Error)
  })
})

describe("defaultReserveFor + candidateFitsContext together", () => {
  test("exact-boundary case: requiredTokens = window − reserve", () => {
    // 32k window: reserve = 6553, usable = 26215.
    const win = 32768
    const reserve = defaultReserveFor(win)
    const usable = win - reserve
    const sink = { value: null as number | null }
    // exactly at the boundary should fit
    expect(candidateFitsContext({ context_window: win }, usable, sink)).toBe(true)
    // one more token must not fit
    expect(candidateFitsContext({ context_window: win }, usable + 1, sink)).toBe(false)
  })

  test("small window uses the 2048 floor for reserve", () => {
    // 4k window: 20% = 800, but reserve floor is 2048, so usable = 2048.
    const win = 4096
    const reserve = defaultReserveFor(win)
    expect(reserve).toBe(2048)
    const sink = { value: null as number | null }
    expect(candidateFitsContext({ context_window: win }, 2048, sink)).toBe(true)
    expect(candidateFitsContext({ context_window: win }, 2049, sink)).toBe(false)
  })
})
