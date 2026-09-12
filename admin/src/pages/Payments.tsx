import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Coins,
  DollarSign,
  TrendingUp,
  ArrowUpRight,
  Calculator,
  Search,
  Check,
  User,
  Plus,
  ShieldCheck,
  Zap,
} from "lucide-react"
import {
  listPaymentDemands,
  confirmPaymentDemand,
  rejectPaymentDemand,
  grantUserCredits,
  walletSummary,
  listUsers,
  type PaymentDemand,
  type User as UserType,
} from "../api"
import { useToast } from "../ui/Toast"

const DEAL_PRESETS = [
  { dt: 15, usd: 5, label: "15 DT ($5 USD)" },
  { dt: 30, usd: 10, label: "30 DT ($10 USD)" },
  { dt: 45, usd: 15, label: "45 DT ($15 USD)" },
  { dt: 60, usd: 20, label: "60 DT ($20 USD)" },
  { dt: 150, usd: 50, label: "150 DT ($50 USD)" },
] as const

export function PaymentsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [searchParams] = useSearchParams()
  const preselectedUserId = searchParams.get("userId") ?? ""

  const [selectedUserId, setSelectedUserId] = useState<string>(preselectedUserId)
  const [grantAmount, setGrantAmount] = useState<number>(15)
  const [grantNote, setGrantNote] = useState<string>("")
  const [searchTerm, setSearchTerm] = useState<string>("")
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)

  // 1. Fetch pending demands
  const demandsQuery = useQuery({
    queryKey: ["paymentDemands"],
    queryFn: listPaymentDemands,
    refetchInterval: 10000,
  })

  // 2. Fetch wallet summary for totals and revenue metrics
  const walletQuery = useQuery({
    queryKey: ["walletSummary"],
    queryFn: walletSummary,
    refetchInterval: 30000,
  })

  // 3. Fetch users for grant selection
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: listUsers,
  })

  const demands = demandsQuery.data?.demands ?? []
  const totals = walletQuery.data?.totals
  const users = usersQuery.data?.users ?? []

  // Confirm demand mutation
  const confirmMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => confirmPaymentDemand(id, note),
    onSuccess: (res) => {
      toast("success", `Payment demand confirmed! Granted ${res.amount_dt} DT. New balance: ${res.new_balance_dt.toFixed(1)} DT`)
      setConfirmingId(null)
      qc.invalidateQueries({ queryKey: ["paymentDemands"] })
      qc.invalidateQueries({ queryKey: ["walletSummary"] })
      qc.invalidateQueries({ queryKey: ["users"] })
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Failed to confirm payment demand")
      setConfirmingId(null)
    },
  })

  // Reject demand mutation
  const rejectMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => rejectPaymentDemand(id, note),
    onSuccess: () => {
      toast("info", "Payment demand rejected")
      setRejectingId(null)
      qc.invalidateQueries({ queryKey: ["paymentDemands"] })
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Failed to reject demand")
      setRejectingId(null)
    },
  })

  // Manual grant mutation
  const grantMut = useMutation({
    mutationFn: ({ userId, amount_dt, note }: { userId: string; amount_dt: number; note?: string }) =>
      grantUserCredits(userId, amount_dt, note),
    onSuccess: (res) => {
      toast("success", `Successfully granted ${res.amount_dt} DT to ${res.user.email}! New balance: ${res.new_balance_dt.toFixed(1)} DT`)
      setGrantNote("")
      qc.invalidateQueries({ queryKey: ["walletSummary"] })
      qc.invalidateQueries({ queryKey: ["users"] })
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Failed to grant credits")
    },
  })

  // Format currency helpers
  const revDt = parseFloat(totals?.total_revenue_dt ?? "0")
  const revUsd = parseFloat(totals?.total_revenue_usd ?? totals?.total_subscription_income_usd ?? "0")
  const apiCostUsd = parseFloat(totals?.total_usage_cost_usd ?? "0")
  const netIncomeUsd = parseFloat(totals?.total_net_income_usd ?? "0")
  const marginPct = totals?.profit_margin_pct ?? (revUsd > 0 ? (netIncomeUsd / revUsd) * 100 : 0)

  const filteredUsers = useMemo(() => {
    if (!searchTerm) return users
    const s = searchTerm.toLowerCase()
    return users.filter((u: UserType) => u.email.toLowerCase().includes(s) || u.id.includes(s))
  }, [users, searchTerm])

  return (
    <div className="space-y-6 pb-12">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-accent/15 text-accent border border-accent/30 shadow-sm">
              <CreditCard className="size-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-text">
                  Payment Demands & Credits Management
                </h1>
                {demands.length > 0 && (
                  <span className="chip bg-amber-500/15 text-amber-400 border-amber-500/30 font-bold px-2 py-0.5 text-xs">
                    {demands.length} Pending
                  </span>
                )}
              </div>
              <p className="text-xs text-muted mt-0.5">
                Review user top-up demands, confirm credit grants ($5 = 15 DT deal), and monitor revenue accounting.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              demandsQuery.refetch()
              walletQuery.refetch()
              usersQuery.refetch()
            }}
            disabled={demandsQuery.isRefetching || walletQuery.isRefetching}
            className="btn btn-secondary text-xs flex items-center gap-2"
          >
            <RefreshCw className={`size-3.5 ${demandsQuery.isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Overview Financial KPI Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Revenue in DT */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-accent/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total Revenue (DT)</span>
            <div className="size-8 rounded-lg bg-accent/15 text-accent grid place-items-center">
              <Coins className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-accent tracking-tight font-mono">
            {revDt.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} DT
          </div>
          <div className="mt-2 text-[11px] text-muted flex items-center gap-1">
            <span>Package Deal: 15 DT = $5 USD</span>
          </div>
        </div>

        {/* Total Revenue in USD */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-emerald-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total Revenue (USD)</span>
            <div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-400 grid place-items-center">
              <DollarSign className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-emerald-400 tracking-tight font-mono">
            ${revUsd.toFixed(2)}
          </div>
          <div className="mt-2 text-[11px] text-muted">
            Formula: Revenue DT / 3
          </div>
        </div>

        {/* Total API Cost in USD */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-amber-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total API Cost (USD)</span>
            <div className="size-8 rounded-lg bg-amber-500/10 text-amber-400 grid place-items-center">
              <Zap className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-amber-400 tracking-tight font-mono">
            ${apiCostUsd.toFixed(4)}
          </div>
          <div className="mt-2 text-[11px] text-muted">
            LLM provider token costs
          </div>
        </div>

        {/* Net Profit & Profit Margin */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-blue-500/5 border-accent/30">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Net Profit (USD)</span>
            <div className="size-8 rounded-lg bg-blue-500/10 text-blue-400 grid place-items-center">
              <ArrowUpRight className="size-4" />
            </div>
          </div>
          <div className={`text-2xl font-extrabold tracking-tight font-mono ${netIncomeUsd >= 0 ? "text-emerald-400" : "text-bad"}`}>
            ${netIncomeUsd.toFixed(2)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
            <span>Profit Margin:</span>
            <span className="font-bold text-accent">{marginPct.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Interactive Financial Formula Card */}
      <div className="card p-5 border-accent/20 bg-panel/70 relative overflow-hidden">
        <div className="flex items-center gap-2 mb-3">
          <Calculator className="size-5 text-accent" />
          <h2 className="text-sm font-semibold tracking-tight uppercase text-accent">
            Financial Revenue & Profit Formula Breakdown
          </h2>
        </div>
        <p className="text-xs text-muted mb-4">
          Overview of pricing rules, currency conversions, and gross profit calculations for your platform balance.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs">
          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">1. Exchange Deal Rate</div>
            <div className="text-sm font-bold text-accent">15 DT = $5.00 USD</div>
            <div className="text-[11px] text-muted font-sans">1 USD = 3 DT (1 DT ≈ $0.333 USD)</div>
          </div>

          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">2. Revenue USD Formula</div>
            <div className="text-sm font-bold text-emerald-400">
              Revenue ($) = DT / 3
            </div>
            <div className="text-[11px] text-muted font-sans">
              ${revUsd.toFixed(2)} USD from {revDt.toFixed(1)} DT
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">3. Net Profit Formula</div>
            <div className="text-sm font-bold text-blue-400">
              Net Profit = Rev ($) - API Cost ($)
            </div>
            <div className="text-[11px] text-muted font-sans">
              ${revUsd.toFixed(2)} - ${apiCostUsd.toFixed(2)} = ${netIncomeUsd.toFixed(2)} ({marginPct.toFixed(1)}% margin)
            </div>
          </div>
        </div>
      </div>

      {/* Pending User Demands Section */}
      <div className="card overflow-hidden border-line">
        <div className="p-4 border-b border-line bg-panel/50 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text flex items-center gap-2">
              <Clock className="size-4 text-amber-400" />
              Pending User Demands (Top-up Requests)
              <span className="chip chip-muted text-xs">{demands.length} pending</span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Review credit purchase requests submitted by users and grant credits directly to their wallet.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>User Email</th>
                <th>Requested Amount (DT)</th>
                <th>Equivalent (USD)</th>
                <th>Request Date</th>
                <th>Status</th>
                <th>Notes / Ref</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {demands.map((d: PaymentDemand) => (
                <tr key={d.id} className="hover:bg-line/10">
                  <td>
                    <div className="font-semibold text-text">{d.email}</div>
                    <div className="text-[10px] text-muted font-mono">{d.user_id}</div>
                  </td>
                  <td>
                    <span className="font-bold font-mono text-accent text-sm">
                      +{d.amount_dt} DT
                    </span>
                  </td>
                  <td>
                    <span className="font-mono text-emerald-400 text-sm">
                      ${d.amount_usd.toFixed(2)} USD
                    </span>
                  </td>
                  <td className="text-xs text-muted">
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td>
                    <span className="chip bg-amber-500/15 text-amber-400 border-amber-500/30 text-xs flex items-center gap-1 w-fit">
                      <Clock className="size-3" />
                      Pending Approval
                    </span>
                  </td>
                  <td className="text-xs text-muted max-w-xs truncate">
                    {d.admin_note ?? d.payment_ref ?? "Standard credit top-up demand"}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setConfirmingId(d.id)
                          confirmMut.mutate({ id: d.id, note: "Confirmed & granted by admin" })
                        }}
                        disabled={confirmMut.isPending && confirmingId === d.id}
                        className="btn-primary text-xs flex items-center gap-1.5 py-1 px-3"
                      >
                        {confirmMut.isPending && confirmingId === d.id ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-3.5" />
                        )}
                        Grant & Confirm
                      </button>

                      <button
                        onClick={() => {
                          if (confirm("Decline and reject this payment demand?")) {
                            setRejectingId(d.id)
                            rejectMut.mutate({ id: d.id, note: "Declined by admin" })
                          }
                        }}
                        disabled={rejectMut.isPending && rejectingId === d.id}
                        className="btn-ghost text-bad text-xs flex items-center gap-1 py-1 px-2 hover:bg-bad/10"
                      >
                        <XCircle className="size-3.5" />
                        Decline
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {demands.length === 0 && !demandsQuery.isLoading && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-10">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <CheckCircle2 className="size-8 text-emerald-400/50" />
                      <p className="text-sm">No pending payment demands right now.</p>
                      <p className="text-xs text-muted">When users request credit top-ups, they will appear here for admin confirmation.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manual Credit Grant Form & User Balances */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Manual Credit Grant Form */}
        <div className="card p-5 lg:col-span-1 border-line space-y-4">
          <div>
            <h2 className="text-base font-semibold text-text flex items-center gap-2">
              <Plus className="size-4 text-accent" />
              Manual Credit Grant
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Directly grant credits ($5 = 15 DT) to any registered user balance.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!selectedUserId) {
                toast("error", "Please select a target user")
                return
              }
              grantMut.mutate({
                userId: selectedUserId,
                amount_dt: grantAmount,
                note: grantNote || "Admin manual grant ($5 = 15 DT deal)",
              })
            }}
            className="space-y-4"
          >
            <div>
              <label className="text-xs uppercase tracking-wider text-muted font-semibold block mb-1">
                Select User
              </label>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="input w-full"
                required
              >
                <option value="">-- Choose User --</option>
                {users.map((u: UserType) => (
                  <option key={u.id} value={u.id}>
                    {u.email} ({u.role})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-muted font-semibold block mb-1">
                Select Deal Package ($5 = 15 DT)
              </label>
              <div className="grid grid-cols-2 gap-2">
                {DEAL_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.dt}
                    onClick={() => setGrantAmount(p.dt)}
                    className={`px-2.5 py-2 text-xs font-medium rounded border text-left transition-colors ${
                      grantAmount === p.dt
                        ? "border-accent bg-accent/15 text-accent font-bold"
                        : "border-line text-muted hover:text-text hover:bg-line/30"
                    }`}
                  >
                    <div>{p.dt} DT</div>
                    <div className="text-[10px] text-muted">${p.usd} USD</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-muted font-semibold block mb-1">
                Custom DT Amount
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={grantAmount}
                  onChange={(e) => setGrantAmount(Number(e.target.value))}
                  className="input w-full font-mono"
                  required
                />
                <span className="text-xs text-muted font-mono shrink-0">
                  ≈ ${(grantAmount / 3).toFixed(2)} USD
                </span>
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-muted font-semibold block mb-1">
                Admin Note / Payment Ref
              </label>
              <input
                type="text"
                placeholder="e.g. Bank transfer reference or promo deal"
                value={grantNote}
                onChange={(e) => setGrantNote(e.target.value)}
                className="input w-full text-xs"
              />
            </div>

            <button
              type="submit"
              disabled={grantMut.isPending || !selectedUserId}
              className="btn-primary w-full flex items-center justify-center gap-2 py-2"
            >
              {grantMut.isPending ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Grant {grantAmount} DT to Wallet
            </button>
          </form>
        </div>

        {/* User Credit Balances Table */}
        <div className="card lg:col-span-2 border-line overflow-hidden flex flex-col">
          <div className="p-4 border-b border-line bg-panel/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text flex items-center gap-2">
                <User className="size-4 text-accent" />
                User Wallet Balances Directory
              </h2>
              <p className="text-xs text-muted mt-0.5">
                Overview of current credit balance and spending for all accounts.
              </p>
            </div>

            <div className="relative">
              <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search user..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input text-xs pl-9 py-1 w-48"
              />
            </div>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>API Usage Cost ($)</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u: UserType) => (
                  <tr key={u.id} className={selectedUserId === u.id ? "bg-accent/5" : ""}>
                    <td>
                      <div className="font-medium text-text">{u.email}</div>
                      <div className="text-[10px] text-muted font-mono">{u.id}</div>
                    </td>
                    <td>
                      <span className={`chip ${u.role === "admin" ? "chip-good" : "chip-muted"}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="font-mono text-xs text-amber-400">
                      ${Number(u.total_cost || u.current_usage_usd || 0).toFixed(4)}
                    </td>
                    <td className="text-right">
                      <button
                        onClick={() => setSelectedUserId(u.id)}
                        className={`btn-ghost text-xs ${selectedUserId === u.id ? "text-accent font-bold" : ""}`}
                      >
                        Select for Grant
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
