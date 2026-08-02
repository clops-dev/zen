import { useQuery } from "@tanstack/react-query"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Line,
  LineChart,
} from "recharts"
import { Activity, AlertTriangle, CheckCircle2, Cpu, KeyRound, Server, Timer, Users, Wallet } from "lucide-react"
import { dashboardOverview, providerHealth } from "../api"

export function Dashboard() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: dashboardOverview, refetchInterval: 30_000 })
  const h = useQuery({ queryKey: ["health"], queryFn: providerHealth, refetchInterval: 60_000 })

  const t: any = q.data?.totals ?? {}
  const c: any = q.data?.counts ?? {}

  return (
    <div className="flex flex-col gap-6">
      <Header />

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Metric icon={<Activity className="size-4" />} label="Total requests" value={fmt(t.total_requests)} />
        <Metric icon={<Timer className="size-4" />} label="Today" value={fmt(t.requests_today)} />
        <Metric icon={<CheckCircle2 className="size-4" />} label="Success rate" value={successRate(t)} accent="good" />
        <Metric icon={<AlertTriangle className="size-4" />} label="Failed" value={fmt(t.failed)} accent={t.failed > 0 ? "bad" : undefined} />
        <Metric icon={<Timer className="size-4" />} label="Avg latency" value={t.avg_latency_ms ? `${t.avg_latency_ms} ms` : "—"} />
        <Metric icon={<Server className="size-4" />} label="Active providers" value={fmt(c.active_providers)} />
        <Metric icon={<Cpu className="size-4" />} label="Active models" value={fmt(c.active_models)} />
        <Metric icon={<KeyRound className="size-4" />} label="API keys" value={fmt(c.api_keys)} />
        <Metric icon={<Users className="size-4" />} label="Users" value={fmt(c.users)} />
        <Metric icon={<Wallet className="size-4" />} label="Total spend" value={`$${Number(t.total_cost ?? 0).toFixed(4)}`} accent="accent" />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Request volume (last 24h)" className="lg:col-span-2">
          <RequestsTimeline data={q.data?.requestsTimeline ?? []} />
        </ChartCard>
        <ChartCard title="Success / failure ratio">
          <SuccessFailure data={q.data?.successFailure ?? []} />
        </ChartCard>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Top providers (7d)">
          <ProviderUsage data={q.data?.providerUsage ?? []} />
        </ChartCard>
        <ChartCard title="Top models (7d)">
          <ModelUsage data={q.data?.modelUsage ?? []} />
        </ChartCard>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Latency p50 / p95 (24h)">
          <Latency data={q.data?.latencyTimeline ?? []} />
        </ChartCard>
        <ChartCard title="Provider health">
          <ProviderHealth rows={h.data?.providers ?? []} />
        </ChartCard>
      </section>
    </div>
  )
}

function Header() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations overview</h1>
        <p className="text-muted text-sm mt-0.5">
          Real-time traffic across all configured providers, models, and routes.
        </p>
      </div>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  accent?: "good" | "bad" | "accent"
}) {
  const color = accent === "good" ? "text-good" : accent === "bad" ? "text-bad" : accent === "accent" ? "text-accent" : ""
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-muted text-xs uppercase tracking-wider">
        <span>{label}</span>
        {icon}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
    </div>
  )
}

function ChartCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card p-4 min-h-[280px] ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="h-[230px]">{children}</div>
    </div>
  )
}

function fmt(v: any) {
  if (v === null || v === undefined) return "—"
  return Number(v).toLocaleString()
}

function successRate(t: any) {
  const total = Number(t.success ?? 0) + Number(t.failed ?? 0) + Number(t.rejected ?? 0)
  if (total === 0) return "—"
  return `${((Number(t.success ?? 0) / total) * 100).toFixed(1)}%`
}

function RequestsTimeline({ data }: { data: any[] }) {
  const series = data.map((d) => ({ ...d, bucket: new Date(d.bucket).toLocaleTimeString([], { hour: "2-digit" }) }))
  return (
    <ResponsiveContainer>
      <AreaChart data={series}>
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity={0.5} />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
        <XAxis dataKey="bucket" stroke="rgb(var(--muted))" fontSize={11} />
        <YAxis stroke="rgb(var(--muted))" fontSize={11} />
        <Tooltip contentStyle={tooltipStyle} />
        <Area type="monotone" dataKey="requests" stroke="rgb(var(--accent))" fill="url(#g1)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function SuccessFailure({ data }: { data: any[] }) {
  const map: Record<string, string> = {
    success: "rgb(var(--good))",
    failure: "rgb(var(--bad))",
    rejected: "rgb(var(--muted))",
  }
  return (
    <ResponsiveContainer>
      <PieChart>
        <Pie data={data} dataKey="n" nameKey="status" innerRadius={50} outerRadius={85} stroke="rgb(var(--bg))">
          {data.map((d, i) => (
            <Cell key={i} fill={map[d.status] ?? "rgb(var(--accent))"} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ color: "rgb(var(--muted))" }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

function ProviderUsage({ data }: { data: any[] }) {
  return (
    <ResponsiveContainer>
      <BarChart data={data} layout="vertical">
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
        <XAxis type="number" stroke="rgb(var(--muted))" fontSize={11} />
        <YAxis type="category" dataKey="provider" stroke="rgb(var(--muted))" fontSize={11} width={120} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="requests" fill="rgb(var(--accent))" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ModelUsage({ data }: { data: any[] }) {
  return (
    <ResponsiveContainer>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
        <XAxis dataKey="model_label" stroke="rgb(var(--muted))" fontSize={10} angle={-15} dy={8} />
        <YAxis stroke="rgb(var(--muted))" fontSize={11} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="requests" fill="rgb(var(--good))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function Latency({ data }: { data: any[] }) {
  const series = data.map((d) => ({ ...d, bucket: new Date(d.bucket).toLocaleTimeString([], { hour: "2-digit" }) }))
  return (
    <ResponsiveContainer>
      <LineChart data={series}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
        <XAxis dataKey="bucket" stroke="rgb(var(--muted))" fontSize={11} />
        <YAxis stroke="rgb(var(--muted))" fontSize={11} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend />
        <Line type="monotone" dataKey="p50" stroke="rgb(var(--accent))" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="p95" stroke="rgb(var(--bad))" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function ProviderHealth({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <div className="text-muted text-sm">No providers configured.</div>
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {rows.map((p) => (
        <div key={p.id} className="card p-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="font-medium">{p.name}</div>
            <span className={p.healthy ? "chip chip-good" : "chip chip-bad"}>
              {p.healthy ? "Healthy" : `Down (${p.consecutive_failures})`}
            </span>
          </div>
          <div className="text-xs text-muted truncate font-mono">{p.base_url}</div>
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{p.provider_type}</span>
            <span>{p.last_failure_at ? `Last fail: ${new Date(p.last_failure_at).toLocaleString()}` : "No failures"}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

const tooltipStyle = {
  background: "rgb(var(--panel))",
  border: "1px solid rgb(var(--line))",
  borderRadius: 8,
  color: "rgb(var(--text))",
  fontSize: 12,
}