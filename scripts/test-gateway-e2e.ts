// E2E test: chat completion routed through agentrouter provider.
const baseUrl = "http://localhost:8787"

async function login(): Promise<string> {
  const fd = new FormData()
  fd.append("email", "admin@zen.com")
  fd.append("password", "admin123456")
  const r = await fetch(`${baseUrl}/login`, {
    method: "POST",
    body: fd,
    redirect: "manual",
  })
  const cookie = r.headers.get("set-cookie")
  if (!cookie) throw new Error(`login failed: status=${r.status} body=${await r.text()}`)
  const match = cookie.match(/zen_session=([^;]+)/)
  if (!match) throw new Error(`no session cookie: ${cookie}`)
  return `zen_session=${match[1]}`
}

async function createApiKey(cookie: string): Promise<string> {
  const r = await fetch(`${baseUrl}/v1/auth/api-keys`, {
    method: "POST",
    headers: { Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "test-key" }),
  })
  if (!r.ok) throw new Error(`api key create failed: ${r.status} ${await r.text()}`)
  const j = await r.json()
  return j.api_key
}

async function chat(apiKey: string, model: string, content: string) {
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 64,
    }),
  })
  return { status: r.status, body: await r.text() }
}

const sessionCookie = await login()
console.log("logged in")
const apiKey = await createApiKey(sessionCookie)
console.log("api key:", apiKey)

console.log("\n=== /v1/models ===")
const modelsR = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
const modelsBody = await modelsR.json()
for (const m of modelsBody.data) console.log("  -", m.id, "(context_window:", m.context_window, ")")

console.log("\n=== chat via agentrouter/claude-opus-4-6 (only agentrouter enabled) ===")
const r1 = await chat(apiKey, "agentrouter/claude-opus-4-6", "只回复 OK, " + Math.random())
console.log("status:", r1.status)
console.log("body:", r1.body)

console.log("\n=== chat via agentrouter/claude-opus-4-7 ===")
const r2 = await chat(apiKey, "agentrouter/claude-opus-4-7", "只回复 OK, " + Math.random())
console.log("status:", r2.status)
console.log("body:", r2.body)

console.log("\n=== chat via agentrouter/claude-opus-4-8 ===")
const r3 = await chat(apiKey, "agentrouter/claude-opus-4-8", "只回复 OK, " + Math.random())
console.log("status:", r3.status)
console.log("body:", r3.body)