/**
 * Mode-color helpers — one source of truth so every list, badge, and card
 * header renders the same mode tint everywhere (Home recents, All Projects
 * dialog, Onboarding recents, live boards list).
 *
 *   2D      → green   (drawing / whiteboard)
 *   3D      → accent  (purple — 3D scene)
 *   Audio   → warn    (amber — sound)
 *   Doc     → blue    (long-form text — same family as the diagram tint)
 *   Code    → cyan    (code editor)
 *   Diagram → sky     (the blue the user likes — keep)
 *
 * `modeHeaderClass` is for full-width card banners (/10 opacity); the badge
 * variant uses /15 so the small pill still reads against bg-2.
 */

import type { DocMode } from '@slate/sync-protocol';

/** Compact pill/badge tint (slightly stronger). */
export function modeBadgeClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'bg-accent/15 text-accent';
    case 'audio':
      return 'bg-warn/15 text-warn';
    case 'doc':
      return 'bg-blue-500/15 text-blue-400';
    case 'code':
      return 'bg-cyan-500/15 text-cyan-400';
    case 'diagram':
      return 'bg-sky-500/15 text-sky-400';
    case '2d':
    default:
      return 'bg-green/15 text-green';
  }
}

/** Full-width card banner / header tint (softer). */
export function modeHeaderClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'bg-accent/10 text-accent';
    case 'audio':
      return 'bg-warn/10 text-warn';
    case 'doc':
      return 'bg-blue-500/10 text-blue-400';
    case 'code':
      return 'bg-cyan-500/10 text-cyan-400';
    case 'diagram':
      return 'bg-sky-500/10 text-sky-400';
    case '2d':
    default:
      return 'bg-green/10 text-green';
  }
}

/** Inline text-only tint (no background) for tiny mode labels in compact lists. */
export function modeTextClass(mode: DocMode): string {
  switch (mode) {
    case '3d':
      return 'text-accent';
    case 'audio':
      return 'text-warn';
    case 'doc':
      return 'text-blue-400';
    case 'code':
      return 'text-cyan-400';
    case 'diagram':
      return 'text-sky-400';
    case '2d':
    default:
      return 'text-green';
  }
}
