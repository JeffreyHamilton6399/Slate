/**
 * FloatingPanels — Unity-style detached panel windows.
 *
 * Each floating panel is a draggable, resizable window. Dragging the title
 * bar over a dock's tab strip highlights it and re-docks on release;
 * releasing anywhere else leaves the window where it was dropped. Windows
 * raise to the top on pointer-down.
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelRegistry, RenderPanel, panelMatchesMode } from './panelRegistry';
import { useDockStore, type FloatGeometry } from './dockStore';
import { findDropTarget } from './panelDrag';
import { useAppStore } from '../app/store';

const MIN_W = 220;
const MIN_H = 160;
const TITLE_H = 30;

export function FloatingPanels() {
  const panels = usePanelRegistry((s) => s.panels);
  const panelSide = useDockStore((s) => s.panelSide);
  const floatStack = useDockStore((s) => s.floatStack);

  const mode = useAppStore((s) => s.currentBoard?.mode ?? '2d');
  const ids = floatStack.filter(
    (id) => panelSide[id] === 'floating' && panelMatchesMode(panels[id], mode),
  );
  if (ids.length === 0) return null;
  return (
    <>
      {ids.map((id, i) => (
        <FloatingWindow key={id} id={id} title={panels[id]!.title} z={40 + i} />
      ))}
    </>
  );
}

function clampGeometry(g: FloatGeometry): FloatGeometry {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(g.w, vw - 24));
  const h = Math.max(MIN_H, Math.min(g.h, vh - 24));
  return {
    w,
    h,
    x: Math.max(4 - w + 80, Math.min(g.x, vw - 80)),
    y: Math.max(4, Math.min(g.y, vh - TITLE_H - 8)),
  };
}

function FloatingWindow({ id, title, z }: { id: string; title: string; z: number }) {
  const stored = useDockStore((s) => s.floats[id]);
  const raiseFloat = useDockStore((s) => s.raiseFloat);
  const closePanel = useDockStore((s) => s.closePanel);
  const setFloatGeometry = useDockStore((s) => s.setFloatGeometry);
  const dockPanel = useDockStore((s) => s.dockPanel);
  const setDropHint = useDockStore((s) => s.setDropHint);

  // Local geometry during drag/resize; committed to the store on release.
  const [geo, setGeo] = useState<FloatGeometry>(() =>
    clampGeometry(stored ?? { x: 120, y: 96, w: 320, h: 400 }),
  );
  useEffect(() => {
    if (stored) setGeo(clampGeometry(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.x, stored?.y, stored?.w, stored?.h]);

  const dragRef = useRef<{ dx: number; dy: number; docking: boolean } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);
  // While the title bar is dragged the window ignores hit-testing so
  // elementFromPoint can see the dock strips underneath it — otherwise a
  // drop always lands on the window itself and re-docking never resolves.
  // Pointer capture keeps delivering the drag events regardless.
  const [titleDragging, setTitleDragging] = useState(false);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  return (
    <div
      className="fixed flex flex-col overflow-hidden rounded-lg border border-border bg-bg-2 shadow-2xl"
      style={{
        left: geo.x,
        top: geo.y,
        width: geo.w,
        height: geo.h,
        zIndex: z,
        pointerEvents: titleDragging ? 'none' : undefined,
        opacity: titleDragging ? 0.7 : undefined,
      }}
      onPointerDown={() => raiseFloat(id)}
      role="dialog"
      aria-label={title}
    >
      <div
        className="flex shrink-0 cursor-grab select-none items-center gap-1 border-b border-border bg-bg-3/60 px-2 active:cursor-grabbing"
        style={{ height: TITLE_H }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { dx: e.clientX - geoRef.current.x, dy: e.clientY - geoRef.current.y, docking: false };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setTitleDragging(true);
          useDockStore.getState().setDragging(true);
          setGeo((g) => ({ ...g, x: e.clientX - d.dx, y: e.clientY - d.dy }));
          const target = findDropTarget(e.clientX, e.clientY);
          d.docking = !!target;
          setDropHint(target?.zone ?? null);
        }}
        onPointerUp={(e) => {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          const d = dragRef.current;
          dragRef.current = null;
          setDropHint(null);
          setTitleDragging(false);
          useDockStore.getState().setDragging(false);
          if (!d) return;
          const target = findDropTarget(e.clientX, e.clientY);
          if (target) {
            dockPanel(id, target.zone, Number.isFinite(target.index) ? target.index : undefined);
          } else {
            setFloatGeometry(id, clampGeometry(geoRef.current));
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDropHint(null);
          setTitleDragging(false);
          useDockStore.getState().setDragging(false);
        }}
      >
        <span className="flex-1 truncate text-xs font-medium text-text">{title}</span>
        <button
          type="button"
          aria-label={`Close ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => closePanel(id)}
          className="rounded-sm p-0.5 text-text-dim hover:bg-bg-4 hover:text-text"
        >
          <X size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <RenderPanel id={id} />
      </div>
      <div
        role="presentation"
        aria-hidden
        className={cn(
          'absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize',
          'after:absolute after:bottom-1 after:right-1 after:h-2 after:w-2',
          'after:border-b-2 after:border-r-2 after:border-text-dim/60',
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          resizeRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            w: geoRef.current.w,
            h: geoRef.current.h,
          };
        }}
        onPointerMove={(e) => {
          const r = resizeRef.current;
          if (!r) return;
          setGeo((g) => ({
            ...g,
            w: Math.max(MIN_W, r.w + (e.clientX - r.startX)),
            h: Math.max(MIN_H, r.h + (e.clientY - r.startY)),
          }));
        }}
        onPointerUp={(e) => {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          resizeRef.current = null;
          setFloatGeometry(id, clampGeometry(geoRef.current));
        }}
        onPointerCancel={() => {
          resizeRef.current = null;
        }}
      />
    </div>
  );
}
