import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type BadgeVariant = 'default' | 'success' | 'error' | 'warning' | 'outline' | 'brand';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
  dot?: boolean;
}

export const Badge = ({
  children,
  variant = 'default',
  className = '',
  dot = false,
}: BadgeProps) => {
  const variants: Record<BadgeVariant, string> = {
    default: 'bg-bg-subtle text-fg-muted border-border',
    success: 'bg-brand/10 text-brand border-brand/30',
    error: 'bg-red-950/40 text-red-400 border-red-900/40',
    warning: 'bg-yellow-950/40 text-yellow-400 border-yellow-900/40',
    outline: 'bg-transparent text-fg-muted border-border',
    brand: 'bg-brand text-black border-brand',
  };
  const dotColors: Record<BadgeVariant, string> = {
    default: 'bg-fg-muted',
    success: 'bg-brand animate-pulseDot',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    outline: 'bg-fg-muted',
    brand: 'bg-black',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded',
        variants[variant],
        className
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', dotColors[variant])} />}
      {children}
    </span>
  );
};
