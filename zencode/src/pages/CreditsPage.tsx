import { useState, useEffect, useCallback } from 'react';
import { Coins, ShoppingCart, Check, Clock, ArrowUpRight, ArrowDownRight, Zap, Info, Receipt, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type CreditTransaction, type PaymentReceipt } from '@/lib/api';

const DT_PER_USD = 3;

// Requirement 8: Fixed Credit packages following 1 USD = 3 DT
const PACKAGES = [
  { usd: 5,   dt: 15,  popular: false },
  { usd: 10,  dt: 30,  popular: true  },
  { usd: 25,  dt: 75,  popular: false },
  { usd: 50,  dt: 150, popular: false },
] as const;

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const CreditsPage = () => {
  const { user, refresh } = useAuth();
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<number | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);

  // Single Source of Truth Values from backend
  const purchasedUsd = user?.total_credits_purchased ?? 0;
  const usageUsd = user?.total_usage_cost ?? 0;
  const remainingUsd = user?.remaining_credits ?? (purchasedUsd - usageUsd);
  const remainingDt = user?.remaining_credits_dt ?? (remainingUsd * DT_PER_USD);
  const hasCredits = remainingUsd > 0;

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

  const handlePurchase = async (dtAmount: number) => {
    setPurchasing(dtAmount);
    setPurchaseError(null);
    try {
      const res = await api.purchaseCredits(dtAmount);
      setReceipt(res.receipt);
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
        <h1 className="text-2xl font-bold tracking-tight">BUY AI CREDITS</h1>
        <p className="text-sm text-fg-muted mt-1">
          Credits-only payment system. Fixed rate: <strong>1 USD = 3 DT</strong> ($5 = 15 DT).
        </p>
      </div>

      {purchaseError && (
        <div className="px-4 py-3 border border-red-500/40 bg-red-500/5 text-red-400 rounded-md text-xs font-mono">
          {purchaseError}
        </div>
      )}

      {/* Credit Balance Card */}
      <Card accent className="p-6 scanlines">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-fg-muted mb-1">
              Current Available AI Credits
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-bold font-mono">
                ${remainingUsd.toFixed(6)}
              </span>
              <span className="text-brand font-bold text-xl">({remainingDt.toFixed(2)} DT)</span>
            </div>
            <div className="text-xs text-fg-muted mt-2">
              Purchased: <span className="text-fg font-bold">${purchasedUsd.toFixed(2)}</span> · 
              Usage Cost: <span className="text-red-400 font-bold">${usageUsd.toFixed(6)}</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <Badge variant={hasCredits ? 'success' : 'error'} dot>
              {hasCredits ? 'CREDITS ACTIVE' : 'NO CREDITS'}
            </Badge>
            <span className="text-[10px] text-fg-subtle">
              Single Source of Truth: Backend Derived
            </span>
          </div>
        </div>
      </Card>

      {/* Requirement 8: Buy Credits Packages */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 bg-brand" />
          <span className="text-xs font-bold tracking-wider uppercase">BUY AI CREDITS ($ → DT)</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PACKAGES.map((pkg) => (
            <Card
              key={pkg.usd}
              accent={pkg.popular}
              hover
              className={`p-5 flex flex-col justify-between relative ${pkg.popular ? 'ring-1 ring-brand/40' : ''}`}
            >
              {pkg.popular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge variant="brand" className="text-[8px] px-2 py-0.5 whitespace-nowrap">
                    Most Popular
                  </Badge>
                </div>
              )}

              <div className="text-center mb-4 mt-2">
                <div className="text-3xl font-bold font-mono">${pkg.usd}</div>
                <div className="text-sm font-bold text-brand mt-1">→ {pkg.dt} DT</div>
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle mt-1">
                  Adds ${pkg.usd}.00 AI Balance
                </div>
              </div>

              <div className="space-y-2 mb-4 text-[11px] text-fg-muted bg-bg-subtle/50 p-3 rounded border border-border">
                <div className="flex justify-between">
                  <span>Price:</span>
                  <span className="font-bold text-fg">{pkg.dt} DT</span>
                </div>
                <div className="flex justify-between">
                  <span>Credits Added:</span>
                  <span className="font-bold text-brand">${pkg.usd}.00</span>
                </div>
              </div>

              <button
                onClick={() => handlePurchase(pkg.dt)}
                disabled={purchasing !== null}
                className={`w-full py-2.5 text-xs font-bold uppercase tracking-wider rounded btn-press transition-colors disabled:opacity-50 ${
                  pkg.popular
                    ? 'bg-brand text-black hover:bg-brand-hover'
                    : 'border border-border hover:border-brand/40 hover:bg-brand/10'
                }`}
              >
                {purchasing === pkg.dt ? 'Processing...' : `[ Buy $${pkg.usd} Credits ]`}
              </button>
            </Card>
          ))}
        </div>
      </div>

      {/* Requirement 10: Credit Transaction History */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider uppercase">CREDIT TRANSACTION HISTORY</span>
          </div>
          <button
            onClick={loadHistory}
            className="text-[10px] text-fg-muted hover:text-brand uppercase tracking-wider transition-colors"
          >
            ↻ Refresh Ledger
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
              <div className="text-sm text-fg-muted">No credit transactions yet.</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-bg-subtle font-mono text-[10px] text-fg-muted uppercase">
                    <th className="text-left px-4 py-3">Date</th>
                    <th className="text-left px-4 py-3">Type</th>
                    <th className="text-right px-4 py-3">Amount (DT)</th>
                    <th className="text-right px-4 py-3">Credits ($)</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {transactions.map((tx, i) => {
                    const isCredit = tx.amount_dt > 0;
                    const creditsUsd = (Math.abs(tx.amount_dt) / DT_PER_USD).toFixed(6);

                    return (
                      <tr
                        key={tx.id}
                        className={`border-b border-border/50 hover:bg-bg-card transition-colors ${
                          i % 2 === 0 ? 'bg-bg' : 'bg-bg-subtle/30'
                        }`}
                      >
                        <td className="px-4 py-3 text-fg-subtle whitespace-nowrap">
                          {formatDate(tx.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`font-bold ${isCredit ? 'text-brand' : 'text-red-400'}`}>
                            {tx.type === 'purchase' ? 'Credit Purchase' : tx.type === 'usage' ? 'AI Usage' : tx.type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold">
                          {isCredit ? `+${tx.amount_dt} DT` : '-'}
                        </td>
                        <td className="px-4 py-3 text-right font-bold">
                          <span className={isCredit ? 'text-brand' : 'text-red-400'}>
                            {isCredit ? `+$${creditsUsd}` : `-$${creditsUsd}`}
                          </span>
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

      {/* Requirement 9: Pixel-Art / 3D Payment Receipt Modal */}
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="PAYMENT RECEIPT" size="md">
        {receipt && (
          <div className="space-y-4 scanlines p-2 font-mono">
            {/* Pixel Art Header */}
            <div className="text-center border-b border-brand/30 pb-4">
              <div className="text-brand font-bold text-lg tracking-widest">▲ ZENCODE ▲</div>
              <div className="text-xs uppercase tracking-widest text-fg-muted mt-1">CREDIT PURCHASE RECEIPT</div>
              <div className="text-[10px] text-fg-subtle mt-1">{formatDate(receipt.date)}</div>
            </div>

            {receipt.status === 'pending' && (
              <div className="p-3 border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 rounded text-xs text-center font-bold">
                ⏳ PENDING ADMIN APPROVAL — Credits will be added to your wallet once confirmed by an admin.
              </div>
            )}

            <div className="space-y-3 text-xs bg-bg-subtle border border-brand/20 p-4 rounded-md">
              <div className="flex justify-between border-b border-border/40 pb-2">
                <span className="text-fg-muted uppercase">Status:</span>
                <span className="font-bold text-yellow-400 uppercase">{receipt.status ?? 'pending'}</span>
              </div>
              <div className="flex justify-between border-b border-border/40 pb-2">
                <span className="text-fg-muted uppercase">Requested Amount:</span>
                <span className="font-bold text-brand">{receipt.amount_paid_dt} DT (${receipt.credits_added_usd.toFixed(2)})</span>
              </div>
              <div className="flex justify-between border-b border-border/40 pb-2">
                <span className="text-fg-muted uppercase">Current Balance:</span>
                <span className="text-fg-subtle">${receipt.previous_balance_usd.toFixed(6)}</span>
              </div>
              <div className="flex justify-between pt-1 text-[11px]">
                <span className="text-fg-muted uppercase">Transaction ID:</span>
                <span className="text-brand font-bold uppercase">{receipt.transaction_id.slice(0, 8)}…</span>
              </div>
            </div>

            <div className="flex items-center justify-end pt-2">
              <button
                onClick={() => setReceipt(null)}
                className="w-full py-2.5 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
              >
                [ CLOSE RECEIPT ]
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
