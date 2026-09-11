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
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';

// $1 USD of AI = 4 DT
const DT_PER_USD = 4;

const features = [
  {
    icon: Terminal,
    title: 'Native CLI',
    desc: 'Runs directly in your terminal. No browser tabs, no context switching. Just code.',
  },
  {
    icon: Zap,
    title: 'Instant Context',
    desc: 'Understands your entire codebase instantly. No indexing wait times.',
  },
  {
    icon: Shield,
    title: 'Privacy First',
    desc: 'Your code never leaves your machine. Local-first architecture by default.',
  },
  {
    icon: Code,
    title: 'Multi-Model',
    desc: 'Switch between Qwen, Claude, GPT-4, DeepSeek. Best model for each task.',
  },
  {
    icon: Users,
    title: 'Team Ready',
    desc: 'Shared prompts, team configs, centralized billing. Built for engineering teams.',
  },
  {
    icon: Star,
    title: 'Extensible',
    desc: 'Custom tools, MCP servers, webhooks. Bend it to your workflow.',
  },
];

const demoSteps = [
  { prompt: 'zencode init', output: 'Initialized .zencode/config.yaml' },
  { prompt: 'zencode explain auth/login.tsx', output: 'This component handles user authentication via JWT tokens...' },
  { prompt: 'zencode refactor --dry-run', output: 'Found 3 optimizations. Apply? [y/N]' },
  { prompt: 'zencode test --generate', output: 'Generated 12 test cases. Coverage: 94%' },
];

// Credit packages — all multiples of 5 DT, $1 = 4 DT
const creditPackages = [
  { dt: 5,   recommended: false },
  { dt: 10,  recommended: false },
  { dt: 20,  recommended: true  },
  { dt: 50,  recommended: false },
  { dt: 100, recommended: false },
];

function dtToUsdValue(dt: number) {
  return (dt / DT_PER_USD).toFixed(2);
}

const stats = [
  { value: '50K+', label: 'Developers' },
  { value: '2.3M', label: 'Requests/Day' },
  { value: '99.9%', label: 'Uptime' },
  { value: '4.9★', label: 'Satisfaction' },
];

