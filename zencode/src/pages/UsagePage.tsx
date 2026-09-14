import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table';
import { formatNumber, formatTokens, formatDate } from '@/lib/utils';
import { Activity, Coins, DollarSign, Zap, ArrowUpRight } from 'lucide-react';
import { api, type DailyUsage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { Link } from 'react-router-dom';

type Range = '7' | '30' | '90';

export const UsagePage = () => {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('30');
  const [dailyData, setDailyData] = useState<DailyUsage[]>([]);
  const [loading, setLoading] = useState(true);

  const loadUsage = useCallback(async () => {
    try {
      setLoading(true);
      const days = range === '7' ? 7 : range === '30' ? 30 : 90;
      const data = await api.getDailyUsage(days);
      setDailyData(data);
    } catch (err) {
      console.error('[UsagePage] Failed to fetch usage:', err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const numDays = range === '7' ? 7 : range === '30' ? 30 : 90;

  // Build contiguous daily series for the chart
  const usageMap = new Map(
    dailyData.map((u) => [new Date(u.day).toISOString().split('T')[0], u])
  );

  const chartSeries: {
    date: string;
    label: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[] = [];

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split('T')[0];
    const item = usageMap.get(dateKey);
    const requests = item?.request_count ?? 0;
    const inputTokens = item?.input_tokens ?? 0;
    const outputTokens = item?.output_tokens ?? 0;
    const costUsd = item?.cost_usd ?? 0;

    totalRequests += requests;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCostUsd += costUsd;

    chartSeries.push({
      date: dateKey,
      label:
        range === '7'
          ? d.toLocaleDateString('en-US', { weekday: 'short' })
          : d.getDate().toString(),
      requests,
      inputTokens,
      outputTokens,
      costUsd,
    });
  }

  const totalTokens = totalInputTokens + totalOutputTokens;
  const maxRequests = Math.max(1, ...chartSeries.map((d) => d.requests));

  // Single source of truth billing fields
  const remainingUsd = user?.remaining_credits ?? 0;
  const remainingDt = user?.remaining_credits_dt ?? (remainingUsd * 3);
  const purchasedUsd = user?.total_credits_purchased ?? 0;
  const usageCostUsd = user?.total_usage_cost ?? totalCostUsd;

  const stats = [
    {
      label: 'Total Requests',
      value: formatNumber(user?.total_requests ?? totalRequests),
      subtext: `All-time requests`,
      icon: Activity,
      color: 'text-brand',
    },
    {
      label: 'Total Tokens',
      value: formatTokens(user?.total_tokens ?? totalTokens),
      subtext: `${formatTokens(user?.input_tokens ?? totalInputTokens)} in · ${formatTokens(user?.output_tokens ?? totalOutputTokens)} out`,
      icon: Coins,
      color: 'text-brand',
    },
    {
      label: 'Total Usage Cost',
      value: `$${usageCostUsd.toFixed(6)}`,
      subtext: 'Real model pricing',
      icon: DollarSign,
      color: 'text-brand',
    },
    {
      label: 'Remaining Credits',
      value: `$${remainingUsd.toFixed(6)}`,
      subtext: `≈ ${remainingDt.toFixed(2)} DT`,
      icon: Zap,
      color: 'text-brand',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/usage</div>
          <h1 className="text-2xl font-bold tracking-tight">Real Usage Analytics</h1>
          <p className="text-sm text-fg-muted mt-1">
            Real-time tracking of requests, token consumption, and cost in USD.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(['7', '30', '90'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase border transition-colors btn-press ${
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

      {/* Remaining Credits Card */}
      <Card accent className="p-5 scanlines">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Zap size={14} className="text-brand" />
              <span className="text-xs font-bold uppercase tracking-wider">Available AI Credits</span>
            </div>
            <div className="flex items-baseline gap-3 pt-1">
              <span className="text-3xl font-bold font-mono">
                ${remainingUsd.toFixed(6)} <span className="text-brand text-lg font-bold">({remainingDt.toFixed(2)} DT)</span>
              </span>
            </div>
            <p className="text-[11px] text-fg-muted">
              Purchased: ${purchasedUsd.toFixed(2)} · Usage: ${usageCostUsd.toFixed(6)} · Remaining: ${remainingUsd.toFixed(6)}
            </p>
          </div>
          <Link
            to="/app/credits"
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press shrink-0"
          >
            Buy Credits <ArrowUpRight size={14} />
          </Link>
        </div>
      </Card>

      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:gap-4">
        {stats.map((s) => (
          <Card key={s.label} hover className="p-4">
            <div className="flex items-start justify-between mb-2">
              <span className="text-[10px] uppercase tracking-widest text-fg-muted font-bold">
                {s.label}
              </span>
              <s.icon size={14} className={s.color} />
            </div>
            <div className="text-xl font-bold font-mono">{s.value}</div>
            <div className="text-[11px] text-fg-subtle mt-1">{s.subtext}</div>
          </Card>
        ))}
      </div>

      {/* Request Volume Chart */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider uppercase">Request Volume (Last {range} Days)</span>
          </div>
          <div className="text-[10px] text-fg-subtle uppercase">
            Total Requests: {formatNumber(totalRequests)}
          </div>
        </div>

        <div className="relative h-56">
          <svg viewBox="0 0 400 180" className="w-full h-full" preserveAspectRatio="none">
            {[0, 1, 2, 3, 4].map((i) => (
              <line
                key={i}
                x1="0"
                y1={(180 / 5) * i + 10}
                x2="400"
                y2={(180 / 5) * i + 10}
                stroke="#262626"
                strokeDasharray="2 4"
              />
            ))}
            <polyline
              fill="none"
              stroke="#ef4444"
              strokeWidth="2"
              points={chartSeries
                .map((d, i) => {
                  const x = (i / Math.max(1, chartSeries.length - 1)) * 400;
                  const y = 170 - (d.requests / maxRequests) * 150;
                  return `${x},${y}`;
                })
                .join(' ')}
            />
            <polygon
              fill="url(#usageGrad)"
              points={`0,170 ${chartSeries
                .map((d, i) => {
                  const x = (i / Math.max(1, chartSeries.length - 1)) * 400;
                  const y = 170 - (d.requests / maxRequests) * 150;
                  return `${x},${y}`;
                })
                .join(' ')} 400,170`}
            />
            <defs>
              <linearGradient id="usageGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
              </linearGradient>
            </defs>
            {chartSeries.map((d, i) => {
              const x = (i / Math.max(1, chartSeries.length - 1)) * 400;
              const y = 170 - (d.requests / maxRequests) * 150;
              return <circle key={i} cx={x} cy={y} r="2" fill="#ef4444" />;
            })}
          </svg>
        </div>
        <div className="flex justify-between text-[10px] text-fg-subtle font-mono px-1 mt-2">
          {chartSeries.filter((_, i) => i % Math.ceil(chartSeries.length / 8) === 0).map((d, i) => (
            <span key={i}>{d.label}</span>
          ))}
        </div>
      </Card>

      {/* Daily Usage History Table */}
      <Card>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider uppercase">Daily Usage History</span>
          </div>
          <span className="text-[10px] text-fg-subtle uppercase">Cost in USD ($)</span>
        </div>
        <Table>
          <Thead>
            <Tr>
              <Th>Date</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Input Tokens</Th>
              <Th align="right">Output Tokens</Th>
              <Th align="right">Cost (USD)</Th>
            </Tr>
          </Thead>
          <Tbody>
            {loading ? (
              <Tr>
                <Td align="center" className="text-fg-subtle py-8">
                  <div className="text-xs uppercase tracking-wider animate-pulse">Loading usage history...</div>
                </Td>
              </Tr>
            ) : dailyData.length === 0 ? (
              <Tr>
                <Td align="center" className="text-fg-subtle py-8">
                  <div className="text-xs uppercase tracking-wider">No usage recorded for this period</div>
                </Td>
              </Tr>
            ) : (
              dailyData.map((d) => {
                const costUsd = d.cost_usd ?? 0;
                return (
                  <Tr key={d.day}>
                    <Td>
                      <div className="font-mono text-[11px] font-bold">
                        {formatDate(d.day)}
                      </div>
                    </Td>
                    <Td align="right" className="font-mono font-bold">
                      {d.request_count.toLocaleString()}
                    </Td>
                    <Td align="right" className="font-mono">{formatTokens(d.input_tokens)}</Td>
                    <Td align="right" className="font-mono">{formatTokens(d.output_tokens)}</Td>
                    <Td align="right" className="text-brand font-mono font-bold">
                      ${costUsd.toFixed(6)}
                    </Td>
                  </Tr>
                );
              })
            )}
          </Tbody>
        </Table>
      </Card>
    </div>
  );
};
