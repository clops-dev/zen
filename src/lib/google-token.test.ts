import { describe, test, expect, beforeAll } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { verifyGoogleIdToken, type GoogleJwk } from "./google-token"

describe("google-token", () => {
  let publicKeyJwk: GoogleJwk
  let privateKeyPem: string
  const testKid = "test-key-1"
  const clientId = "test-google-client-id"
  const expectedNonce = "secure-random-nonce-123"

  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    const exportedJwk = publicKey.export({ format: "jwk" }) as any
    publicKeyJwk = {
      ...exportedJwk,
      kid: testKid,
      alg: "RS256",
      use: "sig",
    }
    privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string
  })

  function createSignedToken(headerOverrides = {}, payloadOverrides = {}): string {
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: testKid,
      ...headerOverrides,
    }
    const payload = {
      iss: "https://accounts.google.com",
      aud: clientId,
      sub: "112233445566778899",
      email: "alice@example.com",
      email_verified: true,
      nonce: expectedNonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      ...payloadOverrides,
    }

    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const data = Buffer.from(`${headerB64}.${payloadB64}`)
    const signature = sign("RSA-SHA256", data, privateKeyPem)
    const sigB64 = signature.toString("base64url")

    return `${headerB64}.${payloadB64}.${sigB64}`
  }

  const mockFetchJwks = async () => ({ keys: [publicKeyJwk] })

  test("successfully verifies valid Google ID token", async () => {
    const token = createSignedToken()
    const verified = await verifyGoogleIdToken({
      idToken: token,
      expectedAudience: clientId,
      expectedNonce,
      fetchJwks: mockFetchJwks,
    })

    expect(verified.email).toBe("alice@example.com")
    expect(verified.sub).toBe("112233445566778899")
    expect(verified.email_verified).toBe(true)
  })

  test("rejects token with wrong audience", async () => {
    const token = createSignedToken({}, { aud: "wrong-client-id" })
    await expect(
      verifyGoogleIdToken({
        idToken: token,
        expectedAudience: clientId,
        expectedNonce,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/Invalid id_token audience/)
  })

  test("rejects token with expired exp", async () => {
    const token = createSignedToken({}, { exp: Math.floor(Date.now() / 1000) - 200 })
    await expect(
      verifyGoogleIdToken({
        idToken: token,
        expectedAudience: clientId,
        expectedNonce,
        clockSkewSeconds: 30,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/id_token expired/)
  })

  test("rejects token with wrong or missing nonce", async () => {
    const token = createSignedToken({}, { nonce: "tampered-nonce" })
    await expect(
      verifyGoogleIdToken({
        idToken: token,
        expectedAudience: clientId,
        expectedNonce,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/Invalid id_token nonce/)
  })

  test("rejects token with email_verified === false", async () => {
    const token = createSignedToken({}, { email_verified: false })
    await expect(
      verifyGoogleIdToken({
        idToken: token,
        expectedAudience: clientId,
        expectedNonce,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/email_verified must be true/)
  })

  test("rejects token with invalid signature", async () => {
    const valid = createSignedToken()
    const parts = valid.split(".")
    // Alter signature
    const badToken = `${parts[0]}.${parts[1]}.${Buffer.from("invalid-signature").toString("base64url")}`

    await expect(
      verifyGoogleIdToken({
        idToken: badToken,
        expectedAudience: clientId,
        expectedNonce,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/signature verification failed/)
  })

  test("rejects token with wrong issuer", async () => {
    const token = createSignedToken({}, { iss: "https://evil.com" })
    await expect(
      verifyGoogleIdToken({
        idToken: token,
        expectedAudience: clientId,
        expectedNonce,
        fetchJwks: mockFetchJwks,
      }),
    ).rejects.toThrow(/Invalid id_token issuer/)
  })
})
