import { describe, test, expect } from "bun:test"
import {
  generateUserCode,
  formatUserCode,
  normalizeUserCode,
  constantTimeEqual,
  USER_CODE_CHARS,
  coarseLocationForIp,
} from "./device-code"

describe("device-code", () => {
  test("generates 8-character user code containing only allowed characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode()
      expect(code.length).toBe(8)
      for (const ch of code) {
        expect(USER_CODE_CHARS.includes(ch)).toBe(true)
      }
      // Ensure no vowels (A, E, I, O, U) or ambiguous chars (0, 1, L)
      expect(/[AEIOU01L]/.test(code)).toBe(false)
    }
  })

  test("formats user code into 4-4 with hyphen", () => {
    expect(formatUserCode("WDJB93KP")).toBe("WDJB-93KP")
    expect(formatUserCode("wdjb-93kp")).toBe("WDJB-93KP")
  })

  test("normalizes user input cleanly", () => {
    expect(normalizeUserCode("wdjb-93kp")).toBe("WDJB93KP")
    expect(normalizeUserCode("  wdjb 93kp  ")).toBe("WDJB93KP")
    expect(normalizeUserCode("w-d-j-b-9-3-k-p")).toBe("WDJB93KP")
  })

  test("constantTimeEqual compares safely", () => {
    expect(constantTimeEqual("secret123", "secret123")).toBe(true)
    expect(constantTimeEqual("secret123", "secret456")).toBe(false)
    expect(constantTimeEqual("secret123", "short")).toBe(false)
    expect(constantTimeEqual("", "test")).toBe(false)
  })

  test("coarseLocationForIp formats local and private networks", () => {
    expect(coarseLocationForIp("127.0.0.1")).toContain("Local loopback")
    expect(coarseLocationForIp("192.168.1.100")).toContain("Private local network")
    expect(coarseLocationForIp("203.0.113.195")).toBe("IP 203.0.113.195")
  })
})
