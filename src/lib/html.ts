export function escape(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch] as string))
}

const STYLE = `
  :root {
    --bg: #000; --panel: #0c0c0c; --panel-2: #171717; --line: #262626; --line-strong: #404040;
    --text: #f5f5f5; --muted: #8c8c8c; --accent: #ef4444; --good: #c8c8c8; --bad: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, "Inter", BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: "cv11", "ss01", "ss03";
  }
  a { color: inherit; text-decoration: none; }
  a.accent { color: var(--accent); }
  a.accent:hover { opacity: 0.85; }

  /* top nav */
  nav {
    display: flex; gap: 4px; padding: 14px 24px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    align-items: center;
  }
  nav .brand {
    font-weight: 600; margin-right: 16px; color: var(--text);
    display: inline-flex; align-items: center; gap: 8px;
    letter-spacing: -0.01em;
  }
  nav .brand .mark {
    width: 22px; height: 22px; border-radius: 6px;
    background: var(--accent); color: #fff;
    display: inline-grid; place-items: center; font-weight: 700; font-size: 13px;
  }
  nav a {
    padding: 6px 12px; border-radius: 6px;
    color: var(--muted); font-size: 13px;
    border: 1px solid transparent;
    transition: color 120ms, border-color 120ms, background 120ms;
  }
  nav a.active {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(239, 68, 68, 0.08);
  }
  nav a:hover { color: var(--text); }
  nav .spacer { flex: 1; }
  nav form { margin: 0; }

  /* layout */
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-weight: 600; font-size: 22px; letter-spacing: -0.01em; margin: 0 0 6px; }
  h2 {
    font-weight: 600; font-size: 13px;
    text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--muted); margin: 28px 0 12px;
  }
  h2:first-child { margin-top: 0; }
  p { margin: 0 0 12px; }
  p.lead { color: var(--muted); font-size: 14px; max-width: 60ch; }

  /* cards */
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 18px 20px;
  }
  .stat-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px; margin-bottom: 24px;
  }
  .stat-card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 14px 16px;
  }
  .stat-card .label {
    color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em;
    font-weight: 600; margin-bottom: 6px;
  }
  .stat-card .val { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .stat-card .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

  /* tables */
  table {
    width: 100%; border-collapse: separate; border-spacing: 0;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; margin-bottom: 16px;
    font-size: 13.5px;
  }
  th, td {
    text-align: left; padding: 12px 16px;
    border-bottom: 1px solid var(--line); font-size: 13px;
  }
  th {
    color: var(--muted); font-weight: 600;
    text-transform: uppercase; font-size: 11px; letter-spacing: 0.14em;
    background: var(--panel-2);
  }
  tr:last-child td { border-bottom: none; }

  /* form */
  input, select, button, textarea {
    font-family: inherit; font-size: 13.5px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 9px 12px;
    transition: border-color 120ms, box-shadow 120ms;
  }
  input::placeholder, textarea::placeholder { color: var(--muted); }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18);
  }
  button {
    cursor: pointer; padding: 9px 16px;
    font-weight: 500; color: var(--text); background: var(--panel-2);
    border-color: var(--line);
  }
  button:hover { border-color: var(--text); color: var(--text); }
  button.primary {
    background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600;
  }
  button.primary:hover { background: #dc2626; border-color: #dc2626; }
  button.danger {
    color: var(--text); background: transparent;
  }
  button.danger:hover { border-color: var(--bad); color: var(--bad); }

  .form-row { display: flex; gap: 8px; align-items: center; }
  .form-row input { flex: 0 0 auto; }

  /* chips / badges */
  .chip, .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 500;
    border: 1px solid var(--line); background: var(--panel-2);
    color: var(--text);
  }
  .badge.accent { color: var(--accent); border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.08); }
  .badge.good { color: var(--good); border-color: var(--line-strong); background: var(--panel-2); }
  .badge.rejected { color: var(--bad); border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.08); }
  .badge.muted { color: var(--muted); }

  /* centered card (auth pages) */
  .center-wrap {
    min-height: calc(100vh - 60px);
    display: grid; place-items: center;
    padding: 48px 24px;
  }
  .center-card {
    width: 100%; max-width: 380px;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 32px 28px;
  }
  .center-card .brandmark {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 20px; font-weight: 600; letter-spacing: -0.01em;
  }
  .center-card .brandmark .mark {
    width: 28px; height: 28px; border-radius: 7px;
    background: var(--accent); color: #fff;
    display: inline-grid; place-items: center; font-weight: 700; font-size: 15px;
  }
  .center-card h1 { text-align: left; font-size: 18px; margin: 0 0 4px; }
  .center-card .lead { font-size: 13px; margin: 0 0 18px; }
  .center-card form { display: flex; flex-direction: column; gap: 10px; }
  .center-card form button { width: 100%; padding: 10px 14px; }
  .center-card .switch {
    text-align: center; margin-top: 16px;
    font-size: 12.5px; color: var(--muted);
  }

  /* utility */
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, "SF Mono", monospace; }
  code {
    font-family: ui-monospace, "SF Mono", monospace;
    background: var(--panel-2); color: var(--text);
    padding: 1px 5px; border-radius: 3px; font-size: 12.5px;
    border: 1px solid var(--line);
  }
  code.mono-block {
    display: block; padding: 12px 14px;
    white-space: pre-wrap; word-break: break-all;
    background: var(--panel-2); border: 1px solid var(--line-strong);
    border-radius: 6px; font-size: 12.5px;
  }
  .error-box {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.4);
    color: #fca5a5;
    padding: 12px 14px; border-radius: 8px;
    margin-bottom: 18px; font-size: 13px;
  }
  .success-box {
    background: var(--panel-2);
    border: 1px solid var(--line-strong);
    color: var(--text);
    padding: 12px 14px; border-radius: 8px;
    margin-bottom: 18px; font-size: 13px;
  }

  /* tier pills in dashboard */
  .tier {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.1em;
    border: 1px solid var(--line-strong); color: var(--text);
    background: var(--panel-2);
  }
  .tier.pro { color: var(--accent); border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.08); }
  .tier.enterprise { color: var(--accent); border-color: var(--accent); background: var(--accent); color: #fff; }
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

  const brand = `<span class="brandmark"><span class="mark">z</span>zen-gateway</span>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(title)} — zen-gateway</title>
<style>${STYLE}</style></head>
<body>
${navItems.length ? `<nav>
  ${brand}
  ${navItems.map(([href, key, label]) => `<a href="${href}" class="${activeNav === key ? "active" : ""}">${label}</a>`).join("")}
  <span class="spacer"></span>
  <form method="POST" action="/logout" style="margin:0"><button type="submit" style="background:transparent">Log out</button></form>
</nav>` : ""}
${body}
</body></html>`
}
