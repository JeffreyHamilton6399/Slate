/**
 * Blender-style modal tool driver.
 *
 * A modal tool enters on a hotkey and stays active until LMB/Enter (confirm)
 * or RMB/Esc (cancel). While active:
 *   - mouse movement updates a single preview value (per axis lock if any)
 *   - X / Y / Z toggle axis lock (Shift+axis flips the lock to "everything
 *     except this axis", matching Blender)
 *   - typing digits / minus / dot / Backspace builds a numeric input that
 *     overrides the mouse-derived preview value
 *
 * Concretely the driver returns a normalized "delta" per frame which the
 * caller maps onto position / rotation / scale / extrude offset / etc.
 *
 * Confirming applies the final delta via the caller's commit callback;
 * canceling rolls back to the snapshot taken on enter.
 */

import type { Object3D, Transform } from '@slate/sync-protocol';

export type ModalKind = 'grab' | 'rotate' | 'scale';
export type ModalAxis = 'x' | 'y' | 'z' | null;

export interface ModalState<T> {
  kind: ModalKind;
  axis: ModalAxis;
  /** Excludes the locked axis when true (Shift+X/Y/Z). */
  exclude: boolean;
  /** Numeric input being typed. */
  numericBuffer: string;
  /** Screen pixel delta accumulated from pointer events. */
  pixelDelta: { x: number; y: number };
  /** Snapshot to restore on cancel. */
  snapshot: T;
}

export interface DeltaResult {
  /** Translation delta in world units. */
  translate?: { x: number; y: number; z: number };
  /** Euler delta in radians. */
  rotate?: { x: number; y: number; z: number };
  /** Multiplicative scale delta. */
  scale?: { x: number; y: number; z: number };
}

/**
 * Convert the current modal state into a concrete delta. `pxScale` is a
 * world-units-per-pixel value derived from camera distance so dragging
 * feels consistent at any zoom. `screenDir` is the per-axis screen vector
 * used to project pointer motion onto the locked axis.
 */
export function deltaFromModal(
  state: ModalState<unknown>,
  pxScale: number,
): DeltaResult {
  const numeric = parseNumeric(state.numericBuffer);
  const ax = axisVector(state);
  if (state.kind === 'grab') {
    const amount =
      numeric !== null
        ? numeric
        : (state.pixelDelta.x + -state.pixelDelta.y) * pxScale;
    return { translate: { x: ax.x * amount, y: ax.y * amount, z: ax.z * amount } };
  }
  if (state.kind === 'rotate') {
    const amount =
      numeric !== null
        ? toRad(numeric)
        : ((state.pixelDelta.x + -state.pixelDelta.y) * Math.PI) / 360;
    return { rotate: { x: ax.x * amount, y: ax.y * amount, z: ax.z * amount } };
  }
  // scale — uniform unless axis is set.
  const k =
    numeric !== null
      ? numeric
      : 1 + (state.pixelDelta.x + -state.pixelDelta.y) * pxScale * 0.5;
  if (state.axis) {
    return {
      scale: {
        x: ax.x ? k : 1,
        y: ax.y ? k : 1,
        z: ax.z ? k : 1,
      },
    };
  }
  return { scale: { x: k, y: k, z: k } };
}

function axisVector(state: ModalState<unknown>): { x: number; y: number; z: number } {
  if (!state.axis) return { x: 1, y: 1, z: 1 };
  if (state.exclude) {
    return {
      x: state.axis === 'x' ? 0 : 1,
      y: state.axis === 'y' ? 0 : 1,
      z: state.axis === 'z' ? 0 : 1,
    };
  }
  return {
    x: state.axis === 'x' ? 1 : 0,
    y: state.axis === 'y' ? 1 : 0,
    z: state.axis === 'z' ? 1 : 0,
  };
}

function parseNumeric(buffer: string): number | null {
  if (!buffer) return null;
  if (buffer === '-' || buffer === '.') return null;
  const n = Number(buffer);
  return Number.isFinite(n) ? n : null;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Apply a delta to a base transform; returns the new transform. */
export function applyDelta(base: Transform, d: DeltaResult): Transform {
  return {
    position: {
      x: base.position.x + (d.translate?.x ?? 0),
      y: base.position.y + (d.translate?.y ?? 0),
      z: base.position.z + (d.translate?.z ?? 0),
    },
    rotation: {
      x: base.rotation.x + (d.rotate?.x ?? 0),
      y: base.rotation.y + (d.rotate?.y ?? 0),
      z: base.rotation.z + (d.rotate?.z ?? 0),
    },
    scale: {
      x: base.scale.x * (d.scale?.x ?? 1),
      y: base.scale.y * (d.scale?.y ?? 1),
      z: base.scale.z * (d.scale?.z ?? 1),
    },
  };
}

export type ObjectModalState = ModalState<Map<string, Object3D>>;

export function startObjectModal(
  kind: ModalKind,
  base: Map<string, Object3D>,
): ObjectModalState {
  return {
    kind,
    axis: null,
    exclude: false,
    numericBuffer: '',
    pixelDelta: { x: 0, y: 0 },
    snapshot: base,
  };
}

/**
 * Update the modal state in response to a key. Returns whether the key was
 * consumed (so callers can prevent default).
 */
export function handleModalKey(
  state: ObjectModalState,
  e: KeyboardEvent,
): { consumed: boolean; confirm: boolean; cancel: boolean } {
  const k = e.key.toLowerCase();
  if (k === 'enter' || k === ' ') {
    return { consumed: true, confirm: true, cancel: false };
  }
  if (k === 'escape') {
    return { consumed: false, confirm: false, cancel: true };
  }
  if (k === 'x' || k === 'y' || k === 'z') {
    if (state.axis === k && state.exclude === e.shiftKey) {
      state.axis = null;
      state.exclude = false;
    } else {
      state.axis = k as 'x' | 'y' | 'z';
      state.exclude = e.shiftKey;
    }
    return { consumed: true, confirm: false, cancel: false };
  }
  if (/^[0-9]$/.test(k)) {
    state.numericBuffer += k;
    return { consumed: true, confirm: false, cancel: false };
  }
  if (k === '.' && !state.numericBuffer.includes('.')) {
    state.numericBuffer += '.';
    return { consumed: true, confirm: false, cancel: false };
  }
  if (k === '-' && state.numericBuffer.length === 0) {
    state.numericBuffer = '-';
    return { consumed: true, confirm: false, cancel: false };
  }
  if (k === 'backspace' && state.numericBuffer.length > 0) {
    state.numericBuffer = state.numericBuffer.slice(0, -1);
    return { consumed: true, confirm: false, cancel: false };
  }
  return { consumed: false, confirm: false, cancel: false };
}

/** Pretty label for the modal HUD. */
export function modalLabel(state: ObjectModalState): string {
  const verb = state.kind === 'grab' ? 'Move' : state.kind === 'rotate' ? 'Rotate' : 'Scale';
  const axis = state.axis ? (state.exclude ? `not ${state.axis.toUpperCase()}` : state.axis.toUpperCase()) : 'free';
  const numeric = state.numericBuffer ? ` (${state.numericBuffer})` : '';
  return `${verb} • ${axis}${numeric}`;
}
