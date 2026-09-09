import { useState, useEffect } from 'react';
import { Copy, Terminal as TerminalIcon, Download, RefreshCw, Laptop, Server, Apple } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs } from '@/components/ui/form';
import { CopyButton } from '@/components/ui/copy-button';
import { mockDevices } from '@/data/mockData';
import { useToast } from '@/hooks/useToast';

type OS = 'windows' | 'macos' | 'linux';

const installCommands: Record<OS, { cmd: string; mgr: string }> = {
  windows: { cmd: 'npm install -g zencode', mgr: 'npm' },
  macos: { cmd: 'brew install zencode', mgr: 'Homebrew' },
  linux: { cmd: 'curl -fsSL https://zencode.dev/install.sh | sh', mgr: 'Shell Script' },
};

const TerminalLine = ({ children, prompt = '$' }: { children: React.ReactNode; prompt?: string }) => (
  <div className="flex items-start gap-2 text-xs font-mono">
    <span className="text-brand shrink-0">{prompt}</span>
    <span className="flex-1">{children}</span>
  </div>
);

const Output = ({ children, color = 'text-fg-muted' }: { children: React.ReactNode; color?: string }) => (
  <div className={`text-xs font-mono pl-4 ${color}`}>{children}</div>
);

export const CliPage = () => {
  const { toast } = useToast();
  const [os, setOs] = useState<OS>('windows');
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    const i = setInterval(() => setCursorOn((v) => !v), 500);
    return () => clearInterval(i);
  }, []);

  const cmd = installCommands[os];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="text-center max-w-2xl mx-auto py-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4">
          <TerminalIcon size={12} className="text-brand" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand">
            Zencode CLI v7.3.58
          </span>
        </div>
        <h1 className="text-3xl lg:text-4xl font-bold tracking-tight mb-3">
          Zencode <span className="text-brand">CLI</span>
        </h1>
        <p className="text-sm text-fg-muted">
          Bring AI-powered coding directly into your terminal.
        </p>
      </div>

      {/* Main Terminal */}
      <Card accent className="p-0 overflow-hidden scanlines relative">
        <div className="flex items-center justify-between px-4 py-2 bg-bg-subtle border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-red-500" />
            <div className="w-2.5 h-2.5 bg-yellow-500" />
            <div className="w-2.5 h-2.5 bg-green-500" />
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
              ┌─ ZENCODE TERMINAL ─────────────────┐
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 bg-brand rounded-full animate-pulseDot" />
            <span className="text-[10px] uppercase tracking-wider text-fg-muted">Connected</span>
          </div>
        </div>

        <div className="p-5 lg:p-6 bg-black/40 min-h-[320px] font-mono space-y-1.5">
          <TerminalLine prompt="$">npm install -g zencode</TerminalLine>
          <Output>added 142 packages in 3s</Output>
          <Output color="text-fg-subtle">12 packages are looking for funding</Output>
          <div className="h-2" />

          <TerminalLine prompt="$">zencode login</TerminalLine>
          <Output color="text-brand">✓ Authentication successful</Output>
          <Output color="text-fg-muted">  Welcome, developer@zencode.dev</Output>
          <div className="h-2" />

          <TerminalLine prompt="$">zencode</TerminalLine>
          <Output color="text-brand">Zencode AI Coding Assistant</Output>
          <Output color="text-fg-muted">v7.3.58 · Production</Output>
          <Output color="text-fg-muted">Ready.</Output>
          <div className="h-3" />

          <div className="flex items-start gap-2 text-xs font-mono">
            <span className="text-brand">&gt;</span>
            <span className="text-fg-muted">Try: </span>
            <span className="text-fg">explain this function</span>
            <span className={cursorOn ? 'text-brand' : 'opacity-0'}>▊</span>
          </div>
        </div>
      </Card>

      {/* Installation */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">INSTALLATION</span>
          </div>

          <Tabs
            tabs={[
              { id: 'windows', label: 'Windows' },
              { id: 'macos', label: 'macOS' },
              { id: 'linux', label: 'Linux' },
            ]}
            active={os}
            onChange={(id) => setOs(id as OS)}
            className="mb-4 -mx-5 px-5"
          />

          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-wider text-fg-muted">
              Package Manager: {cmd.mgr}
            </div>
            <div className="bg-black/60 border border-border rounded-md p-4 flex items-center justify-between gap-3">
              <code className="text-sm font-mono text-fg break-all">{cmd.cmd}</code>
              <CopyButton text={cmd.cmd} label="Copy" />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-fg-muted">
              <span className="text-brand">●</span>
              <span>Requires Node.js 18+ and admin privileges</span>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">VERSION</span>
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-fg-muted">Current</div>
              <div className="text-2xl font-bold">v7.3.58</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="success" dot>
                Latest
              </Badge>
              <span className="text-[10px] text-fg-subtle">Released 2 days ago</span>
            </div>
            <button
              onClick={() => toast({ title: 'Checking for updates...', variant: 'default' })}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 bg-bg-subtle border border-border hover:border-brand/40 hover:bg-brand/10 text-xs font-bold uppercase tracking-wider rounded btn-press"
            >
              <RefreshCw size={12} />
              Update CLI
            </button>
          </div>
        </Card>
      </div>

      {/* Connected Devices */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand" />
            <span className="text-xs font-bold tracking-wider">CONNECTED DEVICES</span>
          </div>
          <Badge variant="outline">{mockDevices.length} devices</Badge>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {mockDevices.map((d) => {
            const Icon = d.os === 'Windows' ? Laptop : d.os === 'Linux' ? Server : Apple;
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 p-3 bg-bg-subtle border border-border rounded hover:border-border-strong transition-colors"
              >
                <div className="w-10 h-10 bg-bg-card border border-border rounded flex items-center justify-center">
                  <Icon size={18} className="text-fg-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold flex items-center gap-2">
                    {d.name}
                    <Badge
                      variant={d.status === 'active' ? 'success' : d.status === 'idle' ? 'warning' : 'error'}
                      dot
                    >
                      {d.status}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-fg-subtle">
                    {d.os} · {d.location}
                  </div>
                </div>
                <div className="text-[10px] text-fg-subtle uppercase text-right shrink-0">
                  <div>Last seen</div>
                  <div className="text-fg-muted">{d.lastSeen}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Quick commands */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'zencode init', desc: 'Initialize project' },
          { label: 'zencode explain', desc: 'Explain code' },
          { label: 'zencode refactor', desc: 'Refactor code' },
          { label: 'zencode test', desc: 'Generate tests' },
        ].map((c) => (
          <div
            key={c.label}
            className="p-3 bg-bg-subtle border border-border rounded hover:border-brand/40 transition-colors"
          >
            <code className="text-xs font-mono text-brand">{c.label}</code>
            <div className="text-[10px] text-fg-muted mt-1">{c.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
