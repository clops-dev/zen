import type { ReactNode, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  bordered?: boolean;
  accent?: boolean;
  hover?: boolean;
}

export const Card = ({
  children,
  className = '',
  bordered = true,
  accent = false,
  hover = false,
  ...props
}: CardProps) => {
  return (
    <div
      className={cn(
        'relative bg-bg-panel rounded-md',
        bordered && 'border border-border',
        accent && 'border-brand/40 shadow-[0_0_12px_rgba(239,68,68,0.15)]',
        hover && 'transition-colors hover:border-border-strong hover:bg-bg-card',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const CardHeader = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={cn('px-4 py-3 border-b border-border', className)}>{children}</div>
);

export const CardTitle = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <h3 className={cn('text-xs font-bold uppercase tracking-wider text-fg-muted', className)}>
    {children}
  </h3>
);

export const CardContent = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={cn('p-4', className)}>{children}</div>
);
