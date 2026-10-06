import type { Context } from "hono"

/**
 * Cloudflare's published IP ranges (IPv4 & IPv6).
 * Source: https://www.cloudflare.com/ips/
 */
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
]

const CLOUDFLARE_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]

interface ParsedIpv4Cidr {
  network: number
  mask: number
}

interface ParsedIpv6Cidr {
  network: bigint
  mask: bigint
}

function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (let i = 0; i < 4; i++) {
    const octet = Number(parts[i])
    if (isNaN(octet) || octet < 0 || octet > 255) return null
    n = ((n << 8) | octet) >>> 0
  }
  return n
}

function parseIpv4Cidr(cidr: string): ParsedIpv4Cidr {
  const [ipStr, bitsStr] = cidr.split("/")
  const bits = Number(bitsStr)
  const ipNum = parseIpv4(ipStr) ?? 0
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0)
  return { network: (ipNum & mask) >>> 0, mask }
}

const PARSED_V4_CIDRS: ParsedIpv4Cidr[] = CLOUDFLARE_IPV4_CIDRS.map(parseIpv4Cidr)

function parseIpv6(ip: string): bigint | null {
  let clean = ip.trim().toLowerCase()
  // Handle IPv4-mapped IPv6 (::ffff:192.0.2.1)
  if (clean.includes(".")) return null

  const halves = clean.split("::")
  if (halves.length > 2) return null // multiple :: invalid

  let parts: string[] = []
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : []
    const right = halves[1] ? halves[1].split(":") : []
    const missing = 8 - (left.length + right.length)
    if (missing < 0) return null
    parts = [...left, ...Array(missing).fill("0"), ...right]
  } else {
    parts = clean.split(":")
    if (parts.length !== 8) return null
  }

  try {
    let result = 0n
    for (const part of parts) {
      const val = BigInt(parseInt(part || "0", 16))
      if (val < 0n || val > 0xffffn) return null
      result = (result << 16n) | val
    }
    return result
  } catch {
    return null
  }
}

function parseIpv6Cidr(cidr: string): ParsedIpv6Cidr {
  const [ipStr, bitsStr] = cidr.split("/")
  const bits = BigInt(bitsStr)
  const ipNum = parseIpv6(ipStr) ?? 0n
  const mask = bits === 0n ? 0n : (((1n << bits) - 1n) << (128n - bits))
  return { network: ipNum & mask, mask }
}

const PARSED_V6_CIDRS: ParsedIpv6Cidr[] = CLOUDFLARE_IPV6_CIDRS.map(parseIpv6Cidr)

/**
 * Returns true if the given IP address is within Cloudflare's published IP ranges.
 */
export function isCloudflareIp(ip: string): boolean {
  if (!ip) return false
  const clean = ip.trim()

  const v4 = parseIpv4(clean)
  if (v4 !== null) {
    for (const cidr of PARSED_V4_CIDRS) {
      if (((v4 & cidr.mask) >>> 0) === cidr.network) return true
    }
    return false
  }

  const v6 = parseIpv6(clean)
  if (v6 !== null) {
    for (const cidr of PARSED_V6_CIDRS) {
      if ((v6 & cidr.mask) === cidr.network) return true
    }
    return false
  }

  return false
}

/**
 * Get client IP securely.
 *
 * Rules:
 * 1. Only trusts `cf-connecting-ip` if the request arrives from Cloudflare's published ranges.
 * 2. Parses `x-forwarded-for` using `TRUSTED_PROXY_HOPS` (default: 1), taking the Nth entry
 *    from the RIGHT to prevent client-supplied leftmost spoofing.
 * 3. Falls back to socket remote address or `x-real-ip` or '127.0.0.1'.
 */
export function getClientIp(c: Context | any): string {
  const trustedHops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1))

  // Retrieve raw header values
  const cfConnectingIp = c.req?.header?.("cf-connecting-ip")?.trim()
  const xff = c.req?.header?.("x-forwarded-for")?.trim()
  const xRealIp = c.req?.header?.("x-real-ip")?.trim()

  // Get socket remote address if exposed by runtime (Bun / Node)
  const socketIp: string | undefined =
    c.env?.incoming?.socket?.remoteAddress ??
    c.req?.raw?.socket?.remoteAddress ??
    undefined

  // Parse X-Forwarded-For chain
  const xffList = xff ? xff.split(",").map((s: string) => s.trim()).filter(Boolean) : []

  // Check if request arrived from Cloudflare
  // The immediate hop could be socketIp or the rightmost hop in XFF (if behind HAProxy)
  const immediateSenderIp = socketIp ?? (xffList.length > 0 ? xffList[xffList.length - 1] : xRealIp)

  if (cfConnectingIp && immediateSenderIp && isCloudflareIp(immediateSenderIp)) {
    return cfConnectingIp
  }

  // Otherwise, use TRUSTED_PROXY_HOPS: take the Nth entry from the RIGHT of XFF
  if (xffList.length > 0) {
    const idx = xffList.length - trustedHops
    return idx >= 0 ? xffList[idx] : xffList[0]
  }

  if (xRealIp) return xRealIp
  if (socketIp) return socketIp
  return "127.0.0.1"
}
