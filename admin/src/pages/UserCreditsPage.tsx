import { useState } from "react"
import { useParams, Link } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Coins, Check, ArrowUpRight, ArrowDownRight, Clock } from "lucide-react"
import {
  getUserCredits,
  grantUserCredits,
  type AdminCreditTransaction,
} from "../api"
import { useToast } from "../ui/Toast"

// Valid grant amounts (multiples of 5)
const GRANT_PRESETS = [5, 10, 20, 50, 100] as const

const DT_PER_USD = 4

const TX_TYPE_LABELS: Record<string, string> = {
  purchase: "Purchase",
  admin_grant: "Admin Grant",
  usage: "AI Usage",
  refund: "Refund",
  adjustment: "Adjustment",
}

function formatDate(d: string) {
  return new Date(d).toLocaleString()
}

export function UserCreditsPage() {
  const { id } = useParams<{ id: string }>()
  const toast = useToast()
  const qc = useQueryClient()

  const [grantAmount, setGrantAmount] = useState<number>(20)
  const [grantNote, setGrantNote] = useState("")

  const q = useQuery({
    queryKey: ["user-credits", id],
    queryFn: () => getUserCredits(id!),
    enabled: !!id,
  })

  const grantMut = useMutation({
    mutationFn: ({ amount_dt, note }: { amount_dt: number; note: string }) =>
      grantUserCredits(id!, amount_dt, note || undefined),
    onSuccess: (data) => {
      toast("success", `Granted ${data.amount_dt} DT. New balance: ${data.new_balance_dt.toFixed(1)} DT`)
      setGrantNote("")
      qc.invalidateQueries({ queryKey: ["user-credits", id] })
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Grant failed")
    },
  })

  const data = q.data

  return (
    <div className="flex flex-col gap-5 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Link to="/users" className="btn-ghost flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" />
          Users
        </Link>
        <span className="text-muted">/</span>
        <span className="text-sm font-medium">{data?.user.email ?? id}</span>
        <span className="text-muted">/</span>
        <span className="text-sm text-muted">Credits</span>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Coins className="size-5 text-accent" />
          Credit Management
        </h1>
        <p className="text-muted text-sm mt-1">
          View and manage AI credit balance for {data?.user.email ?? "this user"}.
        </p>
      </div>

      {q.isLoading && (
        <div className="text-muted text-sm">Loading...</div>
      )}

      {q.isError && (
        <div className="rounded-md border border-bad/30 bg-bad/5 p-4 text-bad text-sm">
          Failed to load credit data.
        </div>
      )}

      {data && (
        <>
          {/* Balance card */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-md border border-line p-4 md:col-span-1">
              <div className="text-[11px] uppercase tracking-widest text-muted font-semibold mb-1">Balance</div>
              <div className="text-3xl font-bold tabular-nums">
                {data.balance.balance_dt.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </div>
              <div className="text-sm text-accent font-semibold">DT</div>
              <div className="text-xs text-muted mt-1">
                ≈ ${data.balance.balance_usd_value.toFixed(2)} AI usage value
              </div>
            </div>

            <div className="rounded-md border border-line p-4">
              <div className="text-[11px] uppercase tracking-widest text-muted font-semibold mb-1">Exchange Rate</div>
              <div className="text-xl font-semibold">1 DT = $0.25</div>
              <div className="text-xs text-muted mt-1">AI usage value</div>
            </div>

            <div className="rounded-md border border-line p-4">
              <div className="text-[11px] uppercase tracking-widest text-muted font-semibold mb-1">Status</div>
              <div className="flex items-center gap-2 mt-1">
                {data.balance.balance_dt > 0 ? (
                  <>
                    <span className="chip chip-good">Credit Account</span>
                    <span className="text-xs text-muted">Bypasses free quota</span>
                  </>
                ) : (
                  <>
                    <span className="chip chip-muted">Free Tier</span>
                    <span className="text-xs text-muted">Subject to token budget</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Grant credits form */}
          <div className="card p-5">
            <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
              <Check className="size-4 text-accent" />
              Grant Credits
            </h2>

            <div className="space-y-4">
              {/* Preset buttons */}
              <div>
                <label className="text-xs text-muted uppercase tracking-wider font-semibold block mb-2">
                  Amount (DT)
                </label>
                <div className="flex flex-wrap gap-2">
                  {GRANT_PRESETS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setGrantAmount(p)}
                      className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
                        grantAmount === p
                          ? "bg-accent text-white border-accent"
                          : "border-line hover:border-accent/50 hover:bg-accent/10"
                      }`}
                    >
                      {p} DT
                      <span className="ml-1 text-xs opacity-70">
                        (${(p / DT_PER_USD).toFixed(2)})
                      </span>
                    </button>
                  ))}
                </div>
                {/* Custom amount */}
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs text-muted">Custom (multiple of 5):</label>
                  <input
                    type="number"
                    min={5}
                    max={10000}
                    step={5}
                    value={grantAmount}
                    onChange={(e) => setGrantAmount(Number(e.target.value))}
                    className="input w-28 text-sm"
                  />
                  <span className="text-xs text-muted">DT</span>
                </div>
              </div>

              {/* Note */}
              <div>
                <label className="text-xs text-muted uppercase tracking-wider font-semibold block mb-2">
                  Note (optional)
                </label>
                <input
                  type="text"
                  maxLength={500}
                  placeholder="e.g. Promotional credit, support request..."
                  value={grantNote}
                  onChange={(e) => setGrantNote(e.target.value)}
                  className="input w-full"
                />
              </div>

              {/* Summary */}
              <div className="text-xs text-muted bg-accent/5 border border-accent/20 rounded p-3">
                Granting <strong>{grantAmount} DT</strong> (≈ ${(grantAmount / DT_PER_USD).toFixed(2)} AI usage value)
                to <strong>{data.user.email}</strong>. 
                New balance will be <strong>{(data.balance.balance_dt + grantAmount).toFixed(1)} DT</strong>.
              </div>

              <button
                disabled={grantMut.isPending || grantAmount < 5 || grantAmount % 5 !== 0}
                onClick={() => grantMut.mutate({ amount_dt: grantAmount, note: grantNote })}
                className="btn-primary"
              >
                {grantMut.isPending ? "Granting..." : `Grant ${grantAmount} DT`}
              </button>
            </div>
          </div>

          {/* Transaction history */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <h2 className="text-sm font-semibold">Transaction History</h2>
              <span className="text-xs text-muted">{data.transactions.length} records</span>
            </div>
            {data.transactions.length === 0 ? (
              <div className="text-center text-muted py-8 text-sm">No transactions yet.</div>
            ) : (
              <table className="table-clean">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                    <th>Note</th>
                    <th>Created by</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transactions.map((tx: AdminCreditTransaction) => {
                    const isCredit = tx.amount_dt > 0
                    return (
                      <tr key={tx.id}>
                        <td>
                          <div className="flex items-center gap-1.5">
                            {isCredit
                              ? <ArrowUpRight className="size-3 text-good" />
                              : <ArrowDownRight className="size-3 text-muted" />
                            }
                            <span className="text-sm">{TX_TYPE_LABELS[tx.type] ?? tx.type}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`chip text-xs ${
                            tx.status === "completed" ? "chip-good"
                            : tx.status === "pending" ? "chip-muted"
                            : "chip-bad"
                          }`}>
                            {tx.status === "pending" && <Clock className="size-3 mr-1 inline" />}
                            {tx.status}
                          </span>
                        </td>
                        <td className="text-right font-mono text-sm font-semibold tabular-nums">
                          <span className={isCredit ? "text-good" : ""}>
                            {isCredit ? "+" : ""}{tx.amount_dt.toFixed(4)} DT
                          </span>
                        </td>
                        <td className="text-xs text-muted max-w-[200px] truncate">
                          {tx.admin_note ?? (tx.type === "usage" ? "CLI request" : "—")}
                        </td>
                        <td className="text-xs text-muted">
                          {tx.created_by_email ?? "—"}
                        </td>
                        <td className="text-xs text-muted whitespace-nowrap">
                          {formatDate(tx.created_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
