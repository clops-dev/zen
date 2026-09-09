import { useEffect, useState, Children, isValidElement, cloneElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TerminalProps {
  children?: ReactNode;
  prompt?: string;
  className?: string;
  height?: string;
}

export const Terminal = ({
  children,
  prompt = '$',
  className = '',
  height = 'h-96',
}: TerminalProps) => {
  const [cursorBlink, setCursorBlink] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => setCursorBlink((v) => !v), 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className={cn(
        'relative bg-black/40 border border-border rounded-md p-4 font-mono overflow-auto',
        height,
        className
      )}
    >
      <div className="absolute top-2 left-2 text-xs text-fg-muted select-none">
        ZENCODE TERMINAL
      </div>
      <div className="relative flex flex-col gap-2 pt-6">
        {children &&
          Children.map(children, (child, index) =>
            isValidElement(child) ? cloneElement(child, { key: index }) : child
          )}
      </div>
      <div className="mt-2 pt-2 border-t border-border/30">
        <div className="flex items-start gap-2">
          <div className="text-xs text-fg-muted">{prompt} </div>
          <div className="flex-1 text-xs">
            <span className={cursorBlink ? 'opacity-100' : 'opacity-0'}>_</span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface TerminalLineProps {
  children: ReactNode;
  className?: string;
}

export const TerminalLine = ({ children, className = '' }: TerminalLineProps) => (
  <div className={cn('flex items-start gap-2 text-xs', className)}>
    <div className="shrink-0 text-fg-muted">$ </div>
    <div className="flex-1">{children}</div>
  </div>
);

export const TerminalOutput = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={cn('text-xs text-fg-muted mb-2', className)}>{children}</div>
);

export const TerminalCommand = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={cn('text-xs text-fg font-mono mb-1', className)}>{children}</div>
);
