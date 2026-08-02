import { useEffect, useState } from "react"
import { useNavigate, useParams, Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Loader2 } from "lucide-react"
import { createCombo, getCombo, listModels, listProviders, updateCombo } from "../api"
import { useToast } from "../ui/Toast"

const STRATEGIES = [
  { v: "priority", label: "Priority", desc: "Always pick the highest-priority enabled model." },
  { v: "weighted", label: "Weighted", desc: "Pick by weight; supports load-balancing." },
  { v: "round-robin", label: "Round-robin", desc: "Cycle through models in order." },
  { v: "cost-optimized", label: "Cost optimised", desc: "Cheapest enabled model wins." },
  { v: "latency-optimized", label: "Latency optimised", desc: "Lowest p95 wins." },
  { v: "fallback", label: "Fallback", desc: "First try, then fallback chain on failure." },
  { v: "health", label: "Health", desc: "Skip providers marked unhealthy." },
] as const

export function ComboEditor() {
  const { id } = useParams()
  const isNew = !id || id === "new"
  const nav = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const provs = useQuery({ queryKey: ["providers"], queryFn: listProviders })
  const mods = useQuery({ queryKey: ["models"], queryFn: listModels })
  const combo = useQuery({
    queryKey: ["combo", id],
    queryFn: () => getCombo(id!),
    enabled: !isNew,
  })

  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState<"active" | "archived" | "draft">("active")
  const [routingStrategy, setRoutingStrategy] = useState<typeof STRATEGIES[number]["v"]>("fallback")
  const [providerIds, setProviderIds] = useState<string[]>([])
  const [modelIds, setModelIds] = useState<string[]>([])
  const [fallbackChain, setFallbackChain] = useState<string[]>([])
  const [defaults, setDefaults] = useState({
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: 4096,
    timeout_ms: 30000,
  })
  const [rateLimitRpm, setRateLimitRpm] = useState(60)
  const [monthlyTokenCap, setMonthlyTokenCap] = useState(0)
  const [monthlyCostCap, setMonthlyCostCap] = useState(0)

  useEffect(() => {
    if (combo.data) {
      const cb = combo.data.combo
      setSlug(cb.slug)
      setName(cb.name)
      setDescription(cb.description ?? "")
      setStatus(cb.status)
      setRoutingStrategy(cb.routing_strategy)
      setProviderIds(cb.provider_ids ?? [])
      setModelIds(cb.model_ids ?? [])
      setFallbackChain(cb.fallback_chain ?? [])
      if (cb.defaults) setDefaults({ ...defaults, ...cb.defaults })
      setRateLimitRpm(cb.rate_limit_rpm)
      setMonthlyTokenCap(cb.monthly_token_cap)
      setMonthlyCostCap(Number(cb.monthly_cost_cap_usd))
    }
  }, [combo.data])

  const create = useMutation({ mutationFn: createCombo })
  const update = useMutation({ mutationFn: (body: any) => updateCombo(id!, body) })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = {
      slug: slug || slugify(name),
      name,
      description: description || null,
      status,
      provider_ids: providerIds,
      model_ids: modelIds,
      routing_strategy: routingStrategy,
      routing_config: {},
      fallback_chain: fallbackChain,
      defaults,
      rate_limit_rpm: rateLimitRpm,
      monthly_token_cap: monthlyTokenCap,
      monthly_cost_cap_usd: monthlyCostCap,
      allowed_user_ids: [],
      is_template: false,
    }
    try {
      let comboId = id
      if (isNew) {
        const r = await create.mutateAsync(body)
        comboId = r.id
      } else {
        await update.mutateAsync(body)
      }
      qc.invalidateQueries({ queryKey: ["combos"] })
      qc.invalidateQueries({ queryKey: ["combo", comboId] })
      toast("success", isNew ? "Combo created" : "Combo updated")
      nav(`/combos/${comboId}`)
    } catch (e: any) {
      toast("error", e?.message ?? "Save failed")
    }
  }

  const isSaving = create.isPending || update.isPending
  const enabledProviders = provs.data?.providers ?? []
  const enabledModels = mods.data?.models ?? []

  return (
    <form onSubmit={submit} className="flex flex-col gap-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/combos" className="text-xs text-muted hover:text-accent flex items-center gap-1">
            <ArrowLeft className="size-3" /> Back to combos
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            {isNew ? "New combo" : combo.data?.combo?.name ?? "Edit combo"}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link to="/combos" className="btn">Cancel</Link>
          <button className="btn-primary" type="submit" disabled={isSaving || !name}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {isNew ? "Create combo" : "Save changes"}
          </button>
        </div>
      </div>

      <Section title="General">
        <Grid>
          <Field label="Name">
            <input className="input w-full" required value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !slug && setSlug(slugify(name))} />
          </Field>
          <Field label="Slug">
            <input className="input w-full font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from name" />
          </Field>
          <Field label="Status">
            <select className="input w-full" value={status} onChange={(e) => setStatus(e.target.value as any)}>
              <option value="active">active</option>
              <option value="draft">draft</option>
              <option value="archived">archived</option>
            </select>
          </Field>
          <Field label="Description" className="md:col-span-3">
            <textarea className="input w-full min-h-[80px]" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </Grid>
      </Section>

      <Section title="Routing strategy">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {STRATEGIES.map((s) => (
            <button
              key={s.v}
              type="button"
              onClick={() => setRoutingStrategy(s.v)}
              className={
                "text-left card p-3 transition border " +
                (routingStrategy === s.v ? "border-accent bg-accent/5" : "hover:border-accent/50")
              }
            >
              <div className="font-medium">{s.label}</div>
              <div className="text-xs text-muted mt-1">{s.desc}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Providers" hint="The gateway only routes to enabled providers in this combo.">
        <MultiList
          options={enabledProviders.map((p) => ({ value: p.id, label: p.name, sub: `${p.provider_type} · ${p.base_url}` }))}
          selected={providerIds}
          onChange={setProviderIds}
        />
      </Section>

      <Section title="Models" hint="The registry filters by these ids when picking the route.">
        <MultiList
          options={enabledModels.map((m: any) => ({ value: m.id, label: m.model_id, sub: `${m.provider_name} · ${Number(m.input_price_per_1m).toFixed(4)}/${Number(m.output_price_per_1m).toFixed(4)} per 1M` }))}
          selected={modelIds}
          onChange={setModelIds}
        />
      </Section>

      <Section title="Fallback chain" hint="Order matters. Used when the primary route fails.">
        <MultiList
          options={modelIds.map((mid) => {
            const m = enabledModels.find((x: any) => x.id === mid)
            return m ? { value: mid, label: m.model_id, sub: m.provider_name } : { value: mid, label: mid, sub: "" }
          })}
          selected={fallbackChain}
          onChange={setFallbackChain}
        />
      </Section>

      <Section title="Performance defaults">
        <Grid>
          <Field label="Temperature">
            <input type="number" step="0.05" min={0} max={2} className="input w-full" value={defaults.temperature} onChange={(e) => setDefaults({ ...defaults, temperature: Number(e.target.value) })} />
          </Field>
          <Field label="Top P">
            <input type="number" step="0.05" min={0} max={1} className="input w-full" value={defaults.top_p} onChange={(e) => setDefaults({ ...defaults, top_p: Number(e.target.value) })} />
          </Field>
          <Field label="Max tokens">
            <input type="number" min={1} className="input w-full" value={defaults.max_tokens} onChange={(e) => setDefaults({ ...defaults, max_tokens: Number(e.target.value) })} />
          </Field>
          <Field label="Timeout (ms)">
            <input type="number" min={1000} step="1000" className="input w-full" value={defaults.timeout_ms} onChange={(e) => setDefaults({ ...defaults, timeout_ms: Number(e.target.value) })} />
          </Field>
        </Grid>
      </Section>

      <Section title="Limits & budget">
        <Grid>
          <Field label="Rate limit (RPM)">
            <input type="number" min={0} className="input w-full" value={rateLimitRpm} onChange={(e) => setRateLimitRpm(Number(e.target.value))} />
          </Field>
          <Field label="Monthly token cap (0 = uncapped)">
            <input type="number" min={0} className="input w-full" value={monthlyTokenCap} onChange={(e) => setMonthlyTokenCap(Number(e.target.value))} />
          </Field>
          <Field label="Monthly cost cap $ (0 = uncapped)">
            <input type="number" min={0} step="0.01" className="input w-full" value={monthlyCostCap} onChange={(e) => setMonthlyCostCap(Number(e.target.value))} />
          </Field>
        </Grid>
      </Section>
    </form>
  )
}

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-semibold">{title}</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{children}</div>
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function MultiList({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string; sub: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  }
  if (options.length === 0) return <div className="text-sm text-muted">No items available.</div>
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto scroll-y">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          onClick={() => toggle(o.value)}
          className={
            "flex items-center gap-2 text-left p-2.5 rounded-md border transition " +
            (selected.includes(o.value) ? "border-accent bg-accent/5" : "border-line hover:border-accent/50")
          }
        >
          <input type="checkbox" readOnly checked={selected.includes(o.value)} className="shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{o.label}</div>
            <div className="text-xs text-muted truncate font-mono">{o.sub}</div>
          </div>
        </button>
      ))}
    </div>
  )
}