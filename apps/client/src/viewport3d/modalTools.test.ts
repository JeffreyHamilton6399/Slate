import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  deltaFromModal,
  handleModalKey,
  startObjectModal,
} from './modalTools';
import type { Object3D } from '@slate/sync-protocol';

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
