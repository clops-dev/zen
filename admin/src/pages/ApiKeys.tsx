import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Loader2, Plus, Power, RotateCcw } from "lucide-react"
import { createApiKey, listApiKeys, listCombos, listUsers, revokeApiKey, rotateApiKey } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

export function ApiKeysPage() {
  const q = useQuery({ queryKey: ["api-keys"], queryFn: listApiKeys })
  const users = useQuery({ queryKey: ["users"], queryFn: listUsers })
  const combos = useQuery({ queryKey: ["combos"], queryFn: listCombos })
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="text-muted text-sm mt-0.5">
            Long-lived machine credentials. The raw key is shown once at creation — store it immediately.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> Create key
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>User</th>
              <th>Combo</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.keys ?? []).map((k) => (
              <tr key={k.id}>
                <td>
                  <code className="text-xs">{k.key_prefix}…</code>
                  {k.label && <div className="text-xs text-muted">{k.label}</div>}
                </td>
                <td>{k.user_email}</td>
                <td>{k.combo_name ?? <span className="text-muted">—</span>}</td>
                <td>{new Date(k.created_at).toLocaleString()}</td>
                <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : <span className="text-muted">never</span>}</td>
                <td>
                  <span className={k.revoked ? "chip chip-bad" : "chip chip-good"}>
                    {k.revoked ? "revoked" : "active"}
                  </span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-1">
                    {!k.revoked && <RotateBtn id={k.id} />}
                    {!k.revoked && <RevokeBtn id={k.id} />}
                  </div>
                </td>
              </tr>
            ))}
            {(q.data?.keys ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateKeyDialog
        open={open}
        onClose={() => setOpen(false)}
        users={users.data?.users ?? []}
        combos={combos.data?.combos ?? []}
      />
    </div>
  )
}

function RotateBtn({ id }: { id: string }) {
  const m = useMutation({ mutationFn: () => rotateApiKey(id) })
  const toast = useToast()
  const qc = useQueryClient()
  return (
    <button
      className="btn-ghost"
      title="Rotate"
      disabled={m.isPending}
      onClick={() =>
        m.mutate(undefined, {
          onSuccess: (r) => {
            qc.invalidateQueries({ queryKey: ["api-keys"] })
            showKeyModal(r.api_key, r.prefix)
          },
          onError: (e: any) => toast("error", e?.message ?? "Rotate failed"),
        })
      }
    >
      {m.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
    </button>
  )
}

function RevokeBtn({ id }: { id: string }) {
  const m = useMutation({
    mutationFn: () => revokeApiKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  })
  const qc = useQueryClient()
  return (
    <button
      className="btn-ghost text-bad"
      title="Revoke"
      onClick={() => {
        if (confirm("Revoke this key? Anything using it stops working immediately.")) m.mutate()
      }}
    >
      <Power className="size-4" />
    </button>
  )
}

function showKeyModal(key: string, prefix: string) {
  const html = `
    <div style="font-family:system-ui;padding:24px;background:#000;color:#fafafa;border:1px solid #262626;border-radius:8px;max-width:480px">
      <h3 style="color:#ef4444;margin:0 0 12px">New API key</h3>
      <p style="color:#8c8c8c;font-size:13px;margin:0 0 8px">Copy this key now — it will not be shown again.</p>
      <code id="k" style="display:block;background:#0c0c0c;color:#fafafa;padding:12px;border:1px solid #262626;border-radius:6px;word-break:break-all;font-family:ui-monospace,monospace;font-size:13px">${key}</code>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button id="cp" style="padding:6px 14px;border-radius:6px;background:#ef4444;color:#fff;border:0;cursor:pointer;font-weight:600">Copy</button>
        <button id="ok" style="padding:6px 14px;border-radius:6px;background:#0c0c0c;color:#fafafa;border:1px solid #404040;cursor:pointer">Done</button>
      </div>
    </div>`
  const wrap = document.createElement("div")
  wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:grid;place-items:center;z-index:100"
  wrap.innerHTML = html
  document.body.appendChild(wrap)
  wrap.querySelector("#cp")?.addEventListener("click", () => {
    navigator.clipboard.writeText(key)
  })
  wrap.querySelector("#ok")?.addEventListener("click", () => wrap.remove())
}

function CreateKeyDialog({
  open,
  onClose,
  users,
  combos,
}: {
  open: boolean
  onClose: () => void
  users: any[]
  combos: any[]
}) {
  const [userId, setUserId] = useState(users[0]?.id ?? "")
  const [label, setLabel] = useState("")
  const [comboId, setComboId] = useState<string>("")
  const qc = useQueryClient()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!userId}
            onClick={async () => {
              try {
                const r = await createApiKey({
                  user_id: userId,
                  label: label || undefined,
                  combo_id: comboId || undefined,
                })
                qc.invalidateQueries({ queryKey: ["api-keys"] })
                onClose()
                showKeyModal(r.api_key, r.prefix)
              } catch {}
            }}
          >
            <Plus className="size-4" /> Create key
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <label className="flex flex-col gap-1">
          <span className="label">Owner</span>
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.email}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Label</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="zen code cli - laptop" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Attach combo</span>
          <select className="input" value={comboId} onChange={(e) => setComboId(e.target.value)}>
            <option value="">No combo (use defaults)</option>
            {combos.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.routing_strategy})</option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  )
}