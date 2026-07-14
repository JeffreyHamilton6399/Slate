/**
 * Shared drag helpers for the Unity-style dock system.
 *
 * Both tab drags (out of a strip) and floating-window title drags use the
 * same drop resolution: hit-test the pointer against dock tab strips
 * (`data-tab-strip="left|right"`) and whole docks (`data-dock-drop`), and
 * compute an insertion index from tab midpoints.
 */

import type { DockZone } from './dockStore';

export interface TabDropTarget {
  zone: DockZone;
  index: number;
}

/** Where would a panel land if released at (x, y)? null = float. */
export function findDropTarget(x: number, y: number): TabDropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const strip = el.closest<HTMLElement>('[data-tab-strip]');
  if (strip) {
    const zone = strip.dataset.tabStrip as DockZone;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'));
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i]!.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    return { zone, index };
  }
  const dock = el.closest<HTMLElement>('[data-dock-drop]');
  if (dock) {
    const zone = dock.dataset.dockDrop as DockZone;
    return { zone, index: Number.POSITIVE_INFINITY };
  }
  return null;
}

/** Imperative drag ghost — a small floating chip that follows the pointer. */
export function createDragGhost(title: string): {
  move: (x: number, y: number) => void;
  destroy: () => void;
} {
  const el = document.createElement('div');
  el.textContent = title;
  Object.assign(el.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    zIndex: '9999',
    pointerEvents: 'none',
    padding: '3px 10px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--color-text, #e0dff5)',
    background: 'var(--color-bg-3, #1c1c22)',
    border: '1px solid var(--color-accent, #7c6aff)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    transform: 'translate(-50%, -140%)',
    whiteSpace: 'nowrap',
    opacity: '0.95',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  return {
    move: (x, y) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    },
    destroy: () => el.remove(),
  };
}
