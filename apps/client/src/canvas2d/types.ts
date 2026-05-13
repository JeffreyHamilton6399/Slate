/**
 * Shared types for the 2D canvas engine. Kept separate so the engine,
 * tools, and React shell can all import without cycles.
 */

import type { Shape, ShapeKind, Stroke, StrokeKind } from '@slate/sync-protocol';

export interface ViewportTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface BoardPoint {
  x: number;
  y: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface PointerSample extends BoardPoint {
  pressure: number;
  /** Monotonic ms for velocity smoothing. */
  t: number;
}

export type { Shape, ShapeKind, Stroke, StrokeKind };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Result of hit-testing against shapes/strokes. */
export interface HitResult {
  kind: 'shape' | 'stroke';
  id: string;
}
