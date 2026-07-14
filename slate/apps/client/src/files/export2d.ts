/**
 * Export the 2D canvas state to a PNG / JPG / WebP / SVG file.
 *
 * Raster export rebuilds the scene into an off-screen canvas at a chosen
 * pixel size; SVG export emits a self-contained <svg> with each shape /
 * stroke as a corresponding element. Both honour layer visibility / opacity.
 */

import type { Layer, Shape, Stroke } from '@slate/sync-protocol';
import { renderScene, type ViewportSize } from '../canvas2d/renderer';
import { rotatedShapeAABB, shapeBounds, strokeBounds } from '../canvas2d/geometry';

export type RasterFormat = 'png' | 'jpg' | 'webp';

interface Export2DArgs {
  layers: Layer[];
  shapesByLayer: Map<string, Shape[]>;
  strokesByLayer: Map<string, Stroke[]>;
  paper: string;
}

interface RasterOpts extends Export2DArgs {
  format: RasterFormat;
  padding?: number;
  maxSize?: number;
  /** Resolution multiplier (Photoshop-style 1x/2x/4x). */
  scale?: number;
  /** JPEG/WebP quality 0–1. */
  quality?: number;
  /** PNG/WebP: skip the paper fill for a transparent background. */
  transparent?: boolean;
}

export async function exportRaster(opts: RasterOpts): Promise<Blob> {
  const bounds = computeContentBounds(opts);
  const pad = opts.padding ?? 32;
  const w = Math.max(1, bounds.w + pad * 2);
  const h = Math.max(1, bounds.h + pad * 2);
  const wanted = (opts.scale ?? 1) * Math.max(w, h);
  const cap = opts.maxSize ?? 8192;
  const scale = (opts.scale ?? 1) * Math.min(1, cap / wanted);
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const size: ViewportSize = { width: cw, height: ch, dpr: 1 };
  const transparent = Boolean(opts.transparent) && opts.format !== 'jpg';
  renderScene(
    canvas,
    {
      layers: opts.layers,
      shapesByLayer: opts.shapesByLayer,
      strokesByLayer: opts.strokesByLayer,
      selection: new Set(),
      paper: transparent ? 'rgba(0,0,0,0)' : opts.paper,
    },
    { zoom: scale, panX: -(bounds.x - pad) * scale, panY: -(bounds.y - pad) * scale },
    size,
  );
  const mime = opts.format === 'png' ? 'image/png' : opts.format === 'jpg' ? 'image/jpeg' : 'image/webp';
  const quality = opts.format === 'png' ? undefined : (opts.quality ?? 0.92);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
      mime,
      quality,
    );
  });
}

