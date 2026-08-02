import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

type ToastKind = "success" | "error" | "info"
type Toast = { id: number; kind: ToastKind; text: string }
const Ctx = createContext<{ push: (kind: ToastKind, text: string) => void } | null>(null)

let counter = 0

/** Provider only — exposes `push`. Used in main.tsx to wrap <App /> so every
 * page can call useToast(). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++counter
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }, [])
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "card px-4 py-3 text-sm shadow-pop border " +
              (t.kind === "error" ? "border-bad/40 text-bad" : t.kind === "success" ? "border-good/40 text-good" : "border-accent/40 text-accent")
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error("useToast must be inside ToastHost")
  return v.push
}