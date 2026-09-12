import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Coins, Edit3, Plus, Trash2 } from "lucide-react"
import { createUser, deleteUser, listUsers, updateUser, type User } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

export function UsersPage() {
  const q = useQuery({ queryKey: ["users"], queryFn: listUsers })
  const [open, setOpen] = useState(false)
  const [capUser, setCapUser] = useState<User | null>(null)
  const users = q.data?.users ?? []
  const admins = users.filter((u: any) => u.role === "admin").length
  const suspended = users.filter((u: any) => u.subscription_status === "suspended").length
  const activeKeys = users.reduce((s: number, u: any) => s + Number(u.active_keys ?? 0), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-muted text-sm mt-1 max-w-xl">
            Manage tenant accounts, tier, status, monthly quotas, and spending limits.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New user
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total users" value={users.length} />
        <Stat label="Admins" value={admins} />
        <Stat label="Suspended" value={suspended} accent={suspended > 0 ? "bad" : undefined} />
        <Stat label="Active API keys" value={activeKeys} />
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Tier</th>
              <th>Status</th>
              <th className="text-right">Spending Limit / Usage</th>
              <th className="text-center">Limit Status</th>
              <th>Last login</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: User) => (
              <UserRow key={u.id} u={u} onEditCap={(user) => setCapUser(user)} />
            ))}
            {users.length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={8} className="text-center text-muted py-12">No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <NewUserDialog open={open} onClose={() => setOpen(false)} />
      {capUser && (
        <EditSpendingCapDialog user={capUser} open={!!capUser} onClose={() => setCapUser(null)} />
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: "bad" }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-xl font-semibold ${accent === "bad" ? "text-bad" : ""}`}>{value}</div>
    </div>
  )
}

function UserRow({ u, onEditCap }: { u: User; onEditCap: (u: User) => void }) {
  const qc = useQueryClient()
  const [tier, setTier] = useState(u.tier ?? "free")
  const [status, setStatus] = useState(u.subscription_status ?? "active")
  const mut = useMutation({
    mutationFn: (b: any) => updateUser(u.id, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  })
  const del = useMutation({
    mutationFn: () => deleteUser(u.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  })

  const currentUsage = u.current_usage_usd ?? Number(Number(u.total_cost ?? 0).toFixed(4))
  const capUsd = u.spending_cap_usd
  const capEnabled = Boolean(u.spending_cap_enabled)
  const remaining = u.remaining_cap_usd

  return (
    <tr>
      <td>
        <div className="font-medium">{u.email}</div>
        <div className="text-xs text-muted">Joined {new Date(u.created_at).toLocaleDateString()}</div>
      </td>
      <td>
        <span className={`chip ${u.role === "admin" ? "text-accent border-accent/40 bg-accent/10" : "chip-muted"}`}>
          {u.role}
        </span>
      </td>
      <td>
        <select
          className="input"
          value={tier}
          onChange={(e) => { setTier(e.target.value); mut.mutate({ tier: e.target.value }) }}
        >
          {["free", "pro", "enterprise"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td>
        <select
          className="input"
          value={status}
          onChange={(e) => { setStatus(e.target.value); mut.mutate({ status: e.target.value }) }}
        >
          {["active", "suspended"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className="text-right font-mono text-xs">
        {capEnabled && capUsd !== null ? (
          <>
            <div className="font-semibold">${currentUsage.toFixed(2)} / ${capUsd!.toFixed(2)}</div>
            <div className="text-muted">Remaining: ${remaining != null ? remaining.toFixed(2) : "0.00"}</div>
          </>
        ) : (
          <>
            <div>${currentUsage.toFixed(2)} / ∞</div>
            <div className="text-muted">Unlimited</div>
          </>
        )}
      </td>
      <td className="text-center">
        {capEnabled && capUsd !== null ? (
          u.limit_status === "limit_reached" ? (
            <span className="chip chip-bad">Limit reached</span>
          ) : (
            <span className="chip chip-good">Within limit</span>
          )
        ) : (
          <span className="chip chip-muted">No cap</span>
        )}
      </td>
      <td className="text-xs">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : <span className="text-muted">never</span>}</td>
      <td className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Link
            to={`/payments?userId=${u.id}`}
            className="btn-ghost"
            title="Manage Credits & Payments"
          >
            <Coins className="size-4" />
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

function EditSpendingCapDialog({ user, open, onClose }: { user: User; open: boolean; onClose: () => void }) {
  const [capUsd, setCapUsd] = useState(user.spending_cap_usd != null ? String(user.spending_cap_usd) : "5.00")
  const [enabled, setEnabled] = useState(user.spending_cap_enabled ?? true)
  const [period, setPeriod] = useState(user.spending_cap_period ?? "monthly")

  const qc = useQueryClient()
  const toast = useToast()
  const mut = useMutation({
    mutationFn: (body: any) => updateUser(user.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      toast("success", "Spending cap updated")
      onClose()
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Update failed")
    },
  })

  const currentUsage = user.current_usage_usd ?? 0
  const capVal = Number(capUsd) || 0
  const remaining = enabled ? Math.max(0, capVal - currentUsage) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Spending limit · ${user.email}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => {
              mut.mutate({
                spending_cap_usd: enabled ? Number(capUsd) : null,
                spending_cap_enabled: enabled,
                spending_cap_period: period,
              })
            }}
            disabled={mut.isPending}
          >
            Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded border-line"
          />
          <span>Cap Enabled</span>
        </label>

        {enabled && (
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="label">Spending limit ($)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={capUsd}
                onChange={(e) => setCapUsd(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">Cap Period</span>
              <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="monthly">Monthly</option>
              </select>
            </label>
          </div>
        )}

        <div className="p-3 rounded-md bg-surface border border-line flex justify-between text-xs">
          <div>
            <span className="text-muted">Current usage:</span>{" "}
            <span className="font-mono font-semibold">${currentUsage.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted">Remaining:</span>{" "}
            <span className="font-mono font-semibold">
              {remaining !== null ? `$${remaining.toFixed(2)}` : "Unlimited"}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function NewUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"user" | "admin">("user")
  const [tier, setTier] = useState<"free" | "pro" | "enterprise">("free")
  const [budget, setBudget] = useState(50000)
  const [spendingCap, setSpendingCap] = useState("5.00")
  const [spendingCapEnabled, setSpendingCapEnabled] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={async () => {
              try {
                await createUser({
                  email, password, role, tier, token_budget_monthly: budget,
                  spending_cap_usd: spendingCapEnabled ? Number(spendingCap) : null,
                  spending_cap_enabled: spendingCapEnabled,
                  spending_cap_period: "monthly",
                })
                qc.invalidateQueries({ queryKey: ["users"] })
                toast("success", "User created")
                onClose()
                setEmail(""); setPassword("")
              } catch (e: any) {
                toast("error", e?.message ?? "Create failed")
              }
            }}
          >
            <Plus className="size-4" /> Create
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="label">Email</span>
          <input type="email" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="label">Password (min 8 chars)</span>
          <input type="password" className="input" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Tier</span>
          <select className="input" value={tier} onChange={(e) => setTier(e.target.value as any)}>
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="label">Monthly token budget</span>
          <input type="number" min={0} className="input" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </label>
        <div className="flex flex-col gap-2 md:col-span-2 pt-2 border-t border-line">
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={spendingCapEnabled}
              onChange={(e) => setSpendingCapEnabled(e.target.checked)}
              className="rounded border-line"
            />
            <span>Enable Spending Cap</span>
          </label>
          {spendingCapEnabled && (
            <label className="flex flex-col gap-1">
              <span className="label">Spending limit ($)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={spendingCap}
                onChange={(e) => setSpendingCap(e.target.value)}
              />
            </label>
          )}
        </div>
      </div>
    </Modal>
  )
}