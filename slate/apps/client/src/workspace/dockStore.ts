/**
 * Dock layout state. Persisted to localStorage so the same browser remembers
 * the user's preferred panel sides + sizes.
 *
 * Unity-style model: each side dock is split into a top and bottom zone,
 * every zone has its own tab strip, and panels can also float as windows or
 * be closed. Tabs drag between zones/docks, out to float, and back. The
 * split lets high-traffic panels (Boards, Properties) stay visible while
 * lower-priority ones (Hierarchy, Chat, Notes) live in the bottom half.
 *
 * 'left'/'right' name the TOP zones so layouts persisted before the split
 * keep working unchanged.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type DockSide = 'left' | 'right';
export type DockZone = 'left' | 'right' | 'left-bottom' | 'right-bottom';

export const DOCK_ZONES: DockZone[] = ['left', 'right', 'left-bottom', 'right-bottom'];

export function zoneSide(zone: DockZone): DockSide {
  return zone.startsWith('left') ? 'left' : 'right';
}

export function bottomZone(side: DockSide): DockZone {
  return side === 'left' ? 'left-bottom' : 'right-bottom';
}

export interface FloatGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_FLOAT: FloatGeometry = { x: 120, y: 96, w: 320, h: 400 };

interface DockState {
  /** Map panelId → zone it is docked to (or 'floating'). */
  panelSide: Record<string, DockZone | 'floating'>;
  /** Active tab per zone. */
  activeTab: Record<DockZone, string | null>;
  /** Tab order within each zone. */
  tabOrder: Record<DockZone, string[]>;
  /** Fraction of dock height given to the top zone (when both populated). */
  splitRatio: Record<DockSide, number>;
  /** Geometry for floating panels. */
  floats: Record<string, FloatGeometry>;
  /** Floating window stacking order; last entry renders on top. */
  floatStack: string[];
  /** Panels the user explicitly closed (not re-added on reload). */
  closed: string[];
  /** Dock widths (px). */
  sidebarWidth: number;
  dockWidth: number;
  /** Mobile drawer (single bottom sheet) collapsed state. */
  mobileDrawerOpen: boolean;
  mobileDrawerTab: string | null;
  /** Transient: zone highlighted as a drop target during a drag. */
  dropHint: DockZone | null;
  /** Transient: a tab/window drag is in progress (reveals empty drop zones). */
  dragging: boolean;

  setActiveTab: (zone: DockZone, id: string | null) => void;
  reorderTab: (zone: DockZone, ids: string[]) => void;
  ensureTab: (zone: DockZone, id: string) => void;
  /** Dock a panel into a zone's strip (from anywhere) at an optional index. */
  dockPanel: (id: string, zone: DockZone, index?: number) => void;
  /** Detach a panel into a floating window. */
  floatPanel: (id: string, geometry?: Partial<FloatGeometry>) => void;
  /** Close a panel entirely (reopen via the + menu). */
  closePanel: (id: string) => void;
  /** Reopen a closed panel into a zone. */
  openPanel: (id: string, zone: DockZone) => void;
  raiseFloat: (id: string) => void;
  setFloatGeometry: (id: string, g: FloatGeometry) => void;
  setDropHint: (zone: DockZone | null) => void;
  setDragging: (v: boolean) => void;
  setSplitRatio: (side: DockSide, ratio: number) => void;
  setSidebarWidth: (w: number) => void;
  setDockWidth: (w: number) => void;
  setMobileDrawer: (open: boolean, tab?: string | null) => void;
}

const emptyZones = <T,>(v: T): Record<DockZone, T> => ({
  left: v,
  right: v,
  'left-bottom': v,
  'right-bottom': v,
});

const initialState = {
  panelSide: {} as Record<string, DockZone | 'floating'>,
  activeTab: emptyZones<string | null>(null),
  tabOrder: {
    left: [] as string[],
    right: [] as string[],
    'left-bottom': [] as string[],
    'right-bottom': [] as string[],
  },
  splitRatio: { left: 0.55, right: 0.6 } as Record<DockSide, number>,
  floats: {} as Record<string, FloatGeometry>,
  floatStack: [] as string[],
  closed: [] as string[],
  sidebarWidth: 260,
  dockWidth: 280,
  mobileDrawerOpen: false,
  mobileDrawerTab: null as string | null,
  dropHint: null as DockZone | null,
  dragging: false,
};

function withoutTab(
  s: Pick<DockState, 'tabOrder' | 'activeTab'>,
  id: string,
): Pick<DockState, 'tabOrder' | 'activeTab'> {
  const tabOrder = { ...s.tabOrder };
  const activeTab = { ...s.activeTab };
  for (const zone of DOCK_ZONES) {
    tabOrder[zone] = tabOrder[zone].filter((x) => x !== id);
    if (activeTab[zone] === id) activeTab[zone] = tabOrder[zone][0] ?? null;
  }
  return { tabOrder, activeTab };
}

