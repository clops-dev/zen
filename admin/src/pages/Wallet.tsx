import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Wallet,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Users,
  Activity,
  Search,
  RefreshCw,
  Zap,
  ArrowUpRight,
  ShieldAlert,
  Coins,
  BadgeCheck,
  Calculator,
  History,
  CheckCircle2,
  Clock,
  XCircle,
} from "lucide-react"
import { walletSummary, type WalletUser, type AdminCreditTransaction } from "../api"

export function WalletPage() {
  const [searchTerm, setSearchTerm] = useState("")
  const [tierFilter, setTierFilter] = useState<string>("all")
  const [txTypeFilter, setTxTypeFilter] = useState<string>("all")

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ["walletSummary"],
    queryFn: walletSummary,
    refetchInterval: 30000,
  })

  const totals = data?.totals
  const users = data?.users ?? []
  const transactions = data?.transactions ?? []

  const filteredUsers = users.filter((u: WalletUser) => {
    const matchesSearch =
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.role.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesTier = tierFilter === "all" || u.tier === tierFilter
    return matchesSearch && matchesTier
  })

  const filteredTransactions = transactions.filter((tx: AdminCreditTransaction) => {
    const matchesType = txTypeFilter === "all" || tx.type === txTypeFilter
    const matchesSearch =
      !searchTerm ||
      tx.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (tx.admin_note ?? "").toLowerCase().includes(searchTerm.toLowerCase())
    return matchesType && matchesSearch
  })

  const formatUSD6 = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null || val === "") return "$0.000000"
    const num = typeof val === "number" ? val : parseFloat(String(val))
    if (isNaN(num)) return "$0.000000"
    return `$${num.toFixed(6)}`
  }

  const formatTokens = (num: number) => {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`
    return num.toLocaleString()
  }

  const revDt = parseFloat(totals?.total_revenue_dt ?? "0")
  const revUsd = parseFloat(totals?.total_revenue_usd ?? totals?.total_subscription_income_usd ?? "0")
  const apiCostUsd = parseFloat(totals?.total_usage_cost_usd ?? "0")
  const netIncomeUsd = parseFloat(totals?.total_net_income_usd ?? "0")
  const marginPct = totals?.profit_margin_pct ?? (revUsd > 0 ? (netIncomeUsd / revUsd) * 100 : 0)

  return (
    <div className="space-y-6 pb-12">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-accent/15 text-accent border border-accent/30 shadow-sm">
              <Wallet className="size-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-text">
                Financial Wallet & Transaction History
              </h1>
              <p className="text-xs text-muted mt-0.5">
                Real-time tracking of revenue in DT & USD ($5 = 15 DT deal), LLM API costs, net profit, and ledger history.
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="btn btn-secondary text-xs flex items-center gap-2"
          >
            <RefreshCw className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {isError && (
        <div className="card p-4 border-bad/30 bg-bad/5 text-bad text-sm flex items-center gap-3">
          <ShieldAlert className="size-5 shrink-0" />
          <div>
            <span className="font-semibold">Failed to load wallet data:</span>{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
        </div>
      )}

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Platform Revenue (DT & USD) */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-accent/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total Platform Revenue</span>
            <div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-400 grid place-items-center">
              <Coins className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-emerald-400 tracking-tight font-mono">
            {isLoading ? "..." : `${revDt.toFixed(1)} DT`}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
            <span className="font-bold text-accent">${revUsd.toFixed(2)} USD</span>
            <span>($5 = 15 DT deal)</span>
          </div>
        </div>

        {/* Total Usage Cost in USD */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-amber-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total API Usage Cost (USD)</span>
            <div className="size-8 rounded-lg bg-amber-500/10 text-amber-400 grid place-items-center">
              <Zap className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-amber-400 tracking-tight font-mono">
            {isLoading ? "..." : formatUSD6(totals?.total_usage_cost_usd)}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <TrendingDown className="size-3 text-amber-400" />
            <span>LLM Provider upstream costs</span>
          </div>
        </div>

        {/* Accumulated Net Profit */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-accent/10 border-accent/20">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Accumulated Net Profit (USD)</span>
            <div className="size-8 rounded-lg bg-accent/15 text-accent grid place-items-center">
              <ArrowUpRight className="size-4" />
            </div>
          </div>
          <div
            className={`text-2xl font-extrabold tracking-tight font-mono ${
              netIncomeUsd >= 0 ? "text-accent" : "text-bad"
            }`}
          >
            {isLoading ? "..." : formatUSD6(totals?.total_net_income_usd)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <BadgeCheck className="size-3 text-accent" /> Margin:
            </span>
            <span className="font-bold text-accent">{marginPct.toFixed(1)}%</span>
          </div>
        </div>

        {/* User & Request Metrics */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-blue-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Accumulated Volume</span>
            <div className="size-8 rounded-lg bg-blue-500/10 text-blue-400 grid place-items-center">
              <Users className="size-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold text-text tracking-tight font-mono">
              {isLoading ? "..." : totals?.accumulated_users ?? 0}
            </span>
            <span className="text-xs text-muted">users</span>
          </div>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <Activity className="size-3 text-blue-400" />
              {(totals?.total_requests ?? 0).toLocaleString()} reqs
            </span>
            <span className="flex items-center gap-1">
              <Zap className="size-3 text-amber-400" />
              {formatTokens(totals?.total_tokens ?? 0)} tokens
            </span>
          </div>
        </div>
      </div>

      {/* Financial Formula Breakdown Card */}
      <div className="card p-5 border-accent/20 bg-panel/70 relative overflow-hidden">
        <div className="flex items-center gap-2 mb-3">
          <Calculator className="size-5 text-accent" />
          <h2 className="text-sm font-semibold tracking-tight uppercase text-accent">
            Revenue & API Cost Formula Overview
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs">
          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">1. Exchange Deal Rate</div>
            <div className="text-sm font-bold text-accent">15 DT = $5.00 USD</div>
            <div className="text-[11px] text-muted font-sans">1 USD = 3 DT (1 DT ≈ $0.333 USD)</div>
          </div>

          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">2. Revenue Conversion</div>
            <div className="text-sm font-bold text-emerald-400">
              Revenue ($) = Revenue (DT) / 3
            </div>
            <div className="text-[11px] text-muted font-sans">
              ${revUsd.toFixed(2)} USD from {revDt.toFixed(1)} DT total
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-line bg-bg/40 space-y-1">
            <div className="text-[11px] text-muted uppercase font-sans font-semibold">3. Net Income & Margin</div>
            <div className="text-sm font-bold text-blue-400">
              Net ($) = Rev ($) - API Cost ($)
            </div>
            <div className="text-[11px] text-muted font-sans">
              ${netIncomeUsd.toFixed(2)} net ({marginPct.toFixed(1)}% margin)
            </div>
          </div>
        </div>
      </div>

      {/* Wallet Transaction History Table Section */}
      <div className="card border-line/70">
        <div className="p-4 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-panel/50">
          <div>
            <h2 className="text-base font-semibold text-text flex items-center gap-2">
              <History className="size-4 text-accent" />
              Wallet Transaction History
              <span className="text-xs font-normal text-muted bg-line/40 px-2 py-0.5 rounded-full">
                {filteredTransactions.length} records
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Immutable ledger of credit purchases, admin grants, usage deductions, and adjustments.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="input py-1.5 text-xs bg-bg"
            >
              <option value="all">All Types</option>
              <option value="purchase">Purchases</option>
              <option value="admin_grant">Admin Grants</option>
              <option value="usage">AI Usage</option>
              <option value="refund">Refunds</option>
              <option value="adjustment">Adjustments</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-bg/60 text-muted uppercase text-[10px] tracking-wider border-b border-line font-medium">
              <tr>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">User Email</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4 text-right">Amount (DT)</th>
                <th className="py-3 px-4 text-right">Value (USD)</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4">Notes / Creator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/40 font-mono">
              {filteredTransactions.map((tx: AdminCreditTransaction) => {
                const isPositive = tx.amount_dt > 0
                return (
                  <tr key={tx.id} className="hover:bg-line/20 transition-colors font-sans">
                    <td className="py-3 px-4 text-xs text-muted">
                      {new Date(tx.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 font-medium text-text">
                      {tx.email}
                    </td>
                    <td className="py-3 px-4">
                      <span className="chip chip-muted text-[10px] uppercase">
                        {tx.type.replace("_", " ")}
                      </span>
                    </td>
                    <td className={`py-3 px-4 text-right font-mono font-bold ${isPositive ? "text-emerald-400" : "text-amber-400"}`}>
                      {isPositive ? "+" : ""}{tx.amount_dt.toFixed(2)} DT
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-muted">
                      ${((Math.abs(tx.amount_dt)) / 3).toFixed(2)} USD
                    </td>
                    <td className="py-3 px-4 text-center">
                      {tx.status === "completed" ? (
                        <span className="chip chip-good text-[10px] flex items-center justify-center gap-1 w-fit mx-auto">
                          <CheckCircle2 className="size-3" />
                          Completed
                        </span>
                      ) : tx.status === "pending" ? (
                        <span className="chip bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px] flex items-center justify-center gap-1 w-fit mx-auto">
                          <Clock className="size-3" />
                          Pending
                        </span>
                      ) : (
                        <span className="chip chip-bad text-[10px] flex items-center justify-center gap-1 w-fit mx-auto">
                          <XCircle className="size-3" />
                          {tx.status}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-muted max-w-xs truncate">
                      {tx.admin_note ?? tx.created_by_email ?? "—"}
                    </td>
                  </tr>
                )
              })}

              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted font-sans">
                    No transactions match the selected filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* User Financial Breakdown Table Section */}
      <div className="card border-line/70">
        <div className="p-4 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-panel/50">
          <div>
            <h2 className="text-base font-semibold text-text flex items-center gap-2">
              User Financial Breakdown
              <span className="text-xs font-normal text-muted bg-line/40 px-2 py-0.5 rounded-full">
                {filteredUsers.length} users
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Individual user subscription income, gateway usage costs, and net margin ($0.000000 precision).
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative min-w-[200px]">
              <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search email or role..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input pl-8 py-1.5 text-xs w-full"
              />
            </div>

            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="input py-1.5 text-xs bg-bg"
            >
              <option value="all">All Tiers</option>
              <option value="free">Free Tier</option>
              <option value="pro">Pro Tier</option>
              <option value="enterprise">Enterprise Tier</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-bg/60 text-muted uppercase text-[10px] tracking-wider border-b border-line font-medium">
              <tr>
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Tier & Status</th>
                <th className="py-3 px-4 text-right">Subscription Price</th>
                <th className="py-3 px-4 text-right">Usage Cost</th>
                <th className="py-3 px-4 text-right">Net Profit / Margin</th>
                <th className="py-3 px-4 text-center">Requests</th>
                <th className="py-3 px-4 text-right">Total Tokens</th>
                <th className="py-3 px-4 text-right">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/40 font-mono">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted font-sans">
                    <RefreshCw className="size-5 animate-spin mx-auto mb-2 text-accent" />
                    Loading user financial records...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted font-sans">
                    No matching users found.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const netValue = parseFloat(u.net_income_usd)
                  const isPositiveNet = netValue >= 0

                  return (
                    <tr
                      key={u.id}
                      className="hover:bg-line/20 transition-colors font-sans"
                    >
                      <td className="py-3 px-4">
                        <div className="font-medium text-text">{u.email}</div>
                        <div className="text-[10px] text-muted flex items-center gap-1">
                          <span
                            className={`inline-block size-1.5 rounded-full ${
                              u.role === "admin" ? "bg-accent" : "bg-muted"
                            }`}
                          />
                          {u.role}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                              u.tier === "enterprise"
                                ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                                : u.tier === "pro"
                                ? "bg-accent/15 text-accent border border-accent/30"
                                : "bg-line/40 text-muted"
                            }`}
                          >
                            {u.tier}
                          </span>
                          <span
                            className={`size-2 rounded-full ${
                              u.subscription_status === "active"
                                ? "bg-emerald-400"
                                : "bg-amber-400"
                            }`}
                            title={u.subscription_status}
                          />
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-400">
                        {formatUSD6(u.subscription_price_usd)}
                      </td>

                      <td className="py-3 px-4 text-right font-mono font-semibold text-amber-400">
                        {formatUSD6(u.usage_cost_usd)}
                      </td>

                      <td className="py-3 px-4 text-right font-mono font-bold">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                            isPositiveNet
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-bad/10 text-bad border border-bad/20"
                          }`}
                        >
                          {isPositiveNet ? "+" : ""}
                          {formatUSD6(u.net_income_usd)}
                        </span>
                      </td>

                      <td className="py-3 px-4 text-center font-mono text-muted">
                        {u.total_requests.toLocaleString()}
                      </td>

                      <td className="py-3 px-4 text-right font-mono text-muted">
                        <div>{formatTokens(u.total_tokens)}</div>
                        <div className="text-[10px] text-muted/70">
                          {formatTokens(u.input_tokens)} in / {formatTokens(u.output_tokens)} out
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right text-muted text-[11px]">
                        {u.last_active_at
                          ? new Date(u.last_active_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Never"}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
