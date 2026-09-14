import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Key,
  Activity,
  Coins,
  Settings,
  LogOut,
  Circle,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const navItems = [
  { to: '/app/dashboard',  icon: LayoutDashboard, label: 'Dashboard', glyph: '▣' },
  { to: '/app/api-keys',   icon: Key,             label: 'API Keys',  glyph: '◇' },
  { to: '/app/usage',      icon: Activity,        label: 'Usage',     glyph: '▤' },
  { to: '/app/credits',    icon: Coins,           label: 'Credits',   glyph: '◎' },
  { to: '/app/settings',   icon: Settings,        label: 'Settings',  glyph: '⚙' },
];

export const Sidebar = ({ open, onClose }: SidebarProps) => {
  const { user, logout } = useAuth();

  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : 'ZC';

  const creditBalance = user?.credit_balance_dt ?? 0;
  const hasCredits = user?.has_credits ?? false;

  const handleLogout = async () => {
    onClose();
    await logout();
  };

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 lg:hidden transition-opacity',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
      />

      <aside
        className={cn(
          'fixed lg:sticky top-0 left-0 h-screen w-64 bg-bg-panel border-r border-border z-50 lg:z-10 flex flex-col transition-transform',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className="h-14 px-4 flex items-center gap-2 border-b border-border">
          <div className="flex items-center gap-0.5">
            {/* Pixel Z logo */}
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
          </div>
          <div>
            <div className="text-sm font-bold tracking-wider">ZENCODE</div>
            <div className="text-[10px] text-fg-subtle uppercase">v7.3.58</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 px-3 py-2.5 text-xs rounded-md transition-all',
                  isActive
                    ? 'bg-brand/10 text-fg border border-brand/40'
                    : 'text-fg-muted hover:text-fg hover:bg-bg-card border border-transparent'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-brand" />
                  )}
                  <span className="text-brand font-bold w-4 text-center">{item.glyph}</span>
                  <span className="font-medium">{item.label}</span>
                  {/* Show credit balance badge next to Credits nav item */}
                  {item.to === '/app/credits' && hasCredits && (
                    <span className="ml-auto text-[9px] font-bold text-brand tabular-nums">
                      {creditBalance.toFixed(1)} DT
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User Account Box */}
        <div className="p-3 border-t border-border space-y-2">
          <div className="bg-bg-subtle border border-border rounded-md p-3">
            <div className="flex items-center gap-2 mb-2">
              <Circle size={8} className="fill-brand text-brand animate-pulseDot" />
              <span className="text-[10px] font-bold uppercase tracking-wider">Account Active</span>
            </div>

            <div className="flex items-center gap-2 mb-2">
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className="w-6 h-6 rounded-sm object-cover shrink-0"
                />
              ) : (
                <div className="w-6 h-6 bg-brand/20 border border-brand/30 rounded-sm flex items-center justify-center text-[9px] font-bold text-brand shrink-0">
                  {initials}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{user?.email ?? '—'}</div>
              </div>
            </div>

            {/* Credit balance */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Zap size={10} className={hasCredits ? 'text-brand' : 'text-fg-muted'} />
                <span className="text-[10px] text-fg-subtle uppercase">
                  {hasCredits ? `${creditBalance.toFixed(1)} DT` : 'Free Tier'}
                </span>
              </div>
              {!hasCredits && (
                <NavLink
                  to="/app/credits"
                  className="text-[9px] font-bold text-brand uppercase tracking-wider hover:underline"
                  onClick={onClose}
                >
                  Buy →
                </NavLink>
              )}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-fg-muted hover:text-brand hover:bg-bg-card rounded-md transition-colors border border-transparent hover:border-border"
          >
            <LogOut size={14} />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
};