export const useDockStore = create<DockState>()(
  persist(
    (set) => ({
      ...initialState,
      setActiveTab: (zone, id) =>
        set((s) => ({ activeTab: { ...s.activeTab, [zone]: id } })),
      reorderTab: (zone, ids) =>
        set((s) => ({ tabOrder: { ...s.tabOrder, [zone]: ids } })),
      ensureTab: (zone, id) =>
        set((s) => {
          // Don't resurrect closed panels or duplicate floating/docked ones.
          if (s.closed.includes(id)) return s;
          if (s.panelSide[id] === 'floating') return s;
          if (DOCK_ZONES.some((z) => s.tabOrder[z].includes(id))) return s;
          const order = s.tabOrder[zone];
          return {
            panelSide: { ...s.panelSide, [id]: zone },
            tabOrder: { ...s.tabOrder, [zone]: [...order, id] },
            activeTab: { ...s.activeTab, [zone]: s.activeTab[zone] ?? id },
          };
        }),
      dockPanel: (id, zone, index) =>
        set((s) => {
          const base = withoutTab(s, id);
          const order = [...base.tabOrder[zone]];
          const at = index === undefined ? order.length : Math.max(0, Math.min(index, order.length));
          order.splice(at, 0, id);
          return {
            panelSide: { ...s.panelSide, [id]: zone },
            tabOrder: { ...base.tabOrder, [zone]: order },
            activeTab: { ...base.activeTab, [zone]: id },
            floats: { ...s.floats },
            floatStack: s.floatStack.filter((x) => x !== id),
            closed: s.closed.filter((x) => x !== id),
          };
        }),
      floatPanel: (id, geometry) =>
        set((s) => {
          const base = withoutTab(s, id);
          const prev = s.floats[id] ?? DEFAULT_FLOAT;
          const g: FloatGeometry = {
            x: geometry?.x ?? prev.x,
            y: geometry?.y ?? prev.y,
            w: geometry?.w ?? prev.w,
            h: geometry?.h ?? prev.h,
          };
          return {
            ...base,
            panelSide: { ...s.panelSide, [id]: 'floating' },
            floats: { ...s.floats, [id]: g },
            floatStack: [...s.floatStack.filter((x) => x !== id), id],
            closed: s.closed.filter((x) => x !== id),
          };
        }),
      closePanel: (id) =>
        set((s) => {
          const base = withoutTab(s, id);
          const panelSide = { ...s.panelSide };
          delete panelSide[id];
          return {
            ...base,
            panelSide,
            floatStack: s.floatStack.filter((x) => x !== id),
            closed: s.closed.includes(id) ? s.closed : [...s.closed, id],
          };
        }),
      openPanel: (id, zone) =>
        set((s) => {
          const base = withoutTab(s, id);
          const order = [...base.tabOrder[zone], id];
          return {
            panelSide: { ...s.panelSide, [id]: zone },
            tabOrder: { ...base.tabOrder, [zone]: order },
            activeTab: { ...base.activeTab, [zone]: id },
            floatStack: s.floatStack.filter((x) => x !== id),
            closed: s.closed.filter((x) => x !== id),
          };
        }),
      raiseFloat: (id) =>
        set((s) =>
          s.floatStack[s.floatStack.length - 1] === id
            ? s
            : { floatStack: [...s.floatStack.filter((x) => x !== id), id] },
        ),
      setFloatGeometry: (id, g) =>
        set((s) => ({ floats: { ...s.floats, [id]: g } })),
      setDropHint: (dropHint) => set({ dropHint }),
      setDragging: (dragging) => set({ dragging }),
      setSplitRatio: (side, ratio) =>
        set((s) => ({
          splitRatio: { ...s.splitRatio, [side]: Math.max(0.2, Math.min(0.85, ratio)) },
        })),
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
      version: 6,
      migrate: (persisted, version) => {
        const p = persisted as Partial<DockState>;
        const state: DockState = {
          ...initialState,
          ...p,
          tabOrder: { ...initialState.tabOrder, ...(p.tabOrder ?? {}) },
          activeTab: { ...initialState.activeTab, ...(p.activeTab ?? {}) },
          splitRatio: { ...initialState.splitRatio, ...(p.splitRatio ?? {}) },
          dropHint: null,
          dragging: false,
        } as DockState;
        const relocate = (id: string, zone: DockZone) => {
          const cur = state.panelSide[id];
          if (cur === 'floating' || cur === undefined || cur === zone) return; // floating/closed stay put
          state.tabOrder[cur] = state.tabOrder[cur].filter((x) => x !== id);
          if (state.activeTab[cur] === id) state.activeTab[cur] = state.tabOrder[cur][0] ?? null;
          state.tabOrder[zone] = [...state.tabOrder[zone], id];
          state.activeTab[zone] = state.activeTab[zone] ?? id;
          state.panelSide[id] = zone;
        };
        if (version < 3) {
          // One-time importance re-layout: secondary panels move down.
          relocate('hierarchy', 'left-bottom');
          relocate('chat', 'right-bottom');
          relocate('notes', 'right-bottom');
        }
        if (version < 4) {
          // Scene tree beats the board list for the prime top-left slot.
          relocate('hierarchy', 'left');
          relocate('boards', 'left-bottom');
        }
        if (version < 5) {
          // Boards joins Chat/Notes bottom-right; Assets and Layers take
          // the bottom-left under the hierarchy.
          relocate('boards', 'right-bottom');
          relocate('assets', 'left-bottom');
          relocate('layers', 'left-bottom');
        }
        if (version < 6) {
          // AI assistant split into per-mode panels (ai-code/ai-2d/…) that dock
          // themselves; drop the old shared 'ai-chat' tab. Code's Files/Preview
          // move to the right so the assistant can take the left.
          for (const z of DOCK_ZONES) {
            state.tabOrder[z] = state.tabOrder[z].filter((x) => x !== 'ai-chat');
            if (state.activeTab[z] === 'ai-chat') state.activeTab[z] = state.tabOrder[z][0] ?? null;
          }
          delete state.panelSide['ai-chat'];
          relocate('code-files', 'right');
          relocate('code-preview', 'right-bottom');
        }
        return state;
      },
      partialize: (s) =>
        ({
          panelSide: s.panelSide,
          activeTab: s.activeTab,
          tabOrder: s.tabOrder,
          splitRatio: s.splitRatio,
          floats: s.floats,
          floatStack: s.floatStack,
          closed: s.closed,
          sidebarWidth: s.sidebarWidth,
          dockWidth: s.dockWidth,
        }) as DockState,
    },
  ),
);
