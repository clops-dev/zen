import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { getClientIp, isCloudflareIp } from "./client-ip"

describe("client-ip helper", () => {
  const origHops = process.env.TRUSTED_PROXY_HOPS

  afterEach(() => {
    if (origHops !== undefined) process.env.TRUSTED_PROXY_HOPS = origHops
    else delete process.env.TRUSTED_PROXY_HOPS
  })

  test("isCloudflareIp recognizes Cloudflare IPv4 ranges", () => {
    // 173.245.48.0/20
    expect(isCloudflareIp("173.245.48.1")).toBe(true)
    expect(isCloudflareIp("173.245.63.254")).toBe(true)
    // 104.16.0.0/13
    expect(isCloudflareIp("104.16.12.34")).toBe(true)
    expect(isCloudflareIp("104.23.255.255")).toBe(true)
    // 172.64.0.0/13
    expect(isCloudflareIp("172.64.32.1")).toBe(true)
  })

  test("isCloudflareIp recognizes Cloudflare IPv6 ranges", () => {
    // 2400:cb00::/32
    expect(isCloudflareIp("2400:cb00:0000:0000:0000:0000:0000:0001")).toBe(true)
    expect(isCloudflareIp("2400:cb00::1")).toBe(true)
    // 2606:4700::/32
    expect(isCloudflareIp("2606:4700:4700::1111")).toBe(true)
  })

  test("isCloudflareIp rejects non-Cloudflare IPs", () => {
    expect(isCloudflareIp("8.8.8.8")).toBe(false)
    expect(isCloudflareIp("1.1.1.1")).toBe(false) // 1.1.1.1 is CF DNS, not a CF edge proxy range
    expect(isCloudflareIp("192.168.1.1")).toBe(false)
    expect(isCloudflareIp("10.0.0.1")).toBe(false)
    expect(isCloudflareIp("203.0.113.195")).toBe(false)
    expect(isCloudflareIp("2001:4860:4860::8888")).toBe(false)
  })

  test("spoofed CF-Connecting-IP from a non-Cloudflare source is ignored", () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "cf-connecting-ip") return "1.2.3.4"
          if (name.toLowerCase() === "x-forwarded-for") return "198.51.100.5" // non-CF
          return undefined
        },
      },
    }

    // 198.51.100.5 is not Cloudflare, so CF-Connecting-IP is ignored
    expect(getClientIp(mockContext)).toBe("198.51.100.5")
  })

  test("CF-Connecting-IP from a verified Cloudflare IP is trusted", () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "cf-connecting-ip") return "203.0.113.88"
          // Request arrived through Cloudflare edge (172.64.1.1)
          if (name.toLowerCase() === "x-forwarded-for") return "172.64.1.1"
          return undefined
        },
      },
    }

    expect(getClientIp(mockContext)).toBe("203.0.113.88")
  })

  test("TRUSTED_PROXY_HOPS=1: takes 1st entry from the right, preventing leftmost spoofing", () => {
    process.env.TRUSTED_PROXY_HOPS = "1"

    // Attacker sends forged client IPs on the left, but HAProxy appends attacker's real IP on the right
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-forwarded-for") {
            return "10.0.0.1, 10.0.0.2, 198.51.100.77"
          }
          return undefined
        },
      },
    }

    expect(getClientIp(mockContext)).toBe("198.51.100.77")
  })

  test("Rotating X-Forwarded-For prefix does NOT change the resolved client IP", () => {
    process.env.TRUSTED_PROXY_HOPS = "1"

    const makeCtx = (spoofedPrefix: string) => ({
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-forwarded-for") {
            return `${spoofedPrefix}, 203.0.113.50`
          }
          return undefined
        },
      },
    })

    const ip1 = getClientIp(makeCtx("1.1.1.1"))
    const ip2 = getClientIp(makeCtx("2.2.2.2"))
    const ip3 = getClientIp(makeCtx("3.3.3.3, 4.4.4.4"))

    expect(ip1).toBe("203.0.113.50")
    expect(ip2).toBe("203.0.113.50")
    expect(ip3).toBe("203.0.113.50")
  })

  test("TRUSTED_PROXY_HOPS=2: takes 2nd entry from the right", () => {
    process.env.TRUSTED_PROXY_HOPS = "2"

    // Client -> Proxy1 (e.g. Ingress) -> Proxy2 (e.g. HAProxy) -> Gateway
    // XFF has [spoofed_ip, real_client_ip, ingress_ip]
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-forwarded-for") {
            return "1.2.3.4, 203.0.113.99, 10.0.0.10"
          }
          return undefined
        },
      },
    }

    expect(getClientIp(mockContext)).toBe("203.0.113.99")
  })

  test("fallback to 127.0.0.1 when no headers or socket available", () => {
    const mockContext = { req: { header: () => undefined } }
    expect(getClientIp(mockContext)).toBe("127.0.0.1")
  })
})
