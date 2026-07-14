import type { Config } from 'tailwindcss';

const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-2': 'var(--bg2)',
        'bg-3': 'var(--bg3)',
        'bg-4': 'var(--bg4)',
        border: 'var(--border)',
        'border-2': 'var(--border2)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent2)',
        'accent-dim': 'var(--accent-dim)',
        'accent-glow': 'var(--accent-glow)',
        green: 'var(--green)',
        'green-dim': 'var(--green-dim)',
        danger: 'var(--danger)',
        warn: 'var(--warn)',
        text: 'var(--text)',
        'text-dim': 'var(--text-dim)',
        'text-mid': 'var(--text-mid)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-up': 'slide-up 0.2s ease-out',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
};

export default preset;
