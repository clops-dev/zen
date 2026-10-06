import { describe, test, expect } from "bun:test"
import { normalizeEmail } from "./email"

describe("normalizeEmail", () => {
  test("lowercases standard uppercase domains and local parts", () => {
    expect(normalizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com")
    expect(normalizeEmail("John.Doe@Example.COM")).toBe("john.doe@example.com")
  })

  test("trims leading and trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com")
    expect(normalizeEmail("\tUser@Example.com\n")).toBe("user@example.com")
  })

  test("handles already normalized emails", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com")
  })
})
