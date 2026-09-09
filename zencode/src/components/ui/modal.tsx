import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const Modal = ({
  open,
  onClose,
  title,
  children,
  size = 'md',
  className = '',
}: ModalProps) => {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  const sizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 animate-in fade-in">
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative w-full bg-bg-panel border border-border-strong rounded-md shadow-pixelDark',
          sizes[size],
          className
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <h2 className="text-xs font-bold uppercase tracking-wider">{title}</h2>
            </div>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg transition-colors p-1"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
};
