import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Terminal,
  Zap,
  Shield,
  Code,
  Users,
  ArrowRight,
  Check,
  Star,
  GitFork,
  ExternalLink,
  Mail,
  LogOut,
  LayoutDashboard,
  Copy,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { copyToClipboard } from '@/lib/copy';

interface CreditPackage {
  dt: number;
  usd: number;
}

interface PricingResponse {
  packages: CreditPackage[];
  dt_per_usd: number;
}

const features = [
  { icon: Terminal, title: 'Native CLI', desc: 'Runs directly in your terminal. No browser tabs, no context switching. Just code.' },
  { icon: Zap, title: 'Instant Context', desc: 'Understands your entire codebase instantly. No indexing wait times.' },
  { icon: Shield, title: 'Privacy First', desc: 'Your code never leaves your machine. Local-first architecture by default.' },
  { icon: Code, title: 'Multi-Model', desc: 'Switch between Qwen, Claude, GPT-4, DeepSeek. Best model for each task.' },
  { icon: Users, title: 'Team Ready', desc: 'Shared prompts, team configs, centralized billing. Built for engineering teams.' },
  { icon: Star, title: 'Extensible', desc: 'Custom tools, MCP servers, webhooks. Bend it to your workflow.' },
];

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${value}`}
      className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted border border-border rounded hover:text-fg hover:border-brand/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <Copy size={12} />
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="flex items-start gap-3 bg-black/40 border border-border rounded-md p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto text-xs leading-relaxed text-fg whitespace-pre">{value}</pre>
      <CopyButton value={value} />
    </div>
  );
}

export const LandingPage = () => {
  const { user, logout } = useAuth();
  const isAuthenticated = !!user;
  const [pricing, setPricing] = useState<PricingResponse | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);
  const [pricingError, setPricingError] = useState(false);

  useEffect(() => {
    fetch('/public-api/credit-packages')
      .then((response) => {
        if (!response.ok) throw new Error('pricing unavailable');
        return response.json() as Promise<PricingResponse>;
      })
      .then(setPricing)
      .catch(() => setPricingError(true))
      .finally(() => setPricingLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-bg text-fg font-mono">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-bg/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2" aria-label="Zencode Home">
            <div className="grid grid-cols-3 gap-0.5">
              {Array.from({ length: 9 }).map((_, i) => <div key={i} className={`w-1.5 h-1.5 ${i % 2 === 0 ? 'bg-brand' : 'bg-brand/30'}`} />)}
            </div>
            <span className="text-sm font-bold tracking-wider hidden sm:block">ZENCODE</span>
          </Link>
          <div className="hidden md:flex items-center gap-6">
            <a href="#features" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg">Features</a>
            <a href="#get-started" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg">Get started</a>
            <a href="#pricing" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg">Pricing</a>
          </div>
          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                <Link to="/app/dashboard" className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 rounded">
                  <LayoutDashboard size={12} /> Dashboard
                </Link>
                <button onClick={logout} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted hover:text-brand rounded border border-transparent hover:border-border" title="Log out">
                  <LogOut size={12} /><span className="hidden sm:inline">Logout</span>
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="hidden sm:block px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 rounded">Sign In</Link>
                <a href="#get-started" className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover">Get Started Free</a>
              </>
            )}
          </div>
        </div>
      </nav>

      <section className="pt-28 pb-20 lg:pt-36 lg:pb-24 px-4 lg:px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-6">
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">v7.3.58</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">●</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">Terminal-first AI</span>
          </div>
          <h1 className="text-4xl lg:text-6xl font-bold tracking-tight mb-6 leading-tight">AI Coding That <span className="text-brand">Lives in Your Terminal</span></h1>
          <p className="text-lg lg:text-xl text-fg-muted max-w-2xl mx-auto mb-10 leading-relaxed">No browser tabs. No context switching. Zencode brings senior-level AI assistance directly into your workflow — right where you write code.</p>
          <a href="#get-started" className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover">Start Free <ArrowRight size={14} /></a>
        </div>
      </section>

      <section id="get-started" className="py-20 lg:py-28 px-4 lg:px-6 bg-bg-panel border-y border-border">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4"><span className="text-[10px] font-bold uppercase tracking-widest text-brand">GET STARTED</span></div>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight">From zero to <span className="text-brand">first prompt</span></h2>
          </div>
          <div className="grid gap-5">
            {[
              { number: '01', title: 'Install', text: 'Install Zencode globally with npm.', code: 'npm install -g @zencodee-cli/zencode@beta' },
              { number: '02', title: 'Log in', text: 'Open PowerShell (or any terminal) and log in.', code: 'zencode login', note: 'It opens your browser to authenticate.' },
              { number: '03', title: 'Open your workspace', text: 'Go to the folder you want to work in and start Zencode. It works on that directory.', code: 'cd path/to/your/project\nzencode' },
            ].map((step) => (
              <Card key={step.number} className="p-5">
                <div className="flex items-start gap-4">
                  <span className="text-xs font-bold text-brand border border-brand/30 bg-brand/10 rounded px-2 py-1">{step.number}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-bold mb-1">{step.title}</h3>
                    <p className="text-sm text-fg-muted mb-4">{step.text}</p>
                    <CodeBlock value={step.code} />
                    {step.note && <p className="text-xs text-fg-subtle mt-2">{step.note}</p>}
                  </div>
                </div>
              </Card>
            ))}
            <Card className="p-5">
              <div className="flex items-start gap-4">
                <span className="text-xs font-bold text-brand border border-brand/30 bg-brand/10 rounded px-2 py-1">04</span>
                <div><h3 className="text-base font-bold mb-1">Buy credits</h3><p className="text-sm text-fg-muted mb-4">Buy credits from your dashboard and pay only for what you use.</p><Link to={isAuthenticated ? '/app/credits' : '/login'} className="inline-flex items-center gap-2 px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover">Open credits <ArrowRight size={13} /></Link></div>
              </div>
            </Card>
          </div>
        </div>
      </section>

      <section id="features" className="py-20 lg:py-28 px-4 lg:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16"><div className="inline-flex px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4"><span className="text-[10px] font-bold uppercase tracking-widest text-brand">FEATURES</span></div><h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">Built for <span className="text-brand">How You Actually Work</span></h2><p className="text-lg text-fg-muted max-w-2xl mx-auto">Every feature designed around the terminal-first workflow you already know.</p></div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">{features.map((f) => <Card key={f.title} hover className="p-6 h-full"><div className="w-12 h-12 bg-brand/10 border border-brand/30 rounded flex items-center justify-center mb-4"><f.icon size={24} className="text-brand" /></div><h3 className="text-lg font-bold mb-2">{f.title}</h3><p className="text-sm text-fg-muted leading-relaxed">{f.desc}</p></Card>)}</div>
        </div>
      </section>

      <section id="pricing" className="py-20 lg:py-28 px-4 lg:px-6 bg-bg-panel border-y border-border">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12"><div className="inline-flex px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4"><span className="text-[10px] font-bold uppercase tracking-widest text-brand">AI CREDITS</span></div><h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">Pay only for what <span className="text-brand">you use</span></h2><p className="text-lg text-fg-muted max-w-2xl mx-auto">No subscriptions or recurring charges. Buy credits and use them whenever you want.</p></div>
          {pricingLoading && <div className="text-center text-sm text-fg-muted animate-pulse">Loading credit packs...</div>}
          {pricingError && <div className="text-center text-sm text-fg-muted border border-border rounded p-5">Credit packs are temporarily unavailable.</div>}
          {pricing && <><p className="text-center text-xs text-fg-subtle mb-8">1 USD = {pricing.dt_per_usd} DT</p><div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 max-w-5xl mx-auto">{pricing.packages.map((pkg, i) => <Card key={pkg.dt} accent={i === 1} className="p-5 flex flex-col"><div className="text-center mb-4"><div className="text-4xl font-bold mb-1">{pkg.dt}</div><div className="text-[10px] uppercase tracking-widest text-brand font-bold">DT credits</div></div><div className="bg-bg-subtle border border-border rounded p-3 text-center mb-5"><div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Price</div><div className="text-xl font-bold text-brand">${pkg.usd.toFixed(2)}</div></div><Link to={isAuthenticated ? '/app/credits' : '/login'} className="mt-auto w-full text-center px-3 py-2 text-[11px] font-bold uppercase tracking-wider rounded border border-border hover:border-brand/40 hover:bg-brand/10">{isAuthenticated ? 'Buy credits' : 'Get started'}</Link></Card>)}</div></>}
        </div>
      </section>

      <section className="py-20 lg:py-28 px-4 lg:px-6"><div className="max-w-3xl mx-auto text-center"><h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-6">Ready to Code <span className="text-brand">Faster</span>?</h2><p className="text-lg text-fg-muted mb-10">Install Zencode and bring AI assistance into your terminal.</p><Link to={isAuthenticated ? '/app/dashboard' : '/login'} className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover">{isAuthenticated ? 'Open Dashboard' : 'Start Free Today'} <ArrowRight size={14} /></Link></div></section>

      <footer className="py-12 px-4 lg:px-6 border-t border-border bg-bg-panel"><div className="max-w-7xl mx-auto"><div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12"><div className="md:col-span-2"><Link to="/" className="flex items-center gap-2 mb-4"><span className="text-sm font-bold tracking-wider">ZENCODE</span></Link><p className="text-sm text-fg-muted max-w-xs">AI coding CLI that lives in your terminal. Built for developers who value speed, privacy, and control.</p></div><div><h4 className="text-xs font-bold uppercase tracking-wider mb-4">Product</h4><ul className="space-y-2 text-sm text-fg-muted"><li><a href="#features" className="hover:text-brand">Features</a></li><li><a href="#pricing" className="hover:text-brand">Pricing</a></li><li><Link to="/docs/getting-started" className="hover:text-brand">Documentation</Link></li><li><Link to="/app/cli" className="hover:text-brand">CLI Reference</Link></li></ul></div><div><h4 className="text-xs font-bold uppercase tracking-wider mb-4">Legal</h4><ul className="space-y-2 text-sm text-fg-muted"><li><a href="#" className="hover:text-brand">Privacy</a></li><li><a href="#" className="hover:text-brand">Terms</a></li><li><a href="#" className="hover:text-brand">Security</a></li></ul></div></div><div className="pt-8 border-t border-border flex items-center justify-between"><p className="text-[10px] text-fg-subtle uppercase tracking-wider">© 2026 Zencode. All rights reserved.</p><div className="flex items-center gap-4"><a href="#" className="text-fg-muted hover:text-brand" aria-label="GitHub"><GitFork size={16} /></a><a href="#" className="text-fg-muted hover:text-brand" aria-label="Twitter"><ExternalLink size={16} /></a><a href="mailto:hello@zencode.dev" className="text-fg-muted hover:text-brand" aria-label="Email"><Mail size={16} /></a></div></div></div></footer>
    </div>
  );
};
