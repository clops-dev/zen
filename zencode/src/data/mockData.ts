import type { ApiKey, Model, Device, Activity, UsageDay, DocPage, Invoice } from '@/types';

export const mockApiKeys: ApiKey[] = [
  {
    id: '1',
    name: 'Production CLI',
    key: 'zk_live_abcdefghijklmnopqrstuvwxyz123456',
    env: 'production',
    status: 'active',
    createdAt: '2026-08-28T10:30:00Z',
    lastUsed: '2026-09-05T09:15:00Z',
    permissions: ['model_access', 'api_requests'],
  },
  {
    id: '2',
    name: 'Development',
    key: 'zk_test_mnopqrstuvwxyzabcdefghijkl',
    env: 'development',
    status: 'active',
    createdAt: '2026-08-24T15:45:00Z',
    lastUsed: '2026-09-04T16:20:00Z',
    permissions: ['model_access'],
  },
  {
    id: '3',
    name: 'Desktop',
    key: 'zk_live_ghijklmnopqrstuvwxyzabcdef',
    env: 'production',
    status: 'revoked',
    createdAt: '2026-08-12T08:15:00Z',
    lastUsed: '2026-08-15T11:30:00Z',
    permissions: ['model_access', 'api_requests', 'admin_access'],
  },
];

export const mockModels: Model[] = [
  {
    id: '1',
    name: 'QWEN',
    provider: 'Alibaba',
    description: 'Specialized for code generation and understanding',
    capability: 'coding',
    context: '128K',
    coding: 92,
    speed: 84,
    quality: 89,
    available: true,
    pricing: { input: 0.0004, output: 0.0012 },
  },
  {
    id: '2',
    name: 'CLAUDE',
    provider: 'Anthropic',
    description: 'Advanced reasoning with strong coding capabilities',
    capability: 'reasoning',
    context: '200K',
    coding: 88,
    speed: 76,
    quality: 95,
    available: true,
    pricing: { input: 0.0008, output: 0.0024 },
  },
  {
    id: '3',
    name: 'GPT-4',
    provider: 'OpenAI',
    description: 'Most capable general purpose model',
    capability: 'general',
    context: '32K',
    coding: 85,
    speed: 68,
    quality: 94,
    available: true,
    pricing: { input: 0.03, output: 0.06 },
  },
  {
    id: '4',
    name: 'DEEPSEEK-CODER',
    provider: 'DeepSeek',
    description: 'Optimized for software engineering tasks',
    capability: 'coding',
    context: '64K',
    coding: 90,
    speed: 82,
    quality: 87,
    available: true,
    pricing: { input: 0.00014, output: 0.00028 },
  },
  {
    id: '5',
    name: 'LLAMA-3',
    provider: 'Meta',
    description: 'Open source with strong multilingual capabilities',
    capability: 'general',
    context: '8K',
    coding: 78,
    speed: 85,
    quality: 82,
    available: true,
    pricing: { input: 0.0003, output: 0.0006 },
  },
];

export const mockDevices: Device[] = [
  {
    id: '1',
    name: 'Windows PC',
    os: 'Windows',
    status: 'active',
    lastSeen: 'Just now',
    location: 'New York, US',
  },
  {
    id: '2',
    name: 'Ubuntu Server',
    os: 'Linux',
    status: 'active',
    lastSeen: '12 minutes ago',
    location: 'Frankfurt, DE',
  },
  {
    id: '3',
    name: 'MacBook Pro',
    os: 'macOS',
    status: 'idle',
    lastSeen: '2 hours ago',
    location: 'San Francisco, US',
  },
  {
    id: '4',
    name: 'Raspberry Pi',
    os: 'Linux',
    status: 'offline',
    lastSeen: '3 days ago',
    location: 'Local Network',
  },
];

export const mockActivities: Activity[] = [
  {
    id: '1',
    type: 'request',
    title: 'API request completed',
    subtitle: 'GPT model - 247 tokens',
    time: '2 minutes ago',
  },
  {
    id: '2',
    type: 'key',
    title: 'API key created',
    subtitle: 'CLI Production',
    time: '18 minutes ago',
  },
  {
    id: '3',
    type: 'auth',
    title: 'CLI authenticated',
    subtitle: 'Windows PC',
    time: '1 hour ago',
  },
  {
    id: '4',
    type: 'config',
    title: 'Configuration updated',
    subtitle: 'Default model changed',
    time: '3 hours ago',
  },
  {
    id: '5',
    type: 'billing',
    title: 'Payment successful',
    subtitle: 'Pro subscription',
    time: '1 day ago',
  },
];

