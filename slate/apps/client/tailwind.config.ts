import type { Config } from 'tailwindcss';
import preset from '@slate/ui-tokens/tailwind-preset';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  presets: [preset as Config],
  darkMode: 'class',
  theme: {},
  plugins: [],
};

export default config;
