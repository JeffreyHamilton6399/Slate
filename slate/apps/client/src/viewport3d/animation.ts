/**
 * Keyframe animation — pure sampling + keyframe list editing.
 *
 * Tracks are per-object arrays of { t, transform } sorted by time. Sampling
 * linearly interpolates position/rotation/scale between the surrounding
 * keys and clamps outside the track (Blender's default constant
 * extrapolation).
 */

import type { AnimKey, Transform, Vec3 } from '@slate/sync-protocol';

const EPS = 1e-4;

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function lerpVec(a: Vec3, b: Vec3, k: number): Vec3 {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k) };
}

/** Lerp angles the short way around so a 350°→10° key doesn't spin back. */
function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function lerpEuler(a: Vec3, b: Vec3, k: number): Vec3 {
  return {
    x: lerpAngle(a.x, b.x, k),
    y: lerpAngle(a.y, b.y, k),
    z: lerpAngle(a.z, b.z, k),
  };
}

export function cloneTransform(t: Transform): Transform {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

/** Interpolated transform at time `t`, or null for an empty track. */
export function sampleAnim(keys: AnimKey[] | undefined, t: number): Transform | null {
  if (!keys || keys.length === 0) return null;
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
        position: lerpVec(a.transform.position, b.transform.position, k),
        rotation: lerpEuler(a.transform.rotation, b.transform.rotation, k),
        scale: lerpVec(a.transform.scale, b.transform.scale, k),
      };
    }
  }
  return cloneTransform(last.transform);
}

/** Insert/replace a key at `t`, keeping the track sorted. */
export function withKey(keys: AnimKey[] | undefined, t: number, transform: Transform): AnimKey[] {
  const next = (keys ?? []).filter((k) => Math.abs(k.t - t) > EPS);
  next.push({ t, transform: cloneTransform(transform) });
  next.sort((a, b) => a.t - b.t);
  return next.slice(0, 500);
}

/** Remove the key nearest to `t` within `tolerance` (returns same array if none).
 *  Default tolerance is generous so the Delete button reliably removes the
 *  nearest key to the playhead without needing pixel-perfect scrubbing. */
export function withoutKey(keys: AnimKey[] | undefined, t: number, tolerance = 0.5): AnimKey[] {
  const list = keys ?? [];
  let bestIdx = -1;
  let bestDist = tolerance;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i]!.t - t);
    if (d <= bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return list;
  return list.filter((_, i) => i !== bestIdx);
}
