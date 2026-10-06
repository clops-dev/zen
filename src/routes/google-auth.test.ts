import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { Hono } from "hono"
import { googleAuth, STATE_COOKIE, VERIFIER_COOKIE, NONCE_COOKIE, LINK_USER_COOKIE } from "./google-auth"
import { setSql, resetSql } from "../lib/db"
import { issueSession, SESSION_COOKIE, verifySession } from "../lib/session"
import { env } from "../lib/env"
import { clearJwksCache, type GoogleJwk } from "../lib/google-token"
import { invalidateActiveUserCache } from "../lib/active-user"

describe("Google OAuth Flow Security & Attack Tests", () => {
  let publicKeyJwk: GoogleJwk
  let privateKeyPem: string
  const testKid = "test-google-kid-1"
  const expectedClientId = "test-client-id"
  const expectedClientSecret = "test-client-secret"
  const expectedCallbackUrl = "http://localhost:8787/auth/google/callback"

  // In-memory mock database
  interface UserRow {
    id: string
    email: string
    password_hash: string | null
    role: "user" | "admin"
    google_id: string | null
    avatar_url: string | null
  }
  interface SubRow {
    user_id: string
    tier: string
    status: "active" | "suspended"
  }
  interface CreditRow {
    user_id: string
    balance_dt: number
  }

  let users: UserRow[] = []
  let subscriptions: SubRow[] = []
  let credits: CreditRow[] = []

  // Mock SQL engine
  const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const raw = strings.join("?")
    const query = raw.replace(/\s+/g, " ").trim().toLowerCase()

    // 1. SELECT ... FROM users WHERE google_id = ?
    if (query.includes("from users") && query.includes("google_id = ?")) {
      const gid = values[0]
      const found = users.filter((u) => u.google_id === gid)
      return found.map((u) => ({ id: u.id, role: u.role, email: u.email }))
    }

    // 2. SELECT ... FROM users WHERE lower(email) = ?
    if (query.includes("from users") && query.includes("lower(email) = ?")) {
      const em = String(values[0]).toLowerCase()
      const found = users.filter((u) => u.email.toLowerCase() === em)
      return found.map((u) => ({ ...u }))
    }

    // 3. SELECT ... FROM subscriptions WHERE user_id = ?
    if (query.includes("from subscriptions") && query.includes("user_id = ?")) {
      const uid = values[0]
      const found = subscriptions.filter((s) => s.user_id === uid)
      return found.map((s) => ({ status: s.status, tier: s.tier }))
    }

    // 3.5 SELECT ... FROM users u WHERE u.id = ? (getActiveUser)
    if (query.includes("from users") && query.includes("u.id = ?")) {
      const uid = values[0]
      const u = users.find((x) => x.id === uid)
      if (!u) return []
      const s = subscriptions.find((x) => x.user_id === uid)
      return [
        {
          id: u.id,
          email: u.email,
          role: u.role,
          user_status: "active",
          sub_status: s ? s.status : "active",
        },
      ]
    }

    if (query.includes("insert into sessions")) {
      return [{ id: `sess-${Date.now()}` }]
    }

    if (query.includes("from sessions")) {
      const u = users[0]
      return [{ id: "sess-1", user_id: u ? u.id : "user-test", last_seen_at: new Date(), expires_at: new Date(Date.now() + 100000), revoked: false }]
    }

    // 4. INSERT INTO users (email, google_id, avatar_url, role) VALUES (...) RETURNING id
    if (query.includes("insert into users")) {
      const [email, google_id, avatar_url, role] = values
      const id = `user-${Math.random().toString(36).slice(2, 10)}`
      const newUser: UserRow = {
        id,
        email,
        google_id,
        avatar_url: avatar_url ?? null,
        role: role ?? "user",
        password_hash: null,
      }
      users.push(newUser)
      return [{ id, role: newUser.role }]
    }

    // 5. UPDATE users SET google_id = ...
    if (query.includes("update users") && query.includes("google_id = ?")) {
      const [gid, avatar] = values
      const uid = values[values.length - 1]
      const user = users.find((u) => u.id === uid)
      if (user) {
        user.google_id = gid
        if (avatar) user.avatar_url = avatar
      }
      return []
    }

    // 6. UPDATE users SET avatar_url = ...
    if (query.includes("update users") && query.includes("avatar_url = ?")) {
      const [avatar, uid] = values
      const user = users.find((u) => u.id === uid)
      if (user) user.avatar_url = avatar
      return []
    }

    // 7. INSERT INTO user_credits
    if (query.includes("insert into user_credits")) {
      const uid = values[0]
      if (!credits.some((c) => c.user_id === uid)) {
        credits.push({ user_id: uid, balance_dt: 0 })
      }
      return []
    }

    // 8. INSERT INTO subscriptions
    if (query.includes("insert into subscriptions")) {
      const uid = values[0]
      const tier = values[1] ?? "free"
      const status = values[2] ?? "active"
      if (!subscriptions.some((s) => s.user_id === uid)) {
        subscriptions.push({ user_id: uid, tier, status })
      }
      return []
    }

    // 9. INSERT INTO credit_transactions
    if (query.includes("insert into credit_transactions")) {
      return [{ id: `ctx-${Date.now()}` }]
    }

    // 10. UPDATE user_credits ... RETURNING balance_dt
    if (query.includes("update user_credits")) {
      const amount = Number(values[0])
      const uid = values[1]
      let c = credits.find((cr) => cr.user_id === uid)
      if (!c) {
        c = { user_id: uid, balance_dt: 0 }
        credits.push(c)
      }
      c.balance_dt += amount
      return [{ balance_dt: c.balance_dt }]
    }

    // Fallback
    return []
  }

  // Setup test app
  const app = new Hono()
  app.route("/auth", googleAuth)

  const originalFetch = globalThis.fetch
  let fetchMockHandler: ((url: string, init?: RequestInit) => Promise<Response>) | null = null

  beforeAll(() => {
    // Generate RSA key for Google ID token mocking
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const exportedJwk = publicKey.export({ format: "jwk" }) as any
    publicKeyJwk = {
      ...exportedJwk,
      kid: testKid,
      alg: "RS256",
      use: "sig",
    }
    privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string

    // Configure env vars for Google OAuth
    ;(env as any).GOOGLE_CLIENT_ID = expectedClientId
    ;(env as any).GOOGLE_CLIENT_SECRET = expectedClientSecret
    ;(env as any).GOOGLE_CALLBACK_URL = expectedCallbackUrl

    setSql(mockSql)

    ;(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (fetchMockHandler) {
        const res = await fetchMockHandler(url, init)
        if (res) return res
      }
      return originalFetch(input, init)
    }
  })

  afterAll(() => {
    resetSql()
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    users = []
    subscriptions = []
    credits = []
    clearJwksCache()
    invalidateActiveUserCache()
    fetchMockHandler = null
  })

  // Helper to create a signed mock Google ID token
  function createSignedGoogleIdToken(claims: Record<string, unknown> = {}): string {
    const header = { alg: "RS256", typ: "JWT", kid: testKid }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: "https://accounts.google.com",
      aud: expectedClientId,
      sub: "google-sub-99999",
      email: "user@example.com",
      email_verified: true,
      exp: now + 3600,
      iat: now,
      ...claims,
    }

    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const data = Buffer.from(`${headerB64}.${payloadB64}`)
    const signature = sign("RSA-SHA256", data, privateKeyPem)
    const sigB64 = signature.toString("base64url")

    return `${headerB64}.${payloadB64}.${sigB64}`
  }

  // Setup standard mock Google responses
  function mockGoogleEndpoints(opts: {
    idToken: string
    userinfo: { sub: string; email: string; email_verified?: boolean; picture?: string }
    tokenStatus?: number
    userinfoStatus?: number
  }) {
    fetchMockHandler = async (url: string) => {
      if (url.includes("oauth2/v3/certs")) {
        return new Response(JSON.stringify({ keys: [publicKeyJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: opts.tokenStatus })
        }
        return new Response(
          JSON.stringify({
            access_token: "mock-access-token",
            id_token: opts.idToken,
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
        if (opts.userinfoStatus && opts.userinfoStatus !== 200) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: opts.userinfoStatus })
        }
        return new Response(JSON.stringify(opts.userinfo), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unhandled mock fetch URL: ${url}`)
    }
  }

  // -------------------------------------------------------------------------
  // ATTACK TEST 1: email_verified=false for an admin's email -> no session
  // -------------------------------------------------------------------------
  test("attack: email_verified=false for an admin's email -> no session issued", async () => {
    // Seed existing admin account
    users.push({
      id: "admin-id-1",
      email: "admin@example.com",
      password_hash: "admin_secure_hash",
      role: "admin",
      google_id: null,
      avatar_url: null,
    })

    const state = "valid-state-123"
    const verifier = "valid-verifier-123"
    const nonce = "valid-nonce-123"

    const idToken = createSignedGoogleIdToken({
      email: "admin@example.com",
      sub: "google-attacker-sub",
      nonce,
      email_verified: false, // NOT VERIFIED
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "google-attacker-sub",
        email: "admin@example.com",
        email_verified: false,
      },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    // Fails closed and redirects to login with generic auth_failed
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")

    // Assert NO session cookie was issued
    const setCookie = res.headers.get("set-cookie") || ""
    expect(setCookie.includes(`${SESSION_COOKIE}=`)).toBe(false)

    // Admin account in DB is untouched
    const adminUser = users.find((u) => u.id === "admin-id-1")!
    expect(adminUser.google_id).toBeNull()
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 2: email_verified=true for a victim password account -> no silent link
  // -------------------------------------------------------------------------
  test("attack: email_verified=true for a victim password account -> no silent link", async () => {
    // Seed victim's password account
    users.push({
      id: "victim-id-42",
      email: "victim@example.com",
      password_hash: "victim_secret_password_hash",
      role: "user",
      google_id: null,
      avatar_url: null,
    })

    const state = "state-victim-test"
    const verifier = "verifier-victim-test"
    const nonce = "nonce-victim-test"

    const idToken = createSignedGoogleIdToken({
      email: "victim@example.com",
      sub: "attacker-google-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "attacker-google-sub",
        email: "victim@example.com",
        email_verified: true,
      },
    })

    // Attacker calls callback without being logged in to victim's account
    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")

    // No session issued
    const setCookie = res.headers.get("set-cookie") || ""
    expect(setCookie.includes(`${SESSION_COOKIE}=`)).toBe(false)

    // Victim's password account MUST NOT be linked
    const victim = users.find((u) => u.id === "victim-id-42")!
    expect(victim.google_id).toBeNull()
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 3: Same email in different case -> same account, no duplicate
  // -------------------------------------------------------------------------
  test("email normalization: same email in different case -> matches same account, no duplicate", async () => {
    // Seed existing Google user with lowercased email
    users.push({
      id: "existing-google-user",
      email: "john.doe@example.com",
      password_hash: null,
      role: "user",
      google_id: "google-john-sub",
      avatar_url: null,
    })
    subscriptions.push({
      user_id: "existing-google-user",
      tier: "free",
      status: "active",
    })

    const state = "state-case-test"
    const verifier = "verifier-case-test"
    const nonce = "nonce-case-test"

    // Google returns email in uppercase / mixed case
    const idToken = createSignedGoogleIdToken({
      email: "John.Doe@EXAMPLE.COM",
      sub: "google-john-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "google-john-sub",
        email: "John.Doe@EXAMPLE.COM",
        email_verified: true,
      },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/app/dashboard")

    // Session issued for the existing user
    const setCookie = res.headers.get("set-cookie") || ""
    expect(setCookie.includes(`${SESSION_COOKIE}=`)).toBe(true)

    // No duplicate user created
    expect(users.length).toBe(1)
    expect(users[0].id).toBe("existing-google-user")
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 4: Tampered/missing state, missing verifier, replayed state -> rejected
  // -------------------------------------------------------------------------
  test("attack: tampered state -> rejected fail closed", async () => {
    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=tampered_state`, {
      headers: {
        Cookie: `${STATE_COOKIE}=original_state; ${VERIFIER_COOKIE}=v1; ${NONCE_COOKIE}=n1`,
      },
    })
    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
    expect(res.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`)).toBe(false)
  })

  test("attack: missing state cookie -> rejected fail closed", async () => {
    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=some_state`, {
      headers: {
        Cookie: `${VERIFIER_COOKIE}=v1; ${NONCE_COOKIE}=n1`,
      },
    })
    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
  })

  test("attack: missing verifier cookie -> rejected fail closed", async () => {
    const req = new Request(`http://localhost:8787/auth/google/callback?code=mock_code&state=state1`, {
      headers: {
        Cookie: `${STATE_COOKIE}=state1; ${NONCE_COOKIE}=n1`,
      },
    })
    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
  })

  test("attack: replayed state (cookie cleared on first call) -> rejected fail closed", async () => {
    const state = "replay-state"
    const verifier = "replay-verifier"
    const nonce = "replay-nonce"

    const idToken = createSignedGoogleIdToken({
      email: "replay@example.com",
      sub: "replay-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "replay-sub",
        email: "replay@example.com",
        email_verified: true,
      },
    })

    // First call succeeds and consumes the state
    const req1 = new Request(`http://localhost:8787/auth/google/callback?code=code1&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })
    const res1 = await app.request(req1)
    expect(res1.status).toBe(303)
    expect(res1.headers.get("location")).toBe("/zencode/app/dashboard")

    // The transient cookies in res1 were cleared:
    const cookiesHeader = res1.headers.get("set-cookie") || ""
    expect(cookiesHeader.includes(`${STATE_COOKIE}=;`)).toBe(true)

    // Replay with identical URL without cookies (as browser cleared them):
    const req2 = new Request(`http://localhost:8787/auth/google/callback?code=code1&state=${state}`)
    const res2 = await app.request(req2)
    expect(res2.status).toBe(303)
    expect(res2.headers.get("location")).toBe("/zencode/login?error=auth_failed")
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 5: Expired or wrong-audience ID token -> rejected
  // -------------------------------------------------------------------------
  test("attack: expired ID token -> rejected fail closed", async () => {
    const state = "state-exp"
    const verifier = "ver-exp"
    const nonce = "nonce-exp"

    const expiredToken = createSignedGoogleIdToken({
      email: "bob@example.com",
      sub: "sub-bob",
      nonce,
      exp: Math.floor(Date.now() / 1000) - 300, // 5 min in past
    })

    mockGoogleEndpoints({
      idToken: expiredToken,
      userinfo: { sub: "sub-bob", email: "bob@example.com", email_verified: true },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_exp&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
    expect(res.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`)).toBe(false)
  })

  test("attack: wrong-audience ID token -> rejected fail closed", async () => {
    const state = "state-aud"
    const verifier = "ver-aud"
    const nonce = "nonce-aud"

    const wrongAudToken = createSignedGoogleIdToken({
      email: "bob@example.com",
      sub: "sub-bob",
      nonce,
      aud: "wrong-client-id-12345",
    })

    mockGoogleEndpoints({
      idToken: wrongAudToken,
      userinfo: { sub: "sub-bob", email: "bob@example.com", email_verified: true },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_aud&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
    expect(res.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 6: Never auto-link to admin account even if email_verified is true
  // -------------------------------------------------------------------------
  test("attack: email_verified=true for admin email -> never auto-link, rejected", async () => {
    users.push({
      id: "admin-master",
      email: "sysadmin@example.com",
      password_hash: "admin_super_secret",
      role: "admin",
      google_id: null,
      avatar_url: null,
    })

    const state = "state-admin-autolink"
    const verifier = "verifier-admin-autolink"
    const nonce = "nonce-admin-autolink"

    const idToken = createSignedGoogleIdToken({
      email: "sysadmin@example.com",
      sub: "attacker-google-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "attacker-google-sub",
        email: "sysadmin@example.com",
        email_verified: true,
      },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_adm&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
    expect(res.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`)).toBe(false)

    // Admin account is not linked
    const adminRow = users.find((u) => u.id === "admin-master")!
    expect(adminRow.google_id).toBeNull()
  })

  // -------------------------------------------------------------------------
  // ATTACK TEST 7: Suspended user attempting Google login -> rejected
  // -------------------------------------------------------------------------
  test("security: suspended user attempting login -> rejected, no session", async () => {
    users.push({
      id: "suspended-user-1",
      email: "suspended@example.com",
      password_hash: null,
      role: "user",
      google_id: "google-suspended-sub",
      avatar_url: null,
    })
    subscriptions.push({
      user_id: "suspended-user-1",
      tier: "free",
      status: "suspended", // SUSPENDED
    })

    const state = "state-suspended"
    const verifier = "verifier-suspended"
    const nonce = "nonce-suspended"

    const idToken = createSignedGoogleIdToken({
      email: "suspended@example.com",
      sub: "google-suspended-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "google-suspended-sub",
        email: "suspended@example.com",
        email_verified: true,
      },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_susp&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/login?error=auth_failed")
    expect(res.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // HAPPY PATH 1: Brand new user signup via Google
  // -------------------------------------------------------------------------
  test("happy path: brand new Google user signup creates user and issues session", async () => {
    const state = "state-new-user"
    const verifier = "verifier-new-user"
    const nonce = "nonce-new-user"

    const idToken = createSignedGoogleIdToken({
      email: "new.developer@example.com",
      sub: "new-dev-sub",
      nonce,
      email_verified: true,
      picture: "https://example.com/avatar.jpg",
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "new-dev-sub",
        email: "new.developer@example.com",
        email_verified: true,
        picture: "https://example.com/avatar.jpg",
      },
    })

    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_new&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/app/dashboard")

    // Session cookie set
    const cookieHeader = res.headers.get("set-cookie") || ""
    expect(cookieHeader.includes(`${SESSION_COOKIE}=`)).toBe(true)

    // User created in DB with welcome credits and active subscription
    expect(users.length).toBe(1)
    expect(users[0].email).toBe("new.developer@example.com")
    expect(users[0].google_id).toBe("new-dev-sub")
    expect(users[0].avatar_url).toBe("https://example.com/avatar.jpg")
    expect(subscriptions[0].status).toBe("active")
    expect(credits[0].balance_dt).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // HAPPY PATH 2: Explicit linking when already logged in
  // -------------------------------------------------------------------------
  test("happy path: logged-in password user explicitly links Google account", async () => {
    // Seed existing password account
    users.push({
      id: "legit-user-id",
      email: "alice@company.com",
      password_hash: "bcrypt_or_argon_hash",
      role: "user",
      google_id: null,
      avatar_url: null,
    })
    subscriptions.push({
      user_id: "legit-user-id",
      tier: "free",
      status: "active",
    })

    const state = "state-link"
    const verifier = "verifier-link"
    const nonce = "nonce-link"

    const idToken = createSignedGoogleIdToken({
      email: "alice@company.com",
      sub: "alice-company-google-sub",
      nonce,
      email_verified: true,
    })

    mockGoogleEndpoints({
      idToken,
      userinfo: {
        sub: "alice-company-google-sub",
        email: "alice@company.com",
        email_verified: true,
      },
    })

    // User is logged in to legit-user-id and has LINK_USER_COOKIE set
    const req = new Request(`http://localhost:8787/auth/google/callback?code=code_link&state=${state}`, {
      headers: {
        Cookie: `${STATE_COOKIE}=${state}; ${VERIFIER_COOKIE}=${verifier}; ${NONCE_COOKIE}=${nonce}; ${LINK_USER_COOKIE}=legit-user-id`,
      },
    })

    const res = await app.request(req)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/zencode/app/dashboard")

    // Successfully linked Google ID
    const user = users.find((u) => u.id === "legit-user-id")!
    expect(user.google_id).toBe("alice-company-google-sub")
  })
})
