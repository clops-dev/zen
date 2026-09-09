import { Link } from 'react-router-dom';
import { Activity, Coins, Key, Zap, Plus, Download, Box, BookOpen, ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { mockActivities } from '@/data/mockData';
import { formatNumber, formatTokens } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useState } from 'react';

type Range = '7' | '30' | '90';

const generateUsageData = (range: Range) => {
  const days = range === '7' ? 7 : range === '30' ? 30 : 90;
  const base = range === '7' ? 800 : range === '30' ? 700 : 600;
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const variation = Math.sin((i / days) * Math.PI * 2) * 200 + Math.random() * 200;
    const value = Math.max(200, Math.round(base + variation + (range === '90' ? 100 : 0)));
    data.push({
      date: d.toISOString().split('T')[0],
      value,
      label: range === '7'
        ? d.toLocaleDateString('en-US', { weekday: 'short' })
        : d.getDate().toString(),
    });
  }
  return data;
};

export const DashboardPage = () => {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('7');
  const usageData = generateUsageData(range);
  const max = Math.max(...usageData.map((d) => d.value));

  const stats: {
    label: string;
    value: string;
    subtext: string;
    icon: any;
    color: string;
    change?: string;
  }[] = [
    {
      label: 'API Requests',
      value: formatNumber(usageData.reduce((a, b) => a + b.value, 0)),
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
      label: 'Current Plan',
      value: (user?.tier ?? 'free').toUpperCase(),
      subtext: user?.status === 'suspended' ? 'Suspended' : 'Active',
      icon: Zap,
      color: 'text-brand',
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
    { label: 'Download CLI', icon: Download, to: '/app/cli' },
    { label: 'Explore Models', icon: Box, to: '/app/models' },
    { label: 'Documentation', icon: BookOpen, to: '/app/docs' },
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
              {s.change && (
                <div className="flex items-center gap-1 text-xs text-brand">
                  <ArrowUpRight size={11} />
                  <span className="font-medium">{s.change}</span>
                </div>
              )}
              {s.subtext && (
                <div className="text-xs text-fg-subtle">{s.subtext}</div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* CLI Status + Usage */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* CLI Status Card */}
        <Card accent className="lg:col-span-1 p-5 scanlines relative overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <span className="text-xs font-bold tracking-wider">ZENCODE CLI</span>
            </div>
            <Badge variant="success" dot>
              ONLINE
            </Badge>
          </div>

          <div className="space-y-3 font-mono text-xs">
            <div className="flex justify-between border-b border-border/30 pb-2">
              <span className="text-fg-muted">Version</span>
              <span>v7.3.58</span>
            </div>
            <div className="flex justify-between border-b border-border/30 pb-2">
              <span className="text-fg-muted">Environment</span>
              <span>Production</span>
            </div>
            <div className="flex justify-between border-b border-border/30 pb-2">
              <span className="text-fg-muted">Status</span>
              <span className="text-brand">Connected</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg-muted">Last Sync</span>
              <span>Just now</span>
            </div>
          </div>

          <div className="mt-5">
            <Link
              to="/cli"
              className="block w-full text-center px-4 py-2 bg-brand/10 hover:bg-brand/20 border border-brand/40 text-xs font-bold uppercase tracking-wider rounded transition-colors btn-press"
            >
              [ Manage CLI ]
            </Link>
          </div>

          {/* Terminal cursor animation */}
          <div className="absolute bottom-2 right-3 text-brand text-xs animate-blink">▊</div>
        </Card>

        {/* Usage Graph */}
        <Card className="lg:col-span-2 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <span className="text-xs font-bold tracking-wider">API USAGE</span>
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
              {/* Grid lines */}
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
              {/* Line path */}
              <polyline
                fill="none"
                stroke="#ef4444"
                strokeWidth="2"
                points={usageData
                  .map((d, i) => {
                    const x = (i / (usageData.length - 1)) * 400;
                    const y = 150 - (d.value / max) * 130;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
              {/* Fill */}
              <polygon
                fill="url(#redGrad)"
                points={`0,150 ${usageData
                  .map((d, i) => {
                    const x = (i / (usageData.length - 1)) * 400;
                    const y = 150 - (d.value / max) * 130;
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
              {/* Data points */}
              {usageData.map((d, i) => {
                const x = (i / (usageData.length - 1)) * 400;
                const y = 150 - (d.value / max) * 130;
                return <circle key={i} cx={x} cy={y} r="2" fill="#ef4444" />;
              })}
            </svg>
          </div>
          {/* Labels */}
          <div className="flex justify-between text-[10px] text-fg-subtle font-mono px-1">
            {usageData.filter((_, i) => i % Math.ceil(usageData.length / 7) === 0).map((d, i) => (
              <span key={i}>{d.label}</span>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <div className="w-3 h-0.5 bg-brand" />
              <span>Total: {formatNumber(usageData.reduce((a, b) => a + b.value, 0))} requests</span>
            </div>
            <span className="text-[10px] text-fg-subtle uppercase">
              avg {Math.round(usageData.reduce((a, b) => a + b.value, 0) / usageData.length)}/day
            </span>
          </div>
        </Card>
      </div>

      {/* Recent Activity + Quick Actions */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">RECENT ACTIVITY</span>
          </div>
          <div className="space-y-1">
            {mockActivities.map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-3 px-3 py-3 hover:bg-bg-card border border-transparent hover:border-border rounded-md transition-colors"
              >
                <div className="w-1.5 h-1.5 bg-brand rounded-full mt-1.5 shrink-0 animate-pulseDot" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">{a.title}</div>
                  <div className="text-[11px] text-fg-muted">{a.subtitle}</div>
                </div>
                <div className="text-[10px] text-fg-subtle uppercase whitespace-nowrap">
                  {a.time}
                </div>
              </div>
            ))}
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
