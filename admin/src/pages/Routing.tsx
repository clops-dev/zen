import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Loader2, Plus, Power, Trash2 } from "lucide-react"
import { createRoute, deleteRoute, listModels, listProviders, listRoutes, toggleRoute } from "../api"
import { Modal } from "../ui/Modal"
import { useToast } from "../ui/Toast"
import clsx from "clsx"

const TIERS = ["trivial", "simple", "medium", "complex"] as const

export function RoutingPage() {
  const q = useQuery({ queryKey: ["routes"], queryFn: listRoutes })
  const provs = useQuery({ queryKey: ["providers"], queryFn: listProviders })
  const mods = useQuery({ queryKey: ["models"], queryFn: listModels })
  const [open, setOpen] = useState(false)
  const [tier, setTier] = useState<typeof TIERS[number]>("medium")

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Routing</h1>
          <p className="text-muted text-sm mt-0.5">
            Pick which model(s) serve each complexity tier. The gateway picks a route by weight when several are configured.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New route
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {TIERS.map((t) => {
          const routes = (q.data?.routes ?? []).filter((r) => r.tier === t)
          return (
            <div key={t} className="card">
              <div className="flex items-center justify-between px-5 py-3 border-b border-line">
                <div className="flex items-center gap-2">
                  <span className={clsx("chip", tierColor(t))}>{t}</span>
                  <span className="text-xs text-muted">{routes.length} route{routes.length === 1 ? "" : "s"}</span>
                </div>
                <button className="btn-ghost" onClick={() => { setTier(t); setOpen(true) }}>
                  <Plus className="size-4" />
                </button>
              </div>
              <div className="divide-y divide-line">
                {routes.length === 0 && (
                  <div className="text-muted text-sm px-5 py-6 text-center">No routes for this tier.</div>
                )}
                {routes.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{r.provider_name}</div>
                      <div className="font-mono text-xs text-muted truncate">{r.model_id}</div>
                    </div>
                    <span className="chip chip-muted">w={r.weight}</span>
                    <ToggleBtn id={r.id} enabled={r.enabled} />
                    <DeleteBtn id={r.id} />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <NewRouteDialog
        open={open}
        onClose={() => setOpen(false)}
        initialTier={tier}
        models={mods.data?.models ?? []}
        providers={provs.data?.providers ?? []}
      />
    </div>
  )
}

function tierColor(t: string) {
  switch (t) {
    case "trivial": return "chip-good"
    case "simple": return "chip-accent"
    case "medium": return "chip-accent"
    case "complex": return "chip-bad"
    default: return "chip-muted"
  }
}

function ToggleBtn({ id, enabled }: { id: string; enabled: boolean }) {
  const qc = useQueryClient()
  const m = useMutation({ mutationFn: () => toggleRoute(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }) })
  return <button className="btn-ghost" onClick={() => m.mutate()}><Power className="size-4" /></button>
}

function DeleteBtn({ id }: { id: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => deleteRoute(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); toast("success", "Route removed") },
  })
  return (
    <button className="btn-ghost text-bad" onClick={() => confirm("Remove this route?") && m.mutate()}>
      <Trash2 className="size-4" />
    </button>
  )
}

function NewRouteDialog({
  open,
  onClose,
  initialTier,
  models,
  providers,
}: {
  open: boolean
  onClose: () => void
  initialTier: typeof TIERS[number]
  models: any[]
  providers: any[]
}) {
  const [tier, setTier] = useState(initialTier)
  const [modelId, setModelId] = useState(models[0]?.id ?? "")
  const [weight, setWeight] = useState("1")
  const qc = useQueryClient()
  const toast = useToast()
  const enabledModels = models.filter((m) => m.enabled)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add route"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            form="route-form"
            type="submit"
            disabled={!modelId}
            onClick={async (e) => {
              e.preventDefault()
              try {
                await createRoute({ tier, model_id: modelId, weight: Number(weight) })
                qc.invalidateQueries({ queryKey: ["routes"] })
                toast("success", "Route added")
                onClose()
              } catch (e: any) {
                toast("error", e?.message ?? "Save failed")
              }
            }}
          >
            <ArrowRight className="size-4" />
            Add route
          </button>
        </>
      }
    >
      <form id="route-form" className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
          <span className="label">Tier</span>
          <select className="input" value={tier} onChange={(e) => setTier(e.target.value as any)}>
            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
          <span className="label">Weight</span>
          <input className="input" type="number" min={0} step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="label">Model</span>
          <select className="input" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {enabledModels.length === 0 && <option value="">No enabled models</option>}
            {enabledModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.provider_name}/{m.model_id}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">
            Routes inherit pricing from the model registry. New route weight applies on the next request.
          </span>
        </label>
      </form>
    </Modal>
  )
}