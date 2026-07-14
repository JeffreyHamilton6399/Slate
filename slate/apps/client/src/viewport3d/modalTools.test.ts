import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  axisDragAmount,
  deltaFromModal,
  handleModalKey,
  startObjectModal,
  type CameraBasis,
} from './modalTools';
import type { Object3D } from '@slate/sync-protocol';

// Camera looking down -Z: screen right = world +X, screen up = world +Y.
const basis: CameraBasis = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
};

const id = 'o1';
const obj: Object3D = {
  id,
  parentId: null,
  type: 'cube',
  name: 'Cube',
  visible: true,
  transform: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  },
  meshId: null,
  materialId: null,
};

describe('startObjectModal', () => {
  it('initializes with empty axis and no numeric buffer', () => {
    const base = new Map([[id, obj]]);
    const s = startObjectModal('grab', base);
    expect(s.axis).toBeNull();
    expect(s.numericBuffer).toBe('');
    expect(s.kind).toBe('grab');
  });
});

describe('handleModalKey', () => {
  it('x key locks to x axis', () => {
    const s = startObjectModal('grab', new Map([[id, obj]]));
    const r = handleModalKey(s, new KeyboardEvent('keydown', { key: 'x' }));
    expect(r.consumed).toBe(true);
    expect(s.axis).toBe('x');
  });
  it('numeric input accumulates', () => {
    const s = startObjectModal('grab', new Map([[id, obj]]));
    handleModalKey(s, new KeyboardEvent('keydown', { key: '1' }));
    handleModalKey(s, new KeyboardEvent('keydown', { key: '.' }));
    handleModalKey(s, new KeyboardEvent('keydown', { key: '5' }));
    expect(s.numericBuffer).toBe('1.5');
  });
  it('Enter confirms, Escape cancels', () => {
    const s = startObjectModal('grab', new Map([[id, obj]]));
    expect(handleModalKey(s, new KeyboardEvent('keydown', { key: 'Enter' })).confirm).toBe(true);
    expect(handleModalKey(s, new KeyboardEvent('keydown', { key: 'Escape' })).cancel).toBe(true);
  });
});

describe('deltaFromModal', () => {
  it('grab with numeric on X yields a pure-X translate', () => {
    const s = startObjectModal('grab', new Map([[id, obj]]));
    handleModalKey(s, new KeyboardEvent('keydown', { key: 'x' }));
    handleModalKey(s, new KeyboardEvent('keydown', { key: '2' }));
    const d = deltaFromModal(s, 0.01);
    expect(d.translate?.x).toBe(2);
    expect(d.translate?.y).toBe(0);
    expect(d.translate?.z).toBe(0);
  });

  it('applyDelta updates the snapshot transform correctly', () => {
    const base = obj.transform;
    const next = applyDelta(base, { translate: { x: 1, y: 2, z: 3 } });
    expect(next.position).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('axisDragAmount', () => {
  it('projects horizontal drag onto a screen-horizontal axis (+X)', () => {
    const a = axisDragAmount({ x: 1, y: 0, z: 0 }, { x: 100, y: 0 }, basis, 0.01);
    expect(a).toBeCloseTo(1); // 100px * 0.01, axis fully in-plane
  });
  it('maps mouse-up (negative y) to +Y motion', () => {
    const a = axisDragAmount({ x: 0, y: 1, z: 0 }, { x: 0, y: -50 }, basis, 0.01);
    expect(a).toBeCloseTo(0.5);
  });
  it('ignores drag perpendicular to the axis', () => {
    // Dragging vertically while locked to X should barely move along X.
    const a = axisDragAmount({ x: 1, y: 0, z: 0 }, { x: 0, y: 80 }, basis, 0.01);
    expect(a).toBeCloseTo(0);
  });
  it('falls back to vertical drag when the axis points at the camera', () => {
    // Axis = view direction → degenerate screen projection.
    const a = axisDragAmount({ x: 0, y: 0, z: 1 }, { x: 0, y: -40 }, basis, 0.01);
    expect(a).toBeCloseTo(0.4);
  });
  it('corrects foreshortening: a 45°-tilted axis needs less pixel travel', () => {
    // Axis half in-plane (X) half toward camera: len = cos(45°) ≈ 0.707.
    const axis = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    const a = axisDragAmount(axis, { x: 100, y: 0 }, basis, 0.01);
    // amountPx = 100 * (0.707/0.707) = 100; world = 100*0.01/0.707 ≈ 1.414
    expect(a).toBeCloseTo(Math.SQRT2);
  });
});
