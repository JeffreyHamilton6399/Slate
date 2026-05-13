/**
 * 2D canvas surface.
 *
 * Owns a `<canvas>` and instantiates a CanvasEngine bound to the active
 * SlateRoom. Pointer events are translated to board-space and forwarded
 * to the active Tool. Wheel + pinch zoom and pan are handled here so the
 * Tool layer stays focused on drawing semantics.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Shape, Stroke } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { CanvasEngine } from './engine';
import { createTool, type Tool, type ToolContext } from './tools';
import { Canvas2DToolbar } from './Toolbar';
import { Minimap } from './Minimap';
import { useCanvasStore } from './store';
import { useLayersStore } from './store';
import { screenToBoard } from './transform';
import type { Rect } from './types';

interface Canvas2DProps {
  room: SlateRoom;
}

export function Canvas2D({ room }: Canvas2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CanvasEngine | null>(null);
  const toolRef = useRef<Tool | null>(null);
  const tool = useCanvasStore((s) => s.tool);
  const stroke = useCanvasStore((s) => s.stroke);
  const fill = useCanvasStore((s) => s.fill);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const strokeOpacity = useCanvasStore((s) => s.strokeOpacity);
  const fontSize = useCanvasStore((s) => s.fontSize);
  const zoom = useCanvasStore((s) => s.zoom);
  const panX = useCanvasStore((s) => s.panX);
  const panY = useCanvasStore((s) => s.panY);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const pan = useCanvasStore((s) => s.pan);
  const zoomAt = useCanvasStore((s) => s.zoomAt);
  const fit = useCanvasStore((s) => s.fit);
  const setStroke = useCanvasStore((s) => s.setStroke);
  const setTool = useCanvasStore((s) => s.setTool);
  const activeLayerId = useLayersStore((s) => s.activeLayerId);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [liveSel, setLiveSel] = useState<Set<string> | null>(null);
  const [paper, setPaper] = useState('#0c0c0e');
  const [size, setSize] = useState({ width: 800, height: 600, dpr: 1 });

  const livePreviewRef = useRef<{ stroke: Stroke | null; shape: Shape | null }>({
    stroke: null,
    shape: null,
  });

  // Watch paper meta.
  useEffect(() => {
    const meta = room.slate.meta();
    const apply = () => setPaper((meta.get('paper') as string) || '#0c0c0e');
    apply();
    meta.observe(apply);
    return () => meta.unobserve(apply);
  }, [room]);

  // Engine lifecycle.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const engine = new CanvasEngine({
      canvas: c,
      room,
      getTransform: () => ({ zoom: useCanvasStore.getState().zoom, panX: useCanvasStore.getState().panX, panY: useCanvasStore.getState().panY }),
      getSelection: () => selectionRef.current,
      getMarquee: () => marqueeRef.current,
      getLivePreview: () => livePreviewRef.current,
      getViewport: () => sizeRef.current,
      getPaper: () => paperRef.current,
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [room]);

  // Live refs so the engine read functions stay stable.
  const selectionRef = useRef(selection);
  const marqueeRef = useRef(marquee);
  const sizeRef = useRef(size);
  const paperRef = useRef(paper);
  useEffect(() => {
    selectionRef.current = liveSel ?? selection;
    engineRef.current?.markDirty();
  }, [selection, liveSel]);
  useEffect(() => {
    marqueeRef.current = marquee;
    engineRef.current?.markDirty();
  }, [marquee]);
  useEffect(() => {
    sizeRef.current = size;
    engineRef.current?.resize(size);
  }, [size]);
  useEffect(() => {
    paperRef.current = paper;
    engineRef.current?.markDirty();
  }, [paper]);
  useEffect(() => {
    engineRef.current?.markDirty();
  }, [zoom, panX, panY]);

  // Resize observer.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const toolCtx: ToolContext = useMemo(
    () => ({
      engine: engineRef.current!,
      authorId: room.identity.peerId,
      layerId: activeLayerId ?? '',
      stroke,
      fill,
      strokeWidth,
      strokeOpacity,
      fontSize,
      additive: false,
    }),
    [room, activeLayerId, stroke, fill, strokeWidth, strokeOpacity, fontSize],
  );

  const ensureTool = useCallback(
    (additive: boolean): Tool | null => {
      if (!engineRef.current || !activeLayerId) return null;
      const ctx: ToolContext = { ...toolCtx, additive };
      const t = createTool({
        toolId: tool,
        context: ctx,
        getSelected: () => selectionRef.current,
        setSelection: (ids) => setSelection(new Set(ids)),
        onSampleColor: (c) => setStroke(c),
      });
      toolRef.current = t;
      return t;
    },
    [tool, toolCtx, activeLayerId, setStroke],
  );

  // Pointer plumbing.
  const draggingPanRef = useRef<{ x: number; y: number } | null>(null);
  const isSpaceDownRef = useRef(false);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ d: number; cx: number; cy: number } | null>(null);

  const toBoard = useCallback(
    (clientX: number, clientY: number) => {
      const c = canvasRef.current!;
      const r = c.getBoundingClientRect();
      const screen = { x: clientX - r.left, y: clientY - r.top };
      return screenToBoard(
        { zoom: useCanvasStore.getState().zoom, panX: useCanvasStore.getState().panX, panY: useCanvasStore.getState().panY },
        screen,
      );
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-canvas-pointer]')) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = {
          d: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          cx: (a!.x + b!.x) / 2,
          cy: (a!.y + b!.y) / 2,
        };
        toolRef.current?.cancel();
        return;
      }
      const wantPan =
        tool === 'pan' || isSpaceDownRef.current || e.button === 1 || e.button === 2;
      if (wantPan) {
        draggingPanRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      const t = ensureTool(e.shiftKey);
      if (!t) return;
      const point = toBoard(e.clientX, e.clientY);
      t.start({ point, pressure: e.pressure || 0.5, t: e.timeStamp, constrain: e.shiftKey });
      livePreviewRef.current = pickPreview(t);
      const sel = t.preview().selection;
      if (sel) setLiveSel(sel);
      engineRef.current?.markDirty();
    },
    [tool, ensureTool, toBoard],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (pinchRef.current && pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        const r = canvasRef.current!.getBoundingClientRect();
        zoomAt(cx - r.left, cy - r.top, d / pinchRef.current.d);
        const dx = cx - pinchRef.current.cx;
        const dy = cy - pinchRef.current.cy;
        pan(dx, dy);
        pinchRef.current = { d, cx, cy };
        return;
      }
      if (draggingPanRef.current) {
        const dx = e.clientX - draggingPanRef.current.x;
        const dy = e.clientY - draggingPanRef.current.y;
        draggingPanRef.current = { x: e.clientX, y: e.clientY };
        pan(dx, dy);
        return;
      }
      const t = toolRef.current;
      if (!t) return;
      const point = toBoard(e.clientX, e.clientY);
      t.move({ point, pressure: e.pressure || 0.5, t: e.timeStamp, constrain: e.shiftKey });
      livePreviewRef.current = pickPreview(t);
      const sel = t.preview().selection;
      if (sel) setLiveSel(sel);
      const m = t.preview().marquee;
      setMarquee(m);
      engineRef.current?.markDirty();
    },
    [toBoard, pan, zoomAt],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(e.pointerId);
      if (pinchRef.current && pointersRef.current.size < 2) {
        pinchRef.current = null;
      }
      if (draggingPanRef.current) {
        draggingPanRef.current = null;
        return;
      }
      const t = toolRef.current;
      if (!t) return;
      const point = toBoard(e.clientX, e.clientY);
      t.end({ point, pressure: e.pressure || 0.5, t: e.timeStamp, constrain: e.shiftKey });
      livePreviewRef.current = { stroke: null, shape: null };
      setMarquee(null);
      setLiveSel(null);
      toolRef.current = null;
      engineRef.current?.markDirty();
    },
    [toBoard],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = canvasRef.current!.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
      } else {
        // Two-finger pan on trackpad / shift+wheel.
        pan(-e.deltaX, -e.deltaY);
      }
    },
    [zoomAt, pan],
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target.isContentEditable) return;
      if (e.code === 'Space') {
        isSpaceDownRef.current = true;
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) room.undo.redo();
        else room.undo.undo();
        return;
      }
      if (ctrl && e.key === '0') {
        e.preventDefault();
        fit();
        return;
      }
      if (e.key === '+' || e.key === '=') {
        const c = canvasRef.current!;
        const r = c.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1.1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        const c = canvasRef.current!;
        const r = c.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 0.9);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.size) {
          engineRef.current?.deleteIds(selection);
          setSelection(new Set());
        }
        return;
      }
      const k = e.key.toLowerCase();
      const map: Record<string, typeof tool> = {
        v: 'select',
        p: 'pen',
        y: 'highlighter',
        e: 'eraser',
        r: 'rect',
        o: 'ellipse',
        g: 'triangle',
        l: 'line',
        a: 'arrow',
        t: 'text',
        i: 'eyedropper',
        k: 'fill',
        h: 'pan',
      };
      if (map[k] && !ctrl) {
        e.preventDefault();
        setTool(map[k]!);
      }
      if (k === 'x') useCanvasStore.getState().swapColors();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') isSpaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [room, setTool, selection, fit, zoomAt]);

  // Awareness cursor publication (throttled to RAF).
  useEffect(() => {
    let rafId = 0;
    let lastSent = 0;
    const move = (e: PointerEvent) => {
      const c = canvasRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const now = performance.now();
        if (now - lastSent < 60) return;
        lastSent = now;
        const board = screenToBoard(
          { zoom, panX, panY },
          { x: e.clientX - r.left, y: e.clientY - r.top },
        );
        room.setLocalAwareness({ cursor: { x: board.x, y: board.y }, tool });
      });
    };
    window.addEventListener('pointermove', move);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', move);
      room.setLocalAwareness({ cursor: null });
    };
  }, [room, zoom, panX, panY, tool]);

  const onUndo = useCallback(() => room.undo.undo(), [room]);
  const onRedo = useCallback(() => room.undo.redo(), [room]);
  const onClear = useCallback(() => {
    if (!window.confirm('Clear the board for everyone?')) return;
    engineRef.current?.clearAll();
  }, []);
  const onZoomIn = useCallback(() => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.1);
  }, [zoomAt]);
  const onZoomOut = useCallback(() => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 0.9);
  }, [zoomAt]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      <Canvas2DToolbar
        onUndo={onUndo}
        onRedo={onRedo}
        onClear={onClear}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFit={fit}
        zoomLabel={`${Math.round(zoom * 100)}%`}
      />
      <Minimap
        getSnapshot={() => engineRef.current?.snapshot() ?? null}
        viewport={{ zoom, panX, panY }}
        size={size}
        onPan={(boardCenter) => {
          const c = canvasRef.current!;
          const r = c.getBoundingClientRect();
          setViewport(zoom, r.width / 2 - boardCenter.x * zoom, r.height / 2 - boardCenter.y * zoom);
        }}
      />
    </div>
  );

  void setViewport;
}

function pickPreview(t: Tool): { stroke: Stroke | null; shape: Shape | null } {
  const p = t.preview();
  return { stroke: p.stroke, shape: p.shape };
}
