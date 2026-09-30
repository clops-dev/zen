import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { getCreditUsage } from '@/lib/credit-usage';

const formatUsd = (value: number) => `$${Math.max(0, value).toFixed(2)}`;

export const DashboardPage = () => {
  const { user, loading, refresh } = useAuth();
  const [refreshError, setRefreshError] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      refresh().then(() => setRefreshError(false)).catch(() => setRefreshError(true));
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  if (loading || !user) {
    return (
      <Card className="p-6 animate-pulse" aria-busy="true">
        <div className="h-4 w-40 bg-bg-subtle rounded" />
        <div className="h-8 w-24 bg-bg-subtle rounded mt-6" />
        <div className="h-3 w-full bg-bg-subtle rounded mt-6" />
      </Card>
    );
  }

  const usage = getCreditUsage({
    totalCredits: user.total_credits_purchased,
    usedCredits: user.total_usage_cost,
    remainingCredits: user.remaining_credits,
    paid: user.has_purchased_credits,
  });
  const color = usage.percentage >= 95
    ? 'bg-red-500'
    : usage.percentage >= 80
      ? 'bg-yellow-400'
      : 'bg-brand';
  const textColor = usage.percentage >= 95
    ? 'text-red-400'
    : usage.percentage >= 80
      ? 'text-yellow-400'
      : 'text-brand';

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] text-fg-subtle uppercase tracking-widest">~/dashboard</div>
        <h1 className="text-2xl font-bold tracking-tight mt-1">Welcome back, {user.email.split('@')[0]}.</h1>
      </div>

      <Card accent className="p-6 scanlines">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-bold tracking-widest uppercase text-fg">Your included usage</span>
          <span className={`text-sm font-mono font-bold ${textColor}`}>
            {usage.percentage.toFixed(0)}% used
          </span>
        </div>

        <div
          className="mt-5 h-3 bg-bg-subtle border border-border rounded overflow-hidden"
          role="progressbar"
          aria-label="Included credit usage"
          aria-valuenow={usage.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full transition-all duration-500 ${color}`} style={{ width: `${usage.percentage}%` }} />
        </div>

        {usage.paid && (
          <div className="mt-4 flex items-center justify-between gap-4 text-sm">
            <span className="text-fg-muted">Remaining credits</span>
            <span className="font-mono font-bold text-fg">{formatUsd(usage.remainingCredits)} remaining</span>
          </div>
        )}

        {refreshError && <p className="mt-4 text-xs text-fg-muted">Live usage updates are temporarily unavailable.</p>}

        <Link
          to="/app/credits"
          className="mt-6 inline-flex items-center gap-2 px-3 py-2 bg-brand/10 hover:bg-brand/20 border border-brand/40 text-xs font-bold uppercase tracking-wider rounded transition-colors"
        >
          Buy credits
        </Link>
      </Card>
    </div>
  );
};
