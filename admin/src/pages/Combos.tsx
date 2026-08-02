import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Archive, Boxes, Copy, Download, Edit3, Loader2, Plus, Sparkles, TestTube2, Trash2, Upload } from "lucide-react"
import { archiveCombo, cloneCombo, deleteCombo, exportCombo, importCombo, listCombos, testCombo } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

export function CombosPage() {
  const q = useQuery({ queryKey: ["combos"], queryFn: listCombos })
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            Combos
            <span className="chip chip-accent text-[10px]">NEW</span>
          </h1>
          <p className="text-muted text-sm mt-0.5 max-w-2xl">
            A Combo is a reusable AI configuration bundle — providers, models, routing strategy, request defaults,
            rate limits, and budget caps. Attach a Combo to an API key and the gateway enforces it for that key's traffic.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" /> Import
          </button>
          <Link to="/combos/new" className="btn-primary">
            <Plus className="size-4" /> New combo
          </Link>
        </div>
      </div>

      <Templates q={q} />

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Strategy</th>
              <th>RPM</th>
              <th>Token cap</th>
              <th>Cost cap</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.combos ?? []).map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/combos/${c.id}`} className="font-medium hover:text-accent">
                    {c.name}
                  </Link>
                  {c.description && <div className="text-xs text-muted mt-0.5 line-clamp-1">{c.description}</div>}
                </td>
                <td><code className="text-xs">{c.slug}</code></td>
                <td><span className="chip chip-accent">{c.routing_strategy}</span></td>
                <td>{c.rate_limit_rpm || "—"}</td>
                <td>{c.monthly_token_cap ? c.monthly_token_cap.toLocaleString() : "—"}</td>
                <td>{Number(c.monthly_cost_cap_usd) > 0 ? `$${Number(c.monthly_cost_cap_usd).toFixed(2)}` : "—"}</td>
                <td>
                  <span className={statusChip(c.status)}>{c.status}</span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-1">
                    <TestBtn id={c.id} />
                    <ExportBtn id={c.id} name={c.name} />
                    <CloneBtn id={c.id} />
                    <ArchiveBtn id={c.id} />
                    <DeleteBtn id={c.id} name={c.name} />
                  </div>
                </td>
              </tr>
            ))}
            {(q.data?.combos ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={8} className="text-center text-muted py-12">
                  No combos yet. Start from a template or build your own.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

function Templates({ q }: { q: any }) {
  const templates = (q.data?.combos ?? []).filter((c: any) => c.is_template)
  if (templates.length === 0) return null
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="size-4 text-accent" />
        <h2 className="text-sm font-semibold">Starter templates</h2>
        <span className="text-xs text-muted">Click to clone and customise</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {templates.map((c: any) => (
          <Link
            key={c.id}
            to={`/combos/${c.id}`}
            className="card p-4 hover:border-accent transition group"
          >
            <div className="flex items-center justify-between">
              <div className="font-medium group-hover:text-accent">{c.name}</div>
              <Boxes className="size-4 text-muted group-hover:text-accent" />
            </div>
            <p className="text-xs text-muted mt-1 line-clamp-3 min-h-[3em]">{c.description}</p>
            <div className="mt-3 flex items-center justify-between">
              <span className="chip chip-accent">{c.routing_strategy}</span>
              <span className="text-xs text-muted">clone →</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

function statusChip(s: string) {
  if (s === "active") return "chip chip-good"
  if (s === "archived") return "chip chip-muted"
  return "chip chip-accent"
}

function TestBtn({ id }: { id: string }) {
  const m = useMutation({ mutationFn: () => testCombo(id) })
  const toast = useToast()
  return (
    <button
      className="btn-ghost"
      title="Test providers"
      disabled={m.isPending}
      onClick={() =>
        m.mutate(undefined, {
          onSuccess: (r) => {
            const ok = r.results.filter((x) => x.ok).length
            toast(ok > 0 ? "success" : "error", `${ok}/${r.results.length} providers reachable`)
          },
          onError: (e: any) => toast("error", e?.message ?? "Test failed"),
        })
      }
    >
      {m.isPending ? <Loader2 className="size-4 animate-spin" /> : <TestTube2 className="size-4" />}
    </button>
  )
}

function CloneBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => cloneCombo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["combos"] }),
  })
  return <button className="btn-ghost" title="Clone" onClick={() => m.mutate()}><Copy className="size-4" /></button>
}

function ArchiveBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => archiveCombo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["combos"] }),
  })
  return <button className="btn-ghost" title="Archive" onClick={() => m.mutate()}><Archive className="size-4" /></button>
}

function DeleteBtn({ id, name }: { id: string; name: string }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => deleteCombo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["combos"] }),
  })
  return (
    <button className="btn-ghost text-bad" title="Delete" onClick={() => confirm(`Delete combo "${name}"?`) && m.mutate()}>
      <Trash2 className="size-4" />
    </button>
  )
}

function ExportBtn({ id, name }: { id: string; name: string }) {
  return (
    <button
      className="btn-ghost"
      title="Export"
      onClick={async () => {
        const data = await exportCombo(id)
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `combo-${name.replace(/\s+/g, "-")}.json`
        a.click()
        URL.revokeObjectURL(url)
      }}
    >
      <Download className="size-4" />
    </button>
  )
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("")
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import combo"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={async () => {
              try {
                const body = JSON.parse(text)
                await importCombo(body)
                qc.invalidateQueries({ queryKey: ["combos"] })
                toast("success", "Combo imported")
                onClose()
              } catch (e: any) {
                toast("error", e?.message ?? "Import failed")
              }
            }}
          >
            <Upload className="size-4" /> Import
          </button>
        </>
      }
    >
      <p className="text-sm text-muted mb-2">
        Paste the JSON exported from another combo. Imported combos start as drafts.
      </p>
      <textarea
        className="input font-mono w-full min-h-[200px]"
        placeholder='{"combo": {...}}'
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  )
}