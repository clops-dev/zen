import { Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { DashboardPage } from '@/pages/DashboardPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { UsagePage } from '@/pages/UsagePage';
import { CliPage } from '@/pages/CliPage';
import { DocsPage } from '@/pages/DocsPage';
import { CreditsPage } from '@/pages/CreditsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LoginPage } from '@/pages/LoginPage';
import { LandingPage } from '@/pages/LandingPage';
import { DeviceSuccessPage } from '@/pages/DeviceSuccessPage';
import { useAuth } from '@/hooks/useAuth';

export const App = () => {
  const { user, loading } = useAuth();
  const isAuthenticated = !!user;

  // While we're checking the session, show a minimal full-screen loader
  // rather than flickering to /login and back.
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="grid grid-cols-3 gap-0.5 animate-pulse">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className={`w-2 h-2 ${i % 2 === 0 ? 'bg-brand' : 'bg-brand/30'}`} />
            ))}
          </div>
          <p className="text-[10px] text-fg-subtle uppercase tracking-widest font-mono">Connecting...</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      {/* Public landing page */}
      <Route path="/" element={<LandingPage />} />

      {/* Auth pages — redirect to /app/dashboard if already logged in */}
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/app/dashboard" replace /> : <LoginPage />}
      />

      {/* Device flow success confirmation */}
      <Route path="/device-success" element={<DeviceSuccessPage />} />

      {/* Protected dashboard routes — require authenticated session */}
      <Route
        path="/app"
        element={isAuthenticated ? <DashboardLayout /> : <Navigate to="/login" replace />}
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="cli" element={<CliPage />} />
        <Route path="docs/*" element={<DocsPage />} />
        {/* Credits replaces the old billing page */}
        <Route path="credits" element={<CreditsPage />} />
        {/* Keep /billing working as a redirect for any old bookmarks */}
        <Route path="billing" element={<Navigate to="/app/credits" replace />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      {/* Catch-all redirects to landing */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};
