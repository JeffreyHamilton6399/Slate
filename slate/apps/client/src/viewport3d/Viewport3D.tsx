/**
 * 3D viewport — react-three-fiber canvas wired up to:
 *   - SceneObjects (mesh rendering from Yjs)
 *   - Object selection (click + Shift+click)
 *   - Camera (OrbitControls)
 *   - Grid + axes + lighting
 *   - GizmoHelper + view gizmo
 *   - Modal tool driver (G / R / S)
 *   - Toolbar3D + keyboard shortcuts
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  Html,
  OrbitControls,
} from '@react-three/drei';
import * as THREE from 'three';
import type {
  AwarenessState,
  Object3D as Object3DSchema,
  Transform,
} from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { useAppStore } from '../app/store';
import { useBoardUnits, useBoardCadSnap } from '../sync/useBoardSettings';
import { Toolbar3D } from './Toolbar3D';
import { AddObjectMenu } from './AddObjectMenu';
import { FlyMode } from './FlyMode';
import { ObjectGizmo } from './ObjectGizmo';
import { Timeline } from './Timeline';
import { sampleAnim } from './animation';
import { SceneObjects, type ElementHit } from './SceneObjects';
import {
  applyMeshModal,
  applyMeshScalar,
  cancelMeshModal,
  meshModalLabel,
  rotateVertices,
  scaleVertices,
  startMeshExtrude,
  startMeshGrab,
  startMeshScalar,
  writeVertices,
  type MeshModalKind,
  type MeshModalState,
} from './meshModal';
import { useScene3DStore } from './store';
import { autoKeyframe, instantiateAsset, readSceneSnapshot, setTransform, type SceneSnapshot } from './scene';
import { importModel } from '../files/import3d';
import { setCameraFocus } from './cameraFocus';
import { toast } from '../ui/Toast';
import { useViewport3DShortcuts } from './useViewport3DShortcuts';
import {
  applyDelta,
  axisDragAmount,
  deltaFromModal,
  handleModalKey,
  modalLabel,
  startObjectModal,
  type CameraBasis,
  type ModalKind,
  type ObjectModalState,
} from './modalTools';

interface CameraInfo {
  basis: CameraBasis;
  /** World units per pixel at the orbit target's distance. */
  pxScale: number;
}

interface Viewport3DProps {
  room: SlateRoom;
}

/** Viewport chrome colors per app theme (bg: [normal, rendered]). Section grid
 *  lines follow the accent color (read from the --accent CSS variable at
 *  runtime so the custom-accent setting recolors the grid); cell lines are a
 *  faint tint of the same hue. */
const VIEWPORT_BG = {
  dark: ['#0c0c0e', '#08080a'],
  light: ['#dfdfe7', '#d4d4de'],
} as const;

/** Read the current accent color from the CSS variable (falls back to the
 *  default purple). Used for grid lines + default material so the custom
 *  accent setting recolors both. */
function readAccentColor(): string {
  if (typeof window === 'undefined') return '#7c6aff';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#7c6aff';
}

/** Darken a hex color by mixing it with black (factor 0..1). */
function darken(hex: string, factor: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!.slice(0, 2), 16);
  const g = parseInt(m[1]!.slice(2, 4), 16);
  const b = parseInt(m[1]!.slice(4, 6), 16);
  const dr = Math.round(r * (1 - factor));
  const dg = Math.round(g * (1 - factor));
  const db = Math.round(b * (1 - factor));
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}

