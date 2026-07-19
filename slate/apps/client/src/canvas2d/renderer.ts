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
import type { Layer, Shape, Stroke, Transform2D } from '@slate/sync-protocol';
import type { Rect, ViewportTransform } from './types';
import { shapeBounds, smoothPath, strokeBounds } from './geometry';
import { sampleAnim2D } from './animation';

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
  /** Current animation playback time (seconds). 0 = no animation. */
  animTime?: number;
  /** Onion skin: draw previous/next frames as ghost overlays. */
  onionSkin?: boolean;
  /** How many frames of onion skin to ghost on each side (default 1). */
  onionSkinFrames?: number;
  /** Frames per second (for onion skin frame stepping). */
  animFps?: number;
  /** Frame-based (cel) animation mode — only the current frame's content
   *  (plus any static, frame-less content) is drawn. */
  animMode?: boolean;
  /** Current cel frame index (used when animMode is on). */
  animFrame?: number;
  /** Skip the background grid (video export renders on plain paper). */
  hideGrid?: boolean;
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

  if (!scene.hideGrid) drawGrid(ctx, transform, size);

  const celMode = !!scene.animMode;
  const curFrame = scene.animFrame ?? 0;
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    const shapes = scene.shapesByLayer.get(layer.id) ?? [];
    const strokes = scene.strokesByLayer.get(layer.id) ?? [];
    const animTime = scene.animTime ?? 0;
    const fps = scene.animFps ?? 24;

    if (celMode) {
      // Frame-based (cel) animation: each frame is its own drawing. Only the
      // content stamped onto the current frame — plus any static, frame-less
      // content — is drawn. Empty frames render blank.
      if (scene.onionSkin) {
        // Ghost up to `onionSkinFrames` neighbours each side: previous frames
        // red, next frames green, fading out the further from the current
        // frame (drawn farthest-first so nearer ghosts paint on top).
        const depth = Math.max(1, Math.min(5, scene.onionSkinFrames ?? 1));
        const drawGhost = (f: number, tint: string, alpha: number) => {
          ctx.globalAlpha = layer.opacity * alpha;
          for (const sh of shapes) {
            if (sh.frame === f) { ctx.save(); drawShapeTint(ctx, sh, tint); ctx.restore(); }
          }
          for (const st of strokes) {
            if (st.frame === f) { ctx.save(); drawStrokeTint(ctx, st, tint); ctx.restore(); }
          }
          ctx.globalAlpha = layer.opacity;
        };
        for (let i = depth; i >= 1; i--) {
          const alpha = 0.3 * (depth - i + 1) / depth;
          if (curFrame - i >= 0) drawGhost(curFrame - i, '#ff4444', alpha);
          drawGhost(curFrame + i, '#44ff44', alpha);
        }
      }
      for (const sh of shapes) {
        if (sh.frame == null || sh.frame === curFrame) {
          // Motion keyframes still animate inside cel mode (Animate's tweens
          // coexist with frame-by-frame cels) — boards keyframed before the
          // frame timeline became the only mode keep playing.
          const override = (sh.anim?.length ?? 0) > 0 ? sampleAnim2D(sh.anim, animTime) : null;
          if (override) drawShapeWithAnim(ctx, sh, override);
          else drawShape(ctx, sh);
        }
      }
      for (const st of strokes) {
        if (st.frame == null || st.frame === curFrame) drawStroke(ctx, st);
      }
      ctx.globalAlpha = 1;
      continue;
    }

    // Onion skin: draw previous and next frames as ghost overlays.
    if (scene.onionSkin && animTime > 0) {
      const frame = Math.round(animTime * fps);
      // Previous frame (red ghost)
      if (frame > 0) {
        const prevTime = (frame - 1) / fps;
        ctx.globalAlpha = layer.opacity * 0.25;
        for (const sh of shapes) {
          const o = sampleAnim2D(sh.anim, prevTime);
          if (o) { ctx.save(); drawShapeWithAnimTint(ctx, sh, o, '#ff4444'); ctx.restore(); }
        }
      }
      // Next frame (green ghost)
      const nextTime = (frame + 1) / fps;
      ctx.globalAlpha = layer.opacity * 0.25;
      for (const sh of shapes) {
        const o = sampleAnim2D(sh.anim, nextTime);
        if (o) { ctx.save(); drawShapeWithAnimTint(ctx, sh, o, '#44ff44'); ctx.restore(); }
      }
      ctx.globalAlpha = layer.opacity;
    }

    for (const sh of shapes) {
      // If the shape has animation keyframes, sample the transform at animTime
      // and apply it as a canvas transform override. The shape's base x/y/rotation
      // are replaced by the sampled values; scale and opacity multiply on top.
      const override = (animTime > 0 || (sh.anim?.length ?? 0) > 0) ? sampleAnim2D(sh.anim, animTime) : null;
      if (override) {
        drawShapeWithAnim(ctx, sh, override);
      } else {
        drawShape(ctx, sh);
      }
    }
    for (const st of strokes) drawStroke(ctx, st);
    ctx.globalAlpha = 1;
  }

  if (scene.liveStroke) drawStroke(ctx, scene.liveStroke);
  if (scene.liveShape) drawShape(ctx, scene.liveShape);

  // Selection overlay rendered in board space using an unscaled stroke width.
  ctx.lineWidth = 1 / transform.zoom;
  ctx.strokeStyle = '#7c6aff';
  ctx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
  // In cel mode, only outline selected items that are actually on-screen for
  // the current frame (frame-less/static items are always shown).
  const visibleOnFrame = (item: { frame?: number }) =>
    !celMode || item.frame == null || item.frame === curFrame;
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    for (const sh of scene.shapesByLayer.get(layer.id) ?? []) {
      if (scene.selection.has(sh.id) && visibleOnFrame(sh)) {
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
      if (scene.selection.has(st.id) && visibleOnFrame(st)) {
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

/** Draw a shape with an animation transform override applied.
 *  The override replaces the shape's base x/y/rotation; scale and opacity
 *  multiply on top. Used while the 2D timeline is scrubbing or playing. */
function drawShapeWithAnim(ctx: CanvasRenderingContext2D, s: Shape, t: Transform2D): void {
  ctx.save();
  // Compute the center at the OVERRIDDEN position.
  const cx = t.x + s.w / 2;
  const cy = t.y + s.h / 2;
  // Translate to center, apply override rotation + scale, translate back.
  ctx.translate(cx, cy);
  ctx.rotate(t.rotation);
  ctx.scale(t.scaleX || 0.001, t.scaleY || 0.001); // guard against 0 scale
  ctx.translate(-cx, -cy);
  // Draw the shape at the overridden position with rotation=0 (rotation
  // already applied via canvas transform) and multiplied opacity.
  const overridden: Shape = {
    ...s,
    x: t.x,
    y: t.y,
    rotation: 0,
    strokeOpacity: s.strokeOpacity * t.opacity,
  };
  drawShape(ctx, overridden);
  ctx.restore();
}

/** Draw a shape with an animation transform + a tint color (onion skin ghost).
 *  Overrides stroke and fill with the tint color so the ghost is a solid
 *  silhouette in the tint color (red for previous frame, green for next). */
function drawShapeWithAnimTint(ctx: CanvasRenderingContext2D, s: Shape, t: Transform2D, tint: string): void {
  ctx.save();
  const cx = t.x + s.w / 2;
  const cy = t.y + s.h / 2;
  ctx.translate(cx, cy);
  ctx.rotate(t.rotation);
  ctx.scale(t.scaleX || 0.001, t.scaleY || 0.001);
  ctx.translate(-cx, -cy);
  const overridden: Shape = {
    ...s,
    x: t.x,
    y: t.y,
    rotation: 0,
    stroke: tint,
    fill: tint,
    strokeOpacity: t.opacity * 0.5,
  };
  drawShape(ctx, overridden);
  ctx.restore();
}

/** Draw a shape at its own position as a flat tinted silhouette — used for
 *  cel-mode onion skinning (neighbour frames as coloured ghosts). */
function drawShapeTint(ctx: CanvasRenderingContext2D, s: Shape, tint: string): void {
  drawShape(ctx, { ...s, stroke: tint, fill: s.fill ? tint : null });
}

/** Stroke equivalent of drawShapeTint. */
function drawStrokeTint(ctx: CanvasRenderingContext2D, s: Stroke, tint: string): void {
  drawStroke(ctx, { ...s, color: tint });
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
    case 'diamond':
    case 'pentagon':
    case 'hexagon': {
      // Regular polygons that fit the bounds (diamond = a 4-gon on its point).
      tracePolygon(ctx, b, s.kind === 'diamond' ? 4 : s.kind === 'pentagon' ? 5 : 6, false);
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'parallelogram': {
      const sl = b.w * 0.25; // top shifted right by 25%
      ctx.beginPath();
      ctx.moveTo(b.x + sl, b.y);
      ctx.lineTo(b.x + b.w, b.y);
      ctx.lineTo(b.x + b.w - sl, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'trapezoid': {
      const ins = b.w * 0.22; // top narrower than the base
      ctx.beginPath();
      ctx.moveTo(b.x + ins, b.y);
      ctx.lineTo(b.x + b.w - ins, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'cross': {
      // Plus sign: an arm-thickness fraction of the smaller dimension.
      const t = Math.min(b.w, b.h) * 0.34;
      const x0 = b.x, y0 = b.y, w = b.w, h = b.h;
      const lx = x0 + (w - t) / 2, rx = x0 + (w + t) / 2;
      const ty = y0 + (h - t) / 2, by = y0 + (h + t) / 2;
      ctx.beginPath();
      ctx.moveTo(lx, y0);
      ctx.lineTo(rx, y0);
      ctx.lineTo(rx, ty);
      ctx.lineTo(x0 + w, ty);
      ctx.lineTo(x0 + w, by);
      ctx.lineTo(rx, by);
      ctx.lineTo(rx, y0 + h);
      ctx.lineTo(lx, y0 + h);
      ctx.lineTo(lx, by);
      ctx.lineTo(x0, by);
      ctx.lineTo(x0, ty);
      ctx.lineTo(lx, ty);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'heart': {
      const cx = b.x + b.w / 2;
      ctx.beginPath();
      ctx.moveTo(cx, b.y + b.h * 0.28);
      ctx.bezierCurveTo(b.x + b.w * 0.5, b.y, b.x, b.y, b.x, b.y + b.h * 0.35);
      ctx.bezierCurveTo(b.x, b.y + b.h * 0.62, cx, b.y + b.h * 0.82, cx, b.y + b.h);
      ctx.bezierCurveTo(cx, b.y + b.h * 0.82, b.x + b.w, b.y + b.h * 0.62, b.x + b.w, b.y + b.h * 0.35);
      ctx.bezierCurveTo(b.x + b.w, b.y, b.x + b.w * 0.5, b.y, cx, b.y + b.h * 0.28);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'cloud': {
      const { x, y, w, h } = b;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.25, y + h);
      ctx.bezierCurveTo(x, y + h, x, y + h * 0.55, x + w * 0.22, y + h * 0.52);
      ctx.bezierCurveTo(x + w * 0.12, y + h * 0.12, x + w * 0.45, y, x + w * 0.52, y + h * 0.28);
      ctx.bezierCurveTo(x + w * 0.62, y, x + w * 0.92, y + h * 0.04, x + w * 0.82, y + h * 0.42);
      ctx.bezierCurveTo(x + w, y + h * 0.42, x + w, y + h, x + w * 0.78, y + h);
      ctx.closePath();
      if (s.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'speech': {
      const { x, y, w, h } = b;
      const bodyH = h * 0.78;
      const r = Math.min(w, bodyH) * 0.18;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + bodyH - r);
      ctx.quadraticCurveTo(x + w, y + bodyH, x + w - r, y + bodyH);
      ctx.lineTo(x + w * 0.34, y + bodyH); // tail base start
      ctx.lineTo(x + w * 0.2, y + h); // tail tip
      ctx.lineTo(x + w * 0.24, y + bodyH); // tail base end
      ctx.lineTo(x + r, y + bodyH);
      ctx.quadraticCurveTo(x, y + bodyH, x, y + bodyH - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
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