export const mockUsage: UsageDay[] = [
  {
    date: '2026-09-05',
    label: 'Sep 05',
    requests: 842,
    tokens: 184000,
    cost: 1.84,
    latency: 245,
    success: 823,
    failed: 19,
  },
  {
    date: '2026-09-04',
    label: 'Sep 04',
    requests: 913,
    tokens: 201000,
    cost: 2.01,
    latency: 238,
    success: 891,
    failed: 22,
  },
  {
    date: '2026-09-03',
    label: 'Sep 03',
    requests: 765,
    tokens: 172000,
    cost: 1.72,
    latency: 252,
    success: 748,
    failed: 17,
  },
  {
    date: '2026-09-02',
    label: 'Sep 02',
    requests: 1024,
    tokens: 224000,
    cost: 2.24,
    latency: 229,
    success: 998,
    failed: 26,
  },
  {
    date: '2026-09-01',
    label: 'Sep 01',
    requests: 956,
    tokens: 209000,
    cost: 2.09,
    latency: 241,
    success: 932,
    failed: 24,
  },
  {
    date: '2026-08-31',
    label: 'Aug 31',
    requests: 887,
    tokens: 194000,
    cost: 1.94,
    latency: 247,
    success: 865,
    failed: 22,
  },
  {
    date: '2026-08-30',
    label: 'Aug 30',
    requests: 734,
    tokens: 161000,
    cost: 1.61,
    latency: 258,
    success: 712,
    failed: 22,
  },
];

export const mockDocs: DocPage[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    group: 'Getting Started',
    content: `# Getting Started with Zencode

Welcome to Zencode, the AI-powered coding CLI that brings intelligent code assistance directly to your terminal.

## Installation

To get started, install Zencode globally using npm:

\`\`\`bash
npm install -g zencode
\`\`\`

Alternatively, you can use other package managers:

\`\`\`bash
# Yarn
yarn global add zencode

# pnpm
pnpm add -g zencode
\`\`\`

## Authentication

After installation, authenticate your CLI:

\`\`\`bash
zencode login
\`\`\`

This will open a browser window where you can log in to your Zencode account and authorize the CLI.

## First Command

Once authenticated, you can start using Zencode:

\`\`\`bash
zencode
\`\`\`

You should see the Zencode prompt, indicating you are ready to start coding with AI assistance.`,
    prev: undefined,
    next: 'installation',
  },
  {
    slug: 'installation',
    title: 'Installation',
    group: 'Getting Started',
    content: `# Installation Methods

## npm (Recommended)

\`\`\`bash
npm install -g zencode
\`\`\`

## Homebrew (macOS)

\`\`\`bash
brew install zencode
\`\`\`

## Shell Script

\`\`\`bash
curl -fsSL https://zencode.dev/install.sh | sh
\`\`\`

## Manual Installation

Download the appropriate binary for your platform from the releases page and add it to your PATH.

## Verification

Verify your installation:

\`\`\`bash
zencode --version
# Should output: zencode v7.3.58
\`\`\`

## Updating

To update to the latest version:

\`\`\`bash
npm update -g zencode
# or
brew upgrade zencode
\`\`\``,
    prev: 'getting-started',
    next: 'authentication',
  },
  {
    slug: 'authentication',
    title: 'Authentication',
    group: 'Getting Started',
    content: `# Authentication

Zencode uses API keys for authentication. You can manage your API keys in the dashboard or via the CLI.

## Login

\`\`\`bash
zencode login
\`\`\`

This command opens a browser window for you to log in to your Zencode account.

## Using API Key Directly

\`\`\`bash
zencode login --api-key zk_live_your_api_key_here
\`\`\`

## Logout

\`\`\`bash
zencode logout
\`\`\`

This removes your local authentication tokens.

## Environment Variables

You can also set your API key via environment variable:

\`\`\`bash
export ZENCODE_API_KEY=zk_live_your_api_key_here
\`\`\`

## Token Management

View your active sessions:

\`\`\`bash
zencode auth list
\`\`\`

Revoke a specific session:

\`\`\`bash
zencode auth revoke <session-id>
\`\`\``,
    prev: 'installation',
    next: 'cli-basics',
  },
];

export const mockInvoices: Invoice[] = [
  {
    id: 'inv_001',
    date: '2026-09-01',
    description: 'Pro Subscription - September 2026',
    amount: 20.0,
    status: 'paid',
  },
  {
    id: 'inv_002',
    date: '2026-08-01',
    description: 'Pro Subscription - August 2026',
    amount: 20.0,
    status: 'paid',
  },
  {
    id: 'inv_003',
    date: '2026-07-01',
    description: 'Pro Subscription - July 2026',
    amount: 20.0,
    status: 'paid',
  },
];
