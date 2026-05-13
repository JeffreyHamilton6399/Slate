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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  OrbitControls,
} from '@react-three/drei';
import * as THREE from 'three';
import type { Object3D as Object3DSchema, Transform } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { Toolbar3D } from './Toolbar3D';
import { SceneObjects } from './SceneObjects';
import { useScene3DStore } from './store';
import { readSceneSnapshot, setTransform, type SceneSnapshot } from './scene';
import { useViewport3DShortcuts } from './useViewport3DShortcuts';
import {
  applyDelta,
  deltaFromModal,
  handleModalKey,
  modalLabel,
  startObjectModal,
  type ModalKind,
  type ObjectModalState,
} from './modalTools';

interface Viewport3DProps {
  room: SlateRoom;
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
  const showWireframe = useScene3DStore((s) => s.showWireframe);

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
    return () => {
      objects.unobserveDeep(refresh);
      meshes.unobserveDeep(refresh);
      materials.unobserveDeep(refresh);
    };
  }, [room]);

  // Modal tool state — independent of zustand so high-frequency updates
  // don't trigger React re-renders.
  const modalRef = useRef<ObjectModalState | null>(null);
  const [modalLabelText, setModalLabelText] = useState<string | null>(null);
  const frameSelectedRef = useRef<() => void>(() => {});

  const onObjectPick = useCallback(
    (id: string, additive: boolean) => {
      if (additive) toggleSelection(id);
      else setSelection([id]);
    },
    [setSelection, toggleSelection],
  );

  void clearSelection;

  const onStartModal = useCallback(
    (kind: ModalKind) => {
      const ids = useScene3DStore.getState().selection;
      if (ids.length === 0) return;
      const base = new Map<string, Object3DSchema>();
      for (const id of ids) {
        const yo = room.slate.scene3dObjects().get(id);
        if (!yo) continue;
        const transform = yo.get('transform') as Transform | undefined;
        if (!transform) continue;
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
      modalRef.current = startObjectModal(kind, base);
      setModalLabelText(modalLabel(modalRef.current));
    },
    [room],
  );

  const onCancelModal = useCallback(() => {
    const state = modalRef.current;
    if (!state) return;
    room.slate.doc.transact(() => {
      for (const [id, snap] of state.snapshot) {
        setTransform(room.slate, id, snap.transform);
      }
    });
    modalRef.current = null;
    setModalLabelText(null);
  }, [room]);

  const onConfirmModal = useCallback(() => {
    modalRef.current = null;
    setModalLabelText(null);
  }, []);

  // Listen for modal keys globally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const state = modalRef.current;
      if (!state) return;
      state.pixelDelta.x += e.movementX;
      state.pixelDelta.y += e.movementY;
      const delta = deltaFromModal(state, 0.01);
      room.slate.doc.transact(() => {
        for (const [id, snap] of state.snapshot) {
          setTransform(room.slate, id, applyDelta(snap.transform, delta));
        }
      });
      setModalLabelText(modalLabel(state));
    };
    const onDown = (e: PointerEvent) => {
      if (!modalRef.current) return;
      if (e.button === 0) {
        onConfirmModal();
      } else if (e.button === 2) {
        onCancelModal();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [room, onCancelModal, onConfirmModal]);

  useViewport3DShortcuts({
    room,
    onFrameSelected: () => frameSelectedRef.current(),
    onStartModal,
    onCancelModal,
    onConfirmModal,
  });

  return (
    <div
      className="relative h-full w-full bg-bg overflow-hidden"
      style={{ touchAction: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        camera={{ position: [4, 3, 4], fov: 50, near: 0.1, far: 200 }}
        shadows
        onPointerMissed={(e) => {
          if (!e.shiftKey) clearSelection();
        }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#0c0c0e']} />
        <ambientLight intensity={0.55} />
        <directionalLight
          position={[6, 8, 5]}
          intensity={1.1}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-4, 3, -3]} intensity={0.35} />
        {showGrid && (
          <Grid
            args={[20, 20]}
            cellSize={1}
            cellThickness={0.6}
            cellColor="#252530"
            sectionSize={5}
            sectionThickness={1.2}
            sectionColor="#7c6aff"
            infiniteGrid
            fadeDistance={40}
            fadeStrength={1}
            followCamera={false}
          />
        )}
        <SceneObjects
          objects={snapshot.objects}
          meshes={snapshot.meshes}
          materials={snapshot.materials}
          selection={new Set(selection)}
          onObjectPick={onObjectPick}
          wireframe={showWireframe}
        />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          mouseButtons={{
            LEFT: undefined as unknown as THREE.MOUSE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN,
          }}
          touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        />
        <FrameSelectedBinding
          frameRef={frameSelectedRef}
          snapshot={snapshot}
          selection={selection}
        />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport axisColors={['#f87171', '#22d3a5', '#7c6aff']} labelColor="white" />
        </GizmoHelper>
      </Canvas>
      <Toolbar3D
        room={room}
        onStartModal={onStartModal}
        onFrameSelected={() => frameSelectedRef.current()}
      />
      {modalLabelText && (
        <div
          className="pointer-events-none absolute left-1/2 bottom-8 z-20 -translate-x-1/2 rounded-md border border-accent/60 bg-bg-2/95 backdrop-blur px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-accent shadow-lg"
          role="status"
        >
          {modalLabelText} — LMB / Enter to confirm, RMB / Esc to cancel
        </div>
      )}
      <div className="pointer-events-none absolute right-2 bottom-2 z-10 rounded-md bg-bg-2/80 px-2 py-1 font-mono text-[10px] text-text-dim">
        {snapshot.objects.length} object{snapshot.objects.length === 1 ? '' : 's'}
      </div>
    </div>
  );
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
  frameRef: React.MutableRefObject<() => void>;
  snapshot: SceneSnapshot;
  selection: string[];
}) {
  const { camera, controls } = useThree();
  useFrame(() => {});
  useEffect(() => {
    frameRef.current = () => {
      if (selection.length === 0) return;
      const positions: THREE.Vector3[] = [];
      for (const id of selection) {
        const obj = snapshot.objects.find((o) => o.id === id);
        if (!obj) continue;
        positions.push(
          new THREE.Vector3(obj.transform.position.x, obj.transform.position.y, obj.transform.position.z),
        );
      }
      if (positions.length === 0) return;
      const box = new THREE.Box3().setFromPoints(positions);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const radius = Math.max(size.length() / 2, 1) * 1.5;
      const dir = new THREE.Vector3()
        .subVectors(camera.position, (controls as { target?: THREE.Vector3 })?.target ?? new THREE.Vector3())
        .normalize();
      camera.position.copy(center.clone().add(dir.multiplyScalar(radius)));
      (controls as { target?: THREE.Vector3 } | null)?.target?.copy(center);
      (controls as { update?: () => void } | null)?.update?.();
    };
  }, [camera, controls, snapshot, selection, frameRef]);
  return null;
}
