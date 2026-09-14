import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Coins, Plus, Trash2, DollarSign, TrendingUp, Users as UsersIcon } from "lucide-react"
import { createUser, deleteUser, listUsers, getAdminBilling, type User } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

function formatTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

export function UsersPage() {
  const q = useQuery({ queryKey: ["users"], queryFn: listUsers })
  const billingQ = useQuery({ queryKey: ["admin-billing"], queryFn: getAdminBilling })

  const [open, setOpen] = useState(false)
  const users = q.data?.users ?? []
  const billing = billingQ.data

  const admins = users.filter((u: any) => u.role === "admin").length
  const activeKeys = users.reduce((s: number, u: any) => s + Number(u.active_keys ?? 0), 0)

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

      {/* Requirement 4: Exact User Table Columns */}
      <div className="card overflow-hidden">
        <table className="table-clean text-xs">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th className="text-right">Purchased Credits</th>
              <th className="text-right">Usage Cost</th>
              <th className="text-right">Remaining Credits</th>
              <th className="text-right">Requests</th>
              <th className="text-right">Tokens</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: User) => (
              <UserRow key={u.id} u={u} />
            ))}
            {users.length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={8} className="text-center text-muted py-12">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
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

function UserRow({ u }: { u: User }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => deleteUser(u.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      qc.invalidateQueries({ queryKey: ["admin-billing"] })
    },
  })

  const purchased = u.credits_purchased ?? 0
  const usage = u.usage_cost ?? 0
  const remaining = u.remaining_credits ?? (purchased - usage)
  const requests = u.requests ?? 0
  const tokens = u.tokens ?? 0

  return (
    <tr>
      <td>
        <div className="font-medium text-sm">{u.email}</div>
        <div className="text-[11px] text-muted">Joined {new Date(u.created_at).toLocaleDateString()}</div>
      </td>
      <td>
        <span className={`chip ${u.role === "admin" ? "text-accent border-accent/40 bg-accent/10" : "chip-muted"}`}>
          {u.role}
        </span>
      </td>
      <td className="text-right font-mono font-semibold">
        ${purchased.toFixed(6)}
      </td>
      <td className="text-right font-mono text-bad font-semibold">
        ${usage.toFixed(6)}
      </td>
      <td className="text-right font-mono text-accent font-bold">
        ${remaining.toFixed(6)}
      </td>
      <td className="text-right font-mono font-bold">
        {requests}
      </td>
      <td className="text-right font-mono">
        {formatTokens(tokens)}
      </td>
      <td className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Link
            to={`/payments?userId=${u.id}`}
            className="btn-ghost"
            title="Manage Credits & Grant Funds"
          >
            <Coins className="size-4 text-accent" />
          </Link>
          <button
            className="btn-ghost text-bad"
            onClick={() => confirm(`Delete user ${u.email}?`) && del.mutate()}
            title="Delete user"
          >
            <Trash2 className="size-4" />
          </button>
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