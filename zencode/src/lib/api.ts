/**
 * Typed fetch wrapper for the /user-api/* backend.
 *
 * - Automatically includes credentials (session cookie) on every request.
 * - Throws ApiError on non-2xx responses so callers can handle them uniformly.
 * - Exposes typed helpers for every endpoint the zencode SPA needs.
 */

// ---------------------------------------------------------------------------
// Types matching the /user-api/* JSON shapes
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  tier: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended';
  token_budget_monthly: number;
  used_this_month: number;
  active_key_count: number;
  total_key_count: number;
}

export interface ApiKey {
  id: string;
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

export interface NewApiKeyResponse {
  api_key: string;
  prefix: string;
}

export interface MonthlyUsage {
  month: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  request_count: number;
}

export interface DailyUsage {
  day: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized() {
    return this.status === 401 || this.status === 403;
  }
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include', // send session cookie on every request
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = 'unknown_error';
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      code = body.error ?? code;
      message = body.message ?? message;
    } catch {
      // non-JSON error body — keep defaults
    }
    throw new ApiError(res.status, code, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed API methods
// ---------------------------------------------------------------------------

export const api = {
  /** Fetch the current user's profile + subscription summary. */
  me(): Promise<UserProfile> {
    return apiFetch<UserProfile>('/user-api/me');
  },

  /** List all API keys (including revoked ones). */
  listApiKeys(): Promise<ApiKey[]> {
    return apiFetch<ApiKey[]>('/user-api/api-keys');
  },

  /** Create a new API key. Returns the raw key exactly once. */
  createApiKey(label?: string): Promise<NewApiKeyResponse> {
    return apiFetch<NewApiKeyResponse>('/user-api/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: label ?? null }),
    });
  },

  /** Revoke an API key by its database ID. */
  revokeApiKey(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/user-api/api-keys/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  /** Monthly aggregate usage for the last 6 months. */
  getMonthlyUsage(): Promise<MonthlyUsage[]> {
    return apiFetch<MonthlyUsage[]>('/user-api/usage');
  },

  /** Per-day usage for the last N days (7–90, default 30). */
  getDailyUsage(days = 30): Promise<DailyUsage[]> {
    return apiFetch<DailyUsage[]>(`/user-api/usage/daily?days=${days}`);
  },

  /** Clear the session cookie server-side. */
  logout(): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>('/user-api/logout', { method: 'POST', body: '{}' });
  },

  /**
   * Build the Google OAuth URL. Optionally pass a device_code (from the
   * CLI `zencode login` flow) so the backend can approve it after Google
   * auth succeeds.
   */
  googleLoginUrl(deviceCode?: string | null): string {
    const params = new URLSearchParams();
    if (deviceCode) params.set('device_code', deviceCode);
    const qs = params.toString();
    return `/auth/google${qs ? `?${qs}` : ''}`;
  },
};
