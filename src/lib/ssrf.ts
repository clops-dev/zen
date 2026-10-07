import dns from "node:dns/promises"
import { isIP } from "node:net"

export interface SsrValidationOptions {
  allowHttpDev?: boolean
}

/**
 * Checks whether an IPv4 address belongs to a prohibited range:
 * - Loopback (127.0.0.0/8)
 * - Private RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-Local / AWS/GCP/Azure Metadata (169.254.0.0/16, including 169.254.169.254)
 * - CGNAT RFC 6598 (100.64.0.0/10)
 * - Broadcast (255.255.255.255)
 * - Current/Unspecified (0.0.0.0/8)
 * - Documentation / Benchmark (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 198.18.0.0/15)
 * - Multicast (224.0.0.0/4)
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true // Malformed IP, block
  }
  const [b0, b1, b2, b3] = parts

  // 0.0.0.0/8
  if (b0 === 0) return true
  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true
  // 100.64.0.0/10 (CGNAT RFC 6598: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true
  // 169.254.0.0/16 (Link-local & cloud metadata 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true
  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true
  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true
  // 198.18.0.0/15 (Network benchmark tests: 198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true
  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true
  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true
  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true
  // 240.0.0.0/4 (Reserved / Future use)
  if (b0 >= 240) return true

  return false
}

/**
 * Checks whether an IPv6 address belongs to a prohibited range:
 * - Loopback (::1)
 * - Unspecified (::)
 * - Unique Local Address / ULA (fc00::/7)
 * - Link-Local (fe80::/10)
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x)
 * - Multicast (ff00::/8)
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // Loopback
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true
  // Unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true

  // IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1 or ::ffff:c0a8:0101)
  if (normalized.startsWith("::ffff:") || normalized.startsWith("0:0:0:0:0:ffff:")) {
    const parts = normalized.split(":")
    const lastPart = parts[parts.length - 1]
    if (lastPart.includes(".")) {
      return isPrivateOrReservedIpv4(lastPart)
    }
  }

  // ULA (fc00::/7 -> first hextet starts with fc or fd)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true

  // Link-Local (fe80::/10 -> first hextet starts with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(normalized)) return true

  // Multicast (ff00::/8)
  if (normalized.startsWith("ff")) return true

  return false
}

/**
 * Validate that a URL is safe against SSRF attacks.
 * Rejects non-HTTP(S), private, loopback, link-local, cloud metadata, and CGNAT destinations.
 */
export async function validateSafeUrl(
  inputUrl: string,
  opts: SsrValidationOptions = {},
): Promise<{ safe: boolean; error?: string; url?: URL }> {
  let parsed: URL
  try {
    parsed = new URL(inputUrl)
  } catch {
    return { safe: false, error: "Invalid URL syntax" }
  }

  const isDev =
    opts.allowHttpDev ??
    (process.env.ALLOW_HTTP_LOCALHOST === "true" ||
      process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test")

  const isLocalhostHost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname.endsWith(".localhost")

  if (parsed.protocol === "http:") {
    if (!isDev || !isLocalhostHost) {
      return {
        safe: false,
        error: "HTTPS protocol is required (HTTP only permitted for localhost in explicit development mode)",
      }
    }
    // Explicit dev mode with localhost is allowed
    return { safe: true, url: parsed }
  } else if (parsed.protocol !== "https:") {
    return { safe: false, error: `Disallowed protocol: '${parsed.protocol}'. Only HTTPS is permitted.` }
  }

  // Prevent credentials in URL
  if (parsed.username || parsed.password) {
    return { safe: false, error: "URLs containing embedded user credentials are not allowed" }
  }

  const hostname = parsed.hostname.toLowerCase()

  // Check if hostname is an IP address
  const ipType = isIP(hostname)
  if (ipType === 4) {
    if (isPrivateOrReservedIpv4(hostname)) {
      return { safe: false, error: `Target IP address ${hostname} belongs to a private/reserved or metadata range` }
    }
  } else if (ipType === 6) {
    if (isPrivateOrReservedIpv6(hostname)) {
      return { safe: false, error: `Target IPv6 address ${hostname} belongs to a private/reserved range` }
    }
  } else {
    // Resolve DNS and check all resolved addresses
    try {
      const addresses = await dns.lookup(hostname, { all: true })
      if (!addresses || addresses.length === 0) {
        return { safe: false, error: `Failed to resolve hostname: ${hostname}` }
      }

      for (const addr of addresses) {
        if (addr.family === 4) {
          if (isPrivateOrReservedIpv4(addr.address)) {
            return {
              safe: false,
              error: `Hostname ${hostname} resolves to prohibited private or metadata IP: ${addr.address}`,
            }
          }
        } else if (addr.family === 6) {
          if (isPrivateOrReservedIpv6(addr.address)) {
            return {
              safe: false,
              error: `Hostname ${hostname} resolves to prohibited private IPv6: ${addr.address}`,
            }
          }
        }
      }
    } catch (err) {
      return {
        safe: false,
        error: `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return { safe: true, url: parsed }
}

export interface SafeFetchOptions extends RequestInit {
  maxRedirects?: number
  timeoutMs?: number
  maxResponseBytes?: number
  allowHttpDev?: boolean
}

/**
 * Safe fetch wrapper that prevents SSRF attacks:
 * - Validates initial URL against SSRF policy
 * - Handles redirects manually (capped at maxRedirects, default 3)
 * - Re-validates target URL on each redirect hop
 * - Enforces timeout (default 8000ms)
 * - Limits response size (default 2MB)
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 3
  const timeoutMs = options.timeoutMs ?? 8000
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024 // 2MB

  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const validation = await validateSafeUrl(currentUrl, { allowHttpDev: options.allowHttpDev })
    if (!validation.safe || !validation.url) {
      throw new Error(`SSRF validation blocked request: ${validation.error}`)
    }

    const { maxRedirects: _, timeoutMs: __, maxResponseBytes: ___, allowHttpDev: ____, ...fetchInit } = options

    const response = await fetch(currentUrl, {
      ...fetchInit,
      redirect: "manual", // Do not follow redirects automatically
      signal: AbortSignal.timeout(timeoutMs),
    })

    // Handle redirects manually
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        throw new Error(`Redirect HTTP ${response.status} missing Location header`)
      }

      redirectCount++
      if (redirectCount > maxRedirects) {
        throw new Error(`Exceeded maximum allowed redirects (${maxRedirects})`)
      }

      // Resolve relative redirect URL against current URL
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    // Check response size
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      throw new Error(`Response size exceeds limit of ${maxResponseBytes} bytes`)
    }

    // Wrap body with byte length counter
    if (response.body) {
      let bytesRead = 0
      const reader = response.body.getReader()
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          bytesRead += value.byteLength
          if (bytesRead > maxResponseBytes) {
            controller.error(new Error(`Response body exceeded maximum allowed size of ${maxResponseBytes} bytes`))
            return
          }
          controller.enqueue(value)
        },
        cancel(reason) {
          reader.cancel(reason)
        },
      })

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    return response
  }
}
