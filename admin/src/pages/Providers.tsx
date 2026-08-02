import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Copy, Edit3, Loader2, Plus, Power, TestTube2, Trash2, XCircle } from "lucide-react"
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  toggleProvider,
  updateProvider,
  type Provider,
} from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"

export function ProvidersPage() {
  const q = useQuery({ queryKey: ["providers"], queryFn: listProviders })
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const toast = useToast()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <p className="text-muted text-sm mt-0.5">
            Connect any OpenAI-compatible or Anthropic-compatible upstream. Secret keys are stored server-side and never re-exposed after save.
          </p>
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setOpen(true) }}>
          <Plus className="size-4" />
          New provider
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Base URL</th>
              <th>Key</th>
              <th>Health</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.providers ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="font-medium">{p.name}</div>
                </td>
                <td>
                  <span className="chip chip-muted">{p.provider_type}</span>
                </td>
                <td className="font-mono text-xs">{p.base_url}</td>
                <td>
                  <code className="text-xs">
                    {p.has_key ? (
                      <span className="text-muted">{p.key_preview}</span>
                    ) : (
                      <span className="text-bad">no key</span>
                    )}
                  </code>
                </td>
                <td>
                  <span className={p.healthy ? "chip chip-good" : "chip chip-bad"}>
                    {p.healthy ? "healthy" : `down (${p.consecutive_failures})`}
                  </span>
                </td>
                <td>
                  <span className={p.enabled ? "chip chip-good" : "chip chip-muted"}>
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-1.5">
                    <TestBtn id={p.id} />
                    <ToggleBtn id={p.id} enabled={p.enabled} />
                    <button className="btn-ghost" onClick={() => { setEditing(p); setOpen(true) }} title="Edit">
                      <Edit3 className="size-4" />
                    </button>
                    <DeleteBtn id={p.id} name={p.name} />
                  </div>
                </td>
              </tr>
            ))}
            {(q.data?.providers ?? []).length === 0 && !q.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">
                  No providers configured yet. Click <strong>New provider</strong> to add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ProviderDialog
        open={open}
        onClose={() => setOpen(false)}
        initial={editing}
        onSaved={() => {
          setOpen(false)
          toast("success", editing ? "Provider updated" : "Provider created")
        }}
      />
    </div>
  )
}

function TestBtn({ id }: { id: string }) {
  const m = useMutation({ mutationFn: () => testProvider(id) })
  return (
    <button
      className="btn-ghost"
      title="Test connection"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending ? <Loader2 className="size-4 animate-spin" /> : <TestTube2 className="size-4" />}
    </button>
  )
}

function ToggleBtn({ id, enabled }: { id: string; enabled: boolean }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => toggleProvider(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  })
  return (
    <button
      className="btn-ghost"
      title={enabled ? "Disable" : "Enable"}
      onClick={() => m.mutate()}
    >
      <Power className="size-4" />
    </button>
  )
}

function DeleteBtn({ id, name }: { id: string; name: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => deleteProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] })
      toast("success", `Provider "${name}" deleted`)
    },
  })
  return (
    <button
      className="btn-ghost text-bad"
      title="Delete"
      onClick={() => {
        if (confirm(`Delete provider "${name}"? Models for this provider will also be deleted.`)) m.mutate()
      }}
    >
      <Trash2 className="size-4" />
    </button>
  )
}

function ProviderDialog({
  open,
  onClose,
  initial,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  initial: Provider | null
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "https://openrouter.ai/api/v1")
  const [providerType, setProviderType] = useState(initial?.provider_type ?? "openai-compatible")
  const [apiKey, setApiKey] = useState("")
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [org, setOrg] = useState<string>((initial?.meta as any)?.organization ?? "")
  const [region, setRegion] = useState<string>((initial?.meta as any)?.region ?? "")
  const [timeoutMs, setTimeoutMs] = useState<string>(String((initial?.meta as any)?.timeout_ms ?? ""))
  const [retryMax, setRetryMax] = useState<string>(String((initial?.meta as any)?.retry_max ?? ""))
  const [rateLimitRpm, setRateLimitRpm] = useState<string>(String((initial?.meta as any)?.rate_limit_rpm ?? ""))
  const [priority, setPriority] = useState<number>((initial?.meta as any)?.priority ?? 50)
  const [weight, setWeight] = useState<number>((initial?.meta as any)?.weight ?? 1)
  const [costMultiplier, setCostMultiplier] = useState<number>((initial?.meta as any)?.cost_multiplier ?? 1)

  const qc = useQueryClient()
  const toast = useToast()

  const create = useMutation({ mutationFn: createProvider })
  const update = useMutation({ mutationFn: (body: any) => updateProvider(initial!.id, body) })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body: any = {
      name,
      base_url: baseUrl,
      provider_type: providerType,
      enabled,
    }
    if (apiKey) body.api_key = apiKey
    if (org) body.organization = org
    if (region) body.region = region
    if (timeoutMs) body.timeout_ms = Number(timeoutMs)
    if (retryMax !== "") body.retry_max = Number(retryMax)
    if (rateLimitRpm !== "") body.rate_limit_rpm = Number(rateLimitRpm)
    body.priority = priority
    body.weight = weight
    body.cost_multiplier = costMultiplier
    try {
      if (initial) await update.mutateAsync(body)
      else await create.mutateAsync(body)
      qc.invalidateQueries({ queryKey: ["providers"] })
      onSaved()
    } catch (e: any) {
      toast("error", e?.message ?? "Save failed")
    }
  }

  const isSaving = create.isPending || update.isPending

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `Edit provider · ${initial.name}` : "New provider"}
      size="lg"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" type="submit" form="provider-form" disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {initial ? "Save changes" : "Create provider"}
          </button>
        </>
      }
    >
      <form id="provider-form" onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input className="input w-full" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Provider type">
          <select className="input w-full" value={providerType} onChange={(e) => setProviderType(e.target.value as any)}>
            <option value="openai-compatible">openai-compatible</option>
            <option value="anthropic-compatible">anthropic-compatible</option>
          </select>
        </Field>
        <Field label="Base URL" className="md:col-span-2">
          <input className="input w-full font-mono" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="API key" className="md:col-span-2" hint={initial ? "Leave blank to keep the existing key." : undefined}>
          <input
            type="password"
            className="input w-full font-mono"
            value={apiKey}
            placeholder={initial?.has_key ? "•••••• (existing key, hidden)" : "sk-..."}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <Field label="Organization">
          <input className="input w-full" value={org} onChange={(e) => setOrg(e.target.value)} />
        </Field>
        <Field label="Region">
          <input className="input w-full" value={region} onChange={(e) => setRegion(e.target.value)} />
        </Field>
        <Field label="Timeout (ms)">
          <input className="input w-full" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} placeholder="30000" />
        </Field>
        <Field label="Retry max">
          <input className="input w-full" value={retryMax} onChange={(e) => setRetryMax(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Rate limit (req/min)">
          <input className="input w-full" value={rateLimitRpm} onChange={(e) => setRateLimitRpm(e.target.value)} placeholder="—" />
        </Field>
        <Field label="Priority">
          <input type="number" min={0} max={100} className="input w-full" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
        </Field>
        <Field label="Weight">
          <input type="number" min={0} step="0.1" className="input w-full" value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
        </Field>
        <Field label="Cost multiplier">
          <input type="number" min={0} step="0.01" className="input w-full" value={costMultiplier} onChange={(e) => setCostMultiplier(Number(e.target.value))} />
        </Field>
        <Field label="Enabled" className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Provider is enabled for routing
          </label>
        </Field>
      </form>
    </Modal>
  )
}

function Field({ label, children, hint, className }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}