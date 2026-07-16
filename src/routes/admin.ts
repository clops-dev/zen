import { Hono } from "hono"
import { sql } from "../lib/db"
import { requireAdmin } from "../middleware/session-auth"
import { layoutHtml, escape } from "../lib/html"

export const admin = new Hono()
admin.use("*", requireAdmin())

const maskKey = (key: string): string => {
  if (!key) return "(none)"
  return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "****"
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

admin.get("/", async (c) => {
  let err: string | null = null
  let today: any = {}
  let timeseries: any[] = []

  try {
    const [t] = await sql`
      SELECT
        count(*) FILTER (WHERE status = 'success')  AS success,
        count(*) FILTER (WHERE status = 'rejected') AS rejected,
        count(*) FILTER (WHERE status = 'failure')  AS failed,
        count(*) FILTER (WHERE from_cache)           AS cached,
        COALESCE(sum(cost_usd), 0)                   AS cost,
        count(DISTINCT user_id)                       AS active_users
      FROM ai_requests WHERE created_at >= date_trunc('day', now())
    `
    today = t

    timeseries = await sql`
      SELECT date_trunc('day', created_at) AS day, count(*) AS requests
      FROM ai_requests WHERE created_at >= now() - interval '14 days'
      GROUP BY day ORDER BY day
    ` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const max = Math.max(...timeseries.map((d) => Number(d.requests)), 1)
  const chart = timeseries.map((d) => {
    const h = Math.max(4, Math.round((Number(d.requests) / max) * 90))
    return `<div style="flex:1;height:${h}px;background:var(--amber);border-radius:2px 2px 0 0;opacity:0.85" title="${new Date(d.day).toLocaleDateString()}: ${d.requests} requests"></div>`
  }).join("")

  const body = `
  <h2>Overview</h2>
  <p class="muted" style="font-size:13px">Today, since midnight UTC</p>
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Successful</div><div class="val" style="color:var(--green)">${Number(today.success ?? 0).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Rejected</div><div class="val" style="color:var(--red)">${Number(today.rejected ?? 0).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="val" style="color:var(--red)">${Number(today.failed ?? 0).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">From cache</div><div class="val">${Number(today.cached ?? 0).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Cost today</div><div class="val" style="color:var(--amber)">$${Number(today.cost ?? 0).toFixed(4)}</div></div>
    <div class="stat-card"><div class="label">Active users</div><div class="val">${Number(today.active_users ?? 0)}</div></div>
  </div>

  <h2>Requests, last 14 days</h2>
  <div style="display:flex;align-items:flex-end;gap:4px;height:100px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px">${chart || '<span class="muted">no data yet</span>'}</div>
  `
  return c.html(layoutHtml("admin overview", "overview", body, { role: "admin", error: err }))
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

admin.get("/users", async (c) => {
  let err: string | null = null
  let rows: any[] = []
  try {
    rows = await sql`
      SELECT u.id, u.email, u.role, u.created_at,
        COALESCE(s.tier, 'free') AS tier, COALESCE(s.status, 'active') AS status,
        COALESCE(s.token_budget_monthly, 0) AS token_budget_monthly,
        COALESCE((SELECT total_input_tokens + total_output_tokens FROM monthly_usage
          WHERE user_id = u.id AND month = date_trunc('month', now())::date), 0) AS used_this_month,
        COALESCE((SELECT total_cost_usd FROM monthly_usage
          WHERE user_id = u.id AND month = date_trunc('month', now())::date), 0) AS cost_this_month
      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      ORDER BY u.created_at DESC LIMIT 200
    ` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const body = `
  <h2>Users (${rows.length})</h2>
  <table>
    <thead><tr><th>email</th><th>role</th><th>tier</th><th>status</th><th>budget/mo</th><th>used/mo</th><th>cost/mo</th><th></th></tr></thead>
    <tbody>
    ${rows.length ? rows.map(u => `<tr>
      <td>${escape(u.email)}</td>
      <td>${escape(u.role)}</td>
      <td>
        <form method="POST" action="/admin/users/${escape(u.id)}" style="display:inline">
          <select name="tier" onchange="this.form.requestSubmit()">
            ${["free", "pro", "enterprise"].map(t => `<option value="${t}" ${t === u.tier ? "selected" : ""}>${t}</option>`).join("")}
          </select>
          <input type="hidden" name="status" value="${escape(u.status)}">
          <input type="hidden" name="token_budget_monthly" value="${escape(u.token_budget_monthly)}">
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/users/${escape(u.id)}" style="display:inline">
          <select name="status" onchange="this.form.requestSubmit()">
            <option value="active" ${u.status === "active" ? "selected" : ""}>active</option>
            <option value="suspended" ${u.status === "suspended" ? "selected" : ""}>suspended</option>
          </select>
          <input type="hidden" name="tier" value="${escape(u.tier)}">
          <input type="hidden" name="token_budget_monthly" value="${escape(u.token_budget_monthly)}">
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/users/${escape(u.id)}" style="display:flex;gap:4px">
          <input type="hidden" name="tier" value="${escape(u.tier)}">
          <input type="hidden" name="status" value="${escape(u.status)}">
          <input name="token_budget_monthly" value="${escape(u.token_budget_monthly)}" style="width:100px">
          <button type="submit">Save</button>
        </form>
      </td>
      <td>${Number(u.used_this_month).toLocaleString()}</td>
      <td>$${Number(u.cost_this_month).toFixed(4)}</td>
      <td></td>
    </tr>`).join("") : `<tr><td colspan="8" class="muted" style="text-align:center">No users yet</td></tr>`}
    </tbody>
  </table>`

  return c.html(layoutHtml("users", "users", body, { role: "admin", error: err }))
})

admin.post("/users/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.parseBody()
  const tier = String(body.tier ?? "free")
  const status = String(body.status ?? "active")
  const budget = Number(body.token_budget_monthly ?? 50000)

  await sql`
    INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly) VALUES (${id}, ${tier}, ${status}, ${budget})
    ON CONFLICT (user_id) DO UPDATE SET tier = ${tier}, status = ${status}, token_budget_monthly = ${budget}
  `
  return c.redirect("/admin/users", 303)
})

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

admin.get("/providers", async (c) => {
  let err: string | null = null
  let rows: any[] = []
  try {
    rows = await sql`SELECT * FROM providers ORDER BY created_at DESC` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const body = `
  <h2>Providers</h2>
  <p class="muted" style="font-size:13px">Any OpenAI-compatible chat completions endpoint works — OpenRouter, Groq, a local Ollama instance, Together, Fireworks, DeepSeek direct, etc. Check <a href="https://models.dev" style="color:var(--amber)">models.dev</a> for base URLs and current pricing per provider. Leave API key blank for providers that don't need one (e.g. local Ollama).</p>
  <table>
    <thead><tr><th>name</th><th>base url</th><th>key</th><th>health</th><th>enabled</th><th></th></tr></thead>
    <tbody>
    ${rows.length ? rows.map(p => `<tr>
      <td>${escape(p.name)}</td>
      <td><code>${escape(p.base_url)}</code></td>
      <td><code>${escape(maskKey(p.api_key))}</code></td>
      <td><span class="badge ${p.healthy ? "success" : "rejected"}">${p.healthy ? "healthy" : "down (" + p.consecutive_failures + " fails)"}</span></td>
      <td><span class="badge ${p.enabled ? "success" : "rejected"}">${p.enabled ? "on" : "off"}</span></td>
      <td>
        <form method="POST" action="/admin/providers/${escape(p.id)}/toggle" style="display:inline"><button type="submit">${p.enabled ? "Disable" : "Enable"}</button></form>
        <form method="POST" action="/admin/providers/${escape(p.id)}/delete" style="display:inline" onsubmit="return confirm('Remove this provider and all its models?')"><button type="submit" class="danger">Remove</button></form>
      </td>
    </tr>`).join("") : `<tr><td colspan="6" class="muted" style="text-align:center">No providers configured yet</td></tr>`}
    </tbody>
  </table>

  <h2>Add provider</h2>
  <form method="POST" action="/admin/providers">
    <input name="name" placeholder="name (e.g. openrouter-main)" required style="width:180px">
    <input name="base_url" placeholder="https://openrouter.ai/api/v1" required style="width:260px">
    <input name="api_key" placeholder="API key (optional for local providers)" style="width:260px">
    <button type="submit" class="primary">Add</button>
  </form>`

  return c.html(layoutHtml("providers", "providers", body, { role: "admin", error: err }))
})

admin.post("/providers", async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name ?? "").trim()
  const base_url = String(body.base_url ?? "").trim().replace(/\/$/, "")
  const api_key = String(body.api_key ?? "").trim()
  if (name && base_url) {
    await sql`INSERT INTO providers (name, base_url, api_key) VALUES (${name}, ${base_url}, ${api_key})`
  }
  return c.redirect("/admin/providers", 303)
})

admin.post("/providers/:id/toggle", async (c) => {
  await sql`UPDATE providers SET enabled = NOT enabled WHERE id = ${c.req.param("id")}`
  return c.redirect("/admin/providers", 303)
})

admin.post("/providers/:id/delete", async (c) => {
  await sql`DELETE FROM providers WHERE id = ${c.req.param("id")}`
  return c.redirect("/admin/providers", 303)
})

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

admin.get("/models", async (c) => {
  let err: string | null = null
  let rows: any[] = []
  let providers: any[] = []
  try {
    rows = await sql`
      SELECT m.*, p.name AS provider_name FROM models m JOIN providers p ON p.id = m.provider_id
      ORDER BY p.name, m.model_id
    ` as any[]
    providers = await sql`SELECT id, name FROM providers WHERE enabled = true ORDER BY name` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const body = `
  <h2>Models</h2>
  <p class="muted" style="font-size:13px">Register a specific model id on a provider, with pricing pulled from <a href="https://models.dev" style="color:var(--amber)">models.dev</a> (verify against the provider's own pricing page before trusting it for billing).</p>
  <table>
    <thead><tr><th>provider</th><th>model id</th><th>label</th><th>input $/1M</th><th>output $/1M</th><th>context</th><th>enabled</th><th></th></tr></thead>
    <tbody>
    ${rows.length ? rows.map(m => `<tr>
      <td>${escape(m.provider_name)}</td>
      <td><code>${escape(m.model_id)}</code></td>
      <td>${escape(m.label ?? "—")}</td>
      <td>$${Number(m.input_price_per_1m).toFixed(4)}</td>
      <td>$${Number(m.output_price_per_1m).toFixed(4)}</td>
      <td>${m.context_window ?? "—"}</td>
      <td><span class="badge ${m.enabled ? "success" : "rejected"}">${m.enabled ? "on" : "off"}</span></td>
      <td>
        <form method="POST" action="/admin/models/${escape(m.id)}/toggle" style="display:inline"><button type="submit">${m.enabled ? "Disable" : "Enable"}</button></form>
        <form method="POST" action="/admin/models/${escape(m.id)}/delete" style="display:inline" onsubmit="return confirm('Remove this model?')"><button type="submit" class="danger">Remove</button></form>
      </td>
    </tr>`).join("") : `<tr><td colspan="8" class="muted" style="text-align:center">No models yet — add a provider first, then register a model here</td></tr>`}
    </tbody>
  </table>

  <h2>Add model</h2>
  ${providers.length ? `
  <form method="POST" action="/admin/models">
    <select name="provider_id">${providers.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join("")}</select>
    <input name="model_id" placeholder="model id (e.g. llama-3.3-70b-versatile)" required style="width:220px">
    <input name="label" placeholder="display label (optional)" style="width:160px">
    <input name="input_price_per_1m" placeholder="input $/1M" value="0" style="width:90px">
    <input name="output_price_per_1m" placeholder="output $/1M" value="0" style="width:90px">
    <input name="context_window" placeholder="context window" style="width:110px">
    <button type="submit" class="primary">Add</button>
  </form>` : `<p class="muted">Add a provider first (Providers tab) before you can register a model.</p>`}`

  return c.html(layoutHtml("models", "models", body, { role: "admin", error: err }))
})

admin.post("/models", async (c) => {
  const body = await c.req.parseBody()
  const provider_id = String(body.provider_id ?? "")
  const model_id = String(body.model_id ?? "").trim()
  const label = String(body.label ?? "").trim() || null
  const input_price = Number(body.input_price_per_1m ?? 0)
  const output_price = Number(body.output_price_per_1m ?? 0)
  const context_window = body.context_window ? Number(body.context_window) : null

  if (provider_id && model_id) {
    await sql`
      INSERT INTO models (provider_id, model_id, label, input_price_per_1m, output_price_per_1m, context_window)
      VALUES (${provider_id}, ${model_id}, ${label}, ${input_price}, ${output_price}, ${context_window})
      ON CONFLICT (provider_id, model_id) DO UPDATE SET
        label = ${label}, input_price_per_1m = ${input_price}, output_price_per_1m = ${output_price}, context_window = ${context_window}
    `
  }
  return c.redirect("/admin/models", 303)
})

admin.post("/models/:id/toggle", async (c) => {
  await sql`UPDATE models SET enabled = NOT enabled WHERE id = ${c.req.param("id")}`
  return c.redirect("/admin/models", 303)
})

admin.post("/models/:id/delete", async (c) => {
  await sql`DELETE FROM models WHERE id = ${c.req.param("id")}`
  return c.redirect("/admin/models", 303)
})

// ---------------------------------------------------------------------------
// Tier routing
// ---------------------------------------------------------------------------

admin.get("/routing", async (c) => {
  let err: string | null = null
  let rows: any[] = []
  let models: any[] = []
  try {
    rows = await sql`
      SELECT tr.id, tr.tier, tr.weight, p.name AS provider_name, m.model_id
      FROM tier_routes tr JOIN models m ON m.id = tr.model_id JOIN providers p ON p.id = m.provider_id
      ORDER BY tr.tier, tr.weight DESC
    ` as any[]
    models = await sql`
      SELECT m.id, p.name AS provider_name, m.model_id
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = true AND p.enabled = true ORDER BY p.name, m.model_id
    ` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const body = `
  <h2>Tier Routing</h2>
  <p class="muted" style="font-size:13px">Which model(s) serve each complexity tier a request gets classified into ("hi" → trivial, "build me a rest api with auth" → complex). Weight controls load balancing when multiple models share a tier. <b>If nothing is configured here at all, the gateway still works</b> — it falls back to any one enabled model, so you can test end-to-end before tuning this.</p>
  <table>
    <thead><tr><th>tier</th><th>provider/model</th><th>weight</th><th></th></tr></thead>
    <tbody>
    ${rows.length ? rows.map(r => `<tr>
      <td>${escape(r.tier)}</td><td><code>${escape(r.provider_name)}/${escape(r.model_id)}</code></td><td>${escape(r.weight)}</td>
      <td><form method="POST" action="/admin/routing/${escape(r.id)}/delete" style="display:inline" onsubmit="return confirm('Remove this route?')"><button type="submit" class="danger">Remove</button></form></td>
    </tr>`).join("") : `<tr><td colspan="4" class="muted" style="text-align:center">No routes configured — using the any-enabled-model fallback</td></tr>`}
    </tbody>
  </table>

  <h2>Add route</h2>
  ${models.length ? `
  <form method="POST" action="/admin/routing">
    <select name="tier"><option>trivial</option><option>simple</option><option>medium</option><option>complex</option></select>
    <select name="model_id">${models.map(m => `<option value="${escape(m.id)}">${escape(m.provider_name)}/${escape(m.model_id)}</option>`).join("")}</select>
    <input name="weight" placeholder="weight" value="1" style="width:70px">
    <button type="submit" class="primary">Add</button>
  </form>` : `<p class="muted">Add a provider and a model first before configuring routing.</p>`}`

  return c.html(layoutHtml("routing", "routing", body, { role: "admin", error: err }))
})

admin.post("/routing", async (c) => {
  const body = await c.req.parseBody()
  const tier = String(body.tier ?? "")
  const model_id = String(body.model_id ?? "")
  const weight = Number(body.weight ?? 1)
  if (tier && model_id) {
    await sql`
      INSERT INTO tier_routes (tier, model_id, weight) VALUES (${tier}, ${model_id}, ${weight})
      ON CONFLICT (tier, model_id) DO UPDATE SET weight = ${weight}
    `
  }
  return c.redirect("/admin/routing", 303)
})

admin.post("/routing/:id/delete", async (c) => {
  await sql`DELETE FROM tier_routes WHERE id = ${c.req.param("id")}`
  return c.redirect("/admin/routing", 303)
})

// ---------------------------------------------------------------------------
// Requests log
// ---------------------------------------------------------------------------

admin.get("/requests", async (c) => {
  let err: string | null = null
  let rows: any[] = []
  try {
    rows = await sql`
      SELECT r.created_at, u.email, r.model_label, r.status, r.reject_reason, r.cost_usd, r.latency_ms, r.from_cache
      FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC LIMIT 200
    ` as any[]
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }

  const body = `
  <h2>Recent requests (last 200)</h2>
  <table>
    <thead><tr><th>time</th><th>user</th><th>model</th><th>status</th><th>reason</th><th>cost</th><th>latency</th><th>cache</th></tr></thead>
    <tbody>
    ${rows.length ? rows.map(r => `<tr>
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>${escape(r.email ?? "—")}</td>
      <td><code>${escape(r.model_label)}</code></td>
      <td><span class="badge ${r.status === "success" ? "success" : "rejected"}">${escape(r.status)}</span></td>
      <td class="muted">${escape(r.reject_reason ?? "—")}</td>
      <td>$${Number(r.cost_usd).toFixed(6)}</td>
      <td>${r.latency_ms ? r.latency_ms + "ms" : "—"}</td>
      <td>${r.from_cache ? "hit" : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="8" class="muted" style="text-align:center">No requests logged yet</td></tr>`}
    </tbody>
  </table>`

  return c.html(layoutHtml("requests", "requests", body, { role: "admin", error: err }))
})