export function Viewport3D({ room }: Viewport3DProps) {
  const [snapshot, setSnapshot] = useState<SceneSnapshot>(() =>
    readSceneSnapshot(room.slate),
  );
  const selection = useScene3DStore((s) => s.selection);
  const setSelection = useScene3DStore((s) => s.setSelection);
  const toggleSelection = useScene3DStore((s) => s.toggleSelection);
  const clearSelection = useScene3DStore((s) => s.clearSelection);
  const showGrid = useScene3DStore((s) => s.showGrid);
  const shading = useScene3DStore((s) => s.shading);
  const flying = useScene3DStore((s) => s.flying);
  const flySpeed = useScene3DStore((s) => s.flySpeed);
  const theme = useAppStore((s) => s.theme);
  const accent = useAppStore((s) => s.accent);
  const paperFollowsTheme = useAppStore((s) => s.paperFollowsTheme);
  const showTransformHud = useAppStore((s) => s.showTransformHud);
  const [units] = useBoardUnits(room);
  // CAD snapping doubles as "CAD mode": when off (Blender-style) the on-mesh
  // dimension NUMBERS are hidden — selection highlights still show.
  const [cadSnap] = useBoardCadSnap(room);
  // Grid lines follow the accent color: section = accent, cell = darkened
  // accent (a faint tint). Recomputed when the accent setting changes.
  const accentColor = accent || readAccentColor();
  const viewportColors = {
    bg: VIEWPORT_BG[theme],
    cell: darken(accentColor, theme === 'dark' ? 0.72 : 0.45),
    section: accentColor,
  };
  // File → Background sets the board's shared paper color; like the 2D
  // canvas, the 3D viewport shows it once "follows theme" is off.
  const [paper, setPaper] = useState('#0c0c0e');
  useEffect(() => {
    const meta = room.slate.meta();
    const apply = () => setPaper((meta.get('paper') as string) || '#0c0c0e');
    apply();
    meta.observe(apply);
    return () => meta.unobserve(apply);
  }, [room]);
  const bgColor = paperFollowsTheme
    ? viewportColors.bg[shading === 'rendered' ? 1 : 0]
    : paper;
  // CAD grid: cell/section spacing follows the chosen display units.
  // The Grid component's infiniteGrid + followCamera handles the rest.
  const grid =
    units === 'mm' || units === 'cm'
      ? { cell: 0.1, section: 1 }
      : units === 'in' || units === 'ft'
        ? { cell: 0.3048, section: 3.048 }
        : { cell: 1, section: 5 };
  // Animation: while the playhead is scrubbing/playing, animated objects render
  // at their sampled keyframe pose so you can see the animation. Editing still
  // writes the base transform; the gizmo syncs from the sampled pose so it
  // stays attached to the visible mesh (no desync glitch). The Properties
  // panel reads the sampled transform too so its numbers update as you scrub.
  const animTime = useScene3DStore((s) => s.animTime);
  const modalTool = useScene3DStore((s) => s.modal.tool);
  const gizmoDragging = useScene3DStore((s) => s.gizmoDragging);
  const animOverrides = useMemo(() => {
    // Only sample when there's actually animation and the playhead is moving
    // or parked away from a base transform. When stopped at t=0 with no
    // scrubbing intent, show base transforms so editing feels natural.
    const hasAnim = snapshot.objects.some((o) => (o.anim?.length ?? 0) > 0);
    if (!hasAnim) return null;
    // While a G/R/S modal OR a gizmo drag is running, DON'T override the
    // objects being transformed — the edit writes the base transform live and
    // the override would mask it (object appears stuck/invisible). Show their
    // real base transform so the drag is visible.
    const transforming = modalTool || gizmoDragging ? new Set(selection) : null;
    const m = new Map<string, Transform>();
    for (const o of snapshot.objects) {
      if (transforming?.has(o.id)) continue; // show base transform during edit
      const t = sampleAnim(o.anim, animTime);
      if (t) m.set(o.id, t);
    }
    return m.size > 0 ? m : null;
  }, [animTime, snapshot, modalTool, gizmoDragging, selection]);
  const viewingCameraId = useScene3DStore((s) => s.viewingCameraId);
  const editorMode = useScene3DStore((s) => s.editorMode);
  const editSelection = useScene3DStore((s) => s.editSelection);
  const selectMode = useScene3DStore((s) => s.selectMode);
  const setEditSelection = useScene3DStore((s) => s.setEditSelection);
  const [awareness, setAwareness] = useState<AwarenessState[]>([]);
  // Blender-style navigation: Shift+MMB pans instead of orbiting.
  const [shiftDown, setShiftDown] = useState(false);
  // Shift+A add menu, opened at the last-known cursor position.
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef({ x: 80, y: 80 });
  /** Screen position (container px) of the selection pivot, for the guide line. */
  const pivotScreenRef = useRef<{ x: number; y: number } | null>(null);
  const guideLineRef = useRef<SVGLineElement | null>(null);

  useEffect(() => room.onAwarenessChange(setAwareness), [room]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Live subscription to Yjs.
  useEffect(() => {
    const objects = room.slate.scene3dObjects();
    const meshes = room.slate.scene3dMeshes();
    const materials = room.slate.scene3dMaterials();
    const refresh = () => setSnapshot(readSceneSnapshot(room.slate));
    objects.observeDeep(refresh);
    meshes.observeDeep(refresh);
    materials.observeDeep(refresh);
    refresh();
    // IndexedDB hydration can complete slightly after the room resolves (the
    // `whenSynced` callback fires, then Yjs applies updates on a microtask).
    // Re-read once after a tick so a freshly-hydrated doc's objects appear
    // immediately instead of showing an empty board until the next edit.
    const lateRead = setTimeout(refresh, 200);
    return () => {
      clearTimeout(lateRead);
      objects.unobserveDeep(refresh);
      meshes.unobserveDeep(refresh);
      materials.unobserveDeep(refresh);
    };
  }, [room]);

  // Modal tool state — independent of zustand so high-frequency updates
  // don't trigger React re-renders. The store's `modal.tool` mirrors whether
  // a modal is active so the shortcut hook can route keys correctly.
  const modalRef = useRef<ObjectModalState | null>(null);
  const meshModalRef = useRef<MeshModalState | null>(null);
  const [modalLabelText, setModalLabelText] = useState<string | null>(null);
  /** True while the left mouse button is held down over the viewport — hides
   *  the cursor during drags (orbit/pan/select) like the modal-transform
   *  cursor hide, so the pointer doesn't float over the working area. */
  const [leftHeld, setLeftHeld] = useState(false);
  const frameSelectedRef = useRef<(all: boolean) => void>(() => {});
  const cameraInfoRef = useRef<CameraInfo | null>(null);
  /** Set when a modal just ended so the confirming click doesn't clear selection. */
  const modalEndedAtRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  /** The viewport element — pointer-locked while a modal drag is running. */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Where the last primary press landed — drags must not clear selection. */
  const pointerDownAtRef = useRef<{ x: number; y: number } | null>(null);

  // The Import dialog (and other non-viewport callers) can't reach the camera
  // directly, so they dispatch a 'slate:frame-selection' window event after
  // adding objects; frame them here so imported models are always in view.
  useEffect(() => {
    const onFrame = () => requestAnimationFrame(() => frameSelectedRef.current(false));
    window.addEventListener('slate:frame-selection', onFrame);
    return () => window.removeEventListener('slate:frame-selection', onFrame);
  }, []);

  // Blender keeps the cursor visible during modal transforms (G/R/S) and just
  // reads pointer motion — no pointer lock. Locking hides the cursor and feels
  // jarring ("the weird preview mouse thing"), so we leave the cursor visible
  // and let the guide line track it. movementX/Y still drive the delta.
  const requestModalLock = useCallback(() => {}, []);
  const releaseModalLock = useCallback(() => {}, []);

  const onObjectPick = useCallback(
    (id: string, additive: boolean) => {
      // The click that confirms a modal transform must not also re-pick.
      if (Date.now() - modalEndedAtRef.current < 350) return;
      if (additive) toggleSelection(id);
      else setSelection([id]);
    },
    [setSelection, toggleSelection],
  );

  // Resolve a sub-element click according to the active select mode
  // (1 = vertex, 2 = edge, 3 = face — Blender's layout).
  const onElementPick = useCallback(
    (objectId: string, hit: ElementHit, additive: boolean) => {
      // Ignore the click that confirms a mesh modal so it can't re-pick a face.
      if (Date.now() - modalEndedAtRef.current < 350) return;
      const store = useScene3DStore.getState();
      const obj = snapshotRef.current.objects.find((o) => o.id === objectId);
      const mesh = obj?.meshId ? snapshotRef.current.meshes.get(obj.meshId) : undefined;
      const poly = mesh?.faces[hit.face]?.v;
      if (!mesh || !poly) return;

      if (store.selectMode === 'face') {
        const cur = store.editSelection.faces;
        const next = additive
          ? cur.includes(hit.face)
            ? cur.filter((f) => f !== hit.face)
            : [...cur, hit.face]
          : cur.length === 1 && cur[0] === hit.face
            ? []
            : [hit.face];
        setEditSelection({ faces: next, verts: [], edges: [] });
        return;
      }

      const vpos = (vi: number) => ({
        x: mesh.vertices[vi * 3] ?? 0,
        y: mesh.vertices[vi * 3 + 1] ?? 0,
        z: mesh.vertices[vi * 3 + 2] ?? 0,
      });
      if (store.selectMode === 'vertex') {
        let best = poly[0]!;
        let bestD = Infinity;
        for (const vi of poly) {
          const p = vpos(vi);
          const d = (p.x - hit.local.x) ** 2 + (p.y - hit.local.y) ** 2 + (p.z - hit.local.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = vi;
          }
        }
        const cur = store.editSelection.verts;
        const next = additive
          ? cur.includes(best)
            ? cur.filter((v) => v !== best)
            : [...cur, best]
          : cur.length === 1 && cur[0] === best
            ? []
            : [best];
        setEditSelection({ verts: next, faces: [], edges: [] });
        return;
      }

      // Edge mode: nearest polygon edge to the hit point.
      let bestA = poly[0]!;
      let bestB = poly[1] ?? poly[0]!;
      let bestD = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const pa = vpos(a);
        const pb = vpos(b);
        const abx = pb.x - pa.x,
          aby = pb.y - pa.y,
          abz = pb.z - pa.z;
        const len2 = abx * abx + aby * aby + abz * abz || 1;
        let t =
          ((hit.local.x - pa.x) * abx + (hit.local.y - pa.y) * aby + (hit.local.z - pa.z) * abz) /
          len2;
        t = Math.max(0, Math.min(1, t));
        const dx = hit.local.x - (pa.x + t * abx);
        const dy = hit.local.y - (pa.y + t * aby);
        const dz = hit.local.z - (pa.z + t * abz);
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestA = Math.min(a, b);
          bestB = Math.max(a, b);
        }
      }
      const cur = store.editSelection.edges;
      const pairs: [number, number][] = [];
      for (let i = 0; i + 1 < cur.length; i += 2) pairs.push([cur[i]!, cur[i + 1]!]);
      const idx = pairs.findIndex(([a, b]) => a === bestA && b === bestB);
      let nextPairs: [number, number][];
      if (additive) {
        nextPairs = idx >= 0 ? pairs.filter((_, i) => i !== idx) : [...pairs, [bestA, bestB]];
      } else {
        nextPairs = pairs.length === 1 && idx === 0 ? [] : [[bestA, bestB]];
      }
      setEditSelection({ edges: nextPairs.flat(), faces: [], verts: [] });
    },
    [setEditSelection],
  );

  void clearSelection;

  const onStartModal = useCallback(
    (kind: ModalKind) => {
      const ids = useScene3DStore.getState().selection;
      if (ids.length === 0) return;
      const animTimeNow = useScene3DStore.getState().animTime;
      const base = new Map<string, Object3DSchema>();
      for (const id of ids) {
        const yo = room.slate.scene3dObjects().get(id);
        if (!yo) continue;
        const baseTransform = yo.get('transform') as Transform | undefined;
        if (!baseTransform) continue;
        // Start the modal from the pose the object is actually SHOWING: when
        // it's animated and the playhead is scrubbed, that's the sampled
        // keyframe pose, not the stored base transform — otherwise the object
        // would jump at drag start (and auto-key would record the jump).
        const anim = yo.get('anim') as Parameters<typeof sampleAnim>[0];
        const transform = sampleAnim(anim, animTimeNow) ?? baseTransform;
        base.set(id, {
          id,
          parentId: (yo.get('parentId') as string | null) ?? null,
          type: yo.get('type') as Object3DSchema['type'],
          name: (yo.get('name') as string) ?? 'Object',
          visible: (yo.get('visible') as boolean) ?? true,
          transform,
          meshId: (yo.get('meshId') as string | null) ?? null,
          materialId: (yo.get('materialId') as string | null) ?? null,
        });
      }
      if (base.size === 0) return;
      // G/R/S are one-shot modal previews (Blender). They must NOT change the
      // active tool: the gizmo stays on whatever the user picked (Move/Rotate/
      // Scale) and is only hidden while the modal runs (see ObjectGizmo). When
      // the modal confirms/cancels the gizmo reappears in the active mode.
      modalRef.current = startObjectModal(kind, base);
      setModalLabelText(modalLabel(modalRef.current));
      useScene3DStore.getState().setModal({ tool: kind });
      requestModalLock();
    },
    [room, requestModalLock],
  );

  // Blender-style modal mesh edits: E extrudes-and-follows-the-mouse,
  // G drags the selected verts/edges/faces.
  const onStartMeshModal = useCallback(
    (kind: MeshModalKind) => {
      const store = useScene3DStore.getState();
      const objectId = store.selection[0];
      if (!objectId || store.selection.length !== 1) return;
      const sel = store.editSelection;
      let state: MeshModalState | null = null;
      if (kind === 'bevel' || kind === 'inset' || kind === 'loop-cut') {
        state = startMeshScalar(room, objectId, kind, sel.faces, sel.verts);
      } else if (kind === 'extrude') {
        state = startMeshExtrude(room, objectId, sel.faces);
      } else {
        const obj = snapshotRef.current.objects.find((o) => o.id === objectId);
        const mesh = obj?.meshId ? snapshotRef.current.meshes.get(obj.meshId) : undefined;
        if (!mesh) return;
        const verts =
          sel.verts.length > 0
            ? sel.verts
            : sel.edges.length > 0
              ? [...new Set(sel.edges)]
              : [...new Set(sel.faces.flatMap((fi) => mesh.faces[fi]?.v ?? []))];
        state = startMeshGrab(room, objectId, verts, sel.faces, kind);
      }
      if (!state) return;
      meshModalRef.current = state;
      // For scalar ops (bevel/inset/loop-cut), apply the initial preview
      // immediately so the user sees the result before moving the mouse —
      // Blender shows the cut/bevel the moment you press the shortcut.
      if (state.scalar) {
        applyMeshScalar(room, state);
      }
      setModalLabelText(meshModalLabel(state));
      useScene3DStore.getState().setModal({ tool: kind });
      requestModalLock();
    },
    [room, requestModalLock],
  );

  const endMeshModal = useCallback(
    (commit: boolean) => {
      const state = meshModalRef.current;
      if (!state) return;
      meshModalRef.current = null;
      modalEndedAtRef.current = Date.now();
      setModalLabelText(null);
      releaseModalLock();
      useScene3DStore.getState().setModal({ tool: null });
      if (commit) {
        useScene3DStore.getState().setEditSelection({ faces: state.resultFaces, verts: [], edges: [] });
      } else {
        cancelMeshModal(room, state);
        useScene3DStore.getState().setEditSelection({ faces: state.baseFaces, verts: [], edges: [] });
      }
    },
    [room, releaseModalLock],
  );

  const onCancelModal = useCallback(() => {
    if (meshModalRef.current) {
      endMeshModal(false);
      return;
    }
    const state = modalRef.current;
    if (!state) return;
    room.slate.doc.transact(() => {
      for (const [id, snap] of state.snapshot) {
        setTransform(room.slate, id, snap.transform);
      }
    });
    modalRef.current = null;
    modalEndedAtRef.current = Date.now();
    setModalLabelText(null);
    releaseModalLock();
    useScene3DStore.getState().setModal({ tool: null });
  }, [room, endMeshModal, releaseModalLock]);

  const onConfirmModal = useCallback(() => {
    if (meshModalRef.current) {
      endMeshModal(true);
      return;
    }
    if (!modalRef.current) return;
    // Auto-key any animated objects at the playhead so a G/R/S edit made while
    // scrubbed to a time is recorded there (else it snaps back on release).
    const ids = [...modalRef.current.snapshot.keys()];
    modalRef.current = null;
    modalEndedAtRef.current = Date.now();
    setModalLabelText(null);
    releaseModalLock();
    useScene3DStore.getState().setModal({ tool: null });
    autoKeyframe(room.slate, ids, useScene3DStore.getState().animTime);
  }, [endMeshModal, releaseModalLock, room]);

  // Listen for modal keys globally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mesh = meshModalRef.current;
      if (mesh) {
        const k = e.key.toLowerCase();
        if (k === 'enter' || k === ' ') {
          e.preventDefault();
          onConfirmModal();
        } else if (k === 'escape') {
          e.preventDefault();
          onCancelModal();
        } else if (k === 'x' || k === 'y' || k === 'z') {
          // Axis lock: replaces the default direction; same key clears it.
          e.preventDefault();
          const axis = { x: 0, y: 0, z: 0, [k]: 1 } as { x: number; y: number; z: number };
          const same =
            mesh.lockDir && mesh.lockDir.x === axis.x && mesh.lockDir.y === axis.y && mesh.lockDir.z === axis.z;
          mesh.lockDir = same ? null : axis;
          setModalLabelText(meshModalLabel(mesh));
        }
        return;
      }
      const state = modalRef.current;
      if (!state) return;
      const r = handleModalKey(state, e);
      if (r.consumed) {
        e.preventDefault();
        setModalLabelText(modalLabel(state));
      }
      if (r.confirm) onConfirmModal();
      if (r.cancel) onCancelModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirmModal, onCancelModal]);

  // Track mouse for modal pixel delta + LMB to confirm / RMB to cancel.
  // Writes are throttled to ~30 Hz (pixel deltas keep accumulating, so
  // nothing is lost). Snapping: Blender-style Ctrl-to-snap, or inverted
  // when CAD snapping is on (snap by default, Ctrl frees the drag).
  const lastModalWriteRef = useRef(0);
  useEffect(() => {
    const snapTo = (v: number, step: number) => Math.round(v / step) * step;
    const snapping = (e: PointerEvent) =>
      e.ctrlKey !== ((room.slate.meta().get('cadSnap') as boolean | undefined) ?? false);
    const onMove = (e: PointerEvent) => {
      const mesh = meshModalRef.current;
      const state = modalRef.current;
      if (!mesh && !state) return;
      const now = performance.now();
      const target = mesh ?? state!;
      target.pixelDelta.x += e.movementX;
      target.pixelDelta.y += e.movementY;
      if (now - lastModalWriteRef.current < 33) return;
      lastModalWriteRef.current = now;

      const cam = cameraInfoRef.current;
      if (mesh) {
        // Scalar ops (bevel/inset): mouse distance sets the amount. Loop-cut's
        // count comes from the wheel handler, so its mouse move is a no-op
        // beyond keeping the preview fresh.
        if (mesh.scalar) {
          if (mesh.scalar.op === 'loop-cut') {
            // Move left/right to slide the cut along the ring (Blender-style).
            mesh.scalar.slide = Math.max(-1, Math.min(1, mesh.pixelDelta.x * 0.004));
          } else {
            const drag = mesh.pixelDelta.x + -mesh.pixelDelta.y;
            // ~half the diagonal at a full-screen drag; clamp to a sane range.
            // Bevel starts from the 5% baseline set on entry — computing the
            // amount from raw pixel delta (which starts at 0) collapsed the
            // bevel flat on the first mouse twitch, so scrolling segments
            // right after pressing the shortcut looked like it did nothing.
            const base = mesh.scalar.op === 'bevel' ? 0.05 : 0;
            mesh.scalar.amount = Math.max(0, Math.min(0.5, base + drag * 0.0015));
          }
          applyMeshScalar(room, mesh);
          setModalLabelText(meshModalLabel(mesh));
          return;
        }
        const s = cam?.pxScale ?? 0.01;
        const amount = mesh.pixelDelta.x + -mesh.pixelDelta.y;
        if (mesh.kind === 'rotate') {
          // Around the locked axis, or the view axis — like Blender's R.
          const axis = mesh.lockDir ?? cam?.basis.forward ?? { x: 0, y: 1, z: 0 };
          let angle = (amount * Math.PI) / 360;
          if (snapping(e)) angle = snapTo(angle, Math.PI / 12);
          writeVertices(room, mesh, rotateVertices(mesh, axis, angle));
          return;
        }
        if (mesh.kind === 'scale') {
          let k = Math.max(0.02, 1 + amount * 0.005);
          if (snapping(e)) k = Math.max(0.05, snapTo(k, 0.05));
          const factor = mesh.lockDir
            ? {
                x: mesh.lockDir.x ? k : 1,
                y: mesh.lockDir.y ? k : 1,
                z: mesh.lockDir.z ? k : 1,
              }
            : { x: k, y: k, z: k };
          writeVertices(room, mesh, scaleVertices(mesh, factor));
          return;
        }
        let delta: { x: number; y: number; z: number };
        if (mesh.lockDir) {
          // Extrude / axis-locked grab: geometry follows the mouse projected
          // onto the axis (the face normal for extrude), like Blender.
          const a = axisDragAmount(mesh.lockDir, mesh.pixelDelta, cam?.basis, s);
          delta = { x: mesh.lockDir.x * a, y: mesh.lockDir.y * a, z: mesh.lockDir.z * a };
        } else if (cam) {
          const dx = mesh.pixelDelta.x * s;
          const dy = -mesh.pixelDelta.y * s;
          delta = {
            x: cam.basis.right.x * dx + cam.basis.up.x * dy,
            y: cam.basis.right.y * dx + cam.basis.up.y * dy,
            z: cam.basis.right.z * dx + cam.basis.up.z * dy,
          };
        } else {
          delta = { x: 0, y: 0, z: 0 };
        }
        if (snapping(e)) {
          delta = {
            x: snapTo(delta.x, 0.25),
            y: snapTo(delta.y, 0.25),
            z: snapTo(delta.z, 0.25),
          };
        }
        applyMeshModal(room, mesh, delta);
        return;
      }

      const obj = state!;
      const delta = deltaFromModal(obj, cam?.pxScale ?? 0.01, cam?.basis);
      if (snapping(e)) {
        if (delta.translate) {
          delta.translate = {
            x: snapTo(delta.translate.x, 0.5),
            y: snapTo(delta.translate.y, 0.5),
            z: snapTo(delta.translate.z, 0.5),
          };
        }
        if (delta.rotate) {
          delta.rotate = {
            x: snapTo(delta.rotate.x, Math.PI / 12),
            y: snapTo(delta.rotate.y, Math.PI / 12),
            z: snapTo(delta.rotate.z, Math.PI / 12),
          };
        }
        if (delta.scale) {
          delta.scale = {
            x: Math.max(0.05, snapTo(delta.scale.x, 0.05)),
            y: Math.max(0.05, snapTo(delta.scale.y, 0.05)),
            z: Math.max(0.05, snapTo(delta.scale.z, 0.05)),
          };
        }
      }
      room.slate.doc.transact(() => {
        for (const [id, snap] of obj.snapshot) {
          setTransform(room.slate, id, applyDelta(snap.transform, delta));
        }
      });
      setModalLabelText(modalLabel(obj));
    };
    const onDown = (e: PointerEvent) => {
      const modalActive = !!(meshModalRef.current || modalRef.current);
      if (!modalActive) return;
      if (e.button !== 0 && e.button !== 2) return;
      // This is a capture-phase window listener, so it runs BEFORE the canvas's
      // OrbitControls pointerdown handler. The click that confirms/cancels a
      // modal must NOT also reach OrbitControls — otherwise it starts an orbit
      // drag and the view spins as the user keeps moving the mouse (the "bevel
      // rotates clockwise" bug). Swallow the event entirely.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.button === 0) onConfirmModal();
      else onCancelModal();
    };
    // Bevel/loop-cut: wheel changes the number of cuts/segments (Blender's
    // scroll-to-add). Both bevel and loop-cut use `cuts` — bevel segments =
    // resolution of the rounded chamfer, loop-cut cuts = number of edge
    // loops. The handler is attached to the viewport container in the CAPTURE
    // phase so it fires before OrbitControls' canvas-level wheel listener.
    const onWheel = (e: WheelEvent) => {
      const mesh = meshModalRef.current;
      if (!mesh?.scalar) return;
      if (mesh.scalar.op !== 'loop-cut' && mesh.scalar.op !== 'bevel') return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 1 : -1;
      // Both ops: scroll increases/decreases the number of cuts.
      mesh.scalar.cuts = Math.max(1, Math.min(20, (mesh.scalar.cuts ?? 1) + delta));
      applyMeshScalar(room, mesh);
      setModalLabelText(meshModalLabel(mesh));
    };
    // Attach to the container element (not window) in capture phase so this
    // fires BEFORE OrbitControls' wheel listener on the canvas.
    const container = containerRef.current;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown, true);
    if (container) container.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      if (container) container.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [room, onCancelModal, onConfirmModal]);

  // Blender-style guide line: while a modal transform runs, draw a dashed line
  // from the pivot to the cursor so you always see where the mouse is. Driven
  // imperatively (no per-frame React state) for smoothness.
  useEffect(() => {
    if (!modalLabelText) {
      const l = guideLineRef.current;
      if (l) l.style.display = 'none';
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const l = guideLineRef.current;
      const pivot = pivotScreenRef.current;
      if (!l || !pivot) {
        if (l) l.style.display = 'none';
        return;
      }
      const m = lastPointerRef.current;
      l.style.display = '';
      l.setAttribute('x1', String(pivot.x));
      l.setAttribute('y1', String(pivot.y));
      l.setAttribute('x2', String(m.x));
      l.setAttribute('y2', String(m.y));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [modalLabelText]);

  // Pointer lock is no longer used (cursor stays visible during modals), so
  // there's no lock-loss to recover from. Kept as a no-op for the hook below.
  useEffect(() => {
    const onLockChange = () => {
      if (document.pointerLockElement) return;
      if (meshModalRef.current || modalRef.current) onCancelModal();
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      if (document.pointerLockElement) document.exitPointerLock?.();
    };
  }, [onCancelModal]);

  /** Fly/pan must never start while a G/R/S drag owns the pointer — nor on
   *  the very press that just cancelled one (RMB cancel fires first). */
  const isModalActive = useCallback(
    () =>
      !!(modalRef.current || meshModalRef.current) ||
      Date.now() - modalEndedAtRef.current < 350,
    [],
  );

  // Shift+A: open the add menu at the cursor, clamped inside the viewport.
  const onOpenAddMenu = useCallback(() => {
    setAddMenuPos((cur) => {
      if (cur) return null; // pressing Shift+A again closes it
      const el = containerRef.current;
      const p = lastPointerRef.current;
      const w = el?.clientWidth ?? 800;
      const h = el?.clientHeight ?? 600;
      return {
        x: Math.max(8, Math.min(p.x, w - 176)),
        y: Math.max(8, Math.min(p.y, h - 360)),
      };
    });
  }, []);

  useEffect(() => {
    if (!addMenuPos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAddMenuPos(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [addMenuPos]);

  useViewport3DShortcuts({
    room,
    onFrameSelected: () => frameSelectedRef.current(false),
    onFrameAll: () => frameSelectedRef.current(true),
    onStartModal,
    onStartMeshModal,
    onCancelModal,
    onConfirmModal,
    onOpenAddMenu,
  });

  /** Set by ViewPresets — jumps the view into the scene camera. */
  const lookThroughRef = useRef<() => boolean>(() => false);
  /** Set by ViewPresets — points the view at the scene camera's pose sampled
   *  at time `t` (follows camera keyframes). Returns false with no camera. */
  const cameraFollowRef = useRef<(t: number) => boolean>(() => false);
  const [rendering, setRendering] = useState(false);

  // "Render image" — Blender F12 style: when the scene has a camera, render
  // from it (jump the view in, wait for the frames to draw, capture);
  // otherwise capture the current viewport.
  const onRenderImage = useCallback(() => {
    const capture = () => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${room.room}-render.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png');
    };
    const jumped = lookThroughRef.current();
    if (jumped) {
      // Give the render loop two frames to draw from the new pose.
      requestAnimationFrame(() => requestAnimationFrame(capture));
    } else {
      capture();
    }
  }, [room]);

  // "Render animation" — play the timeline through the scene camera (or the
  // current view when there's none) and record the canvas to a video. MP4
  // (H.264) is preferred so the file plays everywhere; browsers that can't
  // record MP4 fall back to WebM.
  const onRenderAnimation = useCallback(() => {
    if (rendering) return;
    const canvas = containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      toast({ title: 'Recording unsupported', description: 'This browser can’t record the canvas.', variant: 'error' });
      return;
    }
    const store = useScene3DStore.getState();
    const duration = store.animDuration;
    const hasAnim = snapshotRef.current.objects.some((o) => (o.anim?.length ?? 0) > 0);
    if (!hasAnim) {
      toast({ title: 'Nothing to render', description: 'Add keyframes on the timeline first (select an object, press I).' });
      return;
    }
    // Prefer MP4/H.264 (universally playable); fall back to WebM where the
    // browser can't encode MP4 from a canvas stream (e.g. Firefox).
    const mime = [
      'video/mp4;codecs=avc1.640028',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      toast({ title: 'Recording unsupported', variant: 'error' });
      return;
    }
    const isMp4 = mime.startsWith('video/mp4');
    const ext = isMp4 ? 'mp4' : 'webm';
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${room.room}-animation.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({
        title: 'Animation rendered',
        description: isMp4 ? 'Saved as an MP4 video.' : 'Saved as a WebM video (MP4 unsupported here).',
      });
    };

    // Freeze interactive playback; drive time ourselves for the render. The
    // store `rendering` flag hides viewport aids (camera glyphs, gizmo, grid).
    store.setAnimPlaying(false);
    store.setRendering(true);
    setRendering(true);
    const usingCamera = cameraFollowRef.current(0);
    store.setAnimTime(0);

    let start = 0;
    // Give React a frame to hide the viewport aids before recording starts.
    requestAnimationFrame(() => {
      recorder.start();
      const step = (now: number) => {
        if (!start) start = now;
        const t = (now - start) / 1000;
        const clamped = Math.min(t, duration);
        useScene3DStore.getState().setAnimTime(clamped);
        if (usingCamera) cameraFollowRef.current(clamped);
        if (t < duration) {
          requestAnimationFrame(step);
        } else {
          // Let the last frame paint, then finalize.
          requestAnimationFrame(() => {
            recorder.stop();
            const s = useScene3DStore.getState();
            s.setAnimTime(0);
            s.setRendering(false);
            setRendering(false);
          });
        }
      };
      requestAnimationFrame(step);
    });
  }, [room, rendering]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-bg overflow-hidden"
      style={{ touchAction: 'none', cursor: modalLabelText || leftHeld ? 'none' : 'default' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        lastPointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }}
      onPointerDownCapture={(e) => {
        // Only track left-held + hide cursor when the click lands on the 3D
        // canvas itself — NOT on UI overlays (timeline scrubber, toolbar
        // buttons, etc). Setting leftHeld on the timeline caused the range
        // input drag to conflict with cursor:none, producing a stop-sign
        // (not-allowed) cursor.
        const target = e.target as HTMLElement;
        const onCanvas = target.tagName === 'CANVAS';
        if (e.button === 0 && onCanvas) {
          pointerDownAtRef.current = { x: e.clientX, y: e.clientY };
          setLeftHeld(true);
        }
        // A slider/number input elsewhere (timeline, properties) keeps
        // keyboard focus after use and silently eats every hotkey. Clicking
        // into the viewport hands the keyboard back.
        const active = document.activeElement as HTMLElement | null;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) active.blur();
        // Blender-style camera view lock: the view stays locked to the scene
        // camera until you MMB (orbit/pan) out of it. LMB/RMB drags stay
        // locked so you can still select without leaving camera view.
        if (e.button === 1 && useScene3DStore.getState().viewingCameraId) {
          useScene3DStore.getState().setViewingCamera(null);
        }
      }}
      onPointerUpCapture={(e) => {
        if (e.button === 0) setLeftHeld(false);
      }}
      onPointerLeave={() => setLeftHeld(false)}
      onDragOver={(e) => {
        const items = [...(e.dataTransfer?.items ?? [])];
        if (items.some((i) => i.kind === 'file' || i.type === 'application/x-slate-asset')) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        // 1) A library asset dragged out of the Assets panel (Unity-style).
        const assetId = e.dataTransfer?.getData('application/x-slate-asset');
        if (assetId) {
          e.preventDefault();
          const objId = instantiateAsset(room.slate, assetId, {
            position: { x: 0, y: 0, z: 0 },
            selection: useScene3DStore.getState().selection,
          });
          if (objId) {
            useScene3DStore.getState().setSelection([objId]);
            toast({ title: 'Placed in scene', description: 'Press G to move it.' });
          }
          return;
        }
        // 2) Model files dropped from the OS.
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) =>
          /\.(obj|stl|ply|gltf|glb|fbx)$/i.test(f.name),
        );
        if (!files.length) return;
        e.preventDefault();
        void (async () => {
          const allIds: string[] = [];
          for (const file of files) {
            try {
              const ids = await importModel(room, file);
              allIds.push(...ids);
              toast({
                title: `Imported ${file.name}`,
                description: `${ids.length} object${ids.length === 1 ? '' : 's'} added to the scene`,
              });
            } catch (err) {
              toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' });
            }
          }
          // Select the freshly imported objects and frame the camera on them so
          // the model is immediately visible — regardless of how big/small the
          // source file's units were or where the camera was looking.
          if (allIds.length > 0) {
            useScene3DStore.getState().setSelection(allIds);
            requestAnimationFrame(() => frameSelectedRef.current(false));
          }
        })();
      }}
    >
      <Canvas
        camera={{ position: [4, 3, 4], fov: 50, near: 0.1, far: 200 }}
        shadows
        onPointerMissed={(e) => {
          // Don't clear when the click was confirming/cancelling a modal tool.
          if (modalRef.current || meshModalRef.current) return;
          if (Date.now() - modalEndedAtRef.current < 350) return;
          // Browsers fire `click` even after a long drag; an orbit/pan drag
          // must not deselect (that also hides the properties + material UI).
          const down = pointerDownAtRef.current;
          if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
          if (!e.shiftKey) clearSelection();
        }}
        // preserveDrawingBuffer lets "Render image" capture the canvas.
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={[bgColor]} />
        {shading === 'rendered' ? (
          // Rendered shading: the scene's own lights do the work (they're
          // emitted by SceneObjects); keep a moderate ambient so an unlit
          // scene is still visible while you add lights.
          <ambientLight intensity={0.35} />
        ) : (
          // Studio rig for wireframe/solid/material preview shading: full-
          // bright, even illumination — you should be able to see EVERYTHING
          // regardless of orientation, with no sun-like shadows (those belong
          // to 'rendered', where the scene's own lights do the work). A pair
          // of soft opposing directionals adds just enough face-to-face
          // gradient that geometry still reads as 3D instead of flat.
          <>
            <ambientLight intensity={1.15} />
            <hemisphereLight args={[0xffffff, 0xd8d8e6, 0.9]} />
            <directionalLight position={[6, 8, 5]} intensity={0.55} />
            <directionalLight position={[-6, -4, -5]} intensity={0.45} color="#e8ecff" />
          </>
        )}
        {showGrid && !rendering && (
          <Grid
            args={[20, 20]}
            cellSize={grid.cell}
            cellThickness={0.6}
            cellColor={viewportColors.cell}
            sectionSize={grid.section}
            sectionThickness={1.2}
            sectionColor={viewportColors.section}
            infiniteGrid
            fadeDistance={10000}
            fadeStrength={1}
            // followCamera keeps the grid centered under the camera as you
            // fly/orbit around — Blender's ground plane always sits under the
            // view, not stuck at the origin where it gets left behind.
            followCamera
          />
        )}
        <SceneObjects
          objects={snapshot.objects}
          meshes={snapshot.meshes}
          materials={snapshot.materials}
          selection={new Set(selection)}
          onObjectPick={onObjectPick}
          onElementPick={onElementPick}
          selectedFaces={editSelection.faces}
          selectedVerts={editSelection.verts}
          selectedEdges={editSelection.edges}
          shading={shading}
          editMode={editorMode === 'edit'}
          overrides={animOverrides}
          viewingCameraId={viewingCameraId}
          hideCameras={rendering}
          unit={units}
          showMeasurements={cadSnap}
        />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          // No maxDistance — let the user zoom out basically forever
          // (Blender-style). minDistance prevents clipping through the scene.
          minDistance={0.1}
          // Disable orbit/pan while a modal edit (bevel/grab/rotate/scale/
          // extrude/inset/loop-cut) owns the pointer — otherwise a drag both
          // drives the edit AND orbits the camera, so the mesh appears to spin
          // (the "bevel rotates clockwise" bug).
          enabled={!viewingCameraId && !modalTool}
          mouseButtons={{
            // Blender-style: MMB orbits, Shift+MMB pans, wheel zooms.
            // Left-drag also orbits (friendlier for mice/trackpads); plain
            // clicks still select.
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: shiftDown ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
            RIGHT: THREE.MOUSE.PAN,
          }}
          touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        />
        <FlyMode containerRef={containerRef} isModalActive={isModalActive} />
        <ObjectGizmo room={room} snapshot={snapshot} overrides={animOverrides} />
        <ViewPresets snapshot={snapshot} lookThroughRef={lookThroughRef} cameraFollowRef={cameraFollowRef} />
        <PivotProjector snapshot={snapshot} out={pivotScreenRef} />
        <CameraTracking out={cameraInfoRef} room={room} />
        <RemotePeers3D peers={awareness} selfId={room.identity.peerId} />
        <FrameSelectedBinding
          frameRef={frameSelectedRef}
          snapshot={snapshot}
          selection={selection}
        />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          {/* hideNegativeAxes=false keeps all six spheres so the axis letters
              stay visible no matter how the view is orbited. */}
          <GizmoViewport
            axisColors={['#f87171', '#22d3a5', '#7c6aff']}
            labelColor="white"
            hideNegativeAxes={false}
          />
        </GizmoHelper>
      </Canvas>
      <Toolbar3D
        room={room}
        snapshot={snapshot}
        onStartModal={onStartModal}
        onStartMeshModal={onStartMeshModal}
        onFrameSelected={() => frameSelectedRef.current(false)}
        onRenderImage={onRenderImage}
        onRenderAnimation={onRenderAnimation}
        rendering={rendering}
      />
      <Timeline room={room} snapshot={snapshot} />
      {rendering && (
        <div
          className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2 rounded-md border border-danger/60 bg-bg-2/95 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-danger shadow-lg backdrop-blur"
          role="status"
        >
          ● Recording animation…
        </div>
      )}
      {addMenuPos && (
        <AddObjectMenu room={room} pos={addMenuPos} onClose={() => setAddMenuPos(null)} />
      )}
      {viewingCameraId && (
        <>
          {/* Blender-style camera-view frame: a passe-partout border. */}
          <div className="pointer-events-none absolute inset-4 z-10 rounded-sm border-2 border-warn/50" />
          <div
            className="pointer-events-none absolute left-1/2 top-12 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-warn/60 bg-bg-2/95 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-warn shadow-lg backdrop-blur"
            role="status"
          >
            Camera view — MMB to exit
          </div>
        </>
      )}
      {showTransformHud && flying && (
        <div
          className="pointer-events-none absolute left-1/2 bottom-8 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-accent/60 bg-bg-2/95 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-accent shadow-lg backdrop-blur"
          role="status"
        >
          Fly — WASD move · Q/E down/up · Shift fast · wheel speed ({flySpeed.toFixed(1)}) · release MMB to exit
        </div>
      )}
      {showTransformHud && editorMode === 'edit' && !modalLabelText && !flying && (
        <div
          className="pointer-events-none absolute left-1/2 bottom-8 z-20 -translate-x-1/2 rounded-md border border-border bg-bg-2/95 px-3 py-1.5 text-xs text-text-dim backdrop-blur"
          role="status"
        >
          {selection.length === 0
            ? 'Edit mode — click an object to edit its mesh'
            : (() => {
                const obj = snapshot.objects.find((o) => o.id === selection[0]);
                const mesh = obj?.meshId ? snapshot.meshes.get(obj.meshId) : undefined;
                return editHudText(selectMode, editSelection, mesh?.vertices, obj?.transform);
              })()}
        </div>
      )}
      {showTransformHud && modalLabelText && (
        <div
          className="pointer-events-none absolute left-1/2 bottom-8 z-20 -translate-x-1/2 rounded-md border border-accent/60 bg-bg-2/95 backdrop-blur px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-accent shadow-lg"
          role="status"
        >
          {modalLabelText} — LMB / Enter to confirm, RMB / Esc to cancel
        </div>
      )}
      {/* Guide line from the pivot to the cursor during modal transforms. */}
      <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full" aria-hidden>
        <line
          ref={guideLineRef}
          style={{ display: 'none' }}
          stroke="var(--accent, #7c6aff)"
          strokeWidth={1}
          strokeDasharray="5 4"
          opacity={0.8}
        />
      </svg>
      {/* Kept left of the view gizmo, which owns the bottom-right corner. */}
      <div className="pointer-events-none absolute right-32 bottom-2 z-10 hidden rounded-md bg-bg-2/80 px-2 py-1 font-mono text-[10px] text-text-dim sm:block">
        {snapshot.objects.length} object{snapshot.objects.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}

