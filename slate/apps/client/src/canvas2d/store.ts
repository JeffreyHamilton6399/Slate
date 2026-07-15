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
  | 'pencil'
  | 'marker'
  | 'calligraphy'
  | 'airbrush'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'text'
  | 'polygon'
  | 'star'
  | 'heart'
  | 'cloud'
  | 'speech'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'parallelogram'
  | 'trapezoid'
  | 'cross'
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
  /** Polygon vertex / star point count for those tools. */
  polySides: number;
  /** Favorited tool ids, shown pinned at the top of the Tools panel. */
  favorites: ToolId[];
  /** Viewport transform — board → screen. */
  zoom: number;
  panX: number;
  panY: number;
  /** 2D animation playback state. */
  animTime: number;
  animDuration: number;
  animPlaying: boolean;
  /** True while scrubbing/playing — engine repaints every frame. */
  animPreview: boolean;
  /** Animation mode toggle — when true, shows the frame-based animation UI
   *  (Adobe Animate style: frame strip, onion skin, playhead in frames). */
  animMode: boolean;
  /** Frames per second for frame-based animation (default 24, like film). */
  animFps: number;
  /** Current frame (derived from animTime, but stored for display). */
  animFrame: number;
  /** Onion skin: show previous/next frames as ghost overlays. */
  onionSkin: boolean;

  setTool: (t: ToolId) => void;
  setStroke: (c: string) => void;
  setFill: (c: string | null) => void;
  swapColors: () => void;
  resetColors: () => void;
  setStrokeWidth: (n: number) => void;
  setStrokeOpacity: (n: number) => void;
  setFontSize: (n: number) => void;
  setPolySides: (n: number) => void;
  toggleFavorite: (id: ToolId) => void;
  setViewport: (z: number, px: number, py: number) => void;
  pan: (dx: number, dy: number) => void;
  zoomAt: (sx: number, sy: number, factor: number) => void;
  fit: () => void;
  setAnimTime: (t: number) => void;
  setAnimDuration: (d: number) => void;
  setAnimPlaying: (p: boolean) => void;
  setAnimPreview: (p: boolean) => void;
  setAnimMode: (m: boolean) => void;
  setAnimFps: (fps: number) => void;
  setAnimFrame: (f: number) => void;
  setOnionSkin: (o: boolean) => void;
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
      polySides: 5,
      favorites: [],
      zoom: 1,
      panX: 0,
      panY: 0,
      animTime: 0,
      animDuration: 5,
      animPlaying: false,
      animPreview: false,
      animMode: false,
      animFps: 24,
      animFrame: 0,
      onionSkin: false,
      setTool: (tool) => set({ tool }),
      setStroke: (stroke) => set({ stroke }),
      setFill: (fill) => set({ fill }),
      swapColors: () => set((s) => ({ stroke: s.fill ?? DEFAULT_STROKE, fill: s.stroke })),
      resetColors: () => set({ stroke: DEFAULT_STROKE, fill: DEFAULT_FILL }),
      setStrokeWidth: (strokeWidth) => set({ strokeWidth: Math.max(0.5, Math.min(200, strokeWidth)) }),
      setStrokeOpacity: (strokeOpacity) =>
        set({ strokeOpacity: Math.max(0, Math.min(1, strokeOpacity)) }),
      setFontSize: (fontSize) => set({ fontSize: Math.max(8, Math.min(512, fontSize)) }),
      setPolySides: (polySides) => set({ polySides: Math.max(3, Math.min(24, Math.round(polySides))) }),
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.includes(id)
            ? s.favorites.filter((x) => x !== id)
            : [...s.favorites, id],
        })),
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
      setAnimTime: (t) => set((s) => ({ animTime: Math.max(0, t), animPreview: s.animPlaying || t > 0 })),
      setAnimDuration: (d) => set((s) => {
        const duration = Math.max(0.5, Math.min(600, d));
        return { animDuration: duration, animTime: Math.min(s.animTime, duration) };
      }),
      setAnimPlaying: (p) => set((s) => ({ animPlaying: p, animPreview: p || s.animPreview })),
      setAnimPreview: (animPreview) => set({ animPreview }),
      setAnimMode: (animMode) => set({ animMode }),
      setAnimFps: (fps) => set({ animFps: Math.max(1, Math.min(60, Math.round(fps))) }),
      setAnimFrame: (f) => set((s) => {
        const frame = Math.max(0, Math.floor(f));
        const fps = s.animFps;
        return { animFrame: frame, animTime: frame / fps, animPreview: s.animPlaying || frame > 0 };
      }),
      setOnionSkin: (onionSkin) => set({ onionSkin }),
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
        polySides: s.polySides,
        favorites: s.favorites,
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
