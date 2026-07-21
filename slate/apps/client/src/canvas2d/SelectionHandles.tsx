/**
 * SelectionHandles — Photoshop/Figma-style transform box around the current
 * selection: 8 resize handles (corners scale both axes, edges scale one)
 * plus a rotate grip above the box. Shift constrains resizing to uniform
 * scale and snaps rotation to 15°.
 *
 * A single rotated shape gets a rotated frame: the box and handles turn with
 * the shape and resizing happens in the shape's local (unrotated) space, so
 * the corners you grab are the corners you see.
 *
 * Originals are snapshotted on grab; every drag frame rewrites from those,
 * so the math never compounds and collaborators see the live transform.
 */

import { memo, useRef, useState } from 'react';
import type { Shape, Stroke } from '@slate/sync-protocol';
import type { CanvasEngine } from './engine';
import { rotatedShapeAABB, shapeBounds, strokeBounds } from './geometry';
import { boardToScreen, screenToBoard } from './transform';
import { useCanvasStore } from './store';
import type { BoardPoint, Rect } from './types';

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: { id: HandleId; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
];

const MIN_SIZE = 2;

interface DragState {
  handle: HandleId | 'rotate';
  startBox: Rect;
  rotation: number;
  shapes: Shape[];
  strokes: Stroke[];
  center: BoardPoint;
}

export const SelectionHandles = memo(function SelectionHandles({
  engine,
  selection,
  docVersion,
  wrapper,
}: {
  engine: CanvasEngine | null;
  selection: Set<string>;
  docVersion: number;
  /** The canvas wrapper — pointer math is relative to its rect. */
  wrapper: HTMLElement | null;
}) {
  const zoom = useCanvasStore((s) => s.zoom);
  const panX = useCanvasStore((s) => s.panX);
  const panY = useCanvasStore((s) => s.panY);
  const dragRef = useRef<DragState | null>(null);
  const [, force] = useState(0);
  void docVersion;

  const items = collectSelected(engine, selection);
  if (!engine || !items || selection.size === 0) return null;
  const { box, shapes, strokes } = items;
  if (box.w < 0.01 && box.h < 0.01) return null;

  const singleShape = shapes.length === 1 && strokes.length === 0 ? shapes[0]! : null;
  const rotation = singleShape?.rotation ?? 0;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const centerScreen = boardToScreen({ zoom, panX, panY }, center);
  const w = box.w * zoom;
  const h = box.h * zoom;

  /** Pointer → board coords, using the wrapper's rect (not the page). */
  const toBoard = (e: React.PointerEvent): BoardPoint => {
    const r = wrapper?.getBoundingClientRect();
    const t = useCanvasStore.getState();
    return screenToBoard(
      { zoom: t.zoom, panX: t.panX, panY: t.panY },
      { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) },
    );
  };

  /** Board → the box's local (unrotated) space around its center. */
  const toLocal = (p: BoardPoint, d: DragState): BoardPoint => {
    if (!d.rotation) return p;
    const cos = Math.cos(-d.rotation);
    const sin = Math.sin(-d.rotation);
    const dx = p.x - d.center.x;
    const dy = p.y - d.center.y;
    return { x: d.center.x + dx * cos - dy * sin, y: d.center.y + dx * sin + dy * cos };
  };

  const beginDrag = (e: React.PointerEvent, handle: DragState['handle']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startBox: { ...box },
      rotation,
      shapes: shapes.map((s) => ({ ...s })),
      strokes: strokes.map((s) => ({ ...s, points: s.points.slice() })),
      center: { ...center },
    };
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !engine) return;
    const world = toBoard(e);

    if (d.handle === 'rotate') {
      if (!singleShape) return;
      let angle = Math.atan2(world.y - d.center.y, world.x - d.center.x) + Math.PI / 2;
      if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      engine.updateShape(d.shapes[0]!.id, { rotation: angle });
      force((v) => v + 1);
      return;
    }

    const p = toLocal(world, d);
    const b = d.startBox;
    const anchorX = d.handle.includes('w') ? b.x + b.w : b.x;
    const anchorY = d.handle.includes('n') ? b.y + b.h : b.y;
    const freeX = !(d.handle === 'n' || d.handle === 's');
    const freeY = !(d.handle === 'e' || d.handle === 'w');

    let sx = freeX ? (p.x - anchorX) / (d.handle.includes('w') ? -b.w : b.w) : 1;
    let sy = freeY ? (p.y - anchorY) / (d.handle.includes('n') ? -b.h : b.h) : 1;
    if (e.shiftKey && freeX && freeY) {
      const u = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * u;
      sy = Math.sign(sy || 1) * u;
    }
    sx = Math.max(MIN_SIZE / Math.max(b.w, MIN_SIZE), sx);
    sy = Math.max(MIN_SIZE / Math.max(b.h, MIN_SIZE), sy);

    // A rotated shape rotates about its (moving) center, so scaling in local
    // space shifts the anchor's world position by (I − R)(C0 − C1). Translate
    // by that amount so the grabbed-opposite corner stays pinned on screen.
    let tx = 0;
    let ty = 0;
    if (d.rotation) {
      const vx = d.center.x - (anchorX + (d.center.x - anchorX) * sx);
      const vy = d.center.y - (anchorY + (d.center.y - anchorY) * sy);
      const cos = Math.cos(d.rotation);
      const sin = Math.sin(d.rotation);
      tx = vx - (vx * cos - vy * sin);
      ty = vy - (vx * sin + vy * cos);
    }

    for (const sh of d.shapes) {
      // Clamp to the schema range — out-of-range values fail validation and
      // make the shape vanish from every client.
      const scaledFont = sh.fontSize
        ? Math.min(512, Math.max(8, Math.round(sh.fontSize * Math.min(sx, sy))))
        : undefined;
      engine.updateShape(sh.id, {
        x: anchorX + (sh.x - anchorX) * sx + tx,
        y: anchorY + (sh.y - anchorY) * sy + ty,
        w: sh.w * sx,
        h: sh.h * sy,
        ...(scaledFont !== undefined ? { fontSize: scaledFont } : {}),
      });
    }
    for (const st of d.strokes) {
      const points = st.points.slice();
      for (let i = 0; i < points.length; i += 3) {
        points[i] = anchorX + ((points[i] ?? 0) - anchorX) * sx;
        points[i + 1] = anchorY + ((points[i + 1] ?? 0) - anchorY) * sy;
      }
      engine.updateStroke(st.id, {
        points,
        size: Math.min(200, Math.max(0.5, st.size * ((sx + sy) / 2))),
      });
    }
    force((v) => v + 1);
  };

  const endDrag = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  // The frame rotates with a single rotated shape so the handles track the
  // visible corners.
  return (
    <div
      className="absolute left-0 top-0 z-20"
      style={{
        transform: `translate(${centerScreen.x}px, ${centerScreen.y}px) rotate(${rotation}rad)`,
      }}
      aria-hidden={false}
    >
      <div
        className="pointer-events-none absolute border border-accent/70"
        style={{ left: -w / 2, top: -h / 2, width: w, height: h }}
        aria-hidden
      />
      {HANDLES.map((hdl) => (
        <div
          key={hdl.id}
          data-no-canvas-pointer
          onPointerDown={(e) => beginDrag(e, hdl.id)}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="absolute z-30 h-2.5 w-2.5 rounded-[2px] border border-accent bg-bg"
          style={{
            left: -w / 2 + hdl.x * w - 5,
            top: -h / 2 + hdl.y * h - 5,
            cursor: hdl.cursor,
          }}
        />
      ))}
      {singleShape && singleShape.kind !== 'line' && singleShape.kind !== 'arrow' && (
        <div
          data-no-canvas-pointer
          onPointerDown={(e) => beginDrag(e, 'rotate')}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="absolute z-30 h-3 w-3 cursor-grab rounded-full border border-accent bg-bg active:cursor-grabbing"
          style={{ left: -6, top: -h / 2 - 22 }}
          title="Rotate (Shift snaps to 15°)"
        />
      )}
    </div>
  );
});

function collectSelected(
  engine: CanvasEngine | null,
  selection: Set<string>,
): { box: Rect; shapes: Shape[]; strokes: Stroke[] } | null {
  if (!engine || selection.size === 0) return null;
  const snap = engine.snapshot();
  const shapes: Shape[] = [];
  const strokes: Stroke[] = [];
  for (const layer of snap.layers) {
    for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
      if (selection.has(sh.id)) shapes.push(sh);
    }
    for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
      if (selection.has(st.id)) strokes.push(st);
    }
  }
  if (shapes.length === 0 && strokes.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const grow = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  // A lone rotated shape gets its unrotated rect (the frame itself rotates);
  // in a multi-selection the frame is axis-aligned, so rotated shapes must
  // contribute their rotated AABB or they poke out of the box.
  const single = shapes.length === 1 && strokes.length === 0;
  for (const sh of shapes) grow(single ? shapeBounds(sh) : rotatedShapeAABB(sh));
  for (const st of strokes) grow(strokeBounds(st));
  return { box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, shapes, strokes };
}
