import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Coins, Plus, Trash2, TrendingUp, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react"
import { createUser, deleteUser, listUsers, getAdminBilling, type User } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

function formatTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

export function UsersPage() {
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<"asc" | "desc">("desc")
  const [cursor, setCursor] = useState<string | null>(null)
  const q = useQuery({ queryKey: ["users", order, cursor], queryFn: () => listUsers({ order, cursor }) })
  const billingQ = useQuery({ queryKey: ["admin-billing"], queryFn: getAdminBilling })
  const users = q.data?.users ?? []
  const billing = billingQ.data
  const groupedUsers = useMemo(() => groupUsers(users), [users])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & Credits Billing</h1>
          <p className="text-muted text-sm mt-1 max-w-xl">
            Credits-only single source of truth billing. User and admin portals reference identical database records.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New user
        </button>
      </div>

      {/* Requirement 11: Admin Income & Revenue Section */}
      <div className="card p-4">
        <div className="text-xs uppercase tracking-[0.14em] font-semibold text-muted mb-3 flex items-center gap-2">
          <TrendingUp className="size-4 text-accent" />
          <span>TOTAL REVENUE OVERVIEW (SINGLE SOURCE OF TRUTH)</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Credit Sales (DT)" value={`${billing?.total_credit_sales_dt ?? 0} DT`} />
          <Stat label="Credits Sold ($)" value={`$${(billing?.total_credits_sold_usd ?? 0).toFixed(2)}`} />
          <Stat label="AI Usage Cost" value={`$${(billing?.total_ai_usage_cost_usd ?? 0).toFixed(6)}`} />
          <Stat label="Gross Margin" value={`$${(billing?.gross_margin_usd ?? 0).toFixed(6)}`} accent="good" />
          <Stat label="Total Users" value={billing?.total_users ?? users.length} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 card p-3 text-xs">
        <span className="font-semibold">{q.data?.new_last_24h ?? 0} new in the last 24 h</span>
        <button className="btn" onClick={() => { setOrder(order === "desc" ? "asc" : "desc"); setCursor(null) }}>
          {order === "desc" ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          {order === "desc" ? "Newest first" : "Oldest first"}
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="table-clean text-xs">
          <thead><tr><th>Email</th><th>Joined</th><th>Plan</th><th>Status</th><th>Risk</th><th>Last active</th><th className="text-right">Actions</th></tr></thead>
          <tbody>
            {groupedUsers.map(([label, rows]) => <UserGroup key={label} label={label} users={rows} />)}
            {users.length === 0 && !q.isLoading && <tr><td colSpan={7} className="text-center text-muted py-12">No users found.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <button className="btn" disabled={!q.data?.has_more || q.isFetching} onClick={() => setCursor(q.data?.next_cursor ?? null)}>Next 50</button>
      </div>

      <NewUserDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted font-semibold">
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-lg font-semibold font-mono ${accent === "good" ? "text-accent font-bold" : accent === "bad" ? "text-bad" : ""}`}>
        {value}
      </div>
    </div>
  )
}

function groupUsers(users: User[]) {
  const groups = new Map<string, User[]>()
  for (const user of users) {
    const date = new Date(user.created_at)
    const now = new Date()
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const label = day === today ? "Today" : day === today - 86400000 ? "Yesterday" : day >= today - 6 * 86400000 ? "This week" : date.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(user)
  }
  return [...groups]
}

function UserGroup({ label, users }: { label: string; users: User[] }) {
  return <><tr><td colSpan={7} className="bg-panel/60 text-muted font-semibold py-2">{label}</td></tr>{users.map((u) => <UserRow key={u.id} u={u} />)}</>
}

function UserRow({ u }: { u: User }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => deleteUser(u.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      qc.invalidateQueries({ queryKey: ["admin-billing"] })
    },
  })

  const joined = new Date(u.created_at)
  const lastActive = u.last_active_at ? new Date(u.last_active_at).toLocaleString() : "Never"

  return (
    <tr>
      <td><div className="font-medium text-sm">{u.email}</div><div className="text-[11px] text-muted">{u.role}</div></td>
      <td className="whitespace-nowrap">{joined.toLocaleString()}</td>
      <td><span className="chip chip-muted">{u.tier}</span></td>
      <td><span className={`chip ${u.status === "active" ? "text-accent" : "text-bad"}`}>{u.status}</span></td>
      <td>
        <span className={u.risk_score > 0 ? "text-bad" : "text-muted"}>{u.risk_score}</span>
        {u.risk_flags && <span className="block text-[10px] text-muted max-w-36 truncate" title={u.risk_flags}>{u.risk_flags}</span>}
      </td>
      <td className="whitespace-nowrap">{lastActive}</td>
      <td className="text-right">
        <div className="flex items-center justify-end gap-1">
          {u.email_verified && <CheckCircle2 className="size-4 text-accent" aria-label="Verified" />}
          <Link to={`/payments?userId=${u.id}`} className="btn-ghost" title="Manage credits"><Coins className="size-4 text-accent" /></Link>
          <button className="btn-ghost text-bad" onClick={() => confirm(`Delete user ${u.email}?`) && del.mutate()} title="Delete user"><Trash2 className="size-4" /></button>
        </div>
      </td>
    </tr>
  )
}

function NewUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"user" | "admin">("user")
  const qc = useQueryClient()
  const toast = useToast()

  const mut = useMutation({
    mutationFn: (body: any) => createUser(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      qc.invalidateQueries({ queryKey: ["admin-billing"] })
      toast("success", "User created successfully")
      onClose()
      setEmail("")
      setPassword("")
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Creation failed")
    },
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create New User Account"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => mut.mutate({ email, password, role })}
            disabled={mut.isPending || !email || password.length < 8}
          >
            {mut.isPending ? "Creating..." : "Create User"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <div>
          <label className="block font-medium text-muted mb-1">Email address</label>
          <input
            className="input w-full"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </div>
        <div>
          <label className="block font-medium text-muted mb-1">Initial password (min 8 chars)</label>
          <input
            className="input w-full"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div>
          <label className="block font-medium text-muted mb-1">Account role</label>
          <select className="input w-full" value={role} onChange={(e: any) => setRole(e.target.value)}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
    </Modal>
  )
}