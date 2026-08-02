import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Edit3, Loader2, Plus, Power, TestTube2, Trash2 } from "lucide-react"
import {
  cloneModel,
  createModel,
  deleteModel,
  listModels,
  listProviders,
  testModel,
  toggleModel,
  updateModel,
  type Model,
  type Provider,
} from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

const CAP_KEYS = [
  ["supports_tools", "Tools"],
  ["supports_vision", "Vision"],
  ["supports_json_mode", "JSON"],
  ["supports_streaming", "Streaming"],
  ["supports_reasoning", "Reasoning"],
  ["supports_embeddings", "Embeddings"],
] as const

export function ModelsPage() {
  const q = useQuery({ queryKey: ["models"], queryFn: listModels })
  const provs = useQuery({ queryKey: ["providers"], queryFn: listProviders })
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Model | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="text-muted text-sm mt-0.5">
            Register a specific model id on each provider. Pricing here drives cost tracking on the dashboard.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setOpen(true) }}
          disabled={(provs.data?.providers ?? []).filter((p) => p.enabled).length === 0}
        >
          <Plus className="size-4" /> New model
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model id</th>
              <th>Capabilities</th>
              <th>$/1M in/out</th>
              <th>Context</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.models ?? []).map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="chip chip-muted">{m.provider_name}</span>
                </td>
                <td>
                  <div className="font-mono text-xs">{m.model_id}</div>
                  {m.label && <div className="text-xs text-muted">{m.label}</div>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {CAP_KEYS.map(([k, label]) =>
                      (m as any)[k] ? (
                        <span key={k} className="chip chip-accent text-[10px] py-0">
                          {label}
                        </span>
                      ) : null,
                    )}
                  </div>
                </td>
                <td className="font-mono text-xs">
                  ${Number(m.input_price_per_1m).toFixed(4)} / ${Number(m.output_price_per_1m).toFixed(4)}
                </td>
                <td>{m.context_window ?? "—"}</td>
                <td>
                  <span className={m.enabled ? "chip chip-good" : "chip chip-muted"}>
                    {m.enabled ? "on" : "off"}
                  </span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-1">
                    <TestModelBtn id={m.id} />
                    <ToggleModelBtn id={m.id} enabled={m.enabled} />
                    <button className="btn-ghost" onClick={() => { setEditing(m); setOpen(true) }} title="Edit">
                      <Edit3 className="size-4" />
                    </button>
                    <CloneModelBtn id={m.id} />
                    <DeleteModelBtn id={m.id} />
                  </div>
                </td>
              </tr>
            ))}
            {(q.data?.models ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">
                  Add a provider first, then register a model here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ModelDialog
        open={open}
        onClose={() => setOpen(false)}
        initial={editing}
        providers={provs.data?.providers ?? []}
      />
    </div>
  )
}

function TestModelBtn({ id }: { id: string }) {
  const m = useMutation({ mutationFn: () => testModel(id) })
  const toast = useToast()
  return (
    <button
      className="btn-ghost"
      title="Test model"
      disabled={m.isPending}
      onClick={() =>
        m.mutate(undefined, {
          onSuccess: (r) => toast(r.ok ? "success" : "error", `${r.status} · ${r.latency_ms}ms`),
          onError: (e: any) => toast("error", e?.message ?? "Test failed"),
        })
      }
    >
      {m.isPending ? <Loader2 className="size-4 animate-spin" /> : <TestTube2 className="size-4" />}
    </button>
  )
}

function ToggleModelBtn({ id, enabled }: { id: string; enabled: boolean }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => toggleModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  })
  return (
    <button className="btn-ghost" title={enabled ? "Disable" : "Enable"} onClick={() => m.mutate()}>
      <Power className="size-4" />
    </button>
  )
}

function CloneModelBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => cloneModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] })
      toast("success", "Model cloned")
    },
  })
  return (
    <button className="btn-ghost" title="Clone" onClick={() => m.mutate()}>
      <Copy className="size-4" />
    </button>
  )
}

function DeleteModelBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => deleteModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  })
  return (
    <button className="btn-ghost text-bad" title="Delete" onClick={() => confirm("Delete this model?") && m.mutate()}>
      <Trash2 className="size-4" />
    </button>
  )
}

function ModelDialog({
  open,
  onClose,
  initial,
  providers,
}: {
  open: boolean
  onClose: () => void
  initial: Model | null
  providers: Provider[]
}) {
  const [providerId, setProviderId] = useState(initial?.provider_id ?? providers[0]?.id ?? "")
  const [modelId, setModelId] = useState(initial?.model_id ?? "")
  const [label, setLabel] = useState(initial?.label ?? "")
  const [inPrice, setInPrice] = useState(String(initial?.input_price_per_1m ?? 0))
  const [outPrice, setOutPrice] = useState(String(initial?.output_price_per_1m ?? 0))
  const [ctx, setCtx] = useState(String(initial?.context_window ?? ""))
  const [caps, setCaps] = useState<Record<string, boolean>>(() => {
    const m = initial as any
    return {
      supports_tools: m?.supports_tools ?? false,
      supports_vision: m?.supports_vision ?? false,
      supports_json_mode: m?.supports_json_mode ?? false,
      supports_streaming: m?.supports_streaming ?? true,
      supports_reasoning: m?.supports_reasoning ?? false,
      supports_embeddings: m?.supports_embeddings ?? false,
    }
  })
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)

  const qc = useQueryClient()
  const toast = useToast()

  const create = useMutation({ mutationFn: createModel })
  const update = useMutation({ mutationFn: (body: any) => updateModel(initial!.id, body) })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = {
      provider_id: providerId,
      model_id: modelId,
      label: label || null,
      input_price_per_1m: Number(inPrice),
      output_price_per_1m: Number(outPrice),
      context_window: ctx ? Number(ctx) : null,
      ...caps,
      enabled,
    }
    try {
      if (initial) await update.mutateAsync(body)
      else await create.mutateAsync(body)
      qc.invalidateQueries({ queryKey: ["models"] })
      onClose()
      toast("success", initial ? "Model updated" : "Model created")
    } catch (e: any) {
      toast("error", e?.message ?? "Save failed")
    }
  }

  const isSaving = create.isPending || update.isPending

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `Edit model · ${initial.model_id}` : "New model"}
      size="lg"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" form="model-form" type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {initial ? "Save changes" : "Create model"}
          </button>
        </>
      }
    >
      <form id="model-form" onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Provider" className="md:col-span-2">
          <select className="input w-full" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.provider_type})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model id">
          <input className="input w-full font-mono" required value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="llama-3.3-70b-versatile" />
        </Field>
        <Field label="Display label">
          <input className="input w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Input price $/1M">
          <input className="input w-full" type="number" step="0.0001" value={inPrice} onChange={(e) => setInPrice(e.target.value)} />
        </Field>
        <Field label="Output price $/1M">
          <input className="input w-full" type="number" step="0.0001" value={outPrice} onChange={(e) => setOutPrice(e.target.value)} />
        </Field>
        <Field label="Context window">
          <input className="input w-full" type="number" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="200000" />
        </Field>
        <Field label="Enabled" className="flex-row items-center">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Routable
          </label>
        </Field>
        <Field label="Capabilities" className="md:col-span-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CAP_KEYS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={caps[k]}
                  onChange={(e) => setCaps({ ...caps, [k]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
      </form>
    </Modal>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}