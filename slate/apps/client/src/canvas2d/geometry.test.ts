import { describe, expect, it } from 'vitest';
import {
  pointInShape,
  pointNearStroke,
  rectIntersects,
  rotatedShapeAABB,
  shapeBounds,
  strokeBounds,
  smoothPath,
} from './geometry';
import type { Shape, Stroke } from '@slate/sync-protocol';

const baseShape: Shape = {
  id: 's1',
  kind: 'rect',
  layerId: 'l1',
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  rotation: 0,
  stroke: '#fff',
  fill: null,
  strokeWidth: 2,
  strokeOpacity: 1,
  createdAt: 0,
  authorId: 'a',
};

describe('shapeBounds', () => {
  it('normalizes negative width/height', () => {
    const b = shapeBounds({ ...baseShape, w: -100, h: -50 });
    expect(b).toEqual({ x: -100, y: -50, w: 100, h: 50 });
  });
});

describe('rotatedShapeAABB', () => {
  it('matches shapeBounds when unrotated', () => {
    expect(rotatedShapeAABB(baseShape)).toEqual(shapeBounds(baseShape));
  });
  it('swaps extents at 90° around the same center', () => {
    const b = rotatedShapeAABB({ ...baseShape, rotation: Math.PI / 2 });
    expect(b.w).toBeCloseTo(50);
    expect(b.h).toBeCloseTo(100);
    expect(b.x + b.w / 2).toBeCloseTo(50);
    expect(b.y + b.h / 2).toBeCloseTo(25);
  });
  it('grows to the diagonal at 45°', () => {
    const b = rotatedShapeAABB({ ...baseShape, w: 100, h: 100, rotation: Math.PI / 4 });
    expect(b.w).toBeCloseTo(100 * Math.SQRT2);
    expect(b.h).toBeCloseTo(100 * Math.SQRT2);
  });
});

describe('pointInShape', () => {
  it('rect hit test', () => {
    expect(pointInShape(baseShape, { x: 50, y: 25 })).toBe(true);
    expect(pointInShape(baseShape, { x: 150, y: 25 })).toBe(false);
  });
  it('ellipse hit test', () => {
    const s: Shape = { ...baseShape, kind: 'ellipse' };
    expect(pointInShape(s, { x: 50, y: 25 })).toBe(true);
    expect(pointInShape(s, { x: 0, y: 0 })).toBe(false);
  });
  it('line hit test', () => {
    const s: Shape = { ...baseShape, kind: 'line', x: 0, y: 0, w: 100, h: 0, strokeWidth: 4 };
    expect(pointInShape(s, { x: 50, y: 1 })).toBe(true);
    expect(pointInShape(s, { x: 50, y: 50 })).toBe(false);
  });
});

describe('rectIntersects', () => {
  it('overlapping rectangles intersect', () => {
    expect(rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });
  it('disjoint rectangles do not intersect', () => {
    expect(rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

const stroke: Stroke = {
  id: 'st1',
  kind: 'pen',
  layerId: 'l1',
  color: '#fff',
  size: 4,
  opacity: 1,
  points: [0, 0, 0.5, 10, 0, 0.5, 20, 0, 0.5],
  createdAt: 0,
  authorId: 'a',
};

describe('strokeBounds', () => {
  it('returns bounding box covering all points', () => {
    const b = strokeBounds(stroke);
    expect(b.x).toBeLessThanOrEqual(-1);
    expect(b.x + b.w).toBeGreaterThanOrEqual(21);
  });
});

describe('pointNearStroke', () => {
  it('point on stroke axis is near', () => {
    expect(pointNearStroke(stroke, { x: 10, y: 0 })).toBe(true);
  });
  it('point far from stroke is not near', () => {
    expect(pointNearStroke(stroke, { x: 50, y: 50 })).toBe(false);
  });
});

describe('smoothPath', () => {
  it('returns same length input under 4 elements', () => {
    expect(smoothPath([0, 0]).length).toBe(2);
  });
  it('returns more samples than input for long path', () => {
    const out = smoothPath([0, 0, 10, 10, 20, 0, 30, 10], 4);
    expect(out.length).toBeGreaterThan(8);
  });
});
