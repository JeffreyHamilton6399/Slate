/**
 * Design tokens for Slate. Exported as plain JS objects so both Tailwind
 * (via the preset) and runtime code can consume the same source of truth.
 */

export const colors = {
  bg: '#0c0c0e',
  bg2: '#111114',
  bg3: '#18181d',
  bg4: '#1e1e26',
  border: '#252530',
  border2: '#2e2e3a',
  accent: '#7c6aff',
  accent2: '#a855f7',
  accentDim: '#3d3580',
  accentGlow: 'rgba(124,106,255,0.15)',
  green: '#22d3a5',
  greenDim: '#0d6b52',
  danger: '#f87171',
  warn: '#fbbf24',
  text: '#e0dff5',
  textDim: '#6b6a80',
  textMid: '#9d9baf',
} as const;

export const fonts = {
  sans: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

export const radii = {
  sm: '6px',
  md: '10px',
  lg: '14px',
} as const;

export const layout = {
  sidebarW: '260px',
  dockW: '220px',
  leftDockW: '220px',
  headerH: '52px',
  toolbarH: '52px',
} as const;

export const z = {
  app: 1,
  panel: 10,
  dialog: 100,
  toast: 200,
  modal: 300,
  onboarding: 1000,
} as const;
