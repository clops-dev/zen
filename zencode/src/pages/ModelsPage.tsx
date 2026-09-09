import { useMemo, useState } from 'react';
import { Search, Box } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart } from '@/components/ui/progress';
import { Select, Input } from '@/components/ui/form';
import { mockModels } from '@/data/mockData';
import { useToast } from '@/hooks/useToast';

export const ModelsPage = () => {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('all');
  const [capability, setCapability] = useState('all');

  const providers = useMemo(
    () => ['all', ...Array.from(new Set(mockModels.map((m) => m.provider)))],
    []
  );
  const capabilities = ['all', 'coding', 'reasoning', 'vision', 'general'];

  const filtered = useMemo(() => {
    return mockModels.filter((m) => {
      const matchSearch =
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.description.toLowerCase().includes(search.toLowerCase()) ||
        m.provider.toLowerCase().includes(search.toLowerCase());
      const matchProvider = provider === 'all' || m.provider === provider;
      const matchCap = capability === 'all' || m.capability === capability;
      return matchSearch && matchProvider && matchCap;
    });
  }, [search, provider, capability]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/models</div>
        <h1 className="text-2xl font-bold tracking-tight">Models</h1>
        <p className="text-sm text-fg-muted mt-1">
          Explore the AI models available through the Zencode CLI.
        </p>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
            />
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search models..."
              className="pl-9"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1.5">
              Provider
            </label>
            <Select
              value={provider}
              onChange={setProvider}
              options={providers.map((p) => ({
                label: p === 'all' ? 'All Providers' : p,
                value: p,
              }))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1.5">
              Capability
            </label>
            <Select
              value={capability}
              onChange={setCapability}
              options={capabilities.map((c) => ({
                label: c === 'all' ? 'All Capabilities' : c.charAt(0).toUpperCase() + c.slice(1),
                value: c,
              }))}
            />
          </div>
        </div>
      </Card>

      {/* Demo notice */}
      <div className="flex items-center gap-2 text-[10px] text-fg-subtle uppercase tracking-wider px-1">
        <span className="text-yellow-400">⚠</span>
        <span>Demo data · pricing and availability are illustrative only</span>
      </div>

      {/* Models Grid */}
      {filtered.length === 0 ? (
        <Card className="p-12 text-center">
          <Box size={32} className="mx-auto text-fg-subtle mb-3" />
          <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            No models found
          </div>
          <div className="text-[10px] text-fg-subtle mt-1">
            Try adjusting your filters
          </div>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((m) => (
            <Card key={m.id} hover className="p-5 flex flex-col">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">
                    {m.provider}
                  </div>
                  <div className="text-lg font-bold tracking-wide mt-0.5">
                    {m.name}
                  </div>
                </div>
                <Badge variant={m.available ? 'success' : 'error'} dot>
                  {m.available ? 'Available' : 'Unavailable'}
                </Badge>
              </div>

              <p className="text-xs text-fg-muted mb-4 line-clamp-2">{m.description}</p>

              <div className="space-y-2 mb-4">
                <BarChart value={m.coding} label="Coding" />
                <BarChart value={m.speed} label="Speed" />
                <BarChart value={m.quality} label="Quality" />
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4 pt-3 border-t border-border">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Context</div>
                  <div className="text-xs font-bold">{m.context}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Capability</div>
                  <div className="text-xs font-bold capitalize">{m.capability}</div>
                </div>
              </div>

              <button
                onClick={() => toast({ title: 'Model Selected', description: m.name, variant: 'success' })}
                className="w-full mt-auto px-3 py-2 bg-bg-subtle border border-border hover:border-brand/40 hover:bg-brand/10 text-xs font-bold uppercase tracking-wider rounded btn-press"
              >
                [ View Model ]
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