export function exportSvg(opts: Export2DArgs): string {
  const bounds = computeContentBounds(opts);
  const pad = 32;
  const w = bounds.w + pad * 2;
  const h = bounds.h + pad * 2;
  const tx = -bounds.x + pad;
  const ty = -bounds.y + pad;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
  );
  parts.push(
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${escapeXml(opts.paper)}" />`,
  );
  parts.push(`<g transform="translate(${tx} ${ty})">`);
  for (const layer of opts.layers) {
    if (!layer.visible) continue;
    parts.push(
      `<g id="${escapeXml(layer.id)}" opacity="${layer.opacity}" data-name="${escapeXml(layer.name)}">`,
    );
    for (const sh of opts.shapesByLayer.get(layer.id) ?? []) parts.push(shapeToSvg(sh));
    for (const st of opts.strokesByLayer.get(layer.id) ?? []) parts.push(strokeToSvg(st));
    parts.push(`</g>`);
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

function shapeToSvg(s: Shape): string {
  const body = shapeToSvgBody(s);
  if (!s.rotation) return body;
  // The canvas draws rotated shapes about their bounds center; mirror that.
  const b = shapeBounds(s);
  const deg = (s.rotation * 180) / Math.PI;
  return `<g transform="rotate(${deg} ${b.x + b.w / 2} ${b.y + b.h / 2})">${body}</g>`;
}

function shapeToSvgBody(s: Shape): string {
  const b = shapeBounds(s);
  const stroke = `stroke="${escapeXml(s.stroke)}" stroke-width="${s.strokeWidth}" stroke-opacity="${s.strokeOpacity}"`;
  const fill = s.fill ? `fill="${escapeXml(s.fill)}"` : 'fill="none"';
  switch (s.kind) {
    case 'rect':
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" ${stroke} ${fill} />`;
    case 'ellipse':
      return `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" ${stroke} ${fill} />`;
    case 'triangle':
      return `<polygon points="${b.x + b.w / 2},${b.y} ${b.x + b.w},${b.y + b.h} ${b.x},${b.y + b.h}" ${stroke} ${fill} />`;
    case 'line':
      return `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.w}" y2="${s.y + s.h}" ${stroke} />`;
    case 'arrow': {
      const x1 = s.x,
        y1 = s.y,
        x2 = s.x + s.w,
        y2 = s.y + s.h;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(10, s.strokeWidth * 3);
      const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 6);
      const hy1 = y2 - headLen * Math.sin(angle - Math.PI / 6);
      const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 6);
      const hy2 = y2 - headLen * Math.sin(angle + Math.PI / 6);
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke} />` +
        `<line x1="${x2}" y1="${y2}" x2="${hx1}" y2="${hy1}" ${stroke} />` +
        `<line x1="${x2}" y1="${y2}" x2="${hx2}" y2="${hy2}" ${stroke} />`
      );
    }
    case 'text':
      return `<text x="${b.x}" y="${b.y + (s.fontSize ?? 24)}" font-size="${s.fontSize ?? 24}" font-family="Inter,sans-serif" fill="${escapeXml(s.stroke)}">${escapeXml(s.text ?? '')}</text>`;
    case 'polygon':
    case 'star': {
      const pts = polygonPoints(b, s.sides ?? (s.kind === 'star' ? 5 : 6), s.kind === 'star');
      return `<polygon points="${pts}" ${stroke} ${fill} />`;
    }
    case 'image':
      return s.src
        ? `<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" href="${escapeXml(s.src)}" preserveAspectRatio="none" />`
        : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#888" />`;
    case 'heart':
    case 'cloud':
    case 'speech':
    case 'diamond':
    case 'pentagon':
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
    case 'cross':
      // New shape kinds render as a polygon approximation in SVG export.
      // The canvas renderer draws these natively; SVG export uses the polygon
      // fallback so they're at least visible in exported files.
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" ${stroke} ${fill} rx="4" />`;
    default:
      return '';
  }
}

/** Regular-polygon / star vertices, matching the canvas renderer. */
function polygonPoints(
  b: { x: number; y: number; w: number; h: number },
  sides: number,
  star: boolean,
): string {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  const n = Math.max(3, Math.round(sides));
  const steps = star ? n * 2 : n;
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const k = star && i % 2 === 1 ? 0.45 : 1;
    out.push(`${cx + Math.cos(a) * rx * k},${cy + Math.sin(a) * ry * k}`);
  }
  return out.join(' ');
}

function strokeToSvg(s: Stroke): string {
  const pts: string[] = [];
  for (let i = 0; i < s.points.length; i += 3) {
    pts.push(`${s.points[i]},${s.points[i + 1]}`);
  }
  const dash = s.kind === 'highlighter' ? 'opacity="0.35"' : '';
  return `<polyline points="${pts.join(' ')}" stroke="${escapeXml(s.color)}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round" fill="none" ${dash} />`;
}

function computeContentBounds(opts: Export2DArgs): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const layer of opts.layers) {
    for (const sh of opts.shapesByLayer.get(layer.id) ?? []) {
      const b = rotatedShapeAABB(sh);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    for (const st of opts.strokesByLayer.get(layer.id) ?? []) {
      const b = strokeBounds(st);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 1024, h: 768 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
