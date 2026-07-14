/**
 * Pure helpers for the board-space ↔ screen-space viewport transform.
 * Board space is the infinite canvas the user draws on; screen space is
 * the pixel space of the rendering <canvas>.
 *
 *   screen = board * zoom + (panX, panY)
 *   board  = (screen - (panX, panY)) / zoom
 */

import type { BoardPoint, ScreenPoint, ViewportTransform } from './types';

export function boardToScreen(t: ViewportTransform, p: BoardPoint): ScreenPoint {
  return { x: p.x * t.zoom + t.panX, y: p.y * t.zoom + t.panY };
}

export function screenToBoard(t: ViewportTransform, p: ScreenPoint): BoardPoint {
  return { x: (p.x - t.panX) / t.zoom, y: (p.y - t.panY) / t.zoom };
}

export function applyTransform(ctx: CanvasRenderingContext2D, t: ViewportTransform): void {
  ctx.setTransform(t.zoom, 0, 0, t.zoom, t.panX, t.panY);
}

/** Compute a zoom-at-point that keeps the world point under the cursor fixed. */
export function zoomAtScreen(
  t: ViewportTransform,
  screen: ScreenPoint,
  factor: number,
  min = 0.05,
  max = 32,
): ViewportTransform {
  const nextZoom = clamp(t.zoom * factor, min, max);
  const k = nextZoom / t.zoom;
  return {
    zoom: nextZoom,
    panX: screen.x - (screen.x - t.panX) * k,
    panY: screen.y - (screen.y - t.panY) * k,
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
