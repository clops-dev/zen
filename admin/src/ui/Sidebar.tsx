import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  KeyRound,
  Layers,
  Cpu,
  Network,
  GitBranch,
  Boxes,
  Users,
  ShieldCheck,
  ScrollText,
  Settings as SettingsIcon,
} from "lucide-react"
import clsx from "clsx"

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: string }

const items: readonly NavItem[] = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/providers", label: "Providers", icon: KeyRound },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/routing", label: "Routing", icon: Network },
  { to: "/combos", label: "Combos", icon: Boxes, badge: "NEW" },
  { to: "/api-keys", label: "API Keys", icon: KeyRound },
  { to: "/requests", label: "Requests", icon: GitBranch },
  { to: "/users", label: "Users", icon: Users },
  { to: "/audit", label: "Audit Logs", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
]

const group1 = ["Overview"]
const group2 = ["Providers", "Models", "Routing", "Combos", "API Keys"]
const group3 = ["Requests", "Users", "Audit Logs", "Settings"]

export function Sidebar() {
  return (
    <aside className="bg-panel border-r border-line h-full flex flex-col min-h-0">
      <div className="px-5 py-4 flex items-center gap-2 border-b border-line">
        <div className="size-7 rounded-md bg-accent text-bg grid place-items-center font-bold">z</div>
        <div>
          <div className="text-sm font-semibold tracking-tight">zen-gateway</div>
          <div className="text-[11px] uppercase tracking-wider text-muted">Admin Console</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto scroll-y px-2 py-3 text-sm">
        <Group label="Overview" items={items.filter((i) => group1.includes(i.label))} />
        <Group label="Configuration" items={items.filter((i) => group2.includes(i.label))} />
        <Group label="Observability" items={items.filter((i) => group3.includes(i.label))} />
      </nav>
      <div className="px-4 py-3 border-t border-line text-[11px] text-muted flex items-center gap-2">
        <ShieldCheck className="size-3.5" />
        All admin actions are audit-logged.
      </div>
    </aside>
  )
}

function Group({ label, items }: { label: string; items: readonly NavItem[] }) {
  return (
    <div className="mb-3">
      <div className="px-2 pt-2 pb-1 label">{label}</div>
      <div className="flex flex-col">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 mx-1 transition-colors",
                isActive ? "bg-accent/10 text-accent border border-accent/20" : "text-muted hover:text-text hover:bg-line/30 border border-transparent",
              )
            }
          >
            <it.icon className="size-4 shrink-0" />
            <span className="truncate">{it.label}</span>
            {it.badge ? (
              <span className="ml-auto text-[10px] uppercase tracking-wider font-semibold rounded px-1.5 py-0.5 bg-accent/15 text-accent border border-accent/30">
                {it.badge}
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>
    </div>
  )
}