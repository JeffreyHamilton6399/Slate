/**
 * Pure geometry helpers: bounding boxes, point-in-shape, point-near-stroke,
 * box intersection. No DOM or Yjs imports so this can be unit-tested.
 */

import type { BoardPoint, Rect, Shape, Stroke } from './types';

export function shapeBounds(s: Shape): Rect {
  return {
    x: Math.min(s.x, s.x + s.w),
    y: Math.min(s.y, s.y + s.h),
    w: Math.abs(s.w),
    h: Math.abs(s.h),
  };
}

export function strokeBounds(s: Stroke): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const p = s.points;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] ?? 0;
    const y = p[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = s.size / 2 + 1;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function rectContains(r: Rect, p: BoardPoint): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

export function pointInShape(s: Shape, p: BoardPoint): boolean {
  // Line/arrow have potentially degenerate bounds (zero h or w); their hit
  // test handles padding itself.
  if (s.kind === 'line' || s.kind === 'arrow') {
    const x1 = s.x,
      y1 = s.y,
      x2 = s.x + s.w,
      y2 = s.y + s.h;
    return distToSegment(p.x, p.y, x1, y1, x2, y2) <= Math.max(6, s.strokeWidth);
  }
  const b = shapeBounds(s);
  if (!rectContains(b, p)) return false;
  if (s.kind === 'rect' || s.kind === 'text') return true;
  if (s.kind === 'ellipse') {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rx = b.w / 2 || 1;
    const ry = b.h / 2 || 1;
    const dx = (p.x - cx) / rx;
    const dy = (p.y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (s.kind === 'triangle') {
    const ax = b.x + b.w / 2,
      ay = b.y;
    const bx = b.x + b.w,
      by = b.y + b.h;
    const cxp = b.x,
      cyp = b.y + b.h;
    return pointInTriangle(p.x, p.y, ax, ay, bx, by, cxp, cyp);
  }
  return false;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function pointNearStroke(s: Stroke, p: BoardPoint, tolerance = 0): boolean {
  const tol = Math.max(s.size / 2 + 2, tolerance);
  const pts = s.points;
  for (let i = 3; i < pts.length; i += 3) {
    const x1 = pts[i - 3] ?? 0;
    const y1 = pts[i - 2] ?? 0;
    const x2 = pts[i] ?? 0;
    const y2 = pts[i + 1] ?? 0;
    if (distToSegment(p.x, p.y, x1, y1, x2, y2) <= tol) return true;
  }
  return false;
}

/** Catmull-Rom spline subdivision for smooth ink. Returns interleaved [x,y]. */
export function smoothPath(points: number[], samplesPerSegment = 4): number[] {
  if (points.length < 4) return points.slice();
  const out: number[] = [];
  const n = points.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? i : i - 1;
    const p1 = i;
    const p2 = i + 1;
    const p3 = i + 2 < n ? i + 2 : i + 1;
    const x0 = points[p0 * 2] ?? 0,
      y0 = points[p0 * 2 + 1] ?? 0;
    const x1 = points[p1 * 2] ?? 0,
      y1 = points[p1 * 2 + 1] ?? 0;
    const x2 = points[p2 * 2] ?? 0,
      y2 = points[p2 * 2 + 1] ?? 0;
    const x3 = points[p3 * 2] ?? 0,
      y3 = points[p3 * 2 + 1] ?? 0;
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const cx =
        0.5 *
        (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const cy =
        0.5 *
        (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      out.push(cx, cy);
    }
  }
  const last = points.length - 2;
  out.push(points[last] ?? 0, points[last + 1] ?? 0);
  return out;
}
