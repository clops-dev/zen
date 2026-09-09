export type Status = 'active' | 'revoked' | 'expired';
export type Environment = 'production' | 'development' | 'staging';
export type Plan = 'FREE' | 'PRO' | 'ENTERPRISE';

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  env: Environment;
  status: Status;
  createdAt: string;
  lastUsed?: string;
  permissions: string[];
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  description: string;
  capability: 'coding' | 'reasoning' | 'vision' | 'general';
  context: string;
  coding: number;
  speed: number;
  quality: number;
  available: boolean;
  pricing: { input: number; output: number };
}

export interface Device {
  id: string;
  name: string;
  os: 'Windows' | 'macOS' | 'Linux';
  status: 'active' | 'idle' | 'offline';
  lastSeen: string;
  location: string;
}

export interface Activity {
  id: string;
  type: 'request' | 'key' | 'auth' | 'config' | 'billing';
  title: string;
  subtitle: string;
  time: string;
}

export interface UsageDay {
  date: string;
  label: string;
  requests: number;
  tokens: number;
  cost: number;
  latency: number;
  success: number;
  failed: number;
}

export interface DocPage {
  slug: string;
  title: string;
  group: string;
  content: string;
  prev?: string;
  next?: string;
}

export interface Invoice {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: 'paid' | 'pending' | 'failed';
}
