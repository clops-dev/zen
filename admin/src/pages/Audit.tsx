import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { listAudit } from "../api"
import clsx from "clsx"

export function AuditPage() {
  const [resource, setResource] = useState("")
  const [action, setAction] = useState("")
  const [result, setResult] = useState("")
  const q = useQuery({
    queryKey: ["audit", { resource, action, result }],
    queryFn: () => listAudit({
      resource: resource || undefined,
      action: action || undefined,
      result: (result || undefined) as any,
      limit: 200,
    }),
  })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-muted text-sm mt-0.5">
          Every admin mutation is recorded here. Actor, action, resource, IP, and result.
        </p>
      </div>

      <div className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="label">Resource</span>
          <select className="input" value={resource} onChange={(e) => setResource(e.target.value)}>
            <option value="">any</option>
            {["user", "provider", "model", "routing", "combo", "api_key", "auth", "system"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Action contains</span>
          <input className="input" value={action} onChange={(e) => setAction(e.target.value)} placeholder="create" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Result</span>
          <select className="input" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">any</option>
            {["success", "failure", "denied"].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Result</th>
              <th>IP</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.events ?? []).map((e) => (
              <tr key={e.id}>
                <td className="text-xs">{new Date(e.created_at).toLocaleString()}</td>
                <td className="text-xs">{e.actor_email ?? <span className="text-muted">system</span>}</td>
                <td><code className="text-xs">{e.action}</code></td>
                <td><span className="chip chip-muted">{e.resource}</span></td>
                <td>
                  <span className={clsx("chip", e.result === "success" ? "chip-good" : e.result === "failure" ? "chip-bad" : "chip-muted")}>
                    {e.result}
                  </span>
                </td>
                <td className="text-xs font-mono">{e.ip ?? "—"}</td>
                <td className="text-xs max-w-md truncate">
                  <code>{JSON.stringify(e.metadata)}</code>
                </td>
              </tr>
            ))}
            {(q.data?.events ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">No events.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}