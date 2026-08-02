import { useState } from "react"
import { Bell, Moon, Search, Sun, LogOut, ChevronDown } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { useTheme } from "./Theme"
import { logout, type Me } from "../api"

export function Topbar({ user }: { user: Me | null }) {
  const { theme, setTheme } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()

  const onSignOut = async () => {
    await logout()
    // Clear the cached session so RequireAdmin redirects us to /login.
    qc.setQueryData(["session"], null)
    qc.invalidateQueries({ queryKey: ["session"] })
    nav("/login", { replace: true })
  }

  return (
    <header className="bg-panel border-b border-line h-14 px-4 flex items-center gap-3">
      <div className="flex-1 max-w-xl">
        <label className="relative flex items-center">
          <Search className="size-4 absolute left-3 text-muted" />
          <input
            className="input w-full pl-9"
            placeholder="Search providers, models, combos, users…"
            onChange={() => {}}
          />
        </label>
      </div>
      <button className="btn-ghost" title="Notifications" aria-label="Notifications">
        <Bell className="size-4" />
      </button>
      <button
        className="btn-ghost"
        title="Toggle theme"
        aria-label="Toggle theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
      <div className="relative">
        <button
          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-line/30 transition"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <div className="size-7 rounded-full bg-accent/15 text-accent border border-accent/30 grid place-items-center text-xs font-bold uppercase">
            {(user?.user.email ?? "?").slice(0, 1)}
          </div>
          <div className="hidden sm:block text-left text-xs">
            <div className="font-medium leading-none">{user?.user.email}</div>
            <div className="text-muted mt-0.5 leading-none">{user?.user.role}</div>
          </div>
          <ChevronDown className="size-3.5 text-muted" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 mt-2 w-48 card shadow-pop text-sm"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              className="w-full text-left px-3 py-2 hover:bg-line/30 flex items-center gap-2"
              onClick={onSignOut}
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}