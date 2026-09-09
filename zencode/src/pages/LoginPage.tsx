import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Terminal } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';

const ERROR_MESSAGES: Record<string, string> = {
  account_suspended: 'Your account has been suspended. Please contact support.',
  google_not_configured: 'Google login is not configured on this server.',
  token_exchange_failed: 'Google authentication failed. Please try again.',
  profile_fetch_failed: 'Could not retrieve your Google profile. Please try again.',
  db_error: 'A database error occurred. Please try again later.',
  invalid_state: 'Authentication session expired. Please try again.',
  device_code_expired: 'The CLI connection request expired. Run `zencode login` again.',
  access_denied: 'You denied access. Sign in with Google to continue.',
};

// Google "G" SVG icon
const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
  </svg>
);

export const LoginPage = () => {
  const [searchParams] = useSearchParams();
  const [cursorOn, setCursorOn] = useState(true);

  const deviceCode = searchParams.get('code');
  const errorKey = searchParams.get('error');
  const errorMessage = errorKey ? (ERROR_MESSAGES[errorKey] ?? `Authentication error: ${errorKey}`) : null;

  useEffect(() => {
    const i = setInterval(() => setCursorOn((v) => !v), 500);
    return () => clearInterval(i);
  }, []);

  const handleGoogleLogin = () => {
    // Navigate to the backend OAuth initiation endpoint.
    // The backend will redirect back to /auth/google/callback after Google auth,
    // which will then approve the device code if one is present and redirect
    // the browser to /zencode/device-success or /zencode/app/dashboard.
    window.location.href = api.googleLoginUrl(deviceCode);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="grid grid-cols-3 gap-0.5">
              {[1,0.5,1,0.3,1,0.5,1,0.3,1].map((op, i) => (
                <div key={i} className="w-2 h-2 bg-brand" style={{ opacity: op }} />
              ))}
            </div>
            <h1 className="text-xl font-bold tracking-widest">ZENCODE</h1>
          </div>
          <p className="text-xs text-fg-muted uppercase tracking-wider">
            Developer Portal
          </p>
        </div>

        {/* CLI device-flow banner */}
        {deviceCode && (
          <div className="mb-4 px-4 py-3 border border-brand/40 bg-brand/5 rounded-md flex items-start gap-3">
            <Terminal size={14} className="text-brand mt-0.5 shrink-0" />
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-brand mb-0.5">
                CLI Connection Request
              </p>
              <p className="text-[11px] text-fg-muted">
                Sign in with Google below to authorise your terminal session.
                You can close this tab once connected.
              </p>
            </div>
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div className="mb-4 px-4 py-3 border border-red-500/40 bg-red-500/5 rounded-md">
            <p className="text-[11px] text-red-400">{errorMessage}</p>
          </div>
        )}

        <Card className="p-6">
          <div className="text-center mb-6">
            <p className="text-sm font-medium mb-1">
              {deviceCode ? 'Authorise CLI Access' : 'Sign in to Zencode'}
            </p>
            <p className="text-[11px] text-fg-muted">
              {deviceCode
                ? 'One click to connect your terminal to your account.'
                : 'Use your Google account to access your developer dashboard.'}
            </p>
          </div>

          <button
            onClick={handleGoogleLogin}
            className="w-full inline-flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 text-sm font-semibold rounded-md hover:bg-gray-50 active:scale-[0.98] transition-all shadow-sm border border-gray-200 btn-press"
          >
            <GoogleIcon />
            <span>Continue with Google</span>
            <ArrowRight size={14} className="ml-auto text-gray-500" />
          </button>

          <p className="mt-5 text-center text-[10px] text-fg-subtle leading-relaxed">
            Signing in with Google creates your Zencode account automatically.
            No separate password required.
          </p>
        </Card>

        {/* Version cursor */}
        <div className="text-center mt-6 text-[10px] text-fg-subtle uppercase tracking-wider font-mono">
          <span className={cursorOn ? 'opacity-100' : 'opacity-0'}>▊</span>
          <span className="ml-2">v7.3.58 · ready</span>
        </div>
      </div>
    </div>
  );
};
