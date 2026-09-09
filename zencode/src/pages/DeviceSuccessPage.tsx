import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Terminal } from 'lucide-react';

/**
 * Shown after a successful `zencode login` device-flow.
 * The backend redirects here once the device_code is approved.
 * The user can safely close this tab — the CLI has already received its API key.
 */
export const DeviceSuccessPage = () => {
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    const i = setInterval(() => setCursorOn((v) => !v), 500);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="w-full max-w-sm text-center">

        {/* Logo */}
        <div className="inline-flex items-center gap-2 mb-8">
          <div className="grid grid-cols-3 gap-0.5">
            {[1, 0.5, 1, 0.3, 1, 0.5, 1, 0.3, 1].map((op, i) => (
              <div key={i} className="w-2 h-2 bg-brand" style={{ opacity: op }} />
            ))}
          </div>
          <span className="text-xl font-bold tracking-widest">ZENCODE</span>
        </div>

        {/* Success icon */}
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-brand/10 border border-brand/30 flex items-center justify-center">
            <CheckCircle2 size={32} className="text-brand" />
          </div>
        </div>

        <h1 className="text-2xl font-bold mb-2">CLI Connected</h1>
        <p className="text-sm text-fg-muted mb-6">
          Your terminal is now authenticated. You can close this tab and return to your terminal.
        </p>

        {/* Terminal hint */}
        <div className="bg-bg-card border border-border rounded-md px-4 py-3 mb-8 text-left">
          <div className="flex items-center gap-2 mb-2">
            <Terminal size={12} className="text-brand" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Terminal</span>
          </div>
          <p className="font-mono text-xs text-brand">
            <span className="text-fg-muted">$</span> zencode &quot;Hello, world!&quot;
          </p>
          <p className="font-mono text-xs text-fg-subtle mt-1">
            ✓ Logged in · API key saved
          </p>
        </div>

        <Link
          to="/app/dashboard"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover transition-colors btn-press"
        >
          Go to Dashboard
        </Link>

        <div className="mt-8 text-[10px] text-fg-subtle uppercase tracking-wider font-mono">
          <span className={cursorOn ? 'opacity-100' : 'opacity-0'}>▊</span>
          <span className="ml-2">session active</span>
        </div>
      </div>
    </div>
  );
};
