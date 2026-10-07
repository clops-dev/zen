import { describe, it, expect } from "bun:test"
import { validateSafeUrl, isPrivateOrReservedIpv4, isPrivateOrReservedIpv6, safeFetch } from "./ssrf"

describe("SSRF Protection — IP Range Rules", () => {
  it("blocks private IPv4 ranges (RFC 1918)", () => {
    expect(isPrivateOrReservedIpv4("10.0.0.1")).toBe(true)
    expect(isPrivateOrReservedIpv4("10.255.255.255")).toBe(true)
    expect(isPrivateOrReservedIpv4("172.16.0.1")).toBe(true)
    expect(isPrivateOrReservedIpv4("172.31.255.254")).toBe(true)
    expect(isPrivateOrReservedIpv4("192.168.1.1")).toBe(true)
    expect(isPrivateOrReservedIpv4("192.168.254.254")).toBe(true)
  })

  it("blocks loopback IPv4 addresses (127.0.0.0/8)", () => {
    expect(isPrivateOrReservedIpv4("127.0.0.1")).toBe(true)
    expect(isPrivateOrReservedIpv4("127.0.0.2")).toBe(true)
    expect(isPrivateOrReservedIpv4("127.255.255.255")).toBe(true)
  })

  it("blocks link-local and cloud metadata addresses (169.254.0.0/16)", () => {
    expect(isPrivateOrReservedIpv4("169.254.169.254")).toBe(true)
    expect(isPrivateOrReservedIpv4("169.254.1.1")).toBe(true)
  })

  it("blocks CGNAT addresses (RFC 6598: 100.64.0.0/10)", () => {
    expect(isPrivateOrReservedIpv4("100.64.0.1")).toBe(true)
    expect(isPrivateOrReservedIpv4("100.127.255.255")).toBe(true)
    // 100.63 and 100.128 are outside CGNAT
    expect(isPrivateOrReservedIpv4("100.63.255.255")).toBe(false)
    expect(isPrivateOrReservedIpv4("100.128.0.1")).toBe(false)
  })

  it("permits public routable IPv4 addresses", () => {
    expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false)
    expect(isPrivateOrReservedIpv4("1.1.1.1")).toBe(false)
    expect(isPrivateOrReservedIpv4("104.18.25.100")).toBe(false)
  })

  it("blocks private, loopback, and ULA IPv6 addresses", () => {
    expect(isPrivateOrReservedIpv6("::1")).toBe(true)
    expect(isPrivateOrReservedIpv6("fe80::1")).toBe(true)
    expect(isPrivateOrReservedIpv6("fc00::1")).toBe(true)
    expect(isPrivateOrReservedIpv6("fd12:3456:789a::1")).toBe(true)
    expect(isPrivateOrReservedIpv6("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateOrReservedIpv6("::ffff:169.254.169.254")).toBe(true)
    expect(isPrivateOrReservedIpv6("::ffff:192.168.1.1")).toBe(true)
  })
})

describe("SSRF Protection — validateSafeUrl", () => {
  it("rejects non-https URLs by default", async () => {
    const res = await validateSafeUrl("http://example.com/api", { allowHttpDev: false })
    expect(res.safe).toBe(false)
    expect(res.error).toContain("HTTPS protocol is required")
  })

  it("allows http for localhost ONLY with explicit dev flag", async () => {
    const devRes = await validateSafeUrl("http://localhost:11434/v1", { allowHttpDev: true })
    expect(devRes.safe).toBe(true)

    const noDevRes = await validateSafeUrl("http://localhost:11434/v1", { allowHttpDev: false })
    expect(noDevRes.safe).toBe(false)
  })

  it("rejects cloud metadata IP addresses directly", async () => {
    const res = await validateSafeUrl("https://169.254.169.254/latest/meta-data")
    expect(res.safe).toBe(false)
    expect(res.error).toContain("private/reserved or metadata")
  })

  it("rejects loopback and private IP literals", async () => {
    const r1 = await validateSafeUrl("https://127.0.0.1:8080")
    expect(r1.safe).toBe(false)

    const r2 = await validateSafeUrl("https://10.0.0.5:8080")
    expect(r2.safe).toBe(false)

    const r3 = await validateSafeUrl("https://192.168.1.100:8080")
    expect(r3.safe).toBe(false)
  })

  it("rejects URLs with embedded credentials", async () => {
    const res = await validateSafeUrl("https://admin:password@api.example.com")
    expect(res.safe).toBe(false)
    expect(res.error).toContain("credentials")
  })

  it("accepts valid public HTTPS endpoints", async () => {
    const res = await validateSafeUrl("https://api.openai.com/v1")
    expect(res.safe).toBe(true)
  })
})

describe("SSRF Protection — safeFetch", () => {
  it("blocks requests to metadata IPs before dispatch", async () => {
    expect(
      safeFetch("https://169.254.169.254/latest/meta-data")
    ).rejects.toThrow("SSRF validation blocked request")
  })

  it("blocks requests to private RFC 1918 IPs", async () => {
    expect(
      safeFetch("https://10.10.10.10:8000/models")
    ).rejects.toThrow("SSRF validation blocked request")
  })
})
