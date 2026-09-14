import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Coins, Key, Zap, Plus, ShoppingCart, Settings, ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatTokens, formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { api, type DailyUsage, type CreditTransaction, type ApiKey } from '@/lib/api';

type Range = '7' | '30' | '90';
const USD_TO_TND = 3.10;

export const DashboardPage = () => {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('7');
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      const days = range === '7' ? 7 : range === '30' ? 30 : 90;
      const [usageData, txData, keysData] = await Promise.all([
        api.getDailyUsage(days).catch(() => []),
        api.getCreditHistory(5).catch(() => []),
        api.listApiKeys().catch(() => []),
      ]);
      setDailyUsage(usageData);
      setTransactions(txData);
      setKeys(keysData);
    } catch (err) {
      console.error('[DashboardPage] Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  // Generate chart data based on selected range and real dailyUsage API response
  const numDays = range === '7' ? 7 : range === '30' ? 30 : 90;
  const usageMap = new Map(dailyUsage.map((u) => [new Date(u.day).toISOString().split('T')[0], u.request_count]));
  
  const chartData = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split('T')[0];
    const value = usageMap.get(dateKey) ?? 0;
    chartData.push({
      date: dateKey,
      value,
      label: range === '7'
        ? d.toLocaleDateString('en-US', { weekday: 'short' })
        : d.getDate().toString(),
    });
  }

  const maxVal = Math.max(1, ...chartData.map((d) => d.value));
  const totalRequests = chartData.reduce((a, b) => a + b.value, 0);

  const creditBalance = user?.credit_balance_dt ?? 0;
  const creditUsdValue = user?.credit_balance_usd_value ?? 0;
  const creditTndValue = creditUsdValue * USD_TO_TND;
  const hasCredits = user?.has_credits ?? false;

  const stats = [
    {
      label: 'API Requests',
      value: formatNumber(totalRequests),
      subtext: `Last ${range} days`,
      icon: Activity,
      color: 'text-brand',
    },
    {
      label: 'Tokens Used',
      value: formatTokens(user?.used_this_month ?? 0),
      subtext: 'This month',
      icon: Coins,
      color: 'text-brand',
    },
    {
      label: 'Credit Balance',
      value: `${creditBalance.toFixed(1)} DT`,
      subtext: hasCredits
        ? `$${creditUsdValue.toFixed(2)} / ${creditTndValue.toFixed(2)} TND`
        : 'Free tier · buy credits',
      icon: Zap,
      color: hasCredits ? 'text-brand' : 'text-fg-muted',
    },
    {
      label: 'API Keys',
      value: String(user?.total_key_count ?? 0),
      subtext: `${user?.active_key_count ?? 0} active`,
      icon: Key,
      color: 'text-brand',
    },
  ];

  const quickActions = [
    { label: 'Create API Key', icon: Plus, to: '/app/api-keys' },
    { label: 'Buy Credits', icon: ShoppingCart, to: '/app/credits' },
    { label: 'Usage Analytics', icon: Activity, to: '/app/usage' },
    { label: 'Settings', icon: Settings, to: '/app/settings' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-fg-subtle uppercase tracking-widest">~/dashboard</span>
          <span className="text-brand">●</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome back, {user?.email?.split('@')[0] ?? 'Developer'}.
        </h1>
        <p className="text-sm text-fg-muted mt-1">
          Your Zencode environment is ready.
        </p>
      </div>

      {/* Credit status banner for users with low/no credits */}
      {!hasCredits && (
        <div className="flex items-center gap-3 px-4 py-3 bg-brand/5 border border-brand/20 rounded-md">
          <Zap size={14} className="text-brand shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-fg-muted">
              You're on the free tier. 
              <span className="text-fg ml-1">Purchase AI credits to unlock unlimited usage.</span>
            </span>
          </div>
          <Link
            to="/app/credits"
            className="shrink-0 px-3 py-1 bg-brand text-black text-[10px] font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
          >
            Buy Credits
          </Link>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        {stats.map((s) => (
          <Card key={s.label} hover className="p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">
                {s.label}
              </div>
              <s.icon size={14} className={s.color} />
            </div>
            <div className="space-y-1">
              <div className="text-2xl font-bold">{s.value}</div>
              {s.subtext && (
                <div className="text-xs text-fg-subtle">{s.subtext}</div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* Account Status + Usage Graph */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Account Status Card */}
        <Card accent className="lg:col-span-1 p-5 scanlines relative overflow-hidden flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-brand" />
                <span className="text-xs font-bold tracking-wider">ACCOUNT OVERVIEW</span>
              </div>
              <Badge variant="success" dot>
                {user?.status?.toUpperCase() ?? 'ACTIVE'}
              </Badge>
            </div>

            <div className="space-y-3 font-mono text-xs">
              <div className="flex justify-between border-b border-border/30 pb-2">
                <span className="text-fg-muted">Email</span>
                <span className="truncate max-w-[130px]" title={user?.email}>{user?.email ?? '—'}</span>
              </div>
              <div className="flex justify-between border-b border-border/30 pb-2">
                <span className="text-fg-muted">Plan Tier</span>
                <span className="uppercase text-brand font-bold">{user?.tier ?? 'Free'}</span>
              </div>
              <div className="flex justify-between border-b border-border/30 pb-2">
                <span className="text-fg-muted">Balance (DT)</span>
                <span className={hasCredits ? 'text-brand font-bold' : 'text-fg-muted'}>
                  {creditBalance.toFixed(1)} DT
                </span>
              </div>
              <div className="flex justify-between border-b border-border/30 pb-2">
                <span className="text-fg-muted">Value ($ / TND)</span>
                <span className="text-fg font-bold">
                  ${creditUsdValue.toFixed(2)} / {creditTndValue.toFixed(2)} TND
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-muted">Active Keys</span>
                <span className="text-brand">{user?.active_key_count ?? 0}</span>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <Link
              to="/app/api-keys"
              className="block w-full text-center px-4 py-2 bg-brand/10 hover:bg-brand/20 border border-brand/40 text-xs font-bold uppercase tracking-wider rounded transition-colors btn-press"
            >
              [ Manage API Keys ]
            </Link>
          </div>

          <div className="absolute bottom-2 right-3 text-brand text-xs animate-blink">▊</div>
        </Card>

        {/* Usage Graph */}
        <Card className="lg:col-span-2 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <span className="text-xs font-bold tracking-wider">REAL API USAGE</span>
            </div>
            <div className="flex items-center gap-1">
              {(['7', '30', '90'] as Range[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-2 py-1 text-[10px] font-bold uppercase border transition-colors ${
                    range === r
                      ? 'bg-brand text-black border-brand'
                      : 'border-border text-fg-muted hover:bg-bg-card'
                  }`}
                >
                  {r} Days
                </button>
              ))}
            </div>
          </div>

          {/* Chart */}
          <div className="relative h-48 mb-2">
            <svg viewBox="0 0 400 160" className="w-full h-full" preserveAspectRatio="none">
              {[0, 1, 2, 3].map((i) => (
                <line
                  key={i}
                  x1="0"
                  y1={(160 / 4) * i + 10}
                  x2="400"
                  y2={(160 / 4) * i + 10}
                  stroke="#262626"
                  strokeDasharray="2 4"
                />
              ))}
              <polyline
                fill="none"
                stroke="#ef4444"
                strokeWidth="2"
                points={chartData
                  .map((d, i) => {
                    const x = (i / Math.max(1, chartData.length - 1)) * 400;
                    const y = 150 - (d.value / maxVal) * 130;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
              <polygon
                fill="url(#redGrad)"
                points={`0,150 ${chartData
                  .map((d, i) => {
                    const x = (i / Math.max(1, chartData.length - 1)) * 400;
                    const y = 150 - (d.value / maxVal) * 130;
                    return `${x},${y}`;
                  })
                  .join(' ')} 400,150`}
              />
              <defs>
                <linearGradient id="redGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
                </linearGradient>
              </defs>
              {chartData.map((d, i) => {
                const x = (i / Math.max(1, chartData.length - 1)) * 400;
                const y = 150 - (d.value / maxVal) * 130;
                return <circle key={i} cx={x} cy={y} r="2" fill="#ef4444" />;
              })}
            </svg>
          </div>
          {/* Labels */}
          <div className="flex justify-between text-[10px] text-fg-subtle font-mono px-1">
            {chartData.filter((_, i) => i % Math.ceil(chartData.length / 7) === 0).map((d, i) => (
              <span key={i}>{d.label}</span>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <div className="w-3 h-0.5 bg-brand" />
              <span>Total: {formatNumber(totalRequests)} requests in last {range} days</span>
            </div>
            <span className="text-[10px] text-fg-subtle uppercase">
              avg {Math.round(totalRequests / numDays)}/day
            </span>
          </div>
        </Card>
      </div>

      {/* Recent Activity + Quick Actions */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <span className="text-xs font-bold tracking-wider">RECENT ACTIVITY</span>
            </div>
            <span className="text-[10px] text-fg-subtle uppercase">Live audit log</span>
          </div>
          <div className="space-y-1">
            {loading ? (
              <div className="text-xs text-fg-subtle py-6 text-center animate-pulse">
                Loading activity log...
              </div>
            ) : transactions.length === 0 && keys.length === 0 ? (
              <div className="text-xs text-fg-muted py-6 text-center">
                No recent activity logged yet.
              </div>
            ) : (
              <>
                {transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-start gap-3 px-3 py-3 hover:bg-bg-card border border-transparent hover:border-border rounded-md transition-colors"
                  >
                    <div className="w-1.5 h-1.5 bg-brand rounded-full mt-1.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">
                        {tx.type === 'purchase'
                          ? `Credit Purchase (${tx.amount_dt} DT)`
                          : tx.type === 'usage'
                          ? `AI Model Request (-${Math.abs(tx.amount_dt).toFixed(3)} DT)`
                          : `Account Transaction (${tx.amount_dt > 0 ? '+' : ''}${tx.amount_dt} DT)`}
                      </div>
                      <div className="text-[11px] text-fg-muted">
                        {tx.admin_note ?? `Status: ${tx.status}`} · ≈ ${(Math.abs(tx.amount_dt) / 4).toFixed(2)} / ${(Math.abs(tx.amount_dt) / 4 * USD_TO_TND).toFixed(2)} TND
                      </div>
                    </div>
                    <div className="text-[10px] text-fg-subtle uppercase whitespace-nowrap">
                      {formatDate(tx.created_at)}
                    </div>
                  </div>
                ))}
                {keys.map((k) => (
                  <div
                    key={k.id}
                    className="flex items-start gap-3 px-3 py-3 hover:bg-bg-card border border-transparent hover:border-border rounded-md transition-colors"
                  >
                    <div className="w-1.5 h-1.5 bg-brand rounded-full mt-1.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">API Key {k.revoked ? 'Revoked' : 'Created'}</div>
                      <div className="text-[11px] text-fg-muted">Prefix: {k.key_prefix}… {k.label ? `(${k.label})` : ''}</div>
                    </div>
                    <div className="text-[10px] text-fg-subtle uppercase whitespace-nowrap">
                      {formatDate(k.created_at)}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">QUICK ACTIONS</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {quickActions.map((q) => (
              <Link
                key={q.label}
                to={q.to}
                className="group flex flex-col items-center gap-2 p-4 bg-bg-subtle border border-border rounded-md hover:border-brand/40 hover:bg-bg-card transition-all btn-press"
              >
                <div className="w-10 h-10 bg-brand/10 border border-brand/30 rounded flex items-center justify-center group-hover:bg-brand/20 transition-colors">
                  <q.icon size={18} className="text-brand" />
                </div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-center">
                  {q.label}
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      {/* Pixel art decorative */}
      <div className="flex items-center justify-center gap-1 text-brand text-[10px] font-mono opacity-40">
        <span>▓</span>
        <span>▒</span>
        <span>░</span>
        <span className="px-2">END OF DASHBOARD</span>
        <span>░</span>
        <span>▒</span>
        <span>▓</span>
      </div>
    </div>
  );
};
