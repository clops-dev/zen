import { useState, useEffect, useCallback } from 'react';
import { Plus, Copy, Ban } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table';
import { Input } from '@/components/ui/form';
import { CopyButton } from '@/components/ui/copy-button';
import { api, type ApiKey } from '@/lib/api';
import { formatDate, copyToClipboard } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';


export const ApiKeysPage = () => {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [labelInput, setLabelInput] = useState('');

  const fetchKeys = useCallback(async () => {
    try {
      const data = await api.listApiKeys();
      setKeys(data);
    } catch {
      toast({ title: 'Error', description: 'Failed to load API keys', variant: 'error' });
    } finally {
      setLoadingKeys(false);
    }
  }, [toast]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const { api_key } = await api.createApiKey(labelInput.trim() || undefined);
      setCreatedKey(api_key);
      await fetchKeys();
      toast({ title: 'API Key Created', variant: 'success' });
    } catch {
      toast({ title: 'Error', description: 'Failed to create API key', variant: 'error' });
    } finally {
      setCreating(false);
    }
  };

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setCreatedKey(null);
    setLabelInput('');
  };

  const handleRevoke = async (id: string, prefix: string) => {
    try {
      await api.revokeApiKey(id);
      setKeys((prev) => prev.map((k) => k.id === id ? { ...k, revoked: true } : k));
      toast({ title: 'Key Revoked', description: prefix, variant: 'warning' });
    } catch {
      toast({ title: 'Error', description: 'Failed to revoke key', variant: 'error' });
    }
  };

  const handleCopy = async (text: string, name: string) => {
    const ok = await copyToClipboard(text);
    if (ok) toast({ title: 'Copied', description: name, variant: 'success' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">
            ~/api-keys
          </div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-fg-muted mt-1">
            Manage the credentials used by your Zencode CLI.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
        >
          <Plus size={14} />
          [ + Create API Key ]
        </button>
      </div>

      <Card>
        <Table>
          <Thead>
            <Tr>
              <Th>Label</Th>
              <Th>Key Prefix</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>Last Used</Th>
              <Th align="right">Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {loadingKeys ? (
              <Tr>
                <Td align="center" className="text-fg-subtle py-12">
                  <div className="text-xs uppercase tracking-wider animate-pulse">Loading keys...</div>
                </Td>
              </Tr>
            ) : keys.length === 0 ? (
              <Tr>
                <Td align="center" className="text-fg-subtle py-12">
                  <div className="text-2xl mb-2 opacity-30">▢</div>
                  <div className="text-xs uppercase tracking-wider">No API keys yet</div>
                  <div className="text-[10px] mt-1">Create your first key to get started</div>
                </Td>
              </Tr>
            ) : (
              keys.map((k) => (
                <Tr key={k.id}>
                  <Td>
                    <div className="font-medium">{k.label ?? '—'}</div>
                  </Td>
                  <Td>
                    <code className="font-mono text-[11px] bg-bg-subtle border border-border px-2 py-1 rounded">
                      {k.key_prefix}…
                    </code>
                  </Td>
                  <Td>
                    <Badge variant={k.revoked ? 'error' : 'success'} dot>
                      {k.revoked ? 'Revoked' : 'Active'}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="text-[11px]">{formatDate(k.created_at)}</div>
                  </Td>
                  <Td>
                    <div className="text-[11px] text-fg-muted">
                      {k.last_used_at ? formatDate(k.last_used_at) : 'Never'}
                    </div>
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      {!k.revoked && (
                        <button
                          onClick={() => handleRevoke(k.id, k.key_prefix)}
                          className="p-1.5 text-fg-muted hover:text-yellow-400 hover:bg-yellow-400/10 border border-transparent hover:border-yellow-400/30 rounded"
                          title="Revoke"
                        >
                          <Ban size={12} />
                        </button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))
            )}
          </Tbody>
        </Table>
      </Card>

      {/* Create Modal */}
      <Modal
        open={createOpen && !createdKey}
        onClose={handleCloseCreate}
        title="Create API Key"
        size="md"
      >
        {!createdKey ? (
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                Label (optional)
              </label>
              <Input
                value={labelInput}
                onChange={setLabelInput}
                placeholder="e.g. Laptop CLI"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={handleCloseCreate}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-border hover:bg-bg-card rounded btn-press"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create API Key'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-brand">
              <div className="w-2 h-2 bg-brand animate-pulseDot" />
              <span className="text-xs font-bold uppercase tracking-wider">API KEY CREATED</span>
            </div>
            <div className="bg-bg-subtle border border-brand/30 rounded p-3">
              <code className="text-xs break-all font-mono">{createdKey}</code>
            </div>
            <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded">
              <span className="text-yellow-400 text-sm">⚠</span>
              <div className="text-[11px] text-yellow-200">
                <div className="font-bold">Save this key now.</div>
                <div className="text-yellow-300/80 mt-0.5">You will not be able to see it again.</div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <CopyButton text={createdKey} label="Copy API Key" />
              <button
                onClick={handleCloseCreate}
                className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
