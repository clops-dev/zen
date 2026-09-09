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
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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

const pricing = [
  {
    name: 'Developer',
    price: 0,
    period: '/month',
    features: ['Unlimited personal use', 'All models', 'CLI access', 'Community support'],
    cta: 'Start Free',
    popular: false,
  },
  {
    name: 'Pro',
    price: 20,
    period: '/month',
    features: [
      'Everything in Developer',
      'Team workspaces (up to 10)',
      'Shared prompt library',
      'Priority support',
      'Usage analytics',
    ],
    cta: 'Get Pro',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 99,
    period: '/month',
    features: [
      'Everything in Pro',
      'Unlimited team members',
      'SSO / SAML',
      'Custom model deployment',
      'SLA & dedicated support',
      'On-premise option',
    ],
    cta: 'Contact Sales',
    popular: false,
  },
];

const stats = [
  { value: '50K+', label: 'Developers' },
  { value: '2.3M', label: 'Requests/Day' },
  { value: '99.9%', label: 'Uptime' },
  { value: '4.9★', label: 'Satisfaction' },
];

export const LandingPage = () => {
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
            <Link to="#features" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Features</Link>
            <Link to="#demo" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Demo</Link>
            <Link to="#pricing" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Pricing</Link>
            <Link to="#docs" className="text-xs font-bold uppercase tracking-wider text-fg-muted hover:text-fg transition-colors">Docs</Link>
          </div>

          <div className="flex items-center gap-3">
            <Link to="/docs/getting-started" className="hidden sm:block px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-border hover:border-brand/40 hover:bg-brand/10 rounded btn-press">
              Documentation
            </Link>
            <Link to="/login" className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press">
              Sign In
            </Link>
            <Link to="/login" className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press">
              Get Started Free
            </Link>
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
            <Link to="/login" className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press">
              Start Free
              <ArrowRight size={14} />
            </Link>
            <Link to="/docs/getting-started" className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 border border-border text-xs font-bold uppercase tracking-wider rounded hover:border-brand/40 hover:bg-brand/10 btn-press">
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

      {/* Pricing */}
      <section id="pricing" className="py-20 lg:py-28 px-4 lg:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand/10 border border-brand/30 rounded-full mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand">PRICING</span>
            </div>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight mb-4">
              Simple, <span className="text-brand">Transparent</span> Pricing
            </h2>
            <p className="text-lg text-fg-muted max-w-2xl mx-auto">
              No hidden fees. No per-token surprises. Pay for value, not volume.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {pricing.map((p, i) => (
              <Card
                key={i}
                accent={p.popular}
                className={`p-6 flex flex-col ${p.popular ? 'relative' : ''}`}
              >
                {p.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="brand" className="text-[10px]">Most Popular</Badge>
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="text-lg font-bold mb-2">{p.name}</h3>
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold">${p.price}</span>
                    <span className="text-fg-muted">{p.period}</span>
                  </div>
                </div>
                <ul className="space-y-3 mb-6 flex-1">
                  {p.features.map((f, j) => (
                    <li key={j} className="flex items-start gap-2 text-sm">
                      <Check size={14} className="text-brand shrink-0 mt-0.5" />
                      <span className="text-fg-muted">{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/login"
                  className={`w-full text-center px-4 py-2 text-xs font-bold uppercase tracking-wider rounded btn-press ${
                    p.popular
                      ? 'bg-brand text-black hover:bg-brand-hover'
                      : 'border border-border hover:border-brand/40 hover:bg-brand/10'
                  }`}
                >
                  {p.cta}
                </Link>
              </Card>
            ))}
          </div>

          <div className="text-center mt-12 text-xs text-fg-subtle uppercase tracking-wider">
            All plans include 14-day free trial. No credit card required.
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
            <Link to="/login" className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press">
              Start Free Today
              <ArrowRight size={14} />
            </Link>
            <Link to="/docs/getting-started" className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 border border-border text-xs font-bold uppercase tracking-wider rounded hover:border-brand/40 hover:bg-brand/10 btn-press">
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
                <li><Link to="#features" className="hover:text-brand transition-colors">Features</Link></li>
                <li><Link to="#pricing" className="hover:text-brand transition-colors">Pricing</Link></li>
                <li><Link to="/docs/getting-started" className="hover:text-brand transition-colors">Documentation</Link></li>
                <li><Link to="/cli" className="hover:text-brand transition-colors">CLI Reference</Link></li>
                <li><Link to="/models" className="hover:text-brand transition-colors">Models</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider mb-4">Company</h4>
              <ul className="space-y-2 text-sm text-fg-muted">
                <li><a href="#" className="hover:text-brand transition-colors">About</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Blog</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Careers</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Press</a></li>
                <li><a href="#" className="hover:text-brand transition-colors">Contact</a></li>
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
