import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type UserProfile } from '@/lib/api';

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  /** Call after Google login completes to refresh user data without a full page reload. */
  refresh: () => Promise<void>;
  /** Logs the user out server-side and redirects to /login. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchMe = useCallback(async () => {
    try {
      const profile = await api.me();
      setUser(profile);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        // No valid session — will be redirected by the route guard in App.tsx.
        setUser(null);
      } else {
        // Network / server error — keep whatever we had (avoids flicker on
        // transient errors) but log for debugging.
        console.error('[useAuth] failed to fetch /user-api/me:', err);
      }
    }
  }, []);

  useEffect(() => {
    fetchMe().finally(() => setLoading(false));
  }, [fetchMe]);

  const refresh = useCallback(async () => {
    await fetchMe();
  }, [fetchMe]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Best-effort — proceed to login page regardless.
    }
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
