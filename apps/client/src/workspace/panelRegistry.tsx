/**
 * Panel registry: panels register their renderer once and the dock looks
 * them up by id. This keeps the dock dumb about the actual content and
 * lets us code-split heavy panels (e.g. 3D properties).
 */

import type { ComponentType, ReactNode } from 'react';
import { create } from 'zustand';

export type DockSide = 'left' | 'right';
export type AppMode = '2d' | '3d' | 'both';

export interface PanelDef {
  id: string;
  title: string;
  defaultSide: DockSide;
  render: ComponentType;
  icon?: ComponentType<{ size?: number }>;
  mode?: AppMode;
  order?: number;
}

interface PanelRegistryStore {
  panels: Record<string, PanelDef>;
  register: (def: PanelDef) => void;
  unregister: (id: string) => void;
}

export const usePanelRegistry = create<PanelRegistryStore>((set) => ({
  panels: {},
  register: (def) =>
    set((s) => ({ panels: { ...s.panels, [def.id]: def } })),
  unregister: (id) =>
    set((s) => {
      const next = { ...s.panels };
      delete next[id];
      return { panels: next };
    }),
}));

export function registerPanel(def: PanelDef): void {
  usePanelRegistry.getState().register(def);
}

export function getPanel(id: string): PanelDef | undefined {
  return usePanelRegistry.getState().panels[id];
}

export function RenderPanel({ id }: { id: string }): ReactNode {
  const def = usePanelRegistry((s) => s.panels[id]);
  if (!def) return null;
  const C = def.render;
  return <C />;
}
