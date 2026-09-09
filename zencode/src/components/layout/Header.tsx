import { Menu, Bell, Search } from 'lucide-react';

interface HeaderProps {
  onMenuClick: () => void;
  title?: string;
  subtitle?: string;
}

export const Header = ({ onMenuClick, title, subtitle }: HeaderProps) => {
  return (
    <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-sm border-b border-border">
      <div className="h-14 px-4 lg:px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="lg:hidden p-2 -ml-2 text-fg-muted hover:text-fg"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="lg:hidden flex items-center gap-2">
            <div className="grid grid-cols-3 gap-0.5">
              <div className="w-1.5 h-1.5 bg-brand" />
              <div className="w-1.5 h-1.5 bg-brand/50" />
              <div className="w-1.5 h-1.5 bg-brand" />
            </div>
            <span className="text-xs font-bold tracking-wider">ZENCODE</span>
          </div>
          {title && (
            <div className="hidden lg:block">
              <h1 className="text-sm font-bold tracking-wide">{title}</h1>
              {subtitle && (
                <div className="text-[10px] text-fg-subtle uppercase">{subtitle}</div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 h-9 px-3 bg-bg-subtle border border-border rounded-md text-xs text-fg-subtle">
            <Search size={13} />
            <span>Search...</span>
            <kbd className="px-1.5 py-0.5 ml-4 bg-bg border border-border rounded text-[10px]">
              ⌘K
            </kbd>
          </div>
          <button className="relative p-2 text-fg-muted hover:text-fg transition-colors">
            <Bell size={16} />
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-brand rounded-full" />
          </button>
          <div className="hidden sm:flex items-center gap-2 pl-3 ml-1 border-l border-border">
            <div className="w-7 h-7 bg-brand/20 border border-brand/30 rounded-sm flex items-center justify-center text-[10px] font-bold text-brand">
              DE
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
