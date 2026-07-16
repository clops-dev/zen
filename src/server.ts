import { Hono } from "hono"
import { auth } from "./routes/auth"
import { gateway } from "./routes/gateway"
import { web } from "./routes/web"
import { admin } from "./routes/admin"

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))

app.get("/", (c) => c.redirect("/login", 303))

app.onError((err, c) => {
  console.error("[zen-gateway] unhandled error:", err)
  const accept = c.req.header("Accept") ?? ""
  if (accept.includes("text/html")) {
    return c.html(
      `<!doctype html><body style="background:#0c0a09;color:#ff6467;font-family:monospace;padding:24px">
       <h1>Internal Server Error</h1>
       <pre style="background:#1c1917;color:#fafaf9;padding:16px;border-radius:6px;overflow:auto">${String(err instanceof Error ? err.stack ?? err.message : err).replace(/</g, "&lt;")}</pre>
       </body>`,
      500,
    )
  }
  return c.json({ error: "internal_server_error", message: err instanceof Error ? err.message : String(err) }, 500)
})

app.notFound((c) => {
  if ((c.req.header("Accept") ?? "").includes("text/html")) return c.html("<h1>404 not found</h1>", 404)
  return c.json({ error: "not_found", path: c.req.path }, 404)
})

// JSON API — used by the CLI (or scripted signups)
const v1 = new Hono()
v1.route("/auth", auth)
v1.route("/", gateway) // POST /v1/chat/completions, GET /v1/models
app.route("/v1", v1)

// Server-rendered web UI
app.route("/", web)      // /login, /signup, /dashboard, /logout
app.route("/admin", admin)

export default app
