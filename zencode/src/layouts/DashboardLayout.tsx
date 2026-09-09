import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';

export const DashboardLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 p-4 lg:p-6 max-w-full overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
