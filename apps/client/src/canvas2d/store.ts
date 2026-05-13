/**
 * 2D canvas local UI state — tool, color, brush size, viewport transform,
 * active layer. Persisted partially so the user's tool prefs survive reload.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ToolId =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'text'
  | 'eyedropper'
  | 'fill'
  | 'pan';

interface CanvasState {
  tool: ToolId;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  fontSize: number;
  /** Viewport transform — board → screen. */
  zoom: number;
  panX: number;
  panY: number;

  setTool: (t: ToolId) => void;
  setStroke: (c: string) => void;
  setFill: (c: string | null) => void;
  swapColors: () => void;
  resetColors: () => void;
  setStrokeWidth: (n: number) => void;
  setStrokeOpacity: (n: number) => void;
  setFontSize: (n: number) => void;
  setViewport: (z: number, px: number, py: number) => void;
  pan: (dx: number, dy: number) => void;
  zoomAt: (sx: number, sy: number, factor: number) => void;
  fit: () => void;
}

const DEFAULT_STROKE = '#e0dff5';
const DEFAULT_FILL = null;

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      tool: 'pen',
      stroke: DEFAULT_STROKE,
      fill: DEFAULT_FILL,
      strokeWidth: 4,
      strokeOpacity: 1,
      fontSize: 24,
      zoom: 1,
      panX: 0,
      panY: 0,
      setTool: (tool) => set({ tool }),
      setStroke: (stroke) => set({ stroke }),
      setFill: (fill) => set({ fill }),
      swapColors: () => set((s) => ({ stroke: s.fill ?? DEFAULT_STROKE, fill: s.stroke })),
      resetColors: () => set({ stroke: DEFAULT_STROKE, fill: DEFAULT_FILL }),
      setStrokeWidth: (strokeWidth) => set({ strokeWidth: Math.max(0.5, Math.min(200, strokeWidth)) }),
      setStrokeOpacity: (strokeOpacity) =>
        set({ strokeOpacity: Math.max(0, Math.min(1, strokeOpacity)) }),
      setFontSize: (fontSize) => set({ fontSize: Math.max(8, Math.min(512, fontSize)) }),
      setViewport: (zoom, panX, panY) => set({ zoom, panX, panY }),
      pan: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),
      zoomAt: (sx, sy, factor) => {
        const { zoom, panX, panY } = get();
        const nextZoom = Math.max(0.05, Math.min(32, zoom * factor));
        const k = nextZoom / zoom;
        // Keep (sx, sy) fixed in board space.
        const nextPanX = sx - (sx - panX) * k;
        const nextPanY = sy - (sy - panY) * k;
        set({ zoom: nextZoom, panX: nextPanX, panY: nextPanY });
      },
      fit: () => set({ zoom: 1, panX: 0, panY: 0 }),
    }),
    {
      name: 'slate.canvas.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tool: s.tool,
        stroke: s.stroke,
        fill: s.fill,
        strokeWidth: s.strokeWidth,
        strokeOpacity: s.strokeOpacity,
        fontSize: s.fontSize,
      }),
    },
  ),
);

interface LayersUIState {
  activeLayerId: string | null;
  setActiveLayer: (id: string | null) => void;
}

export const useLayersStore = create<LayersUIState>((set) => ({
  activeLayerId: null,
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
}));
