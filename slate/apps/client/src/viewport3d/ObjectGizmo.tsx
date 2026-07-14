/**
 * Blender-style transform gizmo on the selected object (the "active tool"
 * arrows/rings/boxes). The gizmo drives an invisible proxy group; drags are
 * committed to Yjs at ~30 Hz, and the proxy re-syncs from the document
 * whenever the object changes underneath (remote edits, undo).
 *
 * Keyboard G/R/S remain the modal tools — this is the mouse-first path.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import type { Transform } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { useBoardCadSnap } from '../sync/useBoardSettings';
import { autoKeyframe, setTransform, type SceneSnapshot } from './scene';
import { useScene3DStore } from './store';

export function ObjectGizmo({
  room,
  snapshot,
  overrides,
}: {
  room: SlateRoom;
  snapshot: SceneSnapshot;
  /** Sampled keyframe poses (playhead). Gizmo syncs from these so it stays
   *  attached to the visible mesh during animation scrubbing. */
  overrides?: Map<string, Transform> | null;
}) {
  const gizmo = useScene3DStore((s) => s.gizmo);
  const space = useScene3DStore((s) => s.space);
  const editorMode = useScene3DStore((s) => s.editorMode);
  const selection = useScene3DStore((s) => s.selection);
  const [cadSnap] = useBoardCadSnap(room);

  const proxyRef = useRef<THREE.Group>(new THREE.Group());
  const draggingRef = useRef(false);
  const lastWriteRef = useRef(0);

  const id = selection.length === 1 ? selection[0]! : null;
  const obj = id ? snapshot.objects.find((o) => o.id === id) : undefined;
  // The transform the gizmo should mirror: the sampled (animated) pose when
  // scrubbing, otherwise the document's base transform. This keeps the gizmo
  // attached to the visible mesh instead of desyncing during animation.
  const displayTransform = (id && overrides?.get(id)) ?? obj?.transform;
  // Hidden while a G/R/S modal runs: the click that confirms the modal lands
  // where the object (and so the gizmo) sits, and would otherwise start an
  // unintended gizmo drag — the "grab glitches out" bug.
  const modalTool = useScene3DStore((s) => s.modal.tool);
  const rendering = useScene3DStore((s) => s.rendering);
  const active = Boolean(gizmo && obj && editorMode === 'object' && !modalTool && !rendering);

  // Keep the proxy in sync with the displayed transform while not dragging.
  useEffect(() => {
    if (draggingRef.current || !displayTransform) return;
    const p = proxyRef.current;
    p.position.set(displayTransform.position.x, displayTransform.position.y, displayTransform.position.z);
    p.rotation.set(displayTransform.rotation.x, displayTransform.rotation.y, displayTransform.rotation.z);
    p.scale.set(displayTransform.scale.x, displayTransform.scale.y, displayTransform.scale.z);
  }, [displayTransform]);

  const commit = (force = false) => {
    if (!id) return;
    const now = performance.now();
    if (!force && now - lastWriteRef.current < 33) return;
    lastWriteRef.current = now;
    const p = proxyRef.current;
    // Keep scale strictly positive: dragging a scale handle through the
    // origin would otherwise flip an axis negative, which turns the mesh
    // inside-out and inverts the gizmo cones. Blender allows it, but here
    // it reads as a bug, so we clamp to a tiny positive epsilon.
    const posScale = (v: number) => (Math.abs(v) < 1e-3 ? 1e-3 : Math.abs(v));
    setTransform(room.slate, id, {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z },
      scale: { x: posScale(p.scale.x), y: posScale(p.scale.y), z: posScale(p.scale.z) },
    });
  };

  const onDown = () => {
    draggingRef.current = true;
    useScene3DStore.getState().setGizmoDragging(true);
  };
  const onUp = () => {
    draggingRef.current = false;
    useScene3DStore.getState().setGizmoDragging(false);
    commit(true);
    // Auto-key: if this object is animated, record the new pose at the
    // playhead so the edit sticks instead of snapping back to the nearest
    // existing keyframe.
    if (id) autoKeyframe(room.slate, [id], useScene3DStore.getState().animTime);
  };
  const onChange = () => {
    if (draggingRef.current) commit();
  };

  // 'all' shows the three gizmos at once; otherwise the single chosen mode.
  const modes: ('translate' | 'rotate' | 'scale')[] =
    gizmo === 'all' ? ['translate', 'rotate', 'scale'] : [gizmo as 'translate' | 'rotate' | 'scale'];

  return (
    <>
      <primitive object={proxyRef.current} />
      {active &&
        modes.map((mode) => (
          <GizmoControl
            key={mode}
            proxy={proxyRef.current}
            mode={mode}
            space={space}
            cadSnap={cadSnap}
            onDown={onDown}
            onUp={onUp}
            onChange={onChange}
          />
        ))}
    </>
  );
}

/** One drei TransformControls bound to the shared proxy. Split out so the
 *  combined 'all' mode can mount move + rotate + scale together. */
function GizmoControl({
  proxy,
  mode,
  space,
  cadSnap,
  onDown,
  onUp,
  onChange,
}: {
  proxy: THREE.Group;
  mode: 'translate' | 'rotate' | 'scale';
  space: 'world' | 'local';
  cadSnap: boolean;
  onDown: () => void;
  onUp: () => void;
  onChange: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);

  // Blender's scale gizmo is just three axis handles — three.js also draws the
  // planar (XY/YZ/XZ) and center uniform (XYZ) handles, which read as stray
  // cubes/planes. three.js re-asserts each handle's visibility every frame in
  // the gizmo's updateMatrixWorld, so a one-shot hide won't stick; we patch
  // the visual root's updateMatrixWorld to force the unwanted handles hidden
  // after each update. Works whether drei's ref is the modern controls
  // (Object3D via getHelper()) or the legacy TransformControls Object3D.
  useEffect(() => {
    if (mode !== 'scale') return;
    const ctrl = controlsRef.current;
    const root: THREE.Object3D | null =
      ctrl && typeof ctrl.getHelper === 'function'
        ? ctrl.getHelper()
        : ctrl && typeof ctrl.traverse === 'function'
          ? ctrl
          : null;
    if (!root) return;
    const HIDE = new Set(['XY', 'YZ', 'XZ', 'XYZ']);
    const original = root.updateMatrixWorld.bind(root);
    root.updateMatrixWorld = function (force?: boolean) {
      original(force);
      root.traverse((o) => {
        if (HIDE.has(o.name)) o.visible = false;
      });
    };
    return () => {
      root.updateMatrixWorld = original;
    };
  });

  return (
    <TransformControls
      ref={controlsRef as never}
      object={proxy}
      mode={mode}
      // World = handles align to global axes (default, no inversion);
      // Local = handles follow the object's own rotation (Blender's Local).
      // Scale mode is always object-local in three.js regardless.
      space={space}
      size={0.85}
      translationSnap={cadSnap ? 0.5 : null}
      rotationSnap={cadSnap ? Math.PI / 12 : null}
      scaleSnap={cadSnap ? 0.05 : null}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onObjectChange={onChange}
    />
  );
}
