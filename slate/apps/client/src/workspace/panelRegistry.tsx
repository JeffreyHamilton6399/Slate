/**
 * Panel registry: panels register their renderer once and the dock looks
 * them up by id. This keeps the dock dumb about the actual content and
 * lets us code-split heavy panels (e.g. 3D properties).
 */

import { Suspense, type ComponentType, type ReactNode } from 'react';
import { create } from 'zustand';
import type { DocMode } from '@slate/sync-protocol';
import { RecoverBoundary } from '../app/RecoverBoundary';
import type { DockZone } from './dockStore';

export type { DockSide, DockZone } from './dockStore';
export type AppMode = DocMode | 'both';

export interface PanelDef {
  id: string;
  title: string;
  /** Zone the panel lands in on first open ('left'/'right' are the top zones). */
  defaultSide: DockZone;
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

/** Should this panel be offered in a board of the given mode? */
export function panelMatchesMode(def: PanelDef | undefined, mode: DocMode): boolean {
  if (!def) return false;
  return !def.mode || def.mode === 'both' || def.mode === mode;
}

export function RenderPanel({ id }: { id: string }): ReactNode {
  const def = usePanelRegistry((s) => s.panels[id]);
  if (!def) return null;
  const C = def.render;
  // A throw inside one panel renders an inline recovery card instead of
  // unmounting the whole app via the root ErrorBoundary. Suspense lets a panel
  // be registered as a React.lazy component so its module (and everything it
  // imports) only downloads when its tab is first opened.
  return (
    <RecoverBoundary label={`“${def.title}”`}>
      <Suspense
        fallback={
          <div className="p-3 text-xs text-text-dim" role="status">
            Loading {def.title}…
          </div>
        }
      >
        <C />
      </Suspense>
    </RecoverBoundary>
  );
}
