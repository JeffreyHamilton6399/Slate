/**
 * 2D animation — keyframe sampling + helpers (Adobe Animate / After Effects style).
 * Mirrors the 3D `viewport3d/animation.ts` pattern but for 2D transforms:
 * position (x,y), rotation, scale (x,y), and opacity.
 */

import type { AnimKey2D, Transform2D } from '@slate/sync-protocol';

const EPS = 1e-4;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-arc angle interpolation (so 350°→10° goes forward 20°, not backward 340°). */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function cloneTransform(t: Transform2D): Transform2D {
  return { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY, opacity: t.opacity };
}

/**
 * Sample an animation track at time `t`. Returns the interpolated Transform2D,
 * or null if the track is empty. Uses linear interpolation for position/scale/opacity
 * and shortest-arc interpolation for rotation. Constant extrapolation outside the track.
 */
export function sampleAnim2D(keys: AnimKey2D[] | undefined, t: number): Transform2D | null {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) return cloneTransform(keys[0]!.transform);
  if (t <= keys[0]!.t) return cloneTransform(keys[0]!.transform);
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return cloneTransform(last.transform);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const k = span < EPS ? 0 : (t - a.t) / span;
      return {
        x: lerp(a.transform.x, b.transform.x, k),
        y: lerp(a.transform.y, b.transform.y, k),
        rotation: lerpAngle(a.transform.rotation, b.transform.rotation, k),
        scaleX: lerp(a.transform.scaleX, b.transform.scaleX, k),
        scaleY: lerp(a.transform.scaleY, b.transform.scaleY, k),
        opacity: lerp(a.transform.opacity, b.transform.opacity, k),
      };
    }
  }
  return cloneTransform(last.transform);
}

/** Insert or replace a keyframe at time `t`. Sorted, capped at 500. */
export function withKey2D(keys: AnimKey2D[] | undefined, t: number, transform: Transform2D): AnimKey2D[] {
  const filtered = (keys ?? []).filter((k) => Math.abs(k.t - t) > EPS);
  filtered.push({ t, transform });
  filtered.sort((a, b) => a.t - b.t);
  return filtered.slice(0, 500);
}

/** Remove the keyframe nearest to `t` (within tolerance). */
export function withoutKey2D(keys: AnimKey2D[] | undefined, t: number, tolerance = 0.5): AnimKey2D[] {
  if (!keys || keys.length === 0) return [];
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const d = Math.abs(keys[i]!.t - t);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  if (bestIdx < 0 || bestDist > tolerance) return keys;
  return keys.filter((_, i) => i !== bestIdx);
}

/** Move a keyframe from fromT to toT (generous grab tolerance). */
export function moveKey2D(keys: AnimKey2D[] | undefined, fromT: number, toT: number): AnimKey2D[] {
  if (!keys || keys.length === 0) return [];
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const d = Math.abs(keys[i]!.t - fromT);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  if (bestIdx < 0 || bestDist > 1.0) return keys;
  const moved = keys[bestIdx]!;
  const remaining = keys.filter((_, i) => i !== bestIdx);
  remaining.push({ t: Math.max(0, toT), transform: moved.transform });
  remaining.sort((a, b) => a.t - b.t);
  return remaining;
}

/** Build a Transform2D from a Shape's current properties. */
export function shapeToTransform(s: { x: number; y: number; rotation: number; w: number; h: number; strokeOpacity: number }): Transform2D {
  return {
    x: s.x,
    y: s.y,
    rotation: s.rotation,
    scaleX: 1,
    scaleY: 1,
    opacity: s.strokeOpacity,
  };
}
