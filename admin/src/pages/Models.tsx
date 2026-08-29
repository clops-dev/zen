import { useState, useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Copy, Edit3, Loader2, Plus, Power, RefreshCw, TestTube2, Trash2 } from "lucide-react"
import {
  cloneModel,
  createModel,
  deleteModel,
  fetchOpenRouterMetadata,
  listModels,
  listProviders,
  refreshModelMetadata,
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
  ["supports_structured_outputs", "Structured Outputs"],
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
            Register a specific model id on each provider. OpenRouter models feature automatic metadata population.
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
              <th>Cache Read/Write</th>
              <th>Context</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.models ?? []).map((m) => {
              const isOpenRouter = (m.provider_base_url ?? "").toLowerCase().includes("openrouter.ai")
              return (
                <tr key={m.id}>
                  <td>
                    <span className="chip chip-muted">{m.provider_name}</span>
                  </td>
                  <td>
                    <div className="font-mono text-xs">{m.model_id}</div>
                    {m.label && <div className="text-xs text-muted">{m.label}</div>}
                    {m.metadata_synced_at && (
                      <div className="text-[10px] text-muted font-mono mt-0.5">
                        Synced: {new Date(m.metadata_synced_at).toLocaleDateString()}
                      </div>
                    )}
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
                    {Number(m.request_price_flat) > 0 && (
                      <div className="text-[10px] text-muted">+${Number(m.request_price_flat).toFixed(4)}/req</div>
                    )}
                  </td>
                  <td className="font-mono text-xs text-muted">
                    {m.input_cache_read_price_per_1m != null
                      ? `$${Number(m.input_cache_read_price_per_1m).toFixed(4)}`
                      : "—"}
                    {" / "}
                    {m.input_cache_write_price_per_1m != null
                      ? `$${Number(m.input_cache_write_price_per_1m).toFixed(4)}`
                      : "—"}
                  </td>
                  <td>{m.context_window ?? "—"}</td>
                  <td>
                    <span className={m.enabled ? "chip chip-good" : "chip chip-muted"}>
                      {m.enabled ? "on" : "off"}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      {isOpenRouter && <RefreshModelBtn id={m.id} />}
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
              )
            })}
            {(q.data?.models ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={8} className="text-center text-muted py-12">
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

function RefreshModelBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => refreshModelMetadata(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] })
      toast("success", "Refreshed metadata from OpenRouter")
    },
    onError: (err: any) => {
      toast("error", err?.message ?? "Failed to refresh metadata")
    },
  })

  return (
    <button
      className="btn-ghost"
      title="Refresh from OpenRouter"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      <RefreshCw className={`size-4 ${m.isPending ? "animate-spin" : ""}`} />
    </button>
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
  const [inCacheReadPrice, setInCacheReadPrice] = useState(
    initial?.input_cache_read_price_per_1m != null ? String(initial.input_cache_read_price_per_1m) : "",
  )
  const [inCacheWritePrice, setInCacheWritePrice] = useState(
    initial?.input_cache_write_price_per_1m != null ? String(initial.input_cache_write_price_per_1m) : "",
  )
  const [flatRequestPrice, setFlatRequestPrice] = useState(
    initial?.request_price_flat != null ? String(initial.request_price_flat) : "0",
  )
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
      supports_structured_outputs: m?.supports_structured_outputs ?? false,
    }
  })
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [openrouterModelId, setOpenrouterModelId] = useState(initial?.openrouter_model_id ?? "")
  const [metadataSyncedAt, setMetadataSyncedAt] = useState(initial?.metadata_synced_at ?? "")
  const [overridesWarning, setOverridesWarning] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isFetchingMeta, setIsFetchingMeta] = useState(false)

  const selectedProvider = providers.find((p) => p.id === providerId)
  const isOpenRouter = (selectedProvider?.base_url ?? "").toLowerCase().includes("openrouter.ai")

  useEffect(() => {
    if (open) {
      const pId = initial?.provider_id ?? providers[0]?.id ?? ""
      setProviderId(pId)
      setModelId(initial?.model_id ?? "")
      setLabel(initial?.label ?? "")
      setInPrice(String(initial?.input_price_per_1m ?? 0))
      setOutPrice(String(initial?.output_price_per_1m ?? 0))
      setInCacheReadPrice(initial?.input_cache_read_price_per_1m != null ? String(initial.input_cache_read_price_per_1m) : "")
      setInCacheWritePrice(initial?.input_cache_write_price_per_1m != null ? String(initial.input_cache_write_price_per_1m) : "")
      setFlatRequestPrice(initial?.request_price_flat != null ? String(initial.request_price_flat) : "0")
      setCtx(String(initial?.context_window ?? ""))
      const m = initial as any
      setCaps({
        supports_tools: m?.supports_tools ?? false,
        supports_vision: m?.supports_vision ?? false,
        supports_json_mode: m?.supports_json_mode ?? false,
        supports_streaming: m?.supports_streaming ?? true,
        supports_reasoning: m?.supports_reasoning ?? false,
        supports_embeddings: m?.supports_embeddings ?? false,
        supports_structured_outputs: m?.supports_structured_outputs ?? false,
      })
      setEnabled(initial?.enabled ?? true)
      setOpenrouterModelId(initial?.openrouter_model_id ?? "")
      setMetadataSyncedAt(initial?.metadata_synced_at ?? "")
      setOverridesWarning(null)
      setFetchError(null)
    }
  }, [open, initial, providers])

  const handleFetchOpenRouter = async (slugToFetch?: string) => {
    const targetSlug = slugToFetch || modelId
    if (!targetSlug) {
      setFetchError("Please enter a model ID first (e.g. anthropic/claude-3.5-sonnet).")
      return
    }
    setIsFetchingMeta(true)
    setFetchError(null)
    setOverridesWarning(null)
    try {
      const res = await fetchOpenRouterMetadata(providerId, targetSlug)
      const meta = res.metadata
      setLabel(meta.label ?? "")
      setInPrice(String(meta.input_price_per_1m ?? 0))
      setOutPrice(String(meta.output_price_per_1m ?? 0))
      setInCacheReadPrice(meta.input_cache_read_price_per_1m != null ? String(meta.input_cache_read_price_per_1m) : "")
      setInCacheWritePrice(meta.input_cache_write_price_per_1m != null ? String(meta.input_cache_write_price_per_1m) : "")
      setFlatRequestPrice(String(meta.request_price_flat ?? 0))
      setCtx(meta.context_window != null ? String(meta.context_window) : "")
      setCaps((prev) => ({
        ...prev,
        supports_tools: meta.supports_tools,
        supports_vision: meta.supports_vision,
        supports_json_mode: meta.supports_json_mode,
        supports_structured_outputs: meta.supports_structured_outputs,
        supports_reasoning: meta.supports_reasoning,
      }))
      setOpenrouterModelId(meta.openrouter_model_id ?? targetSlug)
      setMetadataSyncedAt(meta.metadata_synced_at ?? new Date().toISOString())
      if (meta.overrides_warning) {
        setOverridesWarning(meta.overrides_warning)
      }
    } catch (e: any) {
      setFetchError(e?.message || "Failed to fetch metadata from OpenRouter. Check the model ID or enter manually.")
    } finally {
      setIsFetchingMeta(false)
    }
  }

  const qc = useQueryClient()
  const toast = useToast()

  const create = useMutation({ mutationFn: createModel })
  const update = useMutation({ mutationFn: (body: any) => updateModel(initial!.id, body) })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFetchError(null)
    const body = {
      provider_id: providerId,
      model_id: modelId,
      label: label || null,
      input_price_per_1m: Number(inPrice),
      output_price_per_1m: Number(outPrice),
      input_cache_read_price_per_1m: inCacheReadPrice !== "" ? Number(inCacheReadPrice) : null,
      input_cache_write_price_per_1m: inCacheWritePrice !== "" ? Number(inCacheWritePrice) : null,
      request_price_flat: flatRequestPrice !== "" ? Number(flatRequestPrice) : 0,
      context_window: ctx ? Number(ctx) : null,
      openrouter_model_id: openrouterModelId || null,
      metadata_synced_at: metadataSyncedAt || null,
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
      setFetchError(e?.message ?? "Save failed")
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
          <button className="btn-primary" form="model-form" type="submit" disabled={isSaving || isFetchingMeta}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {initial ? "Save changes" : "Create model"}
          </button>
        </>
      }
    >
      <form id="model-form" onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {overridesWarning && (
          <div className="md:col-span-2 p-3 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded text-xs flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{overridesWarning}</span>
          </div>
        )}
        {fetchError && (
          <div className="md:col-span-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded text-xs flex items-center justify-between gap-2">
            <span>{fetchError}</span>
            {isOpenRouter && (
              <button
                type="button"
                className="btn-ghost text-xs underline py-0 px-1"
                onClick={() => handleFetchOpenRouter()}
              >
                Retry
              </button>
            )}
          </div>
        )}
        <Field label="Provider" className="md:col-span-2">
          <select
            className="input w-full"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value)
              setFetchError(null)
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.provider_type})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model id" className="md:col-span-2">
          <div className="flex gap-2">
            <input
              className="input w-full font-mono"
              required
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value)
                if (metadataSyncedAt) setMetadataSyncedAt("")
              }}
              onBlur={() => {
                if (isOpenRouter && modelId && modelId.includes("/") && !metadataSyncedAt && !isFetchingMeta) {
                  handleFetchOpenRouter(modelId)
                }
              }}
              placeholder="e.g. anthropic/claude-3.5-sonnet"
            />
            {isOpenRouter && (
              <button
                type="button"
                className="btn-secondary whitespace-nowrap flex items-center gap-1.5"
                disabled={isFetchingMeta || !modelId}
                onClick={() => handleFetchOpenRouter()}
              >
                {isFetchingMeta ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Auto-fill
              </button>
            )}
          </div>
          {isOpenRouter && metadataSyncedAt && (
            <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              ✓ Prices and tools automatically fetched from OpenRouter
            </div>
          )}
        </Field>
        <Field label="Display label">
          <input className="input w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Context window">
          <input className="input w-full" type="number" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="200000" />
        </Field>
        <Field label="Input price $/1M">
          <input className="input w-full" type="number" step="0.000001" value={inPrice} onChange={(e) => setInPrice(e.target.value)} />
        </Field>
        <Field label="Output price $/1M">
          <input className="input w-full" type="number" step="0.000001" value={outPrice} onChange={(e) => setOutPrice(e.target.value)} />
        </Field>
        <Field label="Cache read price $/1M">
          <input
            className="input w-full"
            type="number"
            step="0.000001"
            value={inCacheReadPrice}
            onChange={(e) => setInCacheReadPrice(e.target.value)}
            placeholder="leave empty if same as input price"
          />
        </Field>
        <Field label="Cache write price $/1M">
          <input
            className="input w-full"
            type="number"
            step="0.000001"
            value={inCacheWritePrice}
            onChange={(e) => setInCacheWritePrice(e.target.value)}
            placeholder="optional"
          />
        </Field>
        <Field label="Flat per-request price ($)">
          <input
            className="input w-full"
            type="number"
            step="0.000001"
            value={flatRequestPrice}
            onChange={(e) => setFlatRequestPrice(e.target.value)}
            placeholder="0"
          />
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
                  checked={caps[k] ?? false}
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