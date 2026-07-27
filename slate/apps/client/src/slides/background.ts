/**
 * Slide background changes, shared by the editor toolbar and the Design panel.
 *
 * Changing a slide's background can silently make its text unreadable — light
 * default text on a newly-light background is the classic version. Switching
 * the background therefore also re-flips any text still sitting on a DEFAULT
 * color. Text the user explicitly colored is left alone, so this only ever
 * rescues the case where nobody made a deliberate choice.
 */

import type * as Y from 'yjs';
import { readElements } from './model';

/** Default text colors — the two values the editor assigns on its own. */
export const DARK_TEXT = '#22222c';
export const LIGHT_TEXT = '#e0dff5';

/** Perceptual luminance test used to pick a legible default text color. */
export function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return false;
  const v = parseInt(m[1]!, 16);
  const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return lum > 150;
}

/** The default text color that reads well on `background`. */
export function defaultTextColor(background: string): string {
  return isLightColor(background) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * Set a slide's background and re-flip default-colored text on it.
 * Runs as one transaction, so it's a single undo step.
 */
export function setSlideBackground(
  doc: Y.Doc,
  slidesMap: Y.Map<Y.Map<unknown>>,
  elementsMap: Y.Map<Y.Map<unknown>>,
  slideId: string,
  background: string,
): void {
  const wanted = defaultTextColor(background);
  doc.transact(() => {
    slidesMap.get(slideId)?.set('background', background);
    for (const el of readElements(elementsMap)) {
      if (el.slideId !== slideId || el.kind !== 'text') continue;
      const cur = el.color ?? LIGHT_TEXT;
      // Only adjust text still on a default color; a deliberate pick stays.
      if (cur !== DARK_TEXT && cur !== LIGHT_TEXT) continue;
      if (cur !== wanted) elementsMap.get(el.id)?.set('color', wanted);
    }
  });
}
