export function escape(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch] as string))
}

const STYLE = `
  :root {
    --bg: #0c0a09; --panel: #1c1917; --panel-2: #262220; --line: #44403b;
    --text: #fafaf9; --muted: #a6a09b; --amber: #ffb454; --green: #3ddc84; --red: #ff6467;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; font-size: 14px; }
  a { color: inherit; text-decoration: none; }
  nav { display: flex; gap: 4px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel); align-items: center; }
  nav a { padding: 6px 12px; border-radius: 6px; color: var(--muted); font-size: 13px; }
  nav a.active, nav a:hover { color: var(--text); background: var(--panel-2); }
  nav .brand { font-weight: 600; margin-right: 12px; color: var(--amber); }
  nav .spacer { flex: 1; }
  main { max-width: 960px; margin: 0 auto; padding: 24px; }
  h1, h2 { font-weight: 600; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  h2:first-child { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; background: var(--panel-2); }
  tr:last-child td { border-bottom: none; }
  code { font-family: ui-monospace, "SF Mono", monospace; background: var(--panel-2); padding: 1px 5px; border-radius: 3px; font-size: 12.5px; }
  input, select, button { font-family: inherit; font-size: 13px; }
  input, select { background: var(--bg); border: 1px solid var(--line); color: var(--text); padding: 6px 9px; border-radius: 4px; }
  button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 6px 14px; border-radius: 4px; cursor: pointer; }
  button:hover { border-color: var(--amber); color: var(--amber); }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  button.primary { background: var(--amber); color: var(--bg); border-color: var(--amber); font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; }
  .badge.success { background: #16302280; color: var(--green); }
  .badge.rejected { background: #3a1818; color: var(--red); }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .stat-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
  .stat-card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; margin-bottom: 4px; }
  .stat-card .val { font-size: 20px; font-weight: 600; }
  .error-box { background: #3a1818; border: 1px solid var(--red); color: #ffc9c9; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .center-card { max-width: 360px; margin: 80px auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 28px; }
  .center-card h1 { text-align: center; font-size: 16px; margin-bottom: 20px; }
  .center-card form { display: flex; flex-direction: column; gap: 10px; }
  .center-card .switch { text-align: center; margin-top: 14px; font-size: 12.5px; color: var(--muted); }
  .muted { color: var(--muted); }
  code.mono-block { display: block; padding: 10px; white-space: pre-wrap; word-break: break-all; }
`

export function layoutHtml(title: string, activeNav: string, body: string, opts: {
  role?: "user" | "admin"
  error?: string | null
} = {}): string {
  const navItems = opts.role === "admin"
    ? [
        ["/dashboard", "dashboard", "Dashboard"],
        ["/admin", "overview", "Admin: Overview"],
        ["/admin/users", "users", "Users"],
        ["/admin/providers", "providers", "Providers"],
        ["/admin/models", "models", "Models"],
        ["/admin/routing", "routing", "Routing"],
        ["/admin/requests", "requests", "Requests"],
      ]
    : opts.role === "user"
    ? [["/dashboard", "dashboard", "Dashboard"]]
    : []

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — zen-gateway</title>
<style>${STYLE}</style></head>
<body>
${navItems.length ? `<nav>
  <span class="brand">zen-gateway</span>
  ${navItems.map(([href, key, label]) => `<a href="${href}" class="${activeNav === key ? "active" : ""}">${label}</a>`).join("")}
  <span class="spacer"></span>
  <form method="POST" action="/logout" style="margin:0"><button type="submit">Log out</button></form>
</nav>` : ""}
<main>
${opts.error ? `<div class="error-box">${escape(opts.error)}</div>` : ""}
${body}
</main>
</body></html>`
}
