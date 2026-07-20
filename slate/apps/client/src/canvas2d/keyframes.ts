/**
 * 2D keyframe Yjs helpers — insert/delete/move keyframes on Shape objects.
 * Mirrors the 3D `viewport3d/scene.ts` keyframe helpers.
 */

import type { SlateDoc } from '../sync/doc';
import type { Shape } from '@slate/sync-protocol';
import { withKey2D, withoutKey2D, moveKey2D, shapeToTransform } from './animation';

/** Read a shape from Yjs by id (returns null if missing). */
function readShapeYjs(slate: SlateDoc, id: string): Shape | null {
  const m = slate.shapes().get(id);
  if (!m) return null;
  const candidate: Record<string, unknown> = {};
  m.forEach((v, k) => { candidate[k] = v; });
  // Minimal validation — the engine's readShape does full zod validation.
  if (!candidate.id || !candidate.kind) return null;
  return candidate as unknown as Shape;
}

/** Insert a keyframe at time `t` capturing the shape's CURRENT transform. */
export function insertKeyframe2D(slate: SlateDoc, ids: string[], t: number): number {
  const shapes = slate.shapes();
  let keyed = 0;
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = shapes.get(id);
      const shape = yo ? readShapeYjs(slate, id) : null;
      if (!yo || !shape) continue;
      const transform = shapeToTransform(shape);
      const anim = withKey2D(shape.anim, t, transform);
      yo.set('anim', anim);
      keyed++;
    }
  });
  return keyed;
}

/** Auto-key: only keys shapes that ALREADY have keyframes (Blender auto-keying). */
export function autoKeyframe2D(slate: SlateDoc, ids: string[], t: number): number {
  const shapes = slate.shapes();
  let keyed = 0;
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = shapes.get(id);
      const shape = yo ? readShapeYjs(slate, id) : null;
      if (!yo || !shape || (shape.anim?.length ?? 0) === 0) continue;
      const transform = shapeToTransform(shape);
      const anim = withKey2D(shape.anim, t, transform);
      yo.set('anim', anim);
      keyed++;
    }
  });
  return keyed;
}

/** Delete the keyframe nearest to `t`. */
export function deleteKeyframe2D(slate: SlateDoc, ids: string[], t: number): number {
  const shapes = slate.shapes();
  let deleted = 0;
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = shapes.get(id);
      const shape = yo ? readShapeYjs(slate, id) : null;
      if (!yo || !shape || (shape.anim?.length ?? 0) === 0) continue;
      const anim = withoutKey2D(shape.anim, t);
      if (anim.length === 0) {
        yo.delete('anim');
      } else {
        yo.set('anim', anim);
      }
      deleted++;
    }
  });
  return deleted;
}

/** Move a keyframe from fromT to toT on a single shape. */
export function moveKeyframe2D(slate: SlateDoc, id: string, fromT: number, toT: number): void {
  const yo = slate.shapes().get(id);
  const shape = yo ? readShapeYjs(slate, id) : null;
  if (!yo || !shape || (shape.anim?.length ?? 0) === 0) return;
  const anim = moveKey2D(shape.anim, fromT, toT);
  slate.doc.transact(() => { yo.set('anim', anim); });
}

/** Check if any shape in the list has animation. */
export function hasAnimation2D(slate: SlateDoc, ids: string[]): boolean {
  for (const id of ids) {
    const shape = readShapeYjs(slate, id);
    if (shape && (shape.anim?.length ?? 0) > 0) return true;
  }
  return false;
}
