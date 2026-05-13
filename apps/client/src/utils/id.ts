import { nanoid } from 'nanoid';

/** Stable id for shapes/strokes/objects. */
export function makeId(prefix?: string): string {
  return prefix ? `${prefix}_${nanoid(14)}` : nanoid(14);
}
