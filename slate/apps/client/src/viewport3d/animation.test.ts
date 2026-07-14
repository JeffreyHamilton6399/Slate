import { describe, expect, it } from 'vitest';
import { sampleAnim, withKey, withoutKey } from './animation';
import type { AnimKey, Transform } from '@slate/sync-protocol';

const T = (x: number, ry = 0, s = 1): Transform => ({
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: ry, z: 0 },
  scale: { x: s, y: s, z: s },
});

const track: AnimKey[] = [
  { t: 0, transform: T(0) },
  { t: 2, transform: T(4, Math.PI / 2, 2) },
];

describe('sampleAnim', () => {
  it('returns null for empty tracks', () => {
    expect(sampleAnim(undefined, 1)).toBeNull();
    expect(sampleAnim([], 1)).toBeNull();
  });
  it('clamps before the first and after the last key', () => {
    expect(sampleAnim(track, -5)!.position.x).toBe(0);
    expect(sampleAnim(track, 99)!.position.x).toBe(4);
  });
  it('lerps position, rotation, and scale at the midpoint', () => {
    const mid = sampleAnim(track, 1)!;
    expect(mid.position.x).toBeCloseTo(2);
    expect(mid.rotation.y).toBeCloseTo(Math.PI / 4);
    expect(mid.scale.x).toBeCloseTo(1.5);
  });
  it('rotates the short way around the circle', () => {
    const wrap: AnimKey[] = [
      { t: 0, transform: T(0, (350 * Math.PI) / 180) },
      { t: 1, transform: T(0, (10 * Math.PI) / 180) },
    ];
    const mid = sampleAnim(wrap, 0.5)!;
    // Halfway between 350° and 10° going forward is 360° (=0°), not 180°.
    const deg = ((mid.rotation.y * 180) / Math.PI + 360) % 360;
    expect(Math.min(deg, 360 - deg)).toBeLessThan(1);
  });
});

describe('withKey / withoutKey', () => {
  it('inserts sorted and replaces keys at the same time', () => {
    let keys = withKey(undefined, 2, T(2));
    keys = withKey(keys, 1, T(1));
    keys = withKey(keys, 2, T(9));
    expect(keys.map((k) => k.t)).toEqual([1, 2]);
    expect(keys[1]!.transform.position.x).toBe(9);
  });
  it('removes the nearest key within tolerance only', () => {
    const keys = withKey(withKey(undefined, 0, T(0)), 1, T(1));
    expect(withoutKey(keys, 1.01).length).toBe(1);
    expect(withoutKey(keys, 5).length).toBe(2);
  });
});
