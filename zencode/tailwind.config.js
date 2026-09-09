/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace'],
        display: ['"JetBrains Mono"', '"Courier New"', 'monospace'],
      },
      colors: {
        bg: {
          DEFAULT: '#0a0a0a',
          panel: '#111111',
          card: '#141414',
          subtle: '#1a1a1a',
          hover: '#1f1f1f',
        },
        border: {
          DEFAULT: '#262626',
          subtle: '#1f1f1f',
          strong: '#333333',
        },
        fg: {
          DEFAULT: '#ffffff',
          muted: '#a3a3a3',
          subtle: '#737373',
          dim: '#525252',
        },
        brand: {
          DEFAULT: '#ef4444',
          hover: '#dc2626',
          dim: '#7f1d1d',
          glow: 'rgba(239, 68, 68, 0.35)',
        },
      },
      boxShadow: {
        pixel: '4px 4px 0 0 rgba(239, 68, 68, 0.25)',
        pixelDark: '4px 4px 0 0 #000000',
        glow: '0 0 16px rgba(239, 68, 68, 0.4)',
      },
      animation: {
        blink: 'blink 1s steps(2) infinite',
        scan: 'scan 6s linear infinite',
        pulseDot: 'pulseDot 2s ease-in-out infinite',
        marquee: 'marquee 30s linear infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        pulseDot: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(239, 68, 68, 0.6)' },
          '50%': { boxShadow: '0 0 0 6px rgba(239, 68, 68, 0)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
    },
  },
  plugins: [],
};
