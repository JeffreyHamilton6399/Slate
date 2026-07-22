/**
 * Diagram / whiteboard local UI state — active tool, node style defaults, and
 * the viewport transform (board → screen). Node/edge DATA lives in Yjs; this
 * store only holds this device's ephemeral editing state. Style + tool prefs
 * are persisted so they survive a reload.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DiagramNodeShape, DiagramEdgeRouting } from '@slate/sync-protocol';

/** 'select' moves/edits; the shape tools drop a node on click; 'connect' drags
 *  a connector between two nodes; 'pan' grabs the canvas. */
export type DiagramTool =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'note'
  | 'pill'
  | 'parallelogram'
  | 'hexagon'
  | 'cylinder'
  | 'triangle'
  | 'connect'
  | 'pan';

/** Board-unit grid that nodes snap to when snapping is on. */
export const DIAGRAM_GRID = 8;

/** A swatch pair (fill + matching border/text) for the node palette. */
export interface DiagramSwatch {
  fill: string;
  stroke: string;
}

/** Curated node palette — soft fills with a legible border/text color. */
export const DIAGRAM_SWATCHES: DiagramSwatch[] = [
  { fill: '#2a2a35', stroke: '#c9c7e8' },
  { fill: '#3b2f5e', stroke: '#c9b8ff' },
  { fill: '#1f3a4d', stroke: '#8fd4ff' },
  { fill: '#1f4030', stroke: '#8fe6b0' },
  { fill: '#4d3b1f', stroke: '#ffd68f' },
  { fill: '#4d2233', stroke: '#ff9db8' },
  { fill: '#f6f5f0', stroke: '#2a2a35' },
];

interface DiagramState {
  tool: DiagramTool;
  /** Default fill for newly created nodes. */
  fill: string;
  /** Default border/text color for new nodes + connectors. */
  stroke: string;
  /** Default routing for newly created connectors. */
  routing: DiagramEdgeRouting;
  /** Whether new connectors are drawn dashed. */
  dashed: boolean;
  /** Snap node positions/sizes to the grid while editing. */
  snap: boolean;
  /** Viewport transform — board → screen. */
  zoom: number;
  panX: number;
  panY: number;

  setTool: (t: DiagramTool) => void;
  setSwatch: (s: DiagramSwatch) => void;
  setRouting: (r: DiagramEdgeRouting) => void;
  setDashed: (d: boolean) => void;
  toggleSnap: () => void;
  setViewport: (z: number, px: number, py: number) => void;
  pan: (dx: number, dy: number) => void;
  zoomAt: (sx: number, sy: number, factor: number) => void;
  fit: () => void;
}

const SHAPE_TOOLS: ReadonlySet<DiagramTool> = new Set<DiagramTool>([
  'rect', 'ellipse', 'diamond', 'note', 'pill', 'parallelogram', 'hexagon', 'cylinder', 'triangle',
]);

/** The shape a shape-tool creates (null for non-shape tools). */
export function toolShape(tool: DiagramTool): DiagramNodeShape | null {
  return SHAPE_TOOLS.has(tool) ? (tool as DiagramNodeShape) : null;
}

export const useDiagramStore = create<DiagramState>()(
  persist(
    (set, get) => ({
      tool: 'select',
      fill: DIAGRAM_SWATCHES[0]!.fill,
      stroke: DIAGRAM_SWATCHES[0]!.stroke,
      routing: 'curved',
      dashed: false,
      snap: true,
      zoom: 1,
      panX: 0,
      panY: 0,
      setTool: (tool) => set({ tool }),
      setSwatch: ({ fill, stroke }) => set({ fill, stroke }),
      setRouting: (routing) => set({ routing }),
      setDashed: (dashed) => set({ dashed }),
      toggleSnap: () => set((s) => ({ snap: !s.snap })),
      setViewport: (zoom, panX, panY) => set({ zoom, panX, panY }),
      pan: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),
      zoomAt: (sx, sy, factor) => {
        const { zoom, panX, panY } = get();
        const nextZoom = Math.max(0.1, Math.min(8, zoom * factor));
        const k = nextZoom / zoom;
        // Keep (sx, sy) fixed in board space.
        set({ zoom: nextZoom, panX: sx - (sx - panX) * k, panY: sy - (sy - panY) * k });
      },
      fit: () => set({ zoom: 1, panX: 0, panY: 0 }),
    }),
    {
      name: 'slate.diagram.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tool: s.tool,
        fill: s.fill,
        stroke: s.stroke,
        routing: s.routing,
        dashed: s.dashed,
        snap: s.snap,
      }),
    },
  ),
);
