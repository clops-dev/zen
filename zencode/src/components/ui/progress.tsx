import { cn } from '@/lib/utils';

interface ProgressBarProps {
  value: number;
  max?: number;
  className?: string;
  color?: 'brand' | 'success' | 'warning';
}

export const ProgressBar = ({
  value,
  max = 100,
  className = '',
  color = 'brand',
}: ProgressBarProps) => {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const colors = {
    brand: 'bg-brand',
    success: 'bg-brand',
    warning: 'bg-yellow-500',
  };

  return (
    <div
      className={cn(
        'w-full h-2 bg-bg-subtle border border-border overflow-hidden',
        className
      )}
    >
      <div
        className={cn('h-full transition-all duration-500', colors[color])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

interface BarChartProps {
  value: number;
  max?: number;
  className?: string;
  label?: string;
  showValue?: boolean;
}

export const BarChart = ({
  value,
  max = 100,
  className = '',
  label,
  showValue = true,
}: BarChartProps) => {
  const blocks = 10;
  const filled = Math.round((value / max) * blocks);
  const empty = blocks - filled;

  return (
    <div className={cn('space-y-1', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-fg-muted">{label}</span>
          {showValue && <span className="text-fg font-bold">{value}%</span>}
        </div>
      )}
      <div className="flex items-center gap-0.5 font-mono text-xs">
        {Array.from({ length: filled }).map((_, i) => (
          <span key={i} className="text-brand">█</span>
        ))}
        {Array.from({ length: empty }).map((_, i) => (
          <span key={i} className="text-border">░</span>
        ))}
      </div>
    </div>
  );
};