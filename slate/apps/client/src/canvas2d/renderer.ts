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

// ── Image shape cache ────────────────────────────────────────────────────────
// Data-URL images decode async; renderers subscribe to know when a bitmap
// becomes drawable so they can repaint (main canvas engine + minimap).
const imageCache = new Map<string, HTMLImageElement>();
const imageReadyListeners = new Set<() => void>();

export function onImageReady(cb: () => void): () => void {
  imageReadyListeners.add(cb);
  return () => imageReadyListeners.delete(cb);
}

function getImage(src: string): HTMLImageElement | null {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => imageReadyListeners.forEach((cb) => cb());
    img.src = src;
    imageCache.set(src, img);
    // Cheap eviction: the cache only ever holds a bounded number of entries.
    if (imageCache.size > 200) {
      const first = imageCache.keys().next().value;
      if (first) imageCache.delete(first);
    }
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Regular polygon / star outline path centered in bounds. */
function tracePolygon(
  ctx: CanvasRenderingContext2D,
  b: { x: number; y: number; w: number; h: number },
  sides: number,
  star: boolean,
): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  const n = Math.max(3, Math.round(sides));
  const steps = star ? n * 2 : n;
  ctx.beginPath();
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const k = star && i % 2 === 1 ? 0.45 : 1;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
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
        if (sh.rotation) {
          ctx.save();
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          ctx.translate(cx, cy);
          ctx.rotate(sh.rotation);
          ctx.translate(-cx, -cy);
        }
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        if (sh.rotation) ctx.restore();
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
  if (s.rotation) {
    ctx.save();
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(s.rotation);
    ctx.translate(-cx, -cy);
  }
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
    case 'polygon':
    case 'star': {
      tracePolygon(ctx, b, s.sides ?? (s.kind === 'star' ? 5 : 6), s.kind === 'star');
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'image': {
      const img = s.src ? getImage(s.src) : null;
      if (img) {
        ctx.drawImage(img, b.x, b.y, b.w, b.h);
      } else {
        // Placeholder while the bitmap decodes (or if the src is bad).
        ctx.fillStyle = 'rgba(127,127,127,0.15)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
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
  if (s.rotation) ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length < 3) return;
  // Brush variants that use the perfect-freehand outline path (pen, pencil,
  // marker, calligraphy, airbrush) — each tuned for a different feel.
  if (s.kind === 'pen' || s.kind === 'pencil' || s.kind === 'marker' || s.kind === 'calligraphy' || s.kind === 'airbrush') {
    const points: [number, number, number][] = [];
    for (let i = 0; i < s.points.length; i += 3) {
      points.push([s.points[i] ?? 0, s.points[i + 1] ?? 0, s.points[i + 2] ?? 0.5]);
    }
    // Per-brush tuning:
    //  - calligraphy: high thinning so pressure varies width (broad strokes)
    //  - airbrush: very low thinning + low opacity for a soft spray feel
    //  - pencil: light thinning for a slightly textured look
    //  - marker/pen: uniform width (no pressure simulation)
    const thinning =
      s.kind === 'calligraphy' ? 0.6 :
      s.kind === 'airbrush' ? 0.1 :
      s.kind === 'pencil' ? 0.45 :
      0.35;
    const outline = getStroke(points, {
      size: s.size,
      thinning,
      smoothing: 0.38,
      streamline: 0.12,
      easing: (t) => t,
      simulatePressure: s.kind === 'calligraphy',
      last: true,
    });
    if (!outline.length) return;
    ctx.fillStyle = s.color;
    ctx.globalAlpha *= s.opacity;
    ctx.beginPath();
    const start = outline[0]!;
    ctx.moveTo(start[0]!, start[1]!);
    // Use quadratic curves through the outline midpoints for a smooth fill
    // instead of straight lineTo segments (which read as connected circles
    // when the brush is large or sampling is sparse).
    for (let i = 1; i < outline.length - 1; i++) {
      const p = outline[i]!;
      const next = outline[i + 1]!;
      const mx = (p[0]! + next[0]!) / 2;
      const my = (p[1]! + next[1]!) / 2;
      ctx.quadraticCurveTo(p[0]!, p[1]!, mx, my);
    }
    const last = outline[outline.length - 1]!;
    ctx.lineTo(last[0]!, last[1]!);
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
