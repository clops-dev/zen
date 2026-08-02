import { type ReactNode, useEffect } from "react"
import { X } from "lucide-react"

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: "md" | "lg" | "xl"
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const width = size === "xl" ? "max-w-4xl" : size === "lg" ? "max-w-2xl" : "max-w-lg"

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`card w-full ${width} shadow-pop max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h3 className="font-semibold">{title}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto scroll-y">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  )
}