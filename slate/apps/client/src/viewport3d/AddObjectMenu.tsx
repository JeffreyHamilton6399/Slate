/**
 * Blender's Shift+A "Add" menu — a floating menu at the cursor listing
 * everything that can be added to the 3D scene: mesh primitives, lights,
 * and an empty. The toolbar's Add dropdown reuses the same item lists.
 */

import {
  Axis3d,
  Box,
  Circle,
  Cone,
  Cylinder,
  Flashlight,
  Lightbulb,
  RectangleHorizontal,
  Square,
  Sun,
  SunMedium,
  Torus,
  Video,
} from 'lucide-react';
import type { LightKind, Object3DType } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { addCamera, addEmpty, addLight, addPrimitive } from './scene';
import { useScene3DStore } from './store';

export type PrimitiveType = Exclude<Object3DType, 'folder' | 'mesh' | 'empty' | 'light' | 'camera'>;

export const MESH_ITEMS: { type: PrimitiveType; label: string; Icon: typeof Box }[] = [
  { type: 'cube', label: 'Cube', Icon: Box },
  { type: 'sphere', label: 'Sphere', Icon: Circle },
  { type: 'cylinder', label: 'Cylinder', Icon: Cylinder },
  { type: 'cone', label: 'Cone', Icon: Cone },
  { type: 'plane', label: 'Plane', Icon: Square },
  { type: 'torus', label: 'Torus', Icon: Torus },
];

export const LIGHT_ITEMS: { kind: LightKind; label: string; Icon: typeof Box }[] = [
  { kind: 'point', label: 'Point', Icon: Lightbulb },
  { kind: 'sun', label: 'Sun', Icon: Sun },
  { kind: 'spot', label: 'Spot', Icon: Flashlight },
  { kind: 'area', label: 'Area', Icon: RectangleHorizontal },
  { kind: 'hemisphere', label: 'Hemisphere', Icon: SunMedium },
];

/** Add an object of any menu kind and select it (Blender selects on add). */
export function addSceneObject(
  room: SlateRoom,
  item: { mesh: PrimitiveType } | { light: LightKind } | { camera: true } | { empty: true },
): void {
  const { id } =
    'mesh' in item
      ? addPrimitive(room.slate, { type: item.mesh })
      : 'light' in item
        ? addLight(room.slate, item.light)
        : 'camera' in item
          ? addCamera(room.slate)
          : addEmpty(room.slate);
  useScene3DStore.getState().setSelection([id]);
}

export function AddObjectMenu({
  room,
  pos,
  onClose,
}: {
  room: SlateRoom;
  pos: { x: number; y: number };
  onClose: () => void;
}) {
  const add = (item: Parameters<typeof addSceneObject>[1]) => {
    addSceneObject(room, item);
    onClose();
  };
  return (
    <>
      {/* Click-away backdrop. */}
      <div
        className="absolute inset-0 z-20"
        onPointerDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="absolute z-30 w-40 rounded-md border border-border bg-bg-2/95 py-1 shadow-xl backdrop-blur"
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        aria-label="Add object"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <MenuHeading>Add</MenuHeading>
        <MenuSection>Mesh</MenuSection>
        {MESH_ITEMS.map(({ type, label, Icon }) => (
          <MenuItem key={type} label={label} Icon={Icon} onSelect={() => add({ mesh: type })} />
        ))}
        <MenuSection>Light</MenuSection>
        {LIGHT_ITEMS.map(({ kind, label, Icon }) => (
          <MenuItem key={kind} label={label} Icon={Icon} onSelect={() => add({ light: kind })} />
        ))}
        <MenuSection>Other</MenuSection>
        <MenuItem label="Camera" Icon={Video} onSelect={() => add({ camera: true })} />
        <MenuItem label="Empty" Icon={Axis3d} onSelect={() => add({ empty: true })} />
      </div>
    </>
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-2.5 pb-1 pt-0.5 text-[10px] font-mono uppercase tracking-wider text-text">
      {children}
    </div>
  );
}

function MenuSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
      {children}
    </div>
  );
}

function MenuItem({
  label,
  Icon,
  onSelect,
}: {
  label: string;
  Icon: typeof Box;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
      onClick={onSelect}
    >
      <Icon size={12} className="text-text-dim" />
      {label}
    </button>
  );
}
