import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { listRequests } from "../api"
import { useToast } from "../ui/Toast"
import clsx from "clsx"

const STATUSES = ["", "success", "failure", "rejected"] as const

export function RequestsPage() {
  const [status, setStatus] = useState<string>("")
  const [provider, setProvider] = useState("")
  const [model, setModel] = useState("")
  const q = useQuery({
    queryKey: ["requests", { status, provider, model }],
    queryFn: () => listRequests({ status: status || undefined, provider: provider || undefined, model: model || undefined, limit: 200 }),
  })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="text-muted text-sm mt-0.5">
          Live stream of upstream attempts. Click a row for full metadata.
        </p>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Status</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s || "any"}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Provider contains</span>
            <input className="input" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="openrouter" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Model contains</span>
            <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
          </label>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Model</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.requests ?? []).map((r) => (
              <tr key={r.id}>
                <td className="text-xs">{new Date(r.created_at).toLocaleString()}</td>
                <td className="text-xs">{r.user_email ?? "—"}</td>
                <td><code className="text-xs">{r.model_label}</code></td>
                <td>
                  <span className={clsx("chip", r.status === "success" ? "chip-good" : r.status === "failure" ? "chip-bad" : "chip-muted")}>
                    {r.status}
                  </span>
                </td>
                <td className="text-xs">{r.latency_ms ? `${r.latency_ms}ms` : "—"}</td>
                <td className="text-xs">{Number(r.input_tokens + r.output_tokens).toLocaleString()}</td>
                <td className="text-xs">${Number(r.cost_usd).toFixed(6)}</td>
              </tr>
            ))}
            {(q.data?.requests ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">No requests match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}