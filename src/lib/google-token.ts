import { createPublicKey, verify } from "node:crypto"

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"])

export interface GoogleJwk {
  kty: string
  alg?: string
  use?: string
  kid: string
  n: string
  e: string
  [key: string]: unknown
}

export interface GoogleJwksResponse {
  keys: GoogleJwk[]
}

export interface GoogleIdTokenClaims {
  iss: string
  aud: string
  sub: string
  email: string
  email_verified: boolean | string
  exp: number
  iat?: number
  nbf?: number
  nonce?: string
  name?: string
  picture?: string
  [key: string]: unknown
}

export interface VerifyGoogleIdTokenOptions {
  idToken: string
  expectedAudience: string
  expectedNonce: string
  clockSkewSeconds?: number
  nowSeconds?: number
  jwksUrl?: string
  fetchJwks?: () => Promise<GoogleJwksResponse>
}

// In-memory JWKS cache
let cachedJwks: { keys: GoogleJwk[]; expiresAt: number } | null = null

export function clearJwksCache() {
  cachedJwks = null
}

async function fetchGoogleJwks(jwksUrl = GOOGLE_CERTS_URL): Promise<GoogleJwksResponse> {
  const now = Date.now()
  if (cachedJwks && cachedJwks.expiresAt > now) {
    return { keys: cachedJwks.keys }
  }

  const res = await fetch(jwksUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${res.status} ${res.statusText}`)
  }

  // Parse cache-control header if available
  let maxAge = 3600 // default 1 hour
  const cacheControl = res.headers.get("cache-control")
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/i)
    if (match) {
      maxAge = Number.parseInt(match[1], 10)
    }
  }

  const data = (await res.json()) as GoogleJwksResponse
  if (!data || !Array.isArray(data.keys)) {
    throw new Error("Invalid JWKS response structure from Google")
  }

  cachedJwks = {
    keys: data.keys,
    expiresAt: now + Math.max(60, maxAge) * 1000,
  }

  return data
}

/**
 * Verify and decode a Google OIDC ID Token.
 *
 * Checks:
 * 1. RS256 algorithm and presence of kid in header.
 * 2. Cryptographic signature against Google's public JWKS.
 * 3. Issuer is https://accounts.google.com or accounts.google.com.
 * 4. Audience matches expected client ID.
 * 5. Token is not expired (exp), with acceptable clock skew.
 * 6. Nonce matches expected random nonce.
 * 7. email_verified is explicitly true.
 * 8. sub and email are non-empty strings.
 */
export async function verifyGoogleIdToken(opts: VerifyGoogleIdTokenOptions): Promise<GoogleIdTokenClaims> {
  const {
    idToken,
    expectedAudience,
    expectedNonce,
    clockSkewSeconds = 60,
    nowSeconds = Math.floor(Date.now() / 1000),
    jwksUrl,
    fetchJwks = () => fetchGoogleJwks(jwksUrl),
  } = opts

  if (!idToken || typeof idToken !== "string") {
    throw new Error("id_token must be a non-empty string")
  }

  const parts = idToken.split(".")
  if (parts.length !== 3) {
    throw new Error("Invalid id_token: must have 3 segments")
  }

  const [headerB64, payloadB64, sigB64] = parts

  // 1. Parse header
  let header: { alg?: string; kid?: string; typ?: string }
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid id_token: malformed header")
  }

  if (header.alg !== "RS256") {
    throw new Error(`Unsupported id_token alg: ${header.alg ?? "missing"} (expected RS256)`)
  }

  if (!header.kid) {
    throw new Error("Invalid id_token: missing kid in header")
  }

  // 2. Parse payload
  let payload: GoogleIdTokenClaims
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid id_token: malformed payload")
  }

  // 3. Claims validation
  if (!VALID_ISSUERS.has(payload.iss)) {
    throw new Error(`Invalid id_token issuer: ${payload.iss}`)
  }

  if (payload.aud !== expectedAudience) {
    throw new Error(`Invalid id_token audience: got ${payload.aud}, expected ${expectedAudience}`)
  }

  if (typeof payload.exp !== "number" || payload.exp + clockSkewSeconds < nowSeconds) {
    throw new Error(`id_token expired at ${payload.exp} (current time: ${nowSeconds})`)
  }

  if (payload.nbf !== undefined && typeof payload.nbf === "number" && payload.nbf - clockSkewSeconds > nowSeconds) {
    throw new Error(`id_token not active before ${payload.nbf}`)
  }

  if (!payload.nonce || payload.nonce !== expectedNonce) {
    throw new Error(`Invalid id_token nonce: got ${payload.nonce ?? "none"}, expected ${expectedNonce}`)
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === "true"
  if (!emailVerified) {
    throw new Error("id_token email_verified must be true")
  }

  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("id_token sub must be a non-empty string")
  }

  if (typeof payload.email !== "string" || !payload.email.trim()) {
    throw new Error("id_token email must be a non-empty string")
  }

  // 4. Verify signature against Google JWKS
  let jwks = await fetchJwks()
  let jwk = jwks.keys.find((k) => k.kid === header.kid)

  if (!jwk) {
    // If not found in cache, clear cache and try one more fetch in case keys rotated
    clearJwksCache()
    jwks = await fetchJwks()
    jwk = jwks.keys.find((k) => k.kid === header.kid)
  }

  if (!jwk) {
    throw new Error(`No matching public key found for kid "${header.kid}" in Google JWKS`)
  }

  try {
    const publicKey = createPublicKey({ key: jwk as any, format: "jwk" })
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`)
    const signature = Buffer.from(sigB64, "base64url")
    const isVerified = verify("RSA-SHA256", signedData, publicKey, signature)

    if (!isVerified) {
      throw new Error("id_token signature verification failed")
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("signature verification failed")) {
      throw err
    }
    throw new Error(`Failed to verify id_token signature: ${err instanceof Error ? err.message : String(err)}`)
  }

  return payload
}