/**
 * Projects the selection pivot (centroid of selected objects) to screen-space
 * container pixels each frame, so the DOM guide-line overlay can anchor to it.
 */
function PivotProjector({
  snapshot,
  out,
}: {
  snapshot: SceneSnapshot;
  out: React.MutableRefObject<{ x: number; y: number } | null>;
}) {
  const { camera, size } = useThree();
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  useFrame(() => {
    const sel = useScene3DStore.getState().selection;
    if (sel.length === 0) {
      out.current = null;
      return;
    }
    let x = 0, y = 0, z = 0, n = 0;
    for (const id of sel) {
      const o = snapRef.current.objects.find((ob) => ob.id === id);
      if (o) {
        x += o.transform.position.x;
        y += o.transform.position.y;
        z += o.transform.position.z;
        n++;
      }
    }
    if (n === 0) {
      out.current = null;
      return;
    }
    const v = new THREE.Vector3(x / n, y / n, z / n).project(camera);
    out.current = { x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height };
  });
  return null;
}

/**
 * Publishes the camera basis + world-units-per-pixel each frame so the modal
 * tool driver (which lives outside the R3F canvas) can map pointer motion
 * into the screen plane at the right sensitivity.
 */
function CameraTracking({
  out,
  room,
}: {
  out: React.MutableRefObject<CameraInfo | null>;
  room: SlateRoom;
}) {
  const { camera, controls, size } = useThree();
  const lastPublish = useRef({ t: 0, key: '' });
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const forward = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const target = (controls as { target?: THREE.Vector3 } | null)?.target;
    const dist = target ? cam.position.distanceTo(target) : Math.max(cam.position.length(), 1);
    const pxScale =
      (2 * Math.max(dist, 0.5) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) /
      Math.max(size.height, 1);
    out.current = {
      basis: {
        right: { x: right.x, y: right.y, z: right.z },
        up: { x: up.x, y: up.y, z: up.z },
        forward: { x: forward.x, y: forward.y, z: forward.z },
      },
      pxScale,
    };
    // Publish "where we're looking" so a model import lands at the orbit target
    // sized to the current view, not at the world origin at a fixed size.
    const focusT = target ?? new THREE.Vector3();
    setCameraFocus({
      center: { x: focusT.x, y: focusT.y, z: focusT.z },
      viewSize: pxScale * size.height,
      ts: performance.now(),
    });
    // Publish the camera pose so other peers can see where we're looking.
    // Throttled and change-gated — awareness messages count against the
    // server's per-peer rate limit. During fly mode (walk navigation) we
    // publish more often so remote peers see the camera move smoothly in
    // real time instead of snapping once on release.
    const now = performance.now();
    const flying = useScene3DStore.getState().flying;
    const interval = flying ? 50 : 150;
    if (now - lastPublish.current.t < interval) return;
    const t = target ?? new THREE.Vector3();
    const r = (n: number) => Math.round(n * 100) / 100;
    const p: [number, number, number] = [r(cam.position.x), r(cam.position.y), r(cam.position.z)];
    const tt: [number, number, number] = [r(t.x), r(t.y), r(t.z)];
    const key = p.join(',') + '|' + tt.join(',');
    if (key === lastPublish.current.key) return;
    lastPublish.current = { t: now, key };
    room.setLocalAwareness({ cam: { p, t: tt } });
  });
  return null;
}

/** Other peers' cameras: a colored wire pyramid at their eye, name attached. */
function RemotePeers3D({ peers, selfId }: { peers: AwarenessState[]; selfId: string }) {
  const remote = peers.filter((p) => p.id !== selfId && p.cam);
  if (remote.length === 0) return null;
  return (
    <>
      {remote.map((p) => (
        <PeerCamera key={p.id} state={p} />
      ))}
    </>
  );
}

/** Blender-style camera glyph: wire frustum + up-triangle, apex at the eye. */
const PEER_CAM_LINES = (() => {
  const w = 0.42, h = 0.28, d = 0.85; // frustum half-extents + depth
  const a = [0, 0, 0];
  const c = [
    [-w, h, d], [w, h, d], [w, -h, d], [-w, -h, d],
  ];
  const seg: number[] = [];
  for (const p of c) seg.push(...a, ...p); // apex → corners
  for (let i = 0; i < 4; i++) seg.push(...c[i]!, ...c[(i + 1) % 4]!); // rect
  // Up indicator above the top edge.
  seg.push(-w * 0.5, h, d, 0, h + 0.18, d);
  seg.push(0, h + 0.18, d, w * 0.5, h, d);
  seg.push(w * 0.5, h, d, -w * 0.5, h, d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
  return g;
})();

function PeerCamera({ state }: { state: AwarenessState }) {
  const cam = state.cam!;
  const groupRef = useRef<THREE.Group | null>(null);
  // Poses arrive ~6/s; damp per frame so remote cameras glide, not hop.
  const targetPos = useRef(new THREE.Vector3(cam.p[0], cam.p[1], cam.p[2]));
  const lookCur = useRef(new THREE.Vector3(cam.t[0], cam.t[1], cam.t[2]));
  const lookTarget = useRef(new THREE.Vector3(cam.t[0], cam.t[1], cam.t[2]));
  targetPos.current.set(cam.p[0], cam.p[1], cam.p[2]);
  lookTarget.current.set(cam.t[0], cam.t[1], cam.t[2]);
  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g) return;
    // Frame-rate-independent smoothing (~90 ms time constant); teleport when
    // the peer jumps far so the glyph never streaks across the whole scene.
    if (g.position.distanceToSquared(targetPos.current) > 400) {
      g.position.copy(targetPos.current);
      lookCur.current.copy(lookTarget.current);
    } else {
      const k = 1 - Math.exp(-delta * 11);
      g.position.lerp(targetPos.current, k);
      lookCur.current.lerp(lookTarget.current, k);
    }
    g.lookAt(lookCur.current);
  });
  return (
    <group ref={groupRef} position={[cam.p[0], cam.p[1], cam.p[2]]}>
      <lineSegments geometry={PEER_CAM_LINES} raycast={() => null}>
        <lineBasicMaterial color={state.color} transparent opacity={0.9} />
      </lineSegments>
      {/* Small solid eye so the camera reads at a distance. */}
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.06, 10, 10]} />
        <meshBasicMaterial color={state.color} />
      </mesh>
      <Html position={[0, 0.55, 0]} center distanceFactor={14} occlude={false}>
        <div
          className="pointer-events-none w-max max-w-[140px] truncate rounded-full px-1.5 py-px text-[10px] font-medium leading-4 text-black/85 shadow"
          style={{ backgroundColor: state.color }}
        >
          {state.name}
        </div>
      </Html>
    </group>
  );
}

function editHudText(
  mode: 'vertex' | 'edge' | 'face',
  sel: { verts: number[]; edges: number[]; faces: number[] },
  vertices?: number[],
  transform?: { scale: { x: number; y: number; z: number } },
): string {
  const counts: Record<string, number> = {
    vertex: sel.verts.length,
    edge: sel.edges.length / 2,
    face: sel.faces.length,
  };
  const n = counts[mode] ?? 0;
  if (n === 0) {
    const noun = mode === 'vertex' ? 'vertex' : mode;
    return `Click a ${noun} to select it · Shift+Click adds · 1/2/3 switch vert/edge/face`;
  }
  const plural = mode === 'vertex' ? 'vertices' : `${mode}s`;
  // CAD-style measurements (Blender's N-panel): edge lengths + face area.
  if (mode === 'edge' && vertices && vertices.length >= 3 && transform) {
    let total = 0;
    for (let i = 0; i + 1 < sel.edges.length; i += 2) {
      const a = sel.edges[i]!;
      const b = sel.edges[i + 1]!;
      const ax = (vertices[a * 3] ?? 0) * transform.scale.x;
      const ay = (vertices[a * 3 + 1] ?? 0) * transform.scale.y;
      const az = (vertices[a * 3 + 2] ?? 0) * transform.scale.z;
      const bx = (vertices[b * 3] ?? 0) * transform.scale.x;
      const by = (vertices[b * 3 + 1] ?? 0) * transform.scale.y;
      const bz = (vertices[b * 3 + 2] ?? 0) * transform.scale.z;
      total += Math.hypot(bx - ax, by - ay, bz - az);
    }
    return `${n} ${n === 1 ? 'edge' : plural} selected — length ${total.toFixed(3)} m · G moves`;
  }
  if (mode === 'face') {
    return `${n} ${n === 1 ? 'face' : plural} selected · E extrudes · G moves`;
  }
  const verb = ' · G moves';
  return `${n} ${n === 1 ? (mode === 'vertex' ? 'vertex' : mode) : plural} selected${verb}`;
}

/** Blender-style numpad view presets: 1 front, 3 right, 7 top, 0 camera. */
function ViewPresets({
  snapshot,
  lookThroughRef,
  cameraFollowRef,
}: {
  snapshot: SceneSnapshot;
  lookThroughRef: React.MutableRefObject<() => boolean>;
  cameraFollowRef?: React.MutableRefObject<(t: number) => boolean>;
}) {
  const { camera, controls } = useThree();
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  // Point the R3F camera at the scene camera's pose sampled at time `t`, so
  // an animation render follows keyframed camera moves. Returns false when
  // there's no scene camera.
  useEffect(() => {
    if (!cameraFollowRef) return;
    cameraFollowRef.current = (t: number) => {
      const sel = useScene3DStore.getState().selection;
      const cams = snapRef.current.objects.filter((o) => o.type === 'camera');
      const cam = cams.find((o) => sel.includes(o.id)) ?? cams[0];
      if (!cam) return false;
      const tr = (cam.anim?.length ? sampleAnim(cam.anim, t) : null) ?? cam.transform;
      const dir = new THREE.Vector3(0, -1, 0).applyEuler(
        new THREE.Euler(tr.rotation.x, tr.rotation.y, tr.rotation.z),
      );
      camera.position.set(tr.position.x, tr.position.y, tr.position.z);
      const persp = camera as THREE.PerspectiveCamera;
      persp.fov = cam.camera?.fov ?? 50;
      persp.updateProjectionMatrix();
      camera.lookAt(new THREE.Vector3().copy(camera.position).addScaledVector(dir, 8));
      return true;
    };
  }, [camera, cameraFollowRef]);

  // Jump the viewport into the selected (or first) scene camera. Shared by
  // Numpad 0 and the render button. Returns false when the scene has none.
  useEffect(() => {
    lookThroughRef.current = () => {
      const sel = useScene3DStore.getState().selection;
      const cams = snapRef.current.objects.filter((o) => o.type === 'camera');
      const cam = cams.find((o) => sel.includes(o.id)) ?? cams[0];
      if (!cam) return false;
      const t = cam.transform;
      const dir = new THREE.Vector3(0, -1, 0).applyEuler(
        new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z),
      );
      camera.position.set(t.position.x, t.position.y, t.position.z);
      const persp = camera as THREE.PerspectiveCamera;
      persp.fov = cam.camera?.fov ?? 50;
      persp.updateProjectionMatrix();
      (controls as { target?: THREE.Vector3 } | null)?.target?.copy(
        new THREE.Vector3().copy(camera.position).addScaledVector(dir, 8),
      );
      (controls as { update?: () => void } | null)?.update?.();
      // Enter "camera view": the glyph hides and a frame HUD shows until the
      // user orbits/flies away (Blender's Numpad 0 behavior).
      useScene3DStore.getState().setViewingCamera(cam.id);
      return true;
    };
  }, [camera, controls, lookThroughRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (useScene3DStore.getState().flying) return;
      if (e.code === 'Numpad0') {
        if (lookThroughRef.current()) e.preventDefault();
        return;
      }
      let dir: THREE.Vector3 | null = null;
      if (e.code === 'Numpad1') dir = new THREE.Vector3(0, 0, 1);
      else if (e.code === 'Numpad3') dir = new THREE.Vector3(1, 0, 0);
      else if (e.code === 'Numpad7') dir = new THREE.Vector3(0.0001, 1, 0.0001);
      if (!dir) return;
      // Ctrl+Numpad flips to the opposite view (back/left/bottom), as in Blender.
      if (e.ctrlKey) dir.negate();
      e.preventDefault();
      const t = (controls as { target?: THREE.Vector3 } | null)?.target ?? new THREE.Vector3();
      const dist = camera.position.distanceTo(t) || 8;
      camera.position.copy(t.clone().add(dir.normalize().multiplyScalar(dist)));
      (controls as { update?: () => void } | null)?.update?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [camera, controls]);
  return null;
}

