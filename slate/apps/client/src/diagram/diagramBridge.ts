/**
 * Tiny window-event bridge between the Diagram tools panel (docked, separate
 * React tree) and the DiagramEditor. The panel dispatches style/command intents
 * and the editor applies them to the current selection — the same decoupling
 * the doc editor uses (`slate:doc-command`), so the panel never needs a handle
 * on the editor's local selection state.
 */

import type { DiagramEdgeRouting } from '@slate/sync-protocol';

export interface DiagramStyle {
  fill?: string;
  stroke?: string;
  /** Restyle a selected connector's routing. */
  routing?: DiagramEdgeRouting;
  /** Restyle a selected connector's dashed flag. */
  dashed?: boolean;
}

const STYLE_EVENT = 'slate:diagram-style';

/** Recolor the current selection (and set the default for new nodes). */
export function applyDiagramStyle(style: DiagramStyle): void {
  window.dispatchEvent(new CustomEvent<DiagramStyle>(STYLE_EVENT, { detail: style }));
}

export function onDiagramStyle(cb: (style: DiagramStyle) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<DiagramStyle>).detail);
  window.addEventListener(STYLE_EVENT, handler);
  return () => window.removeEventListener(STYLE_EVENT, handler);
}
