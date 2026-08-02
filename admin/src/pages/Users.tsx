import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { createUser, deleteUser, listUsers, updateUser } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

export function UsersPage() {
  const q = useQuery({ queryKey: ["users"], queryFn: listUsers })
  const [open, setOpen] = useState(false)
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
            Manage tenant accounts, tier, status, and monthly quotas.
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
              <th className="text-right">API keys</th>
              <th className="text-right">Usage</th>
              <th>Last login</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: any) => (
              <UserRow key={u.id} u={u} />
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

function UserRow({ u }: { u: any }) {
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
      <td className="text-right font-mono text-xs">{u.active_keys}</td>
      <td className="text-right font-mono text-xs">
        {Number(u.total_requests).toLocaleString()} req<br />
        <span className="text-muted">${Number(u.total_cost).toFixed(4)}</span>
      </td>
      <td className="text-xs">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : <span className="text-muted">never</span>}</td>
      <td className="text-right">
        <button
          className="btn-ghost text-bad"
          onClick={() => confirm(`Delete user ${u.email}?`) && del.mutate()}
          title="Delete user"
        >
          <Trash2 className="size-4" />
        </button>
      </td>
    </tr>
  )
}

function NewUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"user" | "admin">("user")
  const [tier, setTier] = useState<"free" | "pro" | "enterprise">("free")
  const [budget, setBudget] = useState(50000)
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
                await createUser({ email, password, role, tier, token_budget_monthly: budget })
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
      </div>
    </Modal>
  )
}