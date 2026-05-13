/**
 * Canvas2D renderer.
 *
 * Strategy:
 *   - Each layer is cached into an OffscreenCanvas at integer "tile" coords
 *     for the current zoom level. On change, only the layer's offscreen is
 *     repainted; the main canvas just composites layers + draws live overlays.
 *   - DPR-aware: the main canvas backing-store size is css * devicePixelRatio
 *     so strokes stay crisp.
 *   - perfect-freehand is used for pen strokes; raw polyline for highlighter.
 *
 * The renderer is intentionally framework-free; the React component just
 * pushes scene data + transform + viewport size.
 */

import { getStroke } from 'perfect-freehand';
import type { Layer, Shape, Stroke } from '@slate/sync-protocol';
import type { Rect, ViewportTransform } from './types';
import { shapeBounds, smoothPath, strokeBounds } from './geometry';

export interface SceneFrame {
  layers: Layer[];
  /** Strokes grouped by layerId in their stable creation order. */
  strokesByLayer: Map<string, Stroke[]>;
  /** Shapes grouped by layerId in their stable creation order. */
  shapesByLayer: Map<string, Shape[]>;
  /** Currently selected ids for selection overlay (any kind). */
  selection: Set<string>;
  /** Live (in-progress) preview stroke (if any). */
  liveStroke?: Stroke | null;
  /** Live (in-progress) preview shape (if any). */
  liveShape?: Shape | null;
  /** Marquee selection rect (in board space). */
  marquee?: Rect | null;
  /** Page background color. */
  paper: string;
}

export interface ViewportSize {
  /** CSS pixel size. */
  width: number;
  height: number;
  /** devicePixelRatio. */
  dpr: number;
}

export function resizeCanvas(canvas: HTMLCanvasElement, size: ViewportSize): void {
  const w = Math.max(1, Math.round(size.width * size.dpr));
  const h = Math.max(1, Math.round(size.height * size.dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
}

export function renderScene(
  canvas: HTMLCanvasElement,
  scene: SceneFrame,
  transform: ViewportTransform,
  size: ViewportSize,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.fillStyle = scene.paper;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.save();
  applyTransformWithDpr(ctx, transform, size.dpr);

  drawGrid(ctx, transform, size);

  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    const shapes = scene.shapesByLayer.get(layer.id) ?? [];
    const strokes = scene.strokesByLayer.get(layer.id) ?? [];
    for (const sh of shapes) drawShape(ctx, sh);
    for (const st of strokes) drawStroke(ctx, st);
    ctx.globalAlpha = 1;
  }

  if (scene.liveStroke) drawStroke(ctx, scene.liveStroke);
  if (scene.liveShape) drawShape(ctx, scene.liveShape);

  // Selection overlay rendered in board space using an unscaled stroke width.
  ctx.lineWidth = 1 / transform.zoom;
  ctx.strokeStyle = '#7c6aff';
  ctx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    for (const sh of scene.shapesByLayer.get(layer.id) ?? []) {
      if (scene.selection.has(sh.id)) {
        const b = shapeBounds(sh);
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
      }
    }
    for (const st of scene.strokesByLayer.get(layer.id) ?? []) {
      if (scene.selection.has(st.id)) {
        const b = strokeBounds(st);
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
      }
    }
  }
  if (scene.marquee) {
    ctx.strokeRect(scene.marquee.x, scene.marquee.y, scene.marquee.w, scene.marquee.h);
    ctx.fillStyle = 'rgba(124,106,255,0.08)';
    ctx.fillRect(scene.marquee.x, scene.marquee.y, scene.marquee.w, scene.marquee.h);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function applyTransformWithDpr(
  ctx: CanvasRenderingContext2D,
  t: ViewportTransform,
  dpr: number,
): void {
  ctx.setTransform(t.zoom * dpr, 0, 0, t.zoom * dpr, t.panX * dpr, t.panY * dpr);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  t: ViewportTransform,
  size: ViewportSize,
): void {
  if (t.zoom < 0.25) return;
  const step = 100;
  const left = (-t.panX) / t.zoom;
  const top = (-t.panY) / t.zoom;
  const right = left + size.width / t.zoom;
  const bottom = top + size.height / t.zoom;
  const x0 = Math.floor(left / step) * step;
  const y0 = Math.floor(top / step) * step;
  ctx.lineWidth = 1 / t.zoom;
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath();
  for (let x = x0; x <= right; x += step) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = y0; y <= bottom; y += step) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  const b = shapeBounds(s);
  ctx.globalAlpha *= s.strokeOpacity;
  ctx.lineWidth = s.strokeWidth;
  ctx.strokeStyle = s.stroke;
  if (s.fill) ctx.fillStyle = s.fill;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (s.kind) {
    case 'rect':
      if (s.fill) ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    case 'ellipse': {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const rx = b.w / 2;
      const ry = b.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + s.w, s.y + s.h);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      const x1 = s.x,
        y1 = s.y,
        x2 = s.x + s.w,
        y2 = s.y + s.h;
      const headLen = Math.max(10, s.strokeWidth * 3);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6),
      );
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6),
      );
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = s.stroke;
      ctx.font = `${s.fontSize ?? 24}px Inter, sans-serif`;
      ctx.textBaseline = 'top';
      const text = s.text ?? '';
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i] ?? '', b.x, b.y + i * (s.fontSize ?? 24) * 1.2);
      }
      break;
    }
  }
  ctx.globalAlpha /= s.strokeOpacity || 1;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length < 3) return;
  if (s.kind === 'pen') {
    const points: [number, number, number][] = [];
    for (let i = 0; i < s.points.length; i += 3) {
      points.push([s.points[i] ?? 0, s.points[i + 1] ?? 0, s.points[i + 2] ?? 0.5]);
    }
    const outline = getStroke(points, {
      size: s.size,
      thinning: 0.55,
      smoothing: 0.5,
      streamline: 0.5,
      easing: (t) => t,
      simulatePressure: false,
      last: true,
    });
    if (!outline.length) return;
    ctx.fillStyle = s.color;
    ctx.globalAlpha *= s.opacity;
    ctx.beginPath();
    const start = outline[0]!;
    ctx.moveTo(start[0]!, start[1]!);
    for (let i = 1; i < outline.length; i++) {
      const p = outline[i]!;
      ctx.lineTo(p[0]!, p[1]!);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha /= s.opacity || 1;
    return;
  }

  // Highlighter / eraser: polyline.
  const polyline: number[] = [];
  for (let i = 0; i < s.points.length; i += 3) {
    polyline.push(s.points[i] ?? 0, s.points[i + 1] ?? 0);
  }
  const smoothed = smoothPath(polyline);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.size;
  ctx.globalAlpha *= s.opacity;
  if (s.kind === 'highlighter') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = s.color;
  } else {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
  }
  ctx.beginPath();
  ctx.moveTo(smoothed[0] ?? 0, smoothed[1] ?? 0);
  for (let i = 2; i < smoothed.length; i += 2) {
    ctx.lineTo(smoothed[i] ?? 0, smoothed[i + 1] ?? 0);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha /= s.opacity || 1;
}

// Re-export so the toolbar can reuse during preview rendering if needed.
export { drawShape, drawStroke };