export const LandingPage = () => {
  const { user, logout } = useAuth();
  const isAuthenticated = !!user;

  return (
    <div className="min-h-screen bg-bg text-fg font-mono">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-bg/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2" aria-label="Zencode Home">
            <div className="grid grid-cols-3 gap-0.5">
              <div className="w-1.5 h-1.5 bg-brand" />
              <div className="w-1.5 h-1.5 bg-brand/50" />
              <div className="w-1.5 h-1.5 bg-brand" />
              <div className="w-1.5 h-1.5 bg-brand/30" />
              <div className="w-1.5 h-1.5 bg-brand" />
              <div className="w-1.5 h-1.5 bg-brand/50" />
              <div className="w-1.5 h-1.5 bg-brand" />
              <div className="w-1.5 h-1.5 bg-brand/30" />
              <div className="w-1.5 h-1.5 bg-brand" />
            </div>
            <span className="text-sm font-bold tracking-wider hidden sm:block">ZENCODE</span>
          </Link>

          <div className="hidden md:flex items-center gap-6">
            <a href="#features" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Features</a>
            {isAuthenticated ? (
              <Link to="/app/credits" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Credits</Link>
            ) : (
              <a href="#pricing" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Pricing</a>
            )}
            <a href="#demo" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Demo</a>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                {/* Authenticated nav */}
                <Link
                  to="/app/dashboard"
                  className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 rounded btn-press"
                >
                  <LayoutDashboard size={12} />
                  Dashboard
                </Link>
                <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-border">
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt="" className="w-7 h-7 rounded-sm object-cover" />
                  ) : (
                    <div className="w-7 h-7 bg-brand/20 border border-brand/30 rounded-sm flex items-center justify-center text-[10px] font-bold text-brand">
                      {user.email?.[0]?.toUpperCase() ?? 'U'}
                    </div>
                  )}
                </div>
                <button
                  onClick={logout}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted hover:text-brand hover:bg-bg-card rounded border border-transparent hover:border-border transition-all btn-press"
                  title="Log out"
                >
                  <LogOut size={12} />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </>
            ) : (
              <>
                {/* Signed-out nav */}
                <Link
                  to="/login"
                  className="hidden sm:block px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 rounded btn-press"
                >
                  Sign In
                </Link>
                <Link
                  to="/login"
                  className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
                >
                  Get Started Free
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-16 lg:pt-36 lg:pb-24 px-4 lg:px-6">
        <div className="max-w-7xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-6">
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">v7.3.58</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">●</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand">Released 2 days ago</span>
          </div>

          <h1 className="text-4xl lg:text-6xl font-bold tracking-tight mb-6 leading-tight">
            AI Coding That <span className="text-brand">Lives in Your Terminal</span>
          </h1>

          <p className="text-lg lg:text-xl text-fg-muted max-w-2xl mx-auto mb-10 leading-relaxed">
            No browser tabs. No context switching. Zencode brings senior-level AI assistance
            directly into your workflow — right where you write code.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link
              to={isAuthenticated ? '/app/dashboard' : '/login'}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
            >
              {isAuthenticated ? 'Open Dashboard' : 'Start Free'}
              <ArrowRight size={14} />
            </Link>
            <Link
              to="/docs/getting-started"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 border border-border text-xs font-bold uppercase tracking-wider rounded hover:border-brand/40 hover:bg-brand/10 btn-press"
            >
              Read Docs
            </Link>
          </div>

          {/* Terminal Preview */}
          <div className="max-w-4xl mx-auto">
            <div className="bg-black/40 border border-border rounded-md overflow-hidden scanlines relative">
              <div className="flex items-center gap-1.5 px-4 py-3 bg-bg-subtle border-b border-border">
                <div className="w-3 h-3 bg-red-500 rounded" />
                <div className="w-3 h-3 bg-yellow-500 rounded" />
                <div className="w-3 h-3 bg-green-500 rounded" />
                <span className="ml-3 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
                  zencode explain src/auth/login.tsx
                </span>
              </div>
              <div className="p-6 font-mono text-xs space-y-3 overflow-x-auto">
                <div className="flex items-start gap-2">
                  <span className="text-brand shrink-0">$</span>
                  <span className="text-fg-muted">zencode explain src/auth/login.tsx</span>
                </div>
                <div className="pl-4 text-fg text-sm leading-relaxed whitespace-pre-wrap">
{`This component handles user authentication via JWT tokens stored in httpOnly cookies.
It provides login, logout, and session validation endpoints.

Key flows:
1. POST /auth/login - validates credentials, issues JWT
2. POST /auth/logout - invalidates session
3. GET /auth/me - returns current user from token

The middleware validates the token on each protected request
and attaches the user to the request context.`}
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-brand shrink-0">$</span>
                  <span className="text-fg-muted">Ready for next command...</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="py-12 px-4 lg:px-6 border-y border-border">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 text-center">
            {stats.map((s, i) => (
              <div key={i} className="border-r border-border last:border-0">
                <div className="text-3xl lg:text-4xl font-bold tracking-tight text-brand">{s.value}</div>
                <div className="text-xs uppercase tracking-widest text-fg-muted mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 lg:py-28 px-4 lg:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand">FEATURES</span>
            </div>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">
              Built for <span className="text-brand">How You Actually Work</span>
            </h2>
            <p className="text-lg text-fg-muted max-w-2xl mx-auto">
              Every feature designed around the terminal-first workflow you already know.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <Card key={i} hover className="p-6 h-full">
                <div className="w-12 h-12 bg-brand/10 border border-brand/30 rounded flex items-center justify-center mb-4">
                  <f.icon size={24} className="text-brand" />
                </div>
                <h3 className="text-lg font-bold mb-2">{f.title}</h3>
                <p className="text-sm text-fg-muted leading-relaxed">{f.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Live Demo */}
      <section id="demo" className="py-20 lg:py-28 px-4 lg:px-6 bg-bg-panel border-y border-border">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand">LIVE DEMO</span>
            </div>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">
              See It In <span className="text-brand">Action</span>
            </h2>
          </div>

          <div className="grid lg:grid-cols-2 gap-8 items-start">
            <div className="space-y-4">
              <div className="bg-black/40 border border-border rounded-md p-6 font-mono text-xs space-y-3 max-h-96 overflow-y-auto">
                {demoSteps.map((step, i) => (
                  <div key={i} className="border-t border-border/30 pt-3 first:border-0 first:pt-0">
                    <div className="flex items-start gap-2 mb-1">
                      <span className="text-brand shrink-0">$</span>
                      <span className="text-fg">{step.prompt}</span>
                    </div>
                    <div className="pl-4 text-fg-muted text-sm leading-relaxed whitespace-pre-wrap">{step.output}</div>
                  </div>
                ))}
                <div className="flex items-start gap-2 pt-3 border-t border-border/30">
                  <span className="text-brand shrink-0">$</span>
                  <span className="text-fg-muted">_</span>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <Card className="p-6">
                <h3 className="text-lg font-bold mb-4">What just happened?</h3>
                <ul className="space-y-3 text-sm text-fg-muted">
                  <li className="flex items-start gap-2"><Check size={14} className="text-brand shrink-0 mt-0.5" /> Analyzed entire auth module in 200ms</li>
                  <li className="flex items-start gap-2"><Check size={14} className="text-brand shrink-0 mt-0.5" /> Identified JWT flow, middleware, endpoints</li>
                  <li className="flex items-start gap-2"><Check size={14} className="text-brand shrink-0 mt-0.5" /> Explained in plain English with code references</li>
                  <li className="flex items-start gap-2"><Check size={14} className="text-brand shrink-0 mt-0.5" /> Ready for follow-up: refactor, test, document</li>
                </ul>
              </Card>

              <Card className="p-6 bg-brand/5 border-brand/30">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 bg-brand rounded-full animate-pulseDot" />
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wider text-brand">Try it now</div>
                    <div className="text-xs text-fg-muted">npm install -g zencode && zencode</div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — Credit Packages */}
      <section id="pricing" className="py-20 lg:py-28 px-4 lg:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand">AI CREDITS</span>
            </div>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">
              Pay Only for What <span className="text-brand">You Actually Use</span>
            </h2>
            <p className="text-lg text-fg-muted max-w-2xl mx-auto">
              No subscriptions. No recurring charges. Buy DT credits — they represent real AI usage value.
              Use them whenever you want, for as long as you want.
            </p>
          </div>

          {/* Rate explainer */}
          <div className="max-w-2xl mx-auto mb-12">
            <Card accent className="p-5 text-center scanlines">
              <div className="text-[10px] font-bold uppercase tracking-widest text-fg-muted mb-3">Exchange Rate</div>
              <div className="flex items-center justify-center gap-4 text-sm font-mono">
                <div>
                  <div className="text-3xl font-bold text-brand">1 DT</div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-muted mt-1">Zencode Credits</div>
                </div>
                <div className="text-fg-muted text-xl">=</div>
                <div>
                  <div className="text-3xl font-bold">$0.25</div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-muted mt-1">AI Usage Value</div>
                </div>
              </div>
              <p className="text-[11px] text-fg-subtle mt-4">
                Credits represent prepaid AI API usage. They are not withdrawable cash. 
                They do not expire while your account is active.
              </p>
            </Card>
          </div>

          {/* Package grid */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 max-w-5xl mx-auto">
            {creditPackages.map((pkg) => (
              <Card
                key={pkg.dt}
                accent={pkg.recommended}
                className={`p-5 flex flex-col relative ${pkg.recommended ? 'lg:scale-[1.04]' : ''}`}
              >
                {pkg.recommended && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="brand" className="text-[9px] whitespace-nowrap">Best Value</Badge>
                  </div>
                )}

                <div className="text-center mb-4">
                  <div className="text-4xl font-bold mb-1">{pkg.dt}</div>
                  <div className="text-[10px] uppercase tracking-widest text-brand font-bold">DT</div>
                </div>

                <div className="flex-1 mb-4">
                  <div className="bg-bg-subtle border border-border rounded p-3 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">AI Usage Value</div>
                    <div className="text-xl font-bold text-brand">${dtToUsdValue(pkg.dt)}</div>
                  </div>
                </div>

                <ul className="space-y-1.5 mb-5 text-[11px] text-fg-muted">
                  <li className="flex items-center gap-1.5"><Check size={10} className="text-brand" /> No expiry</li>
                  <li className="flex items-center gap-1.5"><Check size={10} className="text-brand" /> All models</li>
                  <li className="flex items-center gap-1.5"><Check size={10} className="text-brand" /> CLI ready</li>
                </ul>

                <Link
                  to={isAuthenticated ? '/app/credits' : '/login'}
                  className={`w-full text-center px-3 py-2 text-[11px] font-bold uppercase tracking-wider rounded btn-press ${
                    pkg.recommended
                      ? 'bg-brand text-black hover:bg-brand-hover'
                      : 'border border-border hover:border-brand/40 hover:bg-brand/10'
                  }`}
                >
                  {isAuthenticated ? `Buy ${pkg.dt} DT` : 'Get Started'}
                </Link>
              </Card>
            ))}
          </div>

          <div className="text-center mt-8 space-y-2">
            <p className="text-xs text-fg-subtle uppercase tracking-wider">
              Credits are purchased in multiples of 5 DT · Minimum purchase: 5 DT
            </p>
            <p className="text-xs text-fg-subtle">
              Need more? Custom packages available — contact us.
            </p>
          </div>

          {/* How it works */}
          <div className="mt-16 max-w-3xl mx-auto">
            <div className="text-center mb-8">
              <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">How Credits Work</div>
            </div>
            <div className="grid sm:grid-cols-3 gap-6">
              {[
                { step: '01', title: 'Buy Credits', desc: 'Purchase a DT credit package. Credits are added to your account instantly.' },
                { step: '02', title: 'Use Zencode CLI', desc: 'Run zencode commands normally. Each AI request consumes a small amount of your credits.' },
                { step: '03', title: 'Track Usage', desc: 'View your balance and transaction history in your dashboard at any time.' },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div className="w-12 h-12 bg-brand/10 border border-brand/30 rounded mx-auto mb-3 flex items-center justify-center">
                    <span className="text-[10px] font-bold text-brand">{item.step}</span>
                  </div>
                  <div className="text-sm font-bold mb-2">{item.title}</div>
                  <p className="text-xs text-fg-muted leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Trusted By */}
      <section className="py-16 px-4 lg:px-6 border-y border-border">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[10px] font-bold uppercase tracking-widest text-fg-muted mb-2">TRUSTED BY ENGINEERS AT</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-8 opacity-40">
            <span className="text-xs font-bold uppercase tracking-wider">Vercel</span>
            <span className="text-xs font-bold uppercase tracking-wider">Stripe</span>
            <span className="text-xs font-bold uppercase tracking-wider">Linear</span>
            <span className="text-xs font-bold uppercase tracking-wider">Railway</span>
            <span className="text-xs font-bold uppercase tracking-wider">Supabase</span>
            <span className="text-xs font-bold uppercase tracking-wider">PlanetScale</span>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 lg:py-28 px-4 lg:px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-6">
            Ready to Code <span className="text-brand">Faster</span>?
          </h2>
          <p className="text-lg text-fg-muted mb-10">
            Join 50,000+ developers who've made Zencode their daily driver.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to={isAuthenticated ? '/app/dashboard' : '/login'}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
            >
              {isAuthenticated ? 'Open Dashboard' : 'Start Free Today'}
              <ArrowRight size={14} />
            </Link>
            <Link
              to="/docs/getting-started"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 border border-border text-xs font-bold uppercase tracking-wider rounded hover:border-brand/40 hover:bg-brand/10 btn-press"
            >
              Read Documentation
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-4 lg:px-6 border-t border-border bg-bg-panel">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div className="md:col-span-2">
              <Link to="/" className="flex items-center gap-2 mb-4">
                <div className="grid grid-cols-3 gap-0.5">
                  <div className="w-1.5 h-1.5 bg-brand" />
                  <div className="w-1.5 h-1.5 bg-brand/50" />
                  <div className="w-1.5 h-1.5 bg-brand" />
                  <div className="w-1.5 h-1.5 bg-brand/30" />
                  <div className="w-1.5 h-1.5 bg-brand" />
                  <div className="w-1.5 h-1.5 bg-brand/50" />
                  <div className="w-1.5 h-1.5 bg-brand" />
                  <div className="w-1.5 h-1.5 bg-brand/30" />
                  <div className="w-1.5 h-1.5 bg-brand" />
                </div>
                <span className="text-sm font-bold tracking-wider">ZENCODE</span>
              </Link>
              <p className="text-sm text-fg-muted max-w-xs">
                AI coding CLI that lives in your terminal. Built for developers who value speed, privacy, and control.
              </p>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider mb-4">Product</h4>
              <ul className="space-y-2 text-sm text-fg-muted">
                <li><a href="#features" className="hover:text-brand transition-colors">Features</a></li>
                <li><a href="#pricing" className="hover:text-brand transition-colors">Pricing</a></li>
                <li><Link to="/docs/getting-started" className="hover:text-brand transition-colors">Documentation</Link></li>
                <li><Link to="/app/cli" className="hover:text-brand transition-colors">CLI Reference</Link></li>
                <li><Link to="/app/models" className="hover:text-brand transition-colors">Models</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider mb-4">Legal</h4>
              <ul className="space-y-2 text-sm text-fg-muted">
                <li><a href="#" className="hover:text-brand transition-colors">Privacy</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Terms</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Security</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Cookies</a></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-[10px] text-fg-subtle uppercase tracking-wider">
              © 2026 Zencode. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              <a href="#" className="text-fg-muted hover:text-brand transition-colors" aria-label="GitHub">
                <GitFork size={16} />
              </a>
              <a href="#" className="text-fg-muted hover:text-brand transition-colors" aria-label="Twitter">
                <ExternalLink size={16} />
              </a>
              <a href="mailto:hello@zencode.dev" className="text-fg-muted hover:text-brand transition-colors" aria-label="Email">
                <Mail size={16} />
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};
