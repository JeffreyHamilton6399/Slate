/**
 * Dock layout state. Persisted to localStorage so the same browser remembers
 * the user's preferred panel sides + sizes.
 *
 * Floating panels store their geometry too; mobile collapses both docks
 * into a single bottom drawer.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type DockSide = 'left' | 'right';

export interface FloatGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DockState {
  /** Map panelId → side it is docked to (or 'floating'). */
  panelSide: Record<string, DockSide | 'floating'>;
  /** Active tab per side. */
  activeTab: Record<DockSide, string | null>;
  /** Tab order within each side. */
  tabOrder: Record<DockSide, string[]>;
  /** Geometry for floating panels. */
  floats: Record<string, FloatGeometry>;
  /** Dock widths (px). */
  sidebarWidth: number;
  dockWidth: number;
  /** Mobile drawer (single bottom sheet) collapsed state. */
  mobileDrawerOpen: boolean;
  mobileDrawerTab: string | null;

  setPanelSide: (id: string, side: DockSide | 'floating') => void;
  setActiveTab: (side: DockSide, id: string | null) => void;
  reorderTab: (side: DockSide, ids: string[]) => void;
  ensureTab: (side: DockSide, id: string) => void;
  removeTab: (side: DockSide, id: string) => void;
  setFloatGeometry: (id: string, g: FloatGeometry) => void;
  setSidebarWidth: (w: number) => void;
  setDockWidth: (w: number) => void;
  setMobileDrawer: (open: boolean, tab?: string | null) => void;
}

const initialState = {
  panelSide: {} as Record<string, DockSide | 'floating'>,
  activeTab: { left: null, right: null } as Record<DockSide, string | null>,
  tabOrder: { left: [], right: [] } as Record<DockSide, string[]>,
  floats: {} as Record<string, FloatGeometry>,
  sidebarWidth: 260,
  dockWidth: 280,
  mobileDrawerOpen: false,
  mobileDrawerTab: null as string | null,
};

export const useDockStore = create<DockState>()(
  persist(
    (set) => ({
      ...initialState,
      setPanelSide: (id, side) =>
        set((s) => ({ panelSide: { ...s.panelSide, [id]: side } })),
      setActiveTab: (side, id) =>
        set((s) => ({ activeTab: { ...s.activeTab, [side]: id } })),
      reorderTab: (side, ids) =>
        set((s) => ({ tabOrder: { ...s.tabOrder, [side]: ids } })),
      ensureTab: (side, id) =>
        set((s) => {
          const order = s.tabOrder[side];
          if (order.includes(id)) return s;
          return {
            tabOrder: { ...s.tabOrder, [side]: [...order, id] },
            activeTab: { ...s.activeTab, [side]: s.activeTab[side] ?? id },
          };
        }),
      removeTab: (side, id) =>
        set((s) => {
          const order = s.tabOrder[side].filter((x) => x !== id);
          let active = s.activeTab[side];
          if (active === id) active = order[0] ?? null;
          return {
            tabOrder: { ...s.tabOrder, [side]: order },
            activeTab: { ...s.activeTab, [side]: active },
          };
        }),
      setFloatGeometry: (id, g) =>
        set((s) => ({ floats: { ...s.floats, [id]: g } })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(200, Math.min(420, w)) }),
      setDockWidth: (w) => set({ dockWidth: Math.max(220, Math.min(520, w)) }),
      setMobileDrawer: (open, tab) =>
        set((s) => ({
          mobileDrawerOpen: open,
          mobileDrawerTab: tab ?? s.mobileDrawerTab,
        })),
    }),
    {
      name: 'slate.dock.v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);
