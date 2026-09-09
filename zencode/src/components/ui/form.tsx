import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Tab {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs = ({ tabs, active, onChange, className = '' }: TabsProps) => {
  return (
    <div
      className={cn(
        'flex items-center gap-0 border-b border-border overflow-x-auto',
        className
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors whitespace-nowrap',
              isActive
                ? 'text-fg'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            {tab.label}
            {isActive && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
};

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  className?: string;
  placeholder?: string;
}

export const Select = ({ value, onChange, options, className = '', placeholder }: SelectProps) => {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full h-10 px-3 text-xs bg-bg-subtle border border-border rounded-md text-left flex items-center justify-between hover:bg-bg-card hover:border-border-strong transition-colors"
      >
        <span>{selected?.label || placeholder}</span>
        <span className="text-fg-muted">▼</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-50 w-full mt-1 bg-bg-panel border border-border-strong rounded-md shadow-pixelDark max-h-60 overflow-auto">
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'w-full px-3 py-2 text-xs text-left hover:bg-bg-card transition-colors',
                  value === opt.value && 'bg-brand/10 text-brand'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

interface InputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}

export const Input = ({ value, onChange, placeholder, type = 'text', className = '' }: InputProps) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className={cn(
      'w-full h-10 px-3 text-xs bg-bg-subtle border border-border rounded-md placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors',
      className
    )}
  />
);

interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  className?: string;
}

export const Checkbox = ({ checked, onChange, label, className = '' }: CheckboxProps) => (
  <label
    className={cn(
      'flex items-center gap-2 cursor-pointer select-none text-xs',
      className
    )}
  >
    <div
      onClick={() => onChange(!checked)}
      className={cn(
        'w-4 h-4 border flex items-center justify-center transition-colors',
        checked
          ? 'bg-brand border-brand text-black'
          : 'border-border bg-bg-subtle'
      )}
    >
      {checked && <span className="text-xs font-bold">✓</span>}
    </div>
    <span>{label}</span>
  </label>
);
