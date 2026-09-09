import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table';
import { mockUsage } from '@/data/mockData';
import { formatNumber, formatTokens } from '@/lib/utils';
import { Activity, CheckCircle, XCircle, Coins, Clock, DollarSign, TrendingUp } from 'lucide-react';

type Range = 'today' | '7' | '30' | '90';

const generateRangeData = (range: Range) => {
  const days = range === 'today' ? 1 : range === '7' ? 7 : range === '30' ? 30 : 90;
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const base = range === 'today' ? 800 : 750;
    const variation = Math.sin((i / days) * Math.PI * 2) * 250 + Math.random() * 250;
    const value = Math.max(200, Math.round(base + variation));
    const tokens = Math.round(value * 220);
    data.push({
      date: d.toISOString().split('T')[0],
      label:
        range === 'today'
          ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : d.getDate().toString(),
      requests: value,
      tokens,
      cost: +(tokens * 0.00001).toFixed(2),
      latency: Math.round(200 + Math.random() * 80),
      success: Math.round(value * 0.97),
      failed: Math.round(value * 0.03),
    });
  }
  return data;
};

export const UsagePage = () => {
  const [range, setRange] = useState<Range>('7');
  const data = useMemo(() => generateRangeData(range), [range]);
  const total = data.reduce(
    (acc, d) => ({
      requests: acc.requests + d.requests,
      success: acc.success + d.success,
      failed: acc.failed + d.failed,
      tokens: acc.tokens + d.tokens,
      cost: acc.cost + d.cost,
      latency: acc.latency + d.latency,
    }),
    { requests: 0, success: 0, failed: 0, tokens: 0, cost: 0, latency: 0 }
  );
  const max = Math.max(...data.map((d) => d.requests));

  const stats = [
    {
      label: 'Total Requests',
      value: formatNumber(total.requests),
      icon: Activity,
      change: '+12.3%',
    },
    {
      label: 'Successful',
      value: formatNumber(total.success),
      icon: CheckCircle,
      change: `${((total.success / total.requests) * 100).toFixed(1)}%`,
    },
    {
      label: 'Failed',
      value: formatNumber(total.failed),
      icon: XCircle,
      change: `${((total.failed / total.requests) * 100).toFixed(1)}%`,
    },
    {
      label: 'Tokens',
      value: formatTokens(total.tokens),
      icon: Coins,
      change: '+8.2%',
    },
    {
      label: 'Avg Latency',
      value: `${Math.round(total.latency / data.length)}ms`,
      icon: Clock,
      change: '-15ms',
    },
    {
      label: 'Est. Cost',
      value: `$${total.cost.toFixed(2)}`,
      icon: DollarSign,
      change: '+5.4%',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/usage</div>
          <h1 className="text-2xl font-bold tracking-tight">Usage Analytics</h1>
          <p className="text-sm text-fg-muted mt-1">
            Track your API usage, performance and cost across time.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(['today', '7', '30', '90'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase border transition-colors btn-press ${
                range === r
                  ? 'bg-brand text-black border-brand'
                  : 'border-border text-fg-muted hover:bg-bg-card'
              }`}
            >
              {r === 'today' ? 'Today' : `${r} Days`}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {stats.map((s) => (
          <Card key={s.label} hover className="p-3">
            <div className="flex items-start justify-between mb-2">
              <s.icon size={14} className="text-brand" />
              <span className="text-[10px] text-brand font-bold">{s.change}</span>
            </div>
            <div className="text-[10px] uppercase tracking-widest text-fg-muted mb-1">
              {s.label}
            </div>
            <div className="text-lg font-bold">{s.value}</div>
          </Card>
        ))}
      </div>

      {/* Main chart */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">REQUEST VOLUME</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-fg-muted">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-1 bg-brand" />
              <span>Requests</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-1 bg-red-900" />
              <span>Failed</span>
            </div>
          </div>
        </div>

        <div className="relative h-64">
          <svg viewBox="0 0 400 200" className="w-full h-full" preserveAspectRatio="none">
            {[0, 1, 2, 3, 4].map((i) => (
              <line
                key={i}
                x1="0"
                y1={(200 / 5) * i + 10}
                x2="400"
                y2={(200 / 5) * i + 10}
                stroke="#262626"
                strokeDasharray="2 4"
              />
            ))}
            <polyline
              fill="none"
              stroke="#ef4444"
              strokeWidth="2"
              points={data
                .map((d, i) => {
                  const x = (i / (data.length - 1)) * 400;
                  const y = 190 - (d.requests / max) * 170;
                  return `${x},${y}`;
                })
                .join(' ')}
            />
            <polygon
              fill="url(#usageGrad)"
              points={`0,190 ${data
                .map((d, i) => {
                  const x = (i / (data.length - 1)) * 400;
                  const y = 190 - (d.requests / max) * 170;
                  return `${x},${y}`;
                })
                .join(' ')} 400,190`}
            />
            <defs>
              <linearGradient id="usageGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
              </linearGradient>
            </defs>
            {data.map((d, i) => {
              const x = (i / (data.length - 1)) * 400;
              const y = 190 - (d.requests / max) * 170;
              return <circle key={i} cx={x} cy={y} r="2" fill="#ef4444" />;
            })}
          </svg>
        </div>
        <div className="flex justify-between text-[10px] text-fg-subtle font-mono px-1 mt-2">
          {data.filter((_, i) => i % Math.ceil(data.length / 8) === 0).map((d, i) => (
            <span key={i}>{d.label}</span>
          ))}
        </div>
      </Card>

      {/* Tokens + Latency */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">TOKEN USAGE</span>
          </div>
          <div className="space-y-2">
            {data.slice(-7).map((d) => {
              const maxT = Math.max(...data.slice(-7).map((x) => x.tokens));
              const pct = (d.tokens / maxT) * 100;
              return (
                <div key={d.date} className="space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-fg-muted font-mono">{d.label}</span>
                    <span className="font-bold">{formatTokens(d.tokens)}</span>
                  </div>
                  <div className="h-2 bg-bg-subtle border border-border">
                    <div
                      className="h-full bg-brand transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">LATENCY (MS)</span>
          </div>
          <div className="relative h-40">
            <svg viewBox="0 0 400 120" className="w-full h-full" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="#ef4444"
                strokeWidth="1.5"
                points={data
                  .map((d, i) => {
                    const x = (i / (data.length - 1)) * 400;
                    const y = 110 - ((d.latency - 200) / 100) * 90;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
            </svg>
          </div>
          <div className="flex items-center justify-between text-[10px] mt-3 pt-3 border-t border-border">
            <span className="text-fg-muted">AVG: {Math.round(total.latency / data.length)}ms</span>
            <span className="text-brand font-bold flex items-center gap-1">
              <TrendingUp size={11} /> Optimal
            </span>
          </div>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <div className="px-5 py-3 border-b border-border flex items-center gap-2">
          <div className="w-2 h-2 bg-brand" />
          <span className="text-xs font-bold tracking-wider">USAGE HISTORY</span>
        </div>
        <Table>
          <Thead>
            <Tr>
              <Th>Date</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Tokens</Th>
              <Th align="right">Latency</Th>
              <Th align="right">Cost</Th>
              <Th>Status</Th>
            </Tr>
          </Thead>
          <Tbody>
            {mockUsage.map((d) => (
              <Tr key={d.date}>
                <Td>
                  <div className="font-mono text-[11px]">{d.label}</div>
                  <div className="text-[10px] text-fg-subtle">{d.date}</div>
                </Td>
                <Td align="right" className="font-bold">
                  {d.requests.toLocaleString()}
                </Td>
                <Td align="right">{formatTokens(d.tokens)}</Td>
                <Td align="right">{d.latency}ms</Td>
                <Td align="right" className="text-brand font-bold">
                  ${d.cost.toFixed(2)}
                </Td>
                <Td>
                  <Badge variant="success" dot>
                    Active
                  </Badge>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>
    </div>
  );
};
