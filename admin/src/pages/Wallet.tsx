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
} from "lucide-react"
import { walletSummary, type WalletUser } from "../api"

export function WalletPage() {
  const [searchTerm, setSearchTerm] = useState("")
  const [tierFilter, setTierFilter] = useState<string>("all")

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ["walletSummary"],
    queryFn: walletSummary,
    refetchInterval: 30000,
  })

  const totals = data?.totals
  const users = data?.users ?? []

  const filteredUsers = users.filter((u: WalletUser) => {
    const matchesSearch =
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.role.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesTier = tierFilter === "all" || u.tier === tierFilter
    return matchesSearch && matchesTier
  })

  // Format currency strictly to 6 decimal places ($0.000000)
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
                Financial Wallet & Accounting
              </h1>
              <p className="text-xs text-muted mt-0.5">
                Real-time tracking of subscription income, API usage costs, and net revenue per user ($0.000000 precision).
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
        {/* Total Subscription Income */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-accent/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total Subscription Revenue</span>
            <div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-400 grid place-items-center">
              <DollarSign className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-emerald-400 tracking-tight font-mono">
            {isLoading ? "..." : formatUSD6(totals?.total_subscription_income_usd)}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <TrendingUp className="size-3 text-emerald-400" />
            <span>Avg {formatUSD6(totals?.avg_income_per_user_usd)} / user</span>
          </div>
        </div>

        {/* Total Usage Cost */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-amber-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Total API Usage Cost</span>
            <div className="size-8 rounded-lg bg-amber-500/10 text-amber-400 grid place-items-center">
              <Coins className="size-4" />
            </div>
          </div>
          <div className="text-2xl font-extrabold text-amber-400 tracking-tight font-mono">
            {isLoading ? "..." : formatUSD6(totals?.total_usage_cost_usd)}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <TrendingDown className="size-3 text-amber-400" />
            <span>Avg {formatUSD6(totals?.avg_cost_per_user_usd)} / user</span>
          </div>
        </div>

        {/* Total Net Income */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-accent/10 border-accent/20">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Accumulated Net Profit</span>
            <div className="size-8 rounded-lg bg-accent/15 text-accent grid place-items-center">
              <ArrowUpRight className="size-4" />
            </div>
          </div>
          <div
            className={`text-2xl font-extrabold tracking-tight font-mono ${
              parseFloat(totals?.total_net_income_usd ?? "0") >= 0
                ? "text-accent"
                : "text-bad"
            }`}
          >
            {isLoading ? "..." : formatUSD6(totals?.total_net_income_usd)}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <BadgeCheck className="size-3 text-accent" />
            <span>Revenue minus LLM provider costs</span>
          </div>
        </div>

        {/* User & Request Metrics */}
        <div className="card p-5 relative overflow-hidden bg-gradient-to-br from-panel via-panel to-blue-500/5 border-line/60">
          <div className="flex items-center justify-between text-muted text-xs font-medium mb-2">
            <span>Accumulated Users & Volume</span>
            <div className="size-8 rounded-lg bg-blue-500/10 text-blue-400 grid place-items-center">
              <Users className="size-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold text-text tracking-tight font-mono">
              {isLoading ? "..." : totals?.accumulated_users ?? 0}
            </span>
            <span className="text-xs text-muted">
              ({totals?.active_users ?? 0} active)
            </span>
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
            {/* Search filter */}
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

            {/* Tier Filter */}
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

        {/* Table content */}
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
                      {/* User Email & Role */}
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

                      {/* Tier & Status */}
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

                      {/* Subscription Price */}
                      <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-400">
                        {formatUSD6(u.subscription_price_usd)}
                      </td>

                      {/* Usage Cost */}
                      <td className="py-3 px-4 text-right font-mono font-semibold text-amber-400">
                        {formatUSD6(u.usage_cost_usd)}
                      </td>

                      {/* Net Income / Profit */}
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

                      {/* Requests */}
                      <td className="py-3 px-4 text-center font-mono text-muted">
                        {u.total_requests.toLocaleString()}
                      </td>

                      {/* Tokens */}
                      <td className="py-3 px-4 text-right font-mono text-muted">
                        <div>{formatTokens(u.total_tokens)}</div>
                        <div className="text-[10px] text-muted/70">
                          {formatTokens(u.input_tokens)} in / {formatTokens(u.output_tokens)} out
                        </div>
                      </td>

                      {/* Last Active */}
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
