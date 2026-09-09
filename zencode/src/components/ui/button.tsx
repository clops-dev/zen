import { forwardRef, Ref } from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps {
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  asChild?: boolean;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'default',
      size = 'default',
      asChild = false,
      className = '',
      disabled = false,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? 'span' : 'button';
    
    const base = 'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg*:pointer-events-none]';
    
    const variantMap: Record<string, string> = {
      default: 'bg-bg/50 border border-border hover:bg-bg/70',
      destructive: 'bg-red-600/20 border-red-600/30 text-red-400 hover:bg-red-600/30 hover:border-red-600/40',
      outline: 'bg-transparent border border-border hover:bg-bg/50',
      secondary: 'bg-bg/30 border border-border hover:bg-bg/40',
      ghost: 'bg-transparent hover:bg-bg/50',
      link: 'bg-transparent underline-offset-4 hover:underline text-fg/70',
    };
    
    const sizeMap: Record<string, string> = {
      default: 'h-10 px-4 py-2',
      sm: 'h-9 px-3 rounded-md',
      lg: 'h-11 px-6 rounded-md',
      icon: 'h-10 w-10',
    };
    
    return (
      <Comp
        className={cn(
          base,
          variantMap[variant],
          sizeMap[size],
          className,
          disabled && 'opacity-50 cursor-not-allowed',
          !disabled && 'hover:scale-[1.02] active:scale-[0.98] transition-transform',
          'btn-press'
        )}
        ref={ref}
        type={type}
        disabled={disabled}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';

export { Button };