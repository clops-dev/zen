import { useState } from 'react';
import { Check, CreditCard, Zap, Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress';
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table';
import { mockInvoices } from '@/data/mockData';
import { useToast } from '@/hooks/useToast';

type Plan = 'FREE' | 'PRO' | 'ENTERPRISE';

const plans: { id: Plan; name: string; price: number; features: string[]; recommended?: boolean }[] = [
  {
    id: 'FREE',
    name: 'Free',
    price: 0,
    features: ['1 API Key', '100 requests/day', 'Community support', 'Standard models'],
  },
  {
    id: 'PRO',
    name: 'Pro',
    price: 20,
    recommended: true,
    features: [
      'Unlimited API Keys',
      'Unlimited requests',
      'Priority support',
      'All models',
      'CLI access',
      'Advanced analytics',
    ],
  },
  {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    price: 99,
    features: [
      'Everything in Pro',
      'SSO / SAML',
      'Dedicated support',
      'Custom models',
      'SLA guarantee',
      'On-premise option',
    ],
  },
];

export const BillingPage = () => {
  const { toast } = useToast();
  const [currentPlan, setCurrentPlan] = useState<Plan>('PRO');
  const credits = 8000;
  const creditsMax = 10000;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/billing</div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-sm text-fg-muted mt-1">
          Manage your subscription, usage and invoices.
        </p>
      </div>

      {/* Current plan */}
      <Card accent className="p-6 scanlines relative overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-fg-muted mb-1">
              Current Plan
            </div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-3xl font-bold">{plans.find((p) => p.id === currentPlan)?.name}</h2>
              <Badge variant="success" dot>
                Active
              </Badge>
            </div>
            <div className="text-sm text-fg-muted">
              ${plans.find((p) => p.id === currentPlan)?.price}.00 / month
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => toast({ title: 'Opening billing portal...', variant: 'default' })}
              className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
            >
              Manage Subscription
            </button>
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-fg-muted flex items-center gap-2">
              <Zap size={11} className="text-brand" />
              AI Credits
            </div>
            <div className="text-xs font-bold">
              {credits.toLocaleString()} / {creditsMax.toLocaleString()}
            </div>
          </div>
          <ProgressBar value={credits} max={creditsMax} />
          <div className="flex justify-between mt-2 text-[10px] text-fg-subtle">
            <span>Resets in 12 days</span>
            <span className="text-brand font-bold">
              {Math.round((credits / creditsMax) * 100)}% remaining
            </span>
          </div>
        </div>
      </Card>

      {/* Plans */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 bg-brand" />
          <span className="text-xs font-bold tracking-wider">AVAILABLE PLANS</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map((p) => {
            const isCurrent = p.id === currentPlan;
            return (
              <Card
                key={p.id}
                accent={p.recommended}
                className={`p-5 flex flex-col ${
                  p.recommended ? 'lg:scale-[1.02]' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-bold">{p.name}</h3>
                    {p.recommended && (
                      <Badge variant="brand" className="mt-1">
                        Recommended
                      </Badge>
                    )}
                  </div>
                  {isCurrent && <Badge variant="success" dot>Current</Badge>}
                </div>

                <div className="mb-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold">${p.price}</span>
                    <span className="text-xs text-fg-muted">/month</span>
                  </div>
                </div>

                <ul className="space-y-2 mb-5 flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs">
                      <Check size={12} className="text-brand shrink-0 mt-0.5" />
                      <span className="text-fg-muted">{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => {
                    setCurrentPlan(p.id);
                    toast({
                      title: `Switched to ${p.name}`,
                      description: 'Your plan has been updated',
                      variant: 'success',
                    });
                  }}
                  disabled={isCurrent}
                  className={`w-full px-3 py-2 text-xs font-bold uppercase tracking-wider rounded btn-press ${
                    isCurrent
                      ? 'bg-bg-subtle border border-border text-fg-subtle cursor-not-allowed'
                      : p.recommended
                      ? 'bg-brand text-black hover:bg-brand-hover'
                      : 'bg-bg-subtle border border-border hover:border-brand/40 hover:bg-brand/10'
                  }`}
                >
                  {isCurrent ? 'Current Plan' : `Select ${p.name}`}
                </button>
              </Card>
            );
          })}
        </div>
        <div className="text-[10px] text-fg-subtle text-center mt-3 uppercase tracking-wider">
          Demo data · prices are illustrative
        </div>
      </div>

      {/* Payment + Invoices */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <CreditCard size={14} className="text-brand" />
            <span className="text-xs font-bold tracking-wider">PAYMENT METHOD</span>
          </div>
          <div className="bg-bg-subtle border border-border rounded p-3 mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold">VISA</span>
              <span className="text-[10px] text-fg-subtle">Default</span>
            </div>
            <div className="text-xs text-fg-muted">•••• •••• •••• 4242</div>
            <div className="text-[10px] text-fg-subtle mt-1">Expires 12/27</div>
          </div>
          <button className="w-full text-xs font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 py-2 rounded btn-press">
            + Add Card
          </button>
        </Card>

        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-brand" />
              <span className="text-xs font-bold tracking-wider">BILLING HISTORY</span>
            </div>
            <button className="text-[10px] font-bold uppercase tracking-wider text-fg-muted hover:text-brand flex items-center gap-1">
              <Download size={11} /> Export
            </button>
          </div>
          <Table>
            <Thead>
              <Tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {mockInvoices.map((inv) => (
                <Tr key={inv.id}>
                  <Td>
                    <div className="font-mono text-[11px]">
                      {new Date(inv.date).toLocaleDateString('en-US', {
                        month: 'short',
                        day: '2-digit',
                        year: 'numeric',
                      })}
                    </div>
                  </Td>
                  <Td className="text-fg-muted">{inv.description}</Td>
                  <Td align="right" className="font-bold">
                    ${inv.amount.toFixed(2)}
                  </Td>
                  <Td>
                    <Badge variant="success" dot>
                      Paid
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
};
