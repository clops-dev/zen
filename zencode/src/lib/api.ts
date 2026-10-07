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
  status: 'active';
  active_key_count: number;
  total_key_count: number;
  total_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  has_purchased_credits?: boolean;
  balance_visible?: boolean;
  total_credits_purchased?: number;
  total_credits_purchased_dt?: number;
  total_usage_cost?: number;
  remaining_credits?: number;
  remaining_credits_dt?: number;
  credit_balance_dt?: number;
  credit_balance_usd_value?: number;
  has_credits?: boolean;
  trial_status?: string;
  trial_cta?: string;
}

export interface MonthlyUsage {
  month: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd?: number;
  request_count: number;
}

export interface TrialStatus {
  trial_status: string;
  trial_cta: string;
}

export type CreditBalance = { balance_dt: number; balance_usd_value: number; updated_at: string } | TrialStatus;
export type CreditTransactionResponse = CreditTransaction[] | (TrialStatus & { transactions: CreditTransaction[] });

export interface DailyUsage {
  day: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

export interface CreditTransaction {
  id: string;
  amount_dt: number;
  type: 'purchase' | 'admin_grant' | 'usage' | 'refund' | 'adjustment';
  status: 'pending' | 'completed' | 'failed' | 'reversed';
  admin_note: string | null;
  payment_ref: string | null;
  created_at: string;
}

export interface PurchaseIntentResponse {
  transaction_id: string;
  amount_dt: number;
  usd_value: number;
  status: 'pending';
  payment_ref: string | null;
  message: string;
}

export interface PaymentReceipt {
  transaction_id: string;
  date: string;
  amount_paid_dt: number;
  credits_added_usd?: number;
  previous_balance_usd?: number;
  new_balance_usd?: number;
  status?: string;
}

export interface PurchaseResponse {
  ok: boolean;
  receipt: PaymentReceipt;
  billing: UserProfile;
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
  /** Fetch the current user's profile + credit balance & single source of truth billing metrics. */
  me(): Promise<UserProfile> {
    return apiFetch<UserProfile>('/user-api/me');
  },

  /** Monthly aggregate usage for the last 6 months. */
  getMonthlyUsage(): Promise<MonthlyUsage[]> {
    return apiFetch<MonthlyUsage[]>('/user-api/usage');
  },

  /** Per-day usage for the last N days (7–90, default 30). */
  getDailyUsage(days = 30): Promise<DailyUsage[]> {
    return apiFetch<DailyUsage[]>(`/user-api/usage/daily?days=${days}`);
  },

  /** Current credit balance from the server. */
  getCredits(): Promise<CreditBalance> {
    return apiFetch<CreditBalance>('/user-api/credits');
  },

  /** Last N credit transactions (default 50). */
  async getCreditHistory(limit = 50): Promise<CreditTransaction[]> {
    const response = await apiFetch<CreditTransactionResponse>(`/user-api/credits/history?limit=${limit}`);
    return Array.isArray(response) ? response : response.transactions;
  },

  /**
   * Purchase a credit package.
   * Returns confirmation receipt and updated user billing state.
   */
  purchaseCredits(amount_dt: number): Promise<PurchaseResponse> {
    return apiFetch<PurchaseResponse>('/user-api/credits/purchase', {
      method: 'POST',
      body: JSON.stringify({ amount_dt }),
    });
  },

  /** Create a pending purchase intent. */
  purchaseCreditIntent(amount_dt: number): Promise<PurchaseIntentResponse> {
    return apiFetch<PurchaseIntentResponse>('/user-api/credits/purchase-intent', {
      method: 'POST',
      body: JSON.stringify({ amount_dt }),
    });
  },

  /** Clear the session cookie server-side. */
  logout(): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>('/user-api/logout', { method: 'POST', body: '{}' });
  },

  /** Build Google OAuth URL. */
  googleLoginUrl(deviceCode?: string | null): string {
    const params = new URLSearchParams();
    if (deviceCode) params.set('device_code', deviceCode);
    const qs = params.toString();
    return `/auth/google${qs ? `?${qs}` : ''}`;
  },
};
