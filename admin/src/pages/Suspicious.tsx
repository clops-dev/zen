import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { listFlaggedAccounts, actOnFlaggedAccount, type FlaggedAccount } from "../api"
import { ShieldAlert, CheckCircle, Snowflake, Ban, AlertTriangle } from "lucide-react"
import clsx from "clsx"

export function SuspiciousPage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<string>("all")
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ["flagged-accounts"],
    queryFn: listFlaggedAccounts,
    refetchInterval: 10000,
  })

  const actMutation = useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: "approve" | "freeze_credits" | "suspend" }) =>
      actOnFlaggedAccount(userId, action),
    onSuccess: () => {
      setActionError(null)
      qc.invalidateQueries({ queryKey: ["flagged-accounts"] })
    },
    onError: (err: any) => {
      setActionError(err?.message ?? "Action failed")
    },
  })

  const accounts = data?.flagged_accounts ?? []
  const filtered = accounts.filter((a) => {
    if (filter === "all") return true
    if (filter === "pending") return a.status === "pending"
    if (filter === "frozen") return a.status === "frozen" || a.credits_frozen
    if (filter === "suspended") return a.status === "suspended" || a.user_status === "suspended"
    if (filter === "approved") return a.status === "approved"
    return true
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-6 text-bad" />
            <h1 className="text-2xl font-semibold tracking-tight">Suspicious accounts</h1>
          </div>
          <p className="text-muted text-sm mt-0.5">
            Accounts flagged by multi-layered risk scoring (device collisions, proxy hopping, disposable domains, CGNAT velocity).
          </p>
        </div>

        <div className="flex items-center gap-2">
          {["all", "pending", "frozen", "suspended", "approved"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md capitalize transition",
                filter === f
                  ? "bg-accent text-bg"
                  : "bg-panel border border-line text-muted hover:text-fg"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="card p-3 border border-bad/30 text-bad text-sm flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted text-sm">Loading flagged accounts...</div>
        ) : error ? (
          <div className="p-8 text-center text-bad text-sm">Failed to load flagged accounts.</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">No accounts found matching filter.</div>
        ) : (
          <table className="table-clean">
            <thead>
              <tr>
                <th>Account</th>
                <th>Risk Level</th>
                <th>Score</th>
                <th>Matched Signals</th>
                <th>Credits Status</th>
                <th>Review Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const signalsEntries = Object.entries(item.signals || {})
                const isPending = item.status === "pending"

                return (
                  <tr key={item.id} className={clsx(isPending && "bg-bad/5")}>
                    <td>
                      <div className="font-medium text-sm">{item.email}</div>
                      {item.canonical_email && item.canonical_email !== item.email && (
                        <div className="text-[11px] text-muted font-mono">
                          canon: {item.canonical_email}
                        </div>
                      )}
                      <div className="text-[10px] text-muted mt-0.5">
                        {new Date(item.created_at).toLocaleString()}
                      </div>
                    </td>
                    <td>
                      <span
                        className={clsx(
                          "px-2 py-0.5 rounded text-xs font-semibold uppercase",
                          item.risk_level === "high"
                            ? "bg-bad/20 text-bad border border-bad/40"
                            : item.risk_level === "medium"
                            ? "bg-warn/20 text-warn border border-warn/40"
                            : "bg-ok/20 text-ok border border-ok/40"
                        )}
                      >
                        {item.risk_level}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono text-sm font-semibold">{item.risk_score}</span>
                    </td>
                    <td className="max-w-xs">
                      <div className="text-xs text-fg mb-1">{item.flag_reason}</div>
                      <div className="flex flex-wrap gap-1">
                        {signalsEntries.map(([k, v]) => (
                          <span
                            key={k}
                            className="inline-block bg-line/40 text-muted px-1.5 py-0.5 rounded text-[10px] font-mono"
                          >
                            {k}: {String(v)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {item.credits_frozen ? (
                        <span className="inline-flex items-center gap-1 text-bad text-xs font-medium">
                          <Snowflake className="size-3" />
                          Frozen
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-ok text-xs">
                          Active
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={clsx(
                          "text-xs font-medium capitalize",
                          item.status === "approved"
                            ? "text-ok"
                            : item.status === "suspended"
                            ? "text-bad"
                            : item.status === "frozen"
                            ? "text-warn"
                            : "text-muted font-semibold"
                        )}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          title="Approve account and unfreeze credits"
                          disabled={actMutation.isPending}
                          onClick={() => actMutation.mutate({ userId: item.user_id, action: "approve" })}
                          className="px-2 py-1 text-xs rounded border border-ok/40 text-ok hover:bg-ok/10 transition disabled:opacity-50 flex items-center gap-1"
                        >
                          <CheckCircle className="size-3.5" />
                          Approve
                        </button>
                        <button
                          title="Freeze welcome credits"
                          disabled={actMutation.isPending || item.credits_frozen}
                          onClick={() => actMutation.mutate({ userId: item.user_id, action: "freeze_credits" })}
                          className="px-2 py-1 text-xs rounded border border-warn/40 text-warn hover:bg-warn/10 transition disabled:opacity-50 flex items-center gap-1"
                        >
                          <Snowflake className="size-3.5" />
                          Freeze
                        </button>
                        <button
                          title="Suspend account completely"
                          disabled={actMutation.isPending || item.user_status === "suspended"}
                          onClick={() => actMutation.mutate({ userId: item.user_id, action: "suspend" })}
                          className="px-2 py-1 text-xs rounded border border-bad/40 text-bad hover:bg-bad/10 transition disabled:opacity-50 flex items-center gap-1"
                        >
                          <Ban className="size-3.5" />
                          Suspend
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
