import { Hono } from "hono"
import { auth } from "./routes/auth"
import { deviceAuth } from "./routes/device-auth"
import { gateway } from "./routes/gateway"
import { web } from "./routes/web"
import { adminApi } from "./routes/admin-api"
import { requestId } from "./middleware/request-id"
import { readyz } from "./lib/readiness"
import { log } from "./lib/logger"

import { sql, withDbResilience, isTransientDbError } from "./lib/db"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const app = new Hono()
const isProd = (process.env.NODE_ENV ?? "development") === "production"

// Request-id is first so every other middleware and every log line can
// stamp the same correlation id. Mount it before the routes (which don't
// add it themselves).
app.use("*", requestId())

// ---------------------------------------------------------------------------
// Health / readiness endpoints.
//
//   /livez   — liveness. Process is alive and answering HTTP. Does NOT
//              touch the DB. Orchestrators/HAProxy use this to decide
//              whether to restart the container.
//   /readyz  — readiness. Process can serve user traffic. False during
//              graceful shutdown (so the LB stops sending new requests)
//              and false if Postgres is unreachable. LB uses this to
//              gate traffic.
//   /healthz — legacy. Same shape as before (DB-coupled); kept for
//              backwards compatibility with existing operators.
//   /version — build metadata for ops verification.
// ---------------------------------------------------------------------------
app.get("/livez", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }))

app.get("/readyz", async (c) => {
  const r = await readyz()
  return c.json({ ...r, timestamp: new Date().toISOString() }, r.ready ? 200 : 503)
})

app.get("/version", (c) => c.json({
  name: "zen-gateway",
  version: process.env.VERSION ?? "dev",
  git_sha: process.env.GIT_SHA ?? "unknown",
  node_env: process.env.NODE_ENV ?? "development",
  bun: typeof Bun !== "undefined" ? Bun.version : null,
  timestamp: new Date().toISOString(),
}))

app.get("/healthz", async (c) => {
  let dbOk = false
  let dbError: string | null = null
  try {
    await withDbResilience(() => sql`SELECT 1`)
    dbOk = true
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
    log.error("/healthz db check failed", { request_id: c.get("requestId") }, err)
  }

  const ok = dbOk
  return c.json({
    ok,
    db: dbOk ? "ok" : "error",
    ...(dbError ? { db_error: dbError } : {}),
    transient_db_error: dbError ? isTransientDbError(new Error(dbError)) : false,
    timestamp: new Date().toISOString()
  }, ok ? 200 : 503)
})

app.get("/", (c) => c.redirect("/login", 303))

app.onError((err, c) => {
  log.error("unhandled_error", { request_id: c.get("requestId"), path: c.req.path }, err)
  const accept = c.req.header("Accept") ?? ""
  if (accept.includes("text/html")) {
    if (isProd) {
      return c.html(
        `<!doctype html><body style="background:#0c0a09;color:#ff6467;font-family:monospace;padding:24px">
         <h1>Internal Server Error</h1>
         <p style="color:#fafaf9">Something went wrong. Please try again later.</p>
         </body>`,
        500,
      )
    }
    return c.html(
      `<!doctype html><body style="background:#0c0a09;color:#ff6467;font-family:monospace;padding:24px">
       <h1>Internal Server Error</h1>
       <pre style="background:#1c1917;color:#fafaf9;padding:16px;border-radius:6px;overflow:auto">${String(err instanceof Error ? err.stack ?? err.message : err).replace(/</g, "&lt;")}</pre>
       </body>`,
      500,
    )
  }
  if (isProd) {
    return c.json({ error: "internal_server_error" }, 500)
  }
  return c.json({ error: "internal_server_error", message: err instanceof Error ? err.message : String(err) }, 500)
})

// JSON API — used by the CLI (or scripted signups)
const v1 = new Hono()
v1.route("/auth", auth)
v1.route("/auth", deviceAuth) // POST /v1/auth/device/start, GET /v1/auth/device/poll
v1.route("/", gateway) // POST /v1/chat/completions, GET /v1/models
app.route("/v1", v1)

// Legacy user-facing web UI (login / signup / per-user dashboard /
// device-pair page). The previous SSR admin surface at /admin was a
// quick prototype — we removed it in favour of the React SPA at /admin2,
// so redirect any old /admin bookmarks to the new surface.
app.route("/", web)

// Legacy /admin redirects to the new SPA. Both `/admin` and `/admin/*`
// bounce — the SPA uses /admin2/* and is not served from /admin/*.
app.get("/admin", (c) => c.redirect("/admin2", 303))
app.get("/admin/*", (c) => c.redirect("/admin2", 303))

// JSON admin API for the new SPA.
app.route("/admin-api", adminApi)

// New SPA (built by admin/dist). Mounted at /admin2. Vite is configured
// with `base: "/admin2/"`, so the built index.html references assets at
// `/admin2/assets/...` and we just serve them straight from disk.
const here = path.dirname(fileURLToPath(import.meta.url))
const spaDir = path.resolve(here, "..", "admin", "dist")

if (existsSync(spaDir) && statSync(spaDir).isDirectory()) {
  app.get("/admin2/assets/*", (c) => {
    const rel = c.req.path.replace(/^\/admin2\//, "")
    const filePath = path.join(spaDir, rel)
    if (!filePath.startsWith(spaDir)) return c.text("forbidden", 403)
    return new Response(Bun.file(filePath))
  })

  // SPA fallback. Hono's wildcard pattern is `/*` (slash-asterisk), not
  // bare `*` — register the bare `/admin2` and `/admin2/*` (any subpath)
  // so client-side routes (combos/:id, providers/:id, etc.) resolve when
  // navigated directly.
  const indexHtml = Bun.file(path.join(spaDir, "index.html"))
  const serveIndex = () => new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
  app.get("/admin2", serveIndex)
  app.get("/admin2/*", serveIndex)
} else {
  const placeholder = (c: any) =>
    c.html(
      `<!doctype html><meta charset=utf-8>
      <body style="background:#0c0a09;color:#fafaf9;font-family:system-ui;padding:48px">
      <h1 style="color:#ffb454">zen-gateway admin SPA</h1>
      <p>Built bundle not found. Run the build once:</p>
      <pre style="background:#1c1917;color:#ffb454;padding:12px;border-radius:6px">cd admin && bun install && bun run build</pre>
      <p>After that, /admin2 will serve the React SPA. The legacy HTML admin at <a href="/admin" style="color:#ffb454">/admin</a> has been removed.</p>
      </body>`,
      503,
    )
  app.get("/admin2", placeholder)
  app.get("/admin2/*", placeholder)
}

app.notFound((c) => {
  if ((c.req.header("Accept") ?? "").includes("text/html")) return c.html("<h1>404 not found</h1>", 404)
  return c.json({ error: "not_found", path: c.req.path }, 404)
})

export default app