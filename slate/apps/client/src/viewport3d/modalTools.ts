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

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Camera-space unit vectors in world space (for screen-plane mapping). */
export interface CameraBasis {
  right: Vec3;
  up: Vec3;
  /** View direction (camera → target). */
  forward: Vec3;
}

/**
 * World-units to move along `axis` (unit vector) for the given pointer pixel
 * delta, projecting the drag onto the axis's screen-space direction — the way
 * Blender's axis-locked grab / extrude tracks the cursor.
 *
 * A 1-unit step along `axis` projects to `len = |(axis·right, axis·up)|` units
 * in the screen plane (the rest points toward the camera), so dividing by `len`
 * corrects foreshortening and keeps the grabbed point under the cursor. When
 * the axis is nearly head-on the projection degenerates, so we fall back to
 * vertical mouse motion.
 */
export function axisDragAmount(
  axis: Vec3,
  pixelDelta: { x: number; y: number },
  basis: CameraBasis | undefined,
  pxScale: number,
): number {
  if (!basis) return (pixelDelta.x + -pixelDelta.y) * pxScale;
  const sx = axis.x * basis.right.x + axis.y * basis.right.y + axis.z * basis.right.z;
  const sy = axis.x * basis.up.x + axis.y * basis.up.y + axis.z * basis.up.z;
  // Screen pixels are y-down, so the on-screen axis direction negates `up`.
  const screenX = sx;
  const screenY = -sy;
  const len = Math.hypot(screenX, screenY);
  if (len < 0.1) return -pixelDelta.y * pxScale;
  const ux = screenX / len;
  const uy = screenY / len;
  const amountPx = pixelDelta.x * ux + pixelDelta.y * uy;
  return (amountPx * pxScale) / len;
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
  basis?: CameraBasis,
): DeltaResult {
  const numeric = parseNumeric(state.numericBuffer);
  const ax = axisVector(state);
  if (state.kind === 'grab') {
    // Free grab (and "everything except axis") moves in the screen plane so
    // the object tracks the cursor, like Blender — not along a fixed diagonal.
    if (numeric === null && basis && (!state.axis || state.exclude)) {
      const dx = state.pixelDelta.x * pxScale;
      const dy = -state.pixelDelta.y * pxScale;
      const t = {
        x: basis.right.x * dx + basis.up.x * dy,
        y: basis.right.y * dx + basis.up.y * dy,
        z: basis.right.z * dx + basis.up.z * dy,
      };
      if (state.axis && state.exclude) {
        if (state.axis === 'x') t.x = 0;
        if (state.axis === 'y') t.y = 0;
        if (state.axis === 'z') t.z = 0;
      }
      return { translate: t };
    }
    // Single-axis grab: drag along the axis's on-screen projection.
    const amount =
      numeric !== null
        ? numeric
        : axisDragAmount(ax, state.pixelDelta, basis, pxScale);
    return { translate: { x: ax.x * amount, y: ax.y * amount, z: ax.z * amount } };
  }
  if (state.kind === 'rotate') {
    // Free rotate spins around the world axis closest to the view direction.
    // Use horizontal drag only — combining x+y made diagonal drags rotate
    // twice as fast and feel unpredictable (the "rotating weird" bug).
    if (numeric === null && basis && !state.axis) {
      const amount = (state.pixelDelta.x * Math.PI) / 240;
      const f = basis.forward;
      const axisKey =
        Math.abs(f.x) >= Math.abs(f.y) && Math.abs(f.x) >= Math.abs(f.z)
          ? 'x'
          : Math.abs(f.y) >= Math.abs(f.z)
            ? 'y'
            : 'z';
      const sign = -Math.sign(f[axisKey]) || 1;
      const r = { x: 0, y: 0, z: 0 };
      r[axisKey] = amount * sign;
      return { rotate: r };
    }
    const amount =
      numeric !== null
        ? toRad(numeric)
        : (state.pixelDelta.x * Math.PI) / 240;
    return { rotate: { x: ax.x * amount, y: ax.y * amount, z: ax.z * amount } };
  }
  // scale — uniform unless axis is set. Horizontal drag scales (right grows,
  // left shrinks); combining x+y was unpredictable. Clamp to a tiny positive
  // minimum so scaling never inverts the mesh. Typed numerics pass through.
  const k =
    numeric !== null
      ? numeric
      : Math.max(1e-3, 1 + state.pixelDelta.x * pxScale * 0.5);
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
