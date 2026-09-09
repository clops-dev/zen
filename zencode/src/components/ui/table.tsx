import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TableProps {
  children: ReactNode;
  className?: string;
}

export const Table = ({ children, className = '' }: TableProps) => (
  <div className={cn('overflow-x-auto', className)}>
    <table className="w-full text-sm text-left border-collapse">{children}</table>
  </div>
);

interface TheadProps {
  children: ReactNode;
  className?: string;
}

export const Thead = ({ children, className = '' }: TheadProps) => (
  <thead className={cn('bg-bg-subtle', className)}>{children}</thead>
);

interface TbodyProps {
  children: ReactNode;
  className?: string;
}

export const Tbody = ({ children, className = '' }: TbodyProps) => (
  <tbody>{children}</tbody>
);

interface TrProps {
  children: ReactNode;
  className?: string;
}

export const Tr = ({ children, className = '' }: TrProps) => (
  <tr className={cn('border-b border-border hover:bg-bg-card', className)}>{children}</tr>
);

interface ThProps {
  children: ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
}

export const Th = ({ children, align = 'left', className = '' }: ThProps) => (
  <th
    className={cn(
      'px-4 py-3 text-xs font-medium uppercase tracking-wider text-fg-muted',
      align === 'center' && 'text-center',
      align === 'right' && 'text-end',
      className
    )}
  >
    {children}
  </th>
);

interface TdProps {
  children: ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
}

export const Td = ({ children, align = 'left', className = '' }: TdProps) => (
  <td
    className={cn(
      'px-4 py-3 text-xs',
      align === 'center' && 'text-center',
      align === 'right' && 'text-end',
      className
    )}
  >
    {children}
  </td>
);
