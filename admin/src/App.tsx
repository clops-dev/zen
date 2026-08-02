import { Suspense, Component, type ReactNode } from "react"
import { Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Sidebar } from "./ui/Sidebar"
import { Topbar } from "./ui/Topbar"
import { Login } from "./pages/Login"
import { Dashboard } from "./pages/Dashboard"
import { ProvidersPage } from "./pages/Providers"
import { ModelsPage } from "./pages/Models"
import { RoutingPage } from "./pages/Routing"
import { CombosPage } from "./pages/Combos"
import { ComboEditor } from "./pages/ComboEditor"
import { ApiKeysPage } from "./pages/ApiKeys"
import { RequestsPage } from "./pages/Requests"
import { UsersPage } from "./pages/Users"
import { AuditPage } from "./pages/Audit"
import { SettingsPage } from "./pages/Settings"
import { me } from "./api"
import { ThemeProvider } from "./ui/Theme"

/** Per-route error boundary. Without this, a render-time exception in a
 * page silently blanks the whole <Outlet /> and the user sees a black
 * panel with zero signal. Catching it here shows the message in-app and
 * keeps the Sidebar/Topbar usable. */
class RouteBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error("[RouteBoundary]", error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card p-6 border border-bad/30">
          <h2 className="text-lg font-semibold text-bad mb-2">
            This page failed to render.
          </h2>
          <p className="text-sm text-muted mb-3">
            {this.state.error.message}
          </p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/** Cached session check. Uses TanStack Query so every consumer reads the
 * same result — no per-route refetch. `staleTime: Infinity` because the
 * session doesn't change while the tab is open; logout clears the cache
 * explicitly. */
function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: me,
    staleTime: Infinity,
    retry: false,
  })
}

/** Single layout route for the entire authenticated app. The Sidebar +
 * Topbar stay mounted across navigation — only the page content (the
 * <Outlet />) swaps. This is the source of the previous "black screen"
 * bug: every nav unmounted the whole shell, briefly flashing empty. */
function Shell() {
  const session = useSession()
  const user = session.data?.user ?? null

  return (
    <div className="h-full grid grid-cols-[260px_1fr]">
      <Sidebar />
      <div className="flex flex-col min-h-0">
        <Topbar user={user ? { user } : null} />
        <main className="flex-1 min-h-0 overflow-y-auto scroll-y">
          <div className="max-w-[1280px] mx-auto p-6">
            {/*
              Suspense fallback keeps the previously-rendered page mounted
              during the new page's data fetch. This eliminates the empty
              flash when navigating between pages that each fire their
              own useQuery. The fallback is intentionally minimal so it
              reads as "loading next view" rather than a full black screen.
            */}
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}

/** Full-page fallback shown only on the very first app boot, when there's
 * no previous page to keep mounted. After that, React 18's startTransition
 * keeps the prior page visible while the next one's data loads. */
function PageSkeleton() {
  return (
    <div className="flex items-center justify-center py-16 text-muted text-sm">
      <span className="size-3 mr-2 rounded-full bg-accent animate-pulse" />
      Loading…
    </div>
  )
}

/** Gate that flips to /login if not admin. Reads the cached session, no
 * per-route refetch. */
function RequireAdmin() {
  const session = useSession()
  const loc = useLocation()
  if (session.isLoading) return <PageSkeleton />
  if (session.isError || !session.data || session.data.user.role !== "admin") {
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />
  }
  return <Outlet />
}

export function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAdmin />}>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<RouteBoundary><Dashboard /></RouteBoundary>} />
            <Route path="/providers" element={<RouteBoundary><ProvidersPage /></RouteBoundary>} />
            <Route path="/models" element={<RouteBoundary><ModelsPage /></RouteBoundary>} />
            <Route path="/routing" element={<RouteBoundary><RoutingPage /></RouteBoundary>} />
            <Route path="/combos" element={<RouteBoundary><CombosPage /></RouteBoundary>} />
            <Route path="/combos/new" element={<RouteBoundary><ComboEditor /></RouteBoundary>} />
            <Route path="/combos/:id" element={<RouteBoundary><ComboEditor /></RouteBoundary>} />
            <Route path="/api-keys" element={<RouteBoundary><ApiKeysPage /></RouteBoundary>} />
            <Route path="/requests" element={<RouteBoundary><RequestsPage /></RouteBoundary>} />
            <Route path="/users" element={<RouteBoundary><UsersPage /></RouteBoundary>} />
            <Route path="/audit" element={<RouteBoundary><AuditPage /></RouteBoundary>} />
            <Route path="/settings" element={<RouteBoundary><SettingsPage /></RouteBoundary>} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>
      </Routes>
    </ThemeProvider>
  )
}