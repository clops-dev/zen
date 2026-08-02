import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Loader2 } from "lucide-react"
import { login, me } from "../api"

export function Login() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()
  const [params] = useSearchParams()
  const next = params.get("next") || "/dashboard"
  const qc = useQueryClient()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErr(null)
    try {
      await login(email, password)
      const u = await me()
      if (u.user.role !== "admin") {
        setErr("This account does not have admin access.")
        return
      }
      // Refetch the session so RequireAdmin flips immediately on nav.
      await qc.invalidateQueries({ queryKey: ["session"] })
      nav(next, { replace: true })
    } catch (e: any) {
      setErr(e?.message ?? "Invalid credentials")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-bg">
      <div className="card p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6">
          <div className="size-8 rounded-md bg-accent text-bg grid place-items-center font-bold">z</div>
          <div>
            <div className="font-semibold tracking-tight">zen-gateway</div>
            <div className="text-xs text-muted uppercase tracking-wider">Admin Console</div>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <label className="label mt-1">Password</label>
          <input
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {err && (
            <div className="text-bad text-sm border border-bad/30 bg-bad/10 rounded-md p-2">{err}</div>
          )}
          <button className="btn-primary mt-2" type="submit" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
            Sign in
          </button>
        </form>
        <p className="text-xs text-muted mt-4">
          Public users use the legacy <a className="text-accent" href="/dashboard">/dashboard</a>.
        </p>
      </div>
    </div>
  )
}