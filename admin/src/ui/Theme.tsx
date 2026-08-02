import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

type Theme = "dark" | "light"
const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null)

const KEY = "zen-admin-theme"

function apply(t: Theme) {
  const root = document.documentElement
  root.classList.remove("dark", "light")
  root.classList.add(t)
  root.style.colorScheme = t
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(KEY) as Theme | null
    if (saved) return saved
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  })

  useEffect(() => {
    apply(theme)
    localStorage.setItem(KEY, theme)
  }, [theme])

  return (
    <Ctx.Provider value={{ theme, setTheme: setThemeState }}>{children}</Ctx.Provider>
  )
}

export const useTheme = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error("useTheme must be inside ThemeProvider")
  return v
}