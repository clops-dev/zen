import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Coins, ShoppingCart, Check, Clock, ArrowUpRight, ArrowDownRight, Zap, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type CreditTransaction } from '@/lib/api';

const DT_PER_USD = 4;

// Credit packages — multiples of 5 DT
const PACKAGES = [
  { dt: 5,   popular: false },
  { dt: 10,  popular: false },
  { dt: 20,  popular: true  },
  { dt: 50,  popular: false },
  { dt: 100, popular: false },
] as const;

function dtToUsd(dt: number) {
  return (dt / DT_PER_USD).toFixed(2);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const TX_TYPE_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  admin_grant: 'Admin Grant',
  usage: 'AI Usage',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

const TX_TYPE_COLORS: Record<string, string> = {
  purchase: 'text-brand',
  admin_grant: 'text-brand',
  usage: 'text-fg-muted',
  refund: 'text-brand',
  adjustment: 'text-fg-muted',
};

export const CreditsPage = () => {
  const { user, refresh } = useAuth();
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<number | null>(null);
  const [purchaseMsg, setPurchaseMsg] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const balance = user?.credit_balance_dt ?? 0;
  const balanceUsd = user?.credit_balance_usd_value ?? 0;
  const hasCredits = user?.has_credits ?? false;

  const loadHistory = useCallback(async () => {
    try {
      setTxLoading(true);
      const history = await api.getCreditHistory(50);
      setTransactions(history);
    } catch (err) {
      console.error('[CreditsPage] failed to load history:', err);
    } finally {
      setTxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handlePurchase = async (amountDt: number) => {
    setPurchasing(amountDt);
    setPurchaseMsg(null);
    setPurchaseError(null);
    try {
      const result = await api.purchaseCreditIntent(amountDt);
      setPurchaseMsg(
        `Purchase intent created for ${result.amount_dt} DT ($${result.usd_value.toFixed(2)} AI value). ` +
        `A payment provider integration will complete this transaction. ` +
        `Transaction ID: ${result.transaction_id.slice(0, 8)}…`
      );
      // Refresh user balance and transaction list
      await refresh();
      await loadHistory();
    } catch (err) {
      if (err instanceof ApiError) {
        setPurchaseError(err.message);
      } else {
        setPurchaseError('Purchase failed — please try again.');
      }
    } finally {
      setPurchasing(null);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-fg-subtle uppercase tracking-widest">~/credits</span>
          <span className="text-brand">●</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">AI Credits</h1>
        <p className="text-sm text-fg-muted mt-1">
          Prepaid credits for AI usage. 1 DT = $0.25 AI usage value.
        </p>
      </div>

      {/* Balance + Purchase notice */}
      {(purchaseMsg || purchaseError) && (
        <div className={`px-4 py-3 border rounded-md text-xs font-mono ${
          purchaseError
            ? 'border-red-500/40 bg-red-500/5 text-red-400'
            : 'border-brand/40 bg-brand/5 text-fg'
        }`}>
          {purchaseError ?? purchaseMsg}
        </div>
      )}

      {/* Balance card */}
      <Card accent className="p-6 scanlines">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-fg-muted mb-2">
              Current Balance
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-bold tabular-nums">
                {balance.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </span>
              <span className="text-brand font-bold text-xl">DT</span>
            </div>
            <div className="text-sm text-fg-muted mt-1">
              ≈ ${balanceUsd.toFixed(2)} of AI usage value
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border ${
              hasCredits
                ? 'bg-brand/10 border-brand/30 text-brand'
                : 'bg-bg-subtle border-border text-fg-muted'
            }`}>
              <Zap size={12} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                {hasCredits ? 'Credit Account Active' : 'Free Tier'}
              </span>
            </div>
            <div className="text-[10px] text-fg-subtle text-right">
              Rate: $1 USD = 4 DT
            </div>
          </div>
        </div>
      </Card>

      {/* How credits work */}
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <Info size={14} className="text-brand shrink-0 mt-0.5" />
          <div className="text-xs text-fg-muted leading-relaxed">
            <strong className="text-fg">How credits work:</strong> Each AI request you make via the Zencode CLI consumes a small amount of your DT balance, 
            proportional to the actual AI model cost. Credits do not expire while your account is active.
            Purchases are currently processed manually — a payment provider integration will be added soon.
          </div>
        </div>
      </Card>

      {/* Buy packages */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 bg-brand" />
          <span className="text-xs font-bold tracking-wider uppercase">Buy Credits</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {PACKAGES.map((pkg) => (
            <Card
              key={pkg.dt}
              accent={pkg.popular}
              hover
              className={`p-4 flex flex-col relative ${pkg.popular ? 'ring-1 ring-brand/40' : ''}`}
            >
              {pkg.popular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge variant="brand" className="text-[8px] px-2 py-0.5 whitespace-nowrap">
                    Best Value
                  </Badge>
                </div>
              )}

              <div className="text-center mb-3 mt-1">
                <div className="text-3xl font-bold">{pkg.dt}</div>
                <div className="text-[10px] uppercase tracking-widest text-brand font-bold">DT</div>
              </div>

              <div className="bg-bg-subtle border border-border rounded p-2 text-center mb-3">
                <div className="text-[9px] uppercase tracking-wider text-fg-muted mb-0.5">AI Usage Value</div>
                <div className="text-lg font-bold text-brand">${dtToUsd(pkg.dt)}</div>
              </div>

              <ul className="space-y-1 mb-4 text-[10px] text-fg-muted">
                <li className="flex items-center gap-1"><Check size={9} className="text-brand" /> No expiry</li>
                <li className="flex items-center gap-1"><Check size={9} className="text-brand" /> All models</li>
                <li className="flex items-center gap-1"><Check size={9} className="text-brand" /> Instant CLI use</li>
              </ul>

              <button
                onClick={() => handlePurchase(pkg.dt)}
                disabled={purchasing !== null}
                className={`w-full py-2 text-[10px] font-bold uppercase tracking-wider rounded btn-press transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  pkg.popular
                    ? 'bg-brand text-black hover:bg-brand-hover'
                    : 'border border-border hover:border-brand/40 hover:bg-brand/10'
                }`}
              >
                {purchasing === pkg.dt ? (
                  <span className="flex items-center justify-center gap-1">
                    <span className="animate-spin">⟳</span> Processing...
                  </span>
                ) : (
                  `Buy ${pkg.dt} DT`
                )}
              </button>
            </Card>
          ))}
        </div>

        <p className="text-[10px] text-fg-subtle mt-3 text-center uppercase tracking-wider">
          Packages are multiples of 5 DT · Minimum: 5 DT · Maximum: 100 DT per purchase
        </p>
      </div>

      {/* Transaction history */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider uppercase">Transaction History</span>
          </div>
          <button
            onClick={loadHistory}
            className="text-[10px] text-fg-muted hover:text-brand uppercase tracking-wider transition-colors"
          >
            ↻ Refresh
          </button>
        </div>

        <Card className="overflow-hidden">
          {txLoading ? (
            <div className="p-8 text-center text-xs text-fg-muted font-mono">
              Loading transactions...
            </div>
          ) : transactions.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <Coins size={32} className="mx-auto text-fg-muted opacity-40" />
              <div className="text-sm text-fg-muted">No transactions yet.</div>
              <p className="text-xs text-fg-subtle">
                Purchase a credit package above to get started.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-bg-subtle">
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">Type</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">Status</th>
                    <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">Amount</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">Note</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx, i) => {
                    const isCredit = tx.amount_dt > 0;
                    return (
                      <tr
                        key={tx.id}
                        className={`border-b border-border/50 hover:bg-bg-card transition-colors ${
                          i % 2 === 0 ? 'bg-bg' : 'bg-bg-subtle/30'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {isCredit ? (
                              <ArrowUpRight size={12} className="text-brand" />
                            ) : (
                              <ArrowDownRight size={12} className="text-fg-muted" />
                            )}
                            <span className={`font-medium ${TX_TYPE_COLORS[tx.type] ?? 'text-fg'}`}>
                              {TX_TYPE_LABELS[tx.type] ?? tx.type}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            tx.status === 'completed'
                              ? 'bg-brand/10 text-brand border border-brand/30'
                              : tx.status === 'pending'
                                ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30'
                                : 'bg-red-500/10 text-red-400 border border-red-500/30'
                          }`}>
                            {tx.status === 'pending' && <Clock size={9} />}
                            {tx.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold tabular-nums">
                          <span className={isCredit ? 'text-brand' : 'text-fg'}>
                            {isCredit ? '+' : ''}{tx.amount_dt.toFixed(4)} DT
                          </span>
                        </td>
                        <td className="px-4 py-3 text-fg-muted max-w-[180px] truncate">
                          {tx.admin_note ?? (tx.type === 'usage' ? 'CLI request' : '—')}
                        </td>
                        <td className="px-4 py-3 text-fg-subtle whitespace-nowrap">
                          {formatDate(tx.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Help CTA */}
      <Card className="p-5 bg-brand/5 border-brand/20">
        <div className="flex items-start gap-3">
          <ShoppingCart size={16} className="text-brand mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-bold mb-1">Need more credits or a custom package?</div>
            <p className="text-xs text-fg-muted">
              Custom credit packages, team billing, and enterprise plans are available. 
              Contact us to set up a larger allocation.
            </p>
          </div>
          <a
            href="mailto:billing@zencode.dev"
            className="shrink-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-brand/40 hover:bg-brand/10 rounded transition-colors btn-press"
          >
            Contact Us
          </a>
        </div>
      </Card>

      {/* Bottom decoration */}
      <div className="flex items-center justify-center gap-1 text-brand text-[10px] font-mono opacity-40">
        <span>▓</span>
        <span>▒</span>
        <span>░</span>
        <span className="px-2">END OF CREDITS</span>
        <span>░</span>
        <span>▒</span>
        <span>▓</span>
      </div>
    </div>
  );
};
