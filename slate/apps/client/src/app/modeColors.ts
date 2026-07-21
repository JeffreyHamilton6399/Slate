/**
 * Mode-color helpers — one source of truth so every list, badge, and card
 * header renders the same mode tint everywhere (Home recents, All Projects
 * dialog, Onboarding recents, live boards list).
 *
 *   2D           → emerald-500 (drawing / whiteboard — close to the brand green)
 *   3D           → violet-500  (3D scene — close to the accent purple)
 *   Audio        → amber-500   (sound — close to the warn amber)
 *   Doc          → blue-500    (long-form text)
 *   Code         → cyan-500    (code editor)
 *   Diagram      → sky-500     (the blue the user likes — keep)
 *   Presentation → orange-500  (slides — warm orange/rose tint, distinct
 *                  from amber-500 audio and red-500 danger)
 *
 * All seven use Tailwind-native palette colors (NOT CSS-variable theme colors)
 * so the `/15` and `/10` opacity modifiers compile to a proper `rgb(… / α)`
 * value. The CSS-variable colors (`bg-green`, `bg-accent`, `bg-warn`) render
 * their opacity via `color-mix(in srgb, var(--x) 15%, transparent)` which is
 * fine on a modern browser but tends to wash out next to a Tailwind-native
 * tint — that was the "only doc/code/diagram look colored" bug.
 *
 * `modeHeaderClass` is for full-width card banners (/10 opacity); the badge
 * variant uses /15 so the small pill still reads against bg-2.
 */

import type { DocMode } from '@slate/sync-protocol';

/** Compact pill/badge tint (slightly stronger). */
export function modeBadgeClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'bg-violet-500/15 text-violet-300';
    case 'audio':
      return 'bg-amber-500/15 text-amber-300';
    case 'doc':
      return 'bg-blue-500/15 text-blue-300';
    case 'code':
      return 'bg-cyan-500/15 text-cyan-300';
    case 'diagram':
      return 'bg-sky-500/15 text-sky-300';
    case 'presentation':
      return 'bg-orange-500/15 text-orange-300';
    case '2d':
    default:
      return 'bg-emerald-500/15 text-emerald-300';
  }
}

/** Full-width card banner / header tint (softer). */
export function modeHeaderClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'bg-violet-500/10 text-violet-300';
    case 'audio':
      return 'bg-amber-500/10 text-amber-300';
    case 'doc':
      return 'bg-blue-500/10 text-blue-300';
    case 'code':
      return 'bg-cyan-500/10 text-cyan-300';
    case 'diagram':
      return 'bg-sky-500/10 text-sky-300';
    case 'presentation':
      return 'bg-orange-500/10 text-orange-300';
    case '2d':
    default:
      return 'bg-emerald-500/10 text-emerald-300';
  }
}

/** Inline text-only tint (no background) for tiny mode labels in compact lists. */
export function modeTextClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'text-violet-300';
    case 'audio':
      return 'text-amber-300';
    case 'doc':
      return 'text-blue-300';
    case 'code':
      return 'text-cyan-300';
    case 'diagram':
      return 'text-sky-300';
    case 'presentation':
      return 'text-orange-300';
    case '2d':
    default:
      return 'text-emerald-300';
  }
}