/**
 * Tiny in-canvas component that captures `useThree` and exposes a callback
 * to frame the current selection. Kept inside <Canvas> so it has access to
 * the camera and controls.
 */
function FrameSelectedBinding({
  frameRef,
  snapshot,
  selection,
}: {
  frameRef: React.MutableRefObject<(all: boolean) => void>;
  snapshot: SceneSnapshot;
  selection: string[];
}) {
  const { camera, controls } = useThree();
  useFrame(() => {});
  useEffect(() => {
    frameRef.current = (all: boolean) => {
      // Frame the selection; with `all` (or nothing selected), frame the scene.
      const ids = !all && selection.length > 0 ? selection : snapshot.objects.map((o) => o.id);
      // Build a world-space bounding box from each object's mesh vertices
      // (transformed by position/rotation/scale) — not just its origin point.
      // A model imported at the origin would otherwise frame as a zero-size
      // point and the camera would dive inside it.
      const box = new THREE.Box3();
      let any = false;
      for (const id of ids) {
        const obj = snapshot.objects.find((o) => o.id === id);
        if (!obj) continue;
        const mesh = obj.meshId ? snapshot.meshes.get(obj.meshId) : undefined;
        if (mesh && mesh.vertices.length > 0) {
          // Local AABB of the raw vertices.
          const min = new THREE.Vector3(Infinity, Infinity, Infinity);
          const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
          for (let i = 0; i < mesh.vertices.length; i += 3) {
            min.min(new THREE.Vector3(mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!));
            max.max(new THREE.Vector3(mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!));
          }
          // Transform the 8 corners into world space and expand the box.
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(obj.transform.position.x, obj.transform.position.y, obj.transform.position.z),
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(obj.transform.rotation.x, obj.transform.rotation.y, obj.transform.rotation.z),
            ),
            new THREE.Vector3(obj.transform.scale.x, obj.transform.scale.y, obj.transform.scale.z),
          );
          const corners = [
            new THREE.Vector3(min.x, min.y, min.z),
            new THREE.Vector3(max.x, min.y, min.z),
            new THREE.Vector3(min.x, max.y, min.z),
            new THREE.Vector3(max.x, max.y, min.z),
            new THREE.Vector3(min.x, min.y, max.z),
            new THREE.Vector3(max.x, min.y, max.z),
            new THREE.Vector3(min.x, max.y, max.z),
            new THREE.Vector3(max.x, max.y, max.z),
          ].map((c) => c.applyMatrix4(m));
          for (const c of corners) box.expandByPoint(c);
          any = true;
        } else {
          // Lights / empties: just their position.
          box.expandByPoint(
            new THREE.Vector3(obj.transform.position.x, obj.transform.position.y, obj.transform.position.z),
          );
          any = true;
        }
      }
      if (!any) return;
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      // Pad so the object isn't flush against the frame edge, and never let a
      // degenerate (point) box dive the camera inside the model.
      const padded = size.clone().max(new THREE.Vector3(0.5, 0.5, 0.5)).multiplyScalar(1.25);
      const radius = Math.max(padded.length() / 2, 1.5);
      const dir = new THREE.Vector3()
        .subVectors(camera.position, (controls as { target?: THREE.Vector3 })?.target ?? new THREE.Vector3())
        .normalize();
      if (!Number.isFinite(dir.x) || dir.lengthSq() < 1e-9) dir.set(1, 0.8, 1).normalize();
      camera.position.copy(center.clone().add(dir.multiplyScalar(radius)));
      (controls as { target?: THREE.Vector3 } | null)?.target?.copy(center);
      (controls as { update?: () => void } | null)?.update?.();
    };
  }, [camera, controls, snapshot, selection, frameRef]);
  return null;
}
