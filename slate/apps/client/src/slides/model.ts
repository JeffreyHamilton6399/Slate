/**
 * Slides data model helpers — read typed Slide / SlideElement values out of
 * their Yjs maps, and ordering utilities.
 *
 * Slides and elements live in top-level Y.Maps (see doc.ts container
 * doctrine): `slides:slides` (id → Y.Map) and `slides:elements` (id → Y.Map).
 * Every field is a plain-JS primitive, so shallow copies in/out of Y.Map are
 * enough — there are no nested Y types.
 */

import * as Y from 'yjs';
import {
  slideSchema,
  slideElementSchema,
  type Slide,
  type SlideElement,
} from '@slate/sync-protocol';

export function readSlide(m: Y.Map<unknown>, id: string): Slide | null {
  const out: Record<string, unknown> = { id };
  m.forEach((v, k) => (out[k] = v));
  const parsed = slideSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

export function readElement(m: Y.Map<unknown>, id: string): SlideElement | null {
  const out: Record<string, unknown> = { id };
  m.forEach((v, k) => (out[k] = v));
  const parsed = slideElementSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

/** Snapshot every slide into a plain array sorted by `order`. */
export function readSlides(slides: Y.Map<Y.Map<unknown>>): Slide[] {
  const out: Slide[] = [];
  slides.forEach((m, id) => {
    const s = readSlide(m, id);
    if (s) out.push(s);
  });
  out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return out;
}

/** Snapshot every element into a plain array sorted for painting (z asc). */
export function readElements(elements: Y.Map<Y.Map<unknown>>): SlideElement[] {
  const out: SlideElement[] = [];
  elements.forEach((m, id) => {
    const e = readElement(m, id);
    if (e) out.push(e);
  });
  out.sort((a, b) => a.z - b.z || a.createdAt - b.createdAt);
  return out;
}

/** Build a fresh Y.Map from a plain object (slide or element). */
export function toYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) m.set(k, v);
  }
  return m;
}

/** Fractional order for inserting a slide between neighbours (or at the end).
 *  A single-key write on the moved slide — no renumbering cascade. */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** Highest element z on a slide (0 when empty) — new elements go on top. */
export function topZ(elements: SlideElement[], slideId: string): number {
  let z = 0;
  for (const e of elements) if (e.slideId === slideId && e.z > z) z = e.z;
  return z;
}
