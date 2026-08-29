import { describe, expect, test } from "bun:test"
import { UnsupportedCapabilityError } from "./routing"

describe("Tool Capability Routing", () => {
  test("UnsupportedCapabilityError carries missingCapabilities 'tools'", () => {
    const err = new UnsupportedCapabilityError(["tools"], "medium")
    expect(err.name).toBe("UnsupportedCapabilityError")
    expect(err.missingCapabilities).toEqual(["tools"])
    expect(err.tier).toBe("medium")
  })
})
