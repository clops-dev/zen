import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: 'default' | 'success' | 'error' | 'warning';
}

interface ToastContextValue {
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3500);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto min-w-[280px] max-w-sm border p-3 rounded-md shadow-pixelDark animate-in slide-in-from-right-4 ${
              t.variant === 'success'
                ? 'bg-bg-panel border-brand/50'
                : t.variant === 'error'
                ? 'bg-bg-panel border-red-600/50'
                : t.variant === 'warning'
                ? 'bg-bg-panel border-yellow-500/50'
                : 'bg-bg-panel border-border'
            }`}
          >
            <div className="flex items-start gap-2">
              <div
                className={`mt-0.5 w-2 h-2 ${
                  t.variant === 'success'
                    ? 'bg-brand'
                    : t.variant === 'error'
                    ? 'bg-red-600'
                    : t.variant === 'warning'
                    ? 'bg-yellow-500'
                    : 'bg-fg-muted'
                }`}
              />
              <div className="flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide">{t.title}</div>
                {t.description && (
                  <div className="text-xs text-fg-muted mt-0.5">{t.description}</div>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-fg-subtle hover:text-fg text-xs"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
};
