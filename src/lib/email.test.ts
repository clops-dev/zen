import { describe, test, expect } from "bun:test"
import { normalizeEmail, canonicalEmail, isDisposableDomain } from "./email"

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com")
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com")
    expect(normalizeEmail("John.Doe@Example.COM")).toBe("john.doe@example.com")
    expect(normalizeEmail("\tUser@Example.com\n")).toBe("user@example.com")
  })

  test("handles already normalized emails", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com")
  })
})

describe("canonicalEmail", () => {
  test("Gmail: strips dots from local part", () => {
    expect(canonicalEmail("f.oo@gmail.com")).toBe("foo@gmail.com")
    expect(canonicalEmail("F.o.o@gmail.com")).toBe("foo@gmail.com")
    expect(canonicalEmail("foo@gmail.com")).toBe("foo@gmail.com")
  })

  test("Gmail: strips +tag from local part", () => {
    expect(canonicalEmail("foo+tag@gmail.com")).toBe("foo@gmail.com")
    expect(canonicalEmail("foo+1@gmail.com")).toBe("foo@gmail.com")
    expect(canonicalEmail("Foo+Test@gmail.com")).toBe("foo@gmail.com")
  })

  test("Gmail: strips both dots and +tag", () => {
    expect(canonicalEmail("F.oo+1@gmail.com")).toBe("foo@gmail.com")
    expect(canonicalEmail("f.o.o+anything@googlemail.com")).toBe("foo@googlemail.com")
  })

  test("Gmail: same canonical for 50 variants of the same address", () => {
    const variants = [
      "foo@gmail.com",
      "Foo@gmail.com",
      "f.oo@gmail.com",
      "f.o.o@gmail.com",
      "foo+1@gmail.com",
      "foo+spam@gmail.com",
      "F.Oo+2@gmail.com",
      "F.O.O+tag@gmail.com",
    ]
    const canonical = canonicalEmail(variants[0])
    for (const v of variants) {
      expect(canonicalEmail(v)).toBe(canonical)
    }
  })

  test("Protonmail: strips +tag", () => {
    expect(canonicalEmail("user+tag@protonmail.com")).toBe("user@protonmail.com")
    expect(canonicalEmail("user+tag@proton.me")).toBe("user@proton.me")
  })

  test("Custom domain: does NOT strip dots or +tags", () => {
    expect(canonicalEmail("user+tag@custom.com")).toBe("user+tag@custom.com")
    expect(canonicalEmail("f.oo@example.org")).toBe("f.oo@example.org")
  })

  test("lowercases the result", () => {
    expect(canonicalEmail("FOO+tag@GMAIL.COM")).toBe("foo@gmail.com")
  })
})

describe("isDisposableDomain", () => {
  test("returns true for known disposable domains", () => {
    expect(isDisposableDomain("user@mailinator.com")).toBe(true)
    expect(isDisposableDomain("user@guerrillamail.com")).toBe(true)
    expect(isDisposableDomain("user@trashmail.com")).toBe(true)
    expect(isDisposableDomain("user@10minutemail.com")).toBe(true)
    expect(isDisposableDomain("user@yopmail.com")).toBe(true)
    expect(isDisposableDomain("user@maildrop.cc")).toBe(true)
  })

  test("returns false for legitimate domains", () => {
    expect(isDisposableDomain("user@gmail.com")).toBe(false)
    expect(isDisposableDomain("user@example.com")).toBe(false)
    expect(isDisposableDomain("user@company.io")).toBe(false)
    expect(isDisposableDomain("user@protonmail.com")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(isDisposableDomain("user@Mailinator.COM")).toBe(true)
  })
})
