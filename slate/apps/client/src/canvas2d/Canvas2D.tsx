/**
 * 2D canvas surface.
 *
 * Owns a `<canvas>` and instantiates a CanvasEngine bound to the active
 * SlateRoom. Pointer events are translated to board-space and forwarded
 * to the active Tool. Wheel + pinch zoom and pan are handled here so the
 * Tool layer stays focused on drawing semantics.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { Shape, Stroke } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { CanvasEngine } from './engine';
import { createTool, type Tool, type ToolContext } from './tools';
import { Canvas2DToolbar } from './Toolbar';
import { Minimap } from './Minimap';
import { RemoteCursors } from './RemoteCursors';
import { SelectionHandles } from './SelectionHandles';
import { useCanvasStore } from './store';
import { useLayersStore } from './store';
import { useAppStore } from '../app/store';
import { boardToScreen, screenToBoard } from './transform';
import { pointInShape } from './geometry';
import { fileToImageShape, isImageFile } from './importImage';
import { makeId } from '../utils/id';
import { toast } from '../ui/Toast';
import type { BoardPoint, Rect } from './types';

interface TextEditState {
  board: BoardPoint;
  value: string;
  /** Existing shape id when editing, null when inserting. */
  shapeId: string | null;
  fontSize: number;
  color: string;
}

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
  const [textEdit, setTextEdit] = useState<TextEditState | null>(null);
  const textEditRef = useRef<TextEditState | null>(null);
  textEditRef.current = textEdit;

  const livePreviewRef = useRef<{ stroke: Stroke | null; shape: Shape | null }>({
    stroke: null,
    shape: null,
  });
  /** In-app clipboard for Ctrl+C/X/V/D (plain copies, ids re-minted on paste). */
  const clipboardRef = useRef<{ shapes: Shape[]; strokes: Stroke[] }>({
    shapes: [],
    strokes: [],
  });

  // Watch paper meta.
  useEffect(() => {
    const meta = room.slate.meta();
    const apply = () => setPaper((meta.get('paper') as string) || '#0c0c0e');
    apply();
    meta.observe(apply);
    return () => meta.unobserve(apply);
  }, [room]);

  // Ensure a drawable layer exists and is the active one. The pen / brush /
  // shapes can't commit without an active layer, and that used to depend on
  // the Layers *panel* being open — if it wasn't, activeLayerId stayed null
  // and nothing drew. This lives in the canvas (always mounted on a 2D board)
  // so drawing works no matter which panels are docked.
  const layersArr = useMemo(() => room.slate.layers(), [room]);
  const iAmCreator = useAppStore((s) => s.currentBoard?.iAmCreator ?? false);
  useEffect(() => {
    // Nothing to bootstrap when a layer already exists.
    if (layersArr.length > 0) return;
    const bootstrap = () => {
      if (layersArr.length > 0) return;
      room.slate.doc.transact(() => {
        const m = new Y.Map<unknown>();
        m.set('id', makeId('layer'));
        m.set('name', 'Layer 1');
        m.set('visible', true);
        m.set('locked', false);
        m.set('opacity', 1);
        layersArr.push([m]);
      });
    };
    if (iAmCreator) {
      // The board creator makes the first layer immediately.
      bootstrap();
      return;
    }
    // Joiners wait a beat for the creator's initial sync before creating their
    // own, avoiding duplicate "Layer 1"s.
    const t = setTimeout(bootstrap, 2500);
    return () => clearTimeout(t);
  }, [layersArr, room, iAmCreator]);
  useEffect(() => {
    const ensure = () => {
      const ids: string[] = [];
      layersArr.forEach((m) => {
        const id = (m as Y.Map<unknown>).get('id');
        if (typeof id === 'string') ids.push(id);
      });
      if (ids.length === 0) return;
      const cur = useLayersStore.getState().activeLayerId;
      if (!cur || !ids.includes(cur)) {
        useLayersStore.getState().setActiveLayer(ids[ids.length - 1]!);
      }
    };
    ensure();
    layersArr.observeDeep(ensure);
    return () => layersArr.unobserveDeep(ensure);
  }, [layersArr]);

  // Like the 3D viewport, the paper can follow the app theme on this device
  // (default). Turning it off in Settings shows the board's shared color.
  const theme = useAppStore((s) => s.theme);
  const paperFollowsTheme = useAppStore((s) => s.paperFollowsTheme);
  const effectivePaper = paperFollowsTheme ? (theme === 'light' ? '#f6f5f0' : '#0c0c0e') : paper;

  // Style controls restyle the current selection (Figma-style): changing
  // stroke/fill/width/opacity/font while things are selected applies to them.
  const prevStyleRef = useRef({ stroke, fill, strokeWidth, strokeOpacity, fontSize });
  useEffect(() => {
    const prev = prevStyleRef.current;
    prevStyleRef.current = { stroke, fill, strokeWidth, strokeOpacity, fontSize };
    const engine = engineRef.current;
    if (!engine || selection.size === 0) return;
    const shapePatch: Partial<Shape> = {};
    const strokePatch: Partial<Stroke> = {};
    if (prev.stroke !== stroke) {
      shapePatch.stroke = stroke;
      strokePatch.color = stroke;
    }
    if (prev.fill !== fill) shapePatch.fill = fill;
    if (prev.strokeWidth !== strokeWidth) {
      shapePatch.strokeWidth = strokeWidth;
      strokePatch.size = strokeWidth;
    }
    if (prev.strokeOpacity !== strokeOpacity) {
      shapePatch.strokeOpacity = strokeOpacity;
      strokePatch.opacity = strokeOpacity;
    }
    const fontChanged = prev.fontSize !== fontSize;
    if (
      Object.keys(shapePatch).length === 0 &&
      Object.keys(strokePatch).length === 0 &&
      !fontChanged
    ) {
      return;
    }
    const snap = engine.snapshot();
    for (const layer of snap.layers) {
      for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
        if (!selection.has(sh.id)) continue;
        const patch = { ...shapePatch };
        if (fontChanged && sh.kind === 'text') patch.fontSize = fontSize;
        if (Object.keys(patch).length > 0) engine.updateShape(sh.id, patch);
      }
      if (Object.keys(strokePatch).length > 0) {
        for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
          if (selection.has(st.id)) engine.updateStroke(st.id, strokePatch);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stroke, fill, strokeWidth, strokeOpacity, fontSize]);

  // Doc version bump so DOM overlays (selection handles) track remote edits.
  const [docVersion, setDocVersion] = useState(0);
  useEffect(() => {
    const bump = () => setDocVersion((v) => v + 1);
    const shapes = room.slate.shapes();
    const strokes = room.slate.strokes();
    shapes.observeDeep(bump);
    strokes.observeDeep(bump);
    return () => {
      shapes.unobserveDeep(bump);
      strokes.unobserveDeep(bump);
    };
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
  const paperRef = useRef(effectivePaper);
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
    paperRef.current = effectivePaper;
    engineRef.current?.markDirty();
  }, [effectivePaper]);
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

  // ── Inline text editing ────────────────────────────────────────────────────
  const commitTextEdit = useCallback(() => {
    const te = textEditRef.current;
    if (!te) return;
    setTextEdit(null);
    const engine = engineRef.current;
    if (!engine) return;
    const value = te.value.replace(/\s+$/, '');
    if (te.shapeId) {
      if (!value) {
        engine.deleteIds([te.shapeId]);
        return;
      }
      const lines = value.split('\n');
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
      engine.updateShape(te.shapeId, {
        text: value,
        w: Math.max(40, longest * te.fontSize * 0.6),
        h: lines.length * te.fontSize * 1.2,
      });
      return;
    }
    if (!value || !activeLayerId) return;
    const lines = value.split('\n');
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
    engine.commitShape({
      id: makeId('shape'),
      kind: 'text',
      layerId: activeLayerId,
      x: te.board.x,
      y: te.board.y,
      w: Math.max(40, longest * te.fontSize * 0.6),
      h: lines.length * te.fontSize * 1.2,
      rotation: 0,
      stroke: te.color,
      fill: null,
      strokeWidth: 0,
      strokeOpacity: 1,
      text: value,
      fontSize: te.fontSize,
      createdAt: Date.now(),
      authorId: room.identity.peerId,
    });
  }, [activeLayerId, room]);

  const openTextEditor = useCallback(
    (board: BoardPoint) => {
      setTextEdit({
        board,
        value: '',
        shapeId: null,
        fontSize: useCanvasStore.getState().fontSize,
        color: useCanvasStore.getState().stroke,
      });
    },
    [],
  );

  /** Double-click: edit the topmost text shape under the pointer. */
  const tryEditTextAt = useCallback((board: BoardPoint): boolean => {
    const snap = engineRef.current?.snapshot();
    if (!snap) return false;
    for (let i = snap.layers.length - 1; i >= 0; i--) {
      const layer = snap.layers[i]!;
      if (!layer.visible || layer.locked) continue;
      const shapes = snap.shapesByLayer.get(layer.id) ?? [];
      for (let j = shapes.length - 1; j >= 0; j--) {
        const sh = shapes[j]!;
        if (sh.kind === 'text' && pointInShape(sh, board)) {
          setTextEdit({
            board: { x: sh.x, y: sh.y },
            value: sh.text ?? '',
            shapeId: sh.id,
            fontSize: sh.fontSize ?? 24,
            color: sh.stroke,
          });
          return true;
        }
      }
    }
    return false;
  }, []);

  // ── Image insertion (drag-drop, paste, toolbar button) ─────────────────────
  const insertImages = useCallback(
    async (files: File[] | Blob[], at?: BoardPoint) => {
      const engine = engineRef.current;
      const layerId = useLayersStore.getState().activeLayerId;
      if (!engine || !layerId) return;
      // Default to the viewport center when there is no drop point.
      const t = useCanvasStore.getState();
      const r = canvasRef.current?.getBoundingClientRect();
      const center =
        at ??
        screenToBoard(
          { zoom: t.zoom, panX: t.panX, panY: t.panY },
          { x: (r?.width ?? 800) / 2, y: (r?.height ?? 600) / 2 },
        );
      let offset = 0;
      const newIds: string[] = [];
      for (const file of files) {
        try {
          const img = await fileToImageShape(file);
          // Cap the placed size so a photo doesn't swallow the viewport.
          const maxPlaced = 480 / t.zoom;
          const k = Math.min(1, maxPlaced / Math.max(img.w, img.h));
          const w = img.w * k;
          const h = img.h * k;
          const id = makeId('shape');
          engine.commitShape({
            id,
            kind: 'image',
            layerId,
            x: center.x - w / 2 + offset,
            y: center.y - h / 2 + offset,
            w,
            h,
            rotation: 0,
            stroke: '#00000000',
            fill: null,
            strokeWidth: 0,
            strokeOpacity: 1,
            src: img.src,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          });
          newIds.push(id);
          offset += 24;
        } catch (err) {
          toast({ title: 'Image import failed', description: (err as Error).message, variant: 'error' });
        }
      }
      if (newIds.length) {
        setSelection(new Set(newIds));
        setTool('select');
      }
    },
    [room, setTool],
  );

  // Drop images anywhere on the canvas → image shapes at the drop point.
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter(isImageFile);
      if (!files.length) return;
      e.preventDefault();
      const c = canvasRef.current;
      const t = useCanvasStore.getState();
      const at = c
        ? screenToBoard(
            { zoom: t.zoom, panX: t.panX, panY: t.panY },
            {
              x: e.clientX - c.getBoundingClientRect().left,
              y: e.clientY - c.getBoundingClientRect().top,
            },
          )
        : undefined;
      void insertImages(files, at);
    },
    [insertImages],
  );

  // Paste images from the OS clipboard (screenshots!).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      if (!files.length) return;
      e.preventDefault();
      void insertImages(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [insertImages]);

  const imagePickerRef = useRef<HTMLInputElement | null>(null);

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
        onTextInsert: openTextEditor,
        polySides: useCanvasStore.getState().polySides,
      });
      toolRef.current = t;
      return t;
    },
    [tool, toolCtx, activeLayerId, setStroke, openTextEditor],
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
      if (textEditRef.current) {
        // Click-away commits the inline text editor and swallows the click.
        commitTextEdit();
        return;
      }
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
      t.start({ point, pressure: e.pressure || 0.5, t: e.timeStamp, constrain: e.shiftKey, snap: e.ctrlKey });
      livePreviewRef.current = pickPreview(t);
      const sel = t.preview().selection;
      if (sel) setLiveSel(sel);
      engineRef.current?.markDirty();
    },
    [tool, ensureTool, toBoard, commitTextEdit],
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
      // Browsers coalesce pointermove events for performance, so a single
      // React event can hide many intermediate positions. Feeding only the
      // latest makes fast strokes jagged and laggy — the "drawing feels
      // broken" symptom. getCoalescedEvents() recovers the full-resolution
      // path so ink tracks the cursor smoothly at any speed.
      const native = e.nativeEvent;
      const coalesced =
        typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const samples = coalesced.length > 0 ? coalesced : [native];
      for (const ev of samples) {
        t.move({
          point: toBoard(ev.clientX, ev.clientY),
          pressure: ev.pressure || 0.5,
          t: ev.timeStamp,
          constrain: e.shiftKey,
          snap: e.ctrlKey,
        });
      }
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
      t.end({ point, pressure: e.pressure || 0.5, t: e.timeStamp, constrain: e.shiftKey, snap: e.ctrlKey });
      livePreviewRef.current = { stroke: null, shape: null };
      setMarquee(null);
      setLiveSel(null);
      toolRef.current = null;
      engineRef.current?.markDirty();
    },
    [toBoard],
  );

  // Wheel: React registers wheel listeners passively, so preventDefault would
  // be ignored (browser page-zoom fires alongside ctrl+wheel). Attach a native
  // non-passive listener instead.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = canvasRef.current!.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
      } else {
        // Two-finger pan on trackpad / plain wheel.
        pan(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, pan]);

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
      if ((e.key === ']' || e.key === '[') && !ctrl && selection.size) {
        e.preventDefault();
        engineRef.current?.reorder(selection, e.key === ']' ? 'front' : 'back');
        return;
      }
      if (e.key === 'Escape') {
        toolRef.current?.cancel();
        toolRef.current = null;
        livePreviewRef.current = { stroke: null, shape: null };
        setMarquee(null);
        setLiveSel(null);
        setSelection(new Set());
        engineRef.current?.markDirty();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const snap = engineRef.current?.snapshot();
        if (!snap) return;
        const all = new Set<string>();
        for (const layer of snap.layers) {
          if (!layer.visible || layer.locked) continue;
          for (const sh of snap.shapesByLayer.get(layer.id) ?? []) all.add(sh.id);
          for (const st of snap.strokesByLayer.get(layer.id) ?? []) all.add(st.id);
        }
        setSelection(all);
        return;
      }
      const copySelection = () => {
        const snap = engineRef.current?.snapshot();
        if (!snap || selection.size === 0) return false;
        const shapes: Shape[] = [];
        const strokes: Stroke[] = [];
        for (const layer of snap.layers) {
          for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
            if (selection.has(sh.id)) shapes.push({ ...sh });
          }
          for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
            if (selection.has(st.id)) strokes.push({ ...st, points: st.points.slice() });
          }
        }
        if (shapes.length === 0 && strokes.length === 0) return false;
        clipboardRef.current = { shapes, strokes };
        return true;
      };
      const pasteClipboard = () => {
        const engine = engineRef.current;
        const clip = clipboardRef.current;
        if (!engine || (clip.shapes.length === 0 && clip.strokes.length === 0)) return;
        const OFFSET = 24;
        const now = Date.now();
        const me = room.identity.peerId;
        const newIds: string[] = [];
        for (const sh of clip.shapes) {
          const id = makeId('shape');
          engine.commitShape({ ...sh, id, x: sh.x + OFFSET, y: sh.y + OFFSET, createdAt: now, authorId: me });
          newIds.push(id);
        }
        for (const st of clip.strokes) {
          const id = makeId('stroke');
          const points = st.points.slice();
          for (let i = 0; i < points.length; i += 3) {
            points[i] = (points[i] ?? 0) + OFFSET;
            points[i + 1] = (points[i + 1] ?? 0) + OFFSET;
          }
          engine.commitStroke({ ...st, id, points, createdAt: now, authorId: me });
          newIds.push(id);
        }
        setSelection(new Set(newIds));
      };
      const k0 = e.key.toLowerCase();
      if (ctrl && k0 === 'c') {
        if (copySelection()) e.preventDefault();
        return;
      }
      if (ctrl && k0 === 'x') {
        if (copySelection()) {
          e.preventDefault();
          engineRef.current?.deleteIds(selection);
          setSelection(new Set());
        }
        return;
      }
      if (ctrl && k0 === 'v') {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (ctrl && k0 === 'd') {
        // Duplicate in place (with offset), Figma-style.
        e.preventDefault();
        if (copySelection()) pasteClipboard();
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
        u: 'polygon',
        s: 'star',
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

  // Awareness cursor publication: pointermove stashes the latest position;
  // a 30 Hz interval publishes when it changed. The trailing position is
  // always sent (the old RAF-throttle dropped it, so remote cursors froze
  // short of where the pointer stopped).
  useEffect(() => {
    let pending: { x: number; y: number } | null = null;
    let lastKey = '';
    const move = (e: PointerEvent) => {
      const c = canvasRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        return;
      const t = useCanvasStore.getState();
      pending = screenToBoard(
        { zoom: t.zoom, panX: t.panX, panY: t.panY },
        { x: e.clientX - r.left, y: e.clientY - r.top },
      );
    };
    const timer = window.setInterval(() => {
      if (!pending) return;
      const key = `${pending.x.toFixed(1)},${pending.y.toFixed(1)}`;
      if (key === lastKey) return;
      lastKey = key;
      room.setLocalAwareness({ cursor: { x: pending.x, y: pending.y }, tool });
    }, 33);
    window.addEventListener('pointermove', move);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointermove', move);
      room.setLocalAwareness({ cursor: null });
    };
  }, [room, tool]);

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
      onDragOver={(e) => {
        if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault();
      }}
      onDrop={onDrop}
      onDoubleClick={(e) => {
        if (textEdit) return;
        if (tool !== 'select' && tool !== 'text') return;
        tryEditTextAt(toBoard(e.clientX, e.clientY));
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      <RemoteCursors room={room} />
      {tool === 'select' && selection.size > 0 && !marquee && (
        <SelectionHandles
          engine={engineRef.current}
          selection={selection}
          docVersion={docVersion}
          wrapper={wrapperRef.current}
        />
      )}
      {textEdit && (
        <TextEditorOverlay
          state={textEdit}
          screen={boardToScreen({ zoom, panX, panY }, textEdit.board)}
          zoom={zoom}
          onChange={(value) => setTextEdit((s) => (s ? { ...s, value } : s))}
          onCommit={commitTextEdit}
          onCancel={() => setTextEdit(null)}
        />
      )}
      <Canvas2DToolbar
        onUndo={onUndo}
        onRedo={onRedo}
        onClear={onClear}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFit={fit}
        onInsertImage={() => imagePickerRef.current?.click()}
        zoomLabel={`${Math.round(zoom * 100)}%`}
      />
      <input
        ref={imagePickerRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        data-no-canvas-pointer
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void insertImages(files);
        }}
      />
      <Minimap
        getSnapshot={() => engineRef.current?.snapshot() ?? null}
        viewport={{ zoom, panX, panY }}
        size={size}
        paper={effectivePaper}
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

/** Absolutely-positioned textarea rendered at the text shape's board point. */
function TextEditorOverlay({
  state,
  screen,
  zoom,
  onChange,
  onCommit,
  onCancel,
}: {
  state: TextEditState;
  screen: { x: number; y: number };
  zoom: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (state.shapeId) el.select();
    // Focus/select only on mount — the value keeps updating while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fontPx = Math.max(9, state.fontSize * zoom);
  const lines = state.value.split('\n');
  const rows = Math.max(1, lines.length);
  const cols = Math.max(6, lines.reduce((m, l) => Math.max(m, l.length), 0) + 2);
  return (
    <textarea
      ref={ref}
      data-no-canvas-pointer
      value={state.value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCommit}
      onPointerDown={(e) => e.stopPropagation()}
      spellCheck={false}
      placeholder="Type…"
      className="absolute z-20 resize-none overflow-hidden rounded-sm border border-accent/70 bg-bg/85 outline-none backdrop-blur-[2px] placeholder:text-text-dim"
      style={{
        left: screen.x - 4,
        top: screen.y - 4,
        padding: '2px 4px',
        color: state.color,
        fontSize: fontPx,
        lineHeight: 1.2,
        fontFamily: 'Inter, sans-serif',
        width: `${cols}ch`,
        minWidth: 120,
        maxWidth: '60vw',
      }}
    />
  );
}
