import { useQuery } from "@tanstack/react-query"
import { Cpu, KeyRound, Server, Users, Wallet, Boxes } from "lucide-react"
import { settings } from "../api"

export function SettingsPage() {
  const q = useQuery({ queryKey: ["settings"], queryFn: settings })
  const s = q.data?.summary

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted text-sm mt-0.5">Runtime summary and gateway configuration.</p>
      </div>

      <section className="card p-5">
        <h2 className="font-semibold mb-4">Gateway at a glance</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Tile icon={<Users className="size-4" />} label="Users" value={s?.users_total ?? "—"} />
          <Tile icon={<Users className="size-4" />} label="Suspended" value={s?.users_suspended ?? 0} accent={s?.users_suspended > 0 ? "bad" : undefined} />
          <Tile icon={<Server className="size-4" />} label="Providers (active)" value={s?.providers_active ?? 0} />
          <Tile icon={<Cpu className="size-4" />} label="Models (active)" value={s?.models_active ?? 0} />
          <Tile icon={<KeyRound className="size-4" />} label="API keys (active)" value={s?.api_keys_active ?? 0} />
          <Tile icon={<Boxes className="size-4" />} label="Combos (active)" value={s?.combos_active ?? 0} />
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold mb-2">Runtime</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Row k="APP_URL" v={q.data?.env?.app_url ?? "—"} />
          <Row k="PORT" v={q.data?.env?.port ?? "—"} />
        </dl>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold mb-2">Notes</h2>
        <ul className="list-disc list-inside text-sm text-muted space-y-1">
          <li>All admin mutations go through the JSON API at <code>/admin-api</code> and are recorded in <code>audit_logs</code>.</li>
          <li>Provider API keys are stored server-side and only masked previews are returned to the SPA.</li>
          <li>For per-user quota and usage stats, see the legacy <a href="/dashboard" className="text-accent">/dashboard</a> page.</li>
        </ul>
      </section>
    </div>
  )
}

function Tile({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: "bad" }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted">
        <span>{label}</span>{icon}
      </div>
      <div className={"mt-1 text-xl font-semibold " + (accent === "bad" ? "text-bad" : "")}>{value}</div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-line py-1.5">
      <dt className="text-muted text-xs uppercase tracking-wider">{k}</dt>
      <dd className="font-mono text-xs">{v}</dd>
    </div>
  )
}