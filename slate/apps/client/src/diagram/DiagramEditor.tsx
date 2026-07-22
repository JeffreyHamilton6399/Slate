/**
 * Diagram / whiteboard editor — an infinite SVG canvas of labelled nodes
 * (boxes, ellipses, diamonds, sticky notes) linked by connectors. All node /
 * edge data lives in Yjs (`diagram:nodes` / `diagram:edges`), so editing is
 * live-collaborative and offline-persistent like every other Slate mode.
 *
 * Interaction model (kept close to the 2D canvas so it feels familiar):
 *   - A shape tool drops a node where you click, then drops you into text edit.
 *   - Select tool moves nodes (drag), marquee-selects on empty canvas, resizes
 *     the single selected node via corner handles, and — on hover — exposes
 *     four connect handles you drag to link nodes.
 *   - Connect tool drags a connector from one node to another.
 *   - Double-click a node to (re)label it, double-click an edge to label it.
 *   - Delete removes the selection + incident edges; arrows nudge; Ctrl+C/X/V/D
 *     copy / cut / paste / duplicate; Ctrl+Z / Ctrl+Shift+Z undo / redo.
 *   - Space / middle / right drag pans; wheel pans, ctrl+wheel zooms.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Square,
  Circle,
  Diamond,
  StickyNote,
  Spline,
  MousePointer2,
  Hand,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Trash2,
  Magnet,
} from 'lucide-react';
import type { DiagramNode, DiagramEdge, DiagramNodeShape } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { makeId } from '../utils/id';
import { cn } from '../utils/cn';
import { useDiagramStore, toolShape, DIAGRAM_GRID, type DiagramTool } from './store';
import { onDiagramStyle, type DiagramStyle } from './diagramBridge';
import {
  readNodes,
  readEdges,
  toYMap,
  nodeCenter,
  edgePath,
  nodeAt,
  type Point,
} from './model';

const DEFAULT_SIZE: Record<DiagramNodeShape, { w: number; h: number }> = {
  rect: { w: 160, h: 80 },
  ellipse: { w: 140, h: 100 },
  diamond: { w: 150, h: 100 },
  note: { w: 140, h: 120 },
  pill: { w: 160, h: 64 },
  parallelogram: { w: 170, h: 80 },
  hexagon: { w: 160, h: 90 },
  cylinder: { w: 130, h: 110 },
  triangle: { w: 140, h: 110 },
};
const MIN_W = 48;
const MIN_H = 36;
const PASTE_OFFSET = 28;

/** Snap a scalar to the diagram grid when snapping is on, else just round. */
function snapTo(v: number, on: boolean): number {
  return on ? Math.round(v / DIAGRAM_GRID) * DIAGRAM_GRID : Math.round(v);
}

interface TextEdit {
  nodeId: string;
  value: string;
}
interface EdgeEdit {
  edgeId: string;
  value: string;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** Drag gestures the pointer handlers can be in the middle of. */
type Drag =
  | { kind: 'move'; startBoard: Point; origin: Map<string, Point>; moved: boolean }
  | { kind: 'marquee'; startBoard: Point; cur: Point }
  | { kind: 'resize'; nodeId: string; corner: Corner; start: DiagramNode }
  | { kind: 'connect'; from: string; cur: Point }
  | { kind: 'pan'; startClient: Point };

interface Clip {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function DiagramEditor() {
  const room = useRoom();
  const nodesMap = useMemo(() => room.slate.diagramNodes(), [room]);
  const edgesMap = useMemo(() => room.slate.diagramEdges(), [room]);

  const tool = useDiagramStore((s) => s.tool);
  const setTool = useDiagramStore((s) => s.setTool);
  const stroke = useDiagramStore((s) => s.stroke);
  const zoom = useDiagramStore((s) => s.zoom);
  const panX = useDiagramStore((s) => s.panX);
  const panY = useDiagramStore((s) => s.panY);
  const pan = useDiagramStore((s) => s.pan);
  const zoomAt = useDiagramStore((s) => s.zoomAt);
  const setViewport = useDiagramStore((s) => s.setViewport);
  const snap = useDiagramStore((s) => s.snap);
  const toggleSnap = useDiagramStore((s) => s.toggleSnap);

  const theme = useAppStore((s) => s.theme);
  const paper = theme === 'light' ? '#f6f5f0' : '#0c0c0e';
  const grid = theme === 'light' ? '#00000012' : '#ffffff10';

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Re-read the Yjs maps into plain arrays on any deep change.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    nodesMap.observeDeep(bump);
    edgesMap.observeDeep(bump);
    return () => {
      nodesMap.unobserveDeep(bump);
      edgesMap.unobserveDeep(bump);
    };
  }, [nodesMap, edgesMap]);
  // `version` bumps on every deep Yjs change — it's the reason to re-read the
  // mutable maps, even though eslint sees it as an "unnecessary" dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodes = useMemo(() => readNodes(nodesMap), [nodesMap, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const edges = useMemo(() => readEdges(edgesMap), [edgesMap, version]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [edgeEdit, setEdgeEdit] = useState<EdgeEdit | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const clipboardRef = useRef<Clip>({ nodes: [], edges: [] });
  const [, setDragTick] = useState(0); // forces re-render during marquee/connect
  const isSpaceDownRef = useRef(false);

  // Live refs so window-level listeners see current selection.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectedEdgeRef = useRef(selectedEdge);
  selectedEdgeRef.current = selectedEdge;

  // Keep selection valid as nodes disappear (remote deletes).
  useEffect(() => {
    setSelection((sel) => {
      const next = new Set([...sel].filter((id) => nodeById.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [nodeById]);

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const toBoard = useCallback((clientX: number, clientY: number): Point => {
    const r = wrapperRef.current!.getBoundingClientRect();
    const { zoom: z, panX: px, panY: py } = useDiagramStore.getState();
    return { x: (clientX - r.left - px) / z, y: (clientY - r.top - py) / z };
  }, []);

  // ── Mutation helpers ───────────────────────────────────────────────────────
  const patchNode = useCallback(
    (id: string, patch: Partial<DiagramNode>) => {
      const m = nodesMap.get(id);
      if (!m) return;
      room.slate.doc.transact(() => {
        for (const [k, v] of Object.entries(patch)) m.set(k, v);
      });
    },
    [nodesMap, room],
  );

  const createNode = useCallback(
    (shape: DiagramNodeShape, center: Point): string => {
      const size = DEFAULT_SIZE[shape];
      const id = makeId('node');
      const snap = useDiagramStore.getState().snap;
      const node: DiagramNode = {
        id,
        shape,
        x: snapTo(center.x - size.w / 2, snap),
        y: snapTo(center.y - size.h / 2, snap),
        w: size.w,
        h: size.h,
        text: '',
        fill: useDiagramStore.getState().fill,
        stroke: useDiagramStore.getState().stroke,
        createdAt: Date.now(),
        authorId: room.identity.peerId,
      };
      nodesMap.set(id, toYMap(node as unknown as Record<string, unknown>));
      return id;
    },
    [nodesMap, room],
  );

  const createEdge = useCallback(
    (from: string, to: string) => {
      if (from === to) return;
      if (edges.some((e) => e.from === from && e.to === to)) return;
      const id = makeId('edge');
      const { stroke, routing, dashed } = useDiagramStore.getState();
      const edge: DiagramEdge = {
        id,
        from,
        to,
        label: '',
        stroke,
        routing,
        dashed,
        createdAt: Date.now(),
        authorId: room.identity.peerId,
      };
      edgesMap.set(id, toYMap(edge as unknown as Record<string, unknown>));
    },
    [edges, edgesMap, room],
  );

  const deleteSelection = useCallback(() => {
    if (selection.size === 0 && !selectedEdge) return;
    room.slate.doc.transact(() => {
      for (const id of selection) {
        nodesMap.delete(id);
        for (const e of edges) {
          if (e.from === id || e.to === id) edgesMap.delete(e.id);
        }
      }
      if (selectedEdge) edgesMap.delete(selectedEdge);
    });
    setSelection(new Set());
    setSelectedEdge(null);
  }, [selection, selectedEdge, edges, nodesMap, edgesMap, room]);

  // Restyle the current selection: nodes take fill+stroke; a selected connector
  // takes stroke + routing + dashed. Only defined fields are written.
  const applyStyle = useCallback(
    (style: DiagramStyle) => {
      const sel = selectionRef.current;
      const selEdge = selectedEdgeRef.current;
      if (sel.size === 0 && !selEdge) return;
      room.slate.doc.transact(() => {
        for (const id of sel) {
          const m = nodesMap.get(id);
          if (!m) continue;
          if (style.fill !== undefined) m.set('fill', style.fill);
          if (style.stroke !== undefined) m.set('stroke', style.stroke);
        }
        const em = selEdge ? edgesMap.get(selEdge) : null;
        if (em) {
          if (style.stroke !== undefined) em.set('stroke', style.stroke);
          if (style.routing !== undefined) em.set('routing', style.routing);
          if (style.dashed !== undefined) em.set('dashed', style.dashed);
        }
      });
    },
    [nodesMap, edgesMap, room],
  );

  useEffect(() => onDiagramStyle(applyStyle), [applyStyle]);

  // ── Text / edge-label editing ──────────────────────────────────────────────
  const commitText = useCallback(() => {
    const te = textEdit;
    if (!te) return;
    setTextEdit(null);
    patchNode(te.nodeId, { text: te.value.slice(0, 5000) });
  }, [textEdit, patchNode]);

  const commitEdgeLabel = useCallback(() => {
    const ee = edgeEdit;
    if (!ee) return;
    setEdgeEdit(null);
    edgesMap.get(ee.edgeId)?.set('label', ee.value.slice(0, 2000));
  }, [edgeEdit, edgesMap]);

  const commitEdits = useCallback(() => {
    if (textEdit) commitText();
    if (edgeEdit) commitEdgeLabel();
  }, [textEdit, edgeEdit, commitText, commitEdgeLabel]);

  const editNode = useCallback(
    (id: string) => {
      const n = nodeById.get(id);
      if (n) setTextEdit({ nodeId: id, value: n.text });
    },
    [nodeById],
  );

  // ── Pointer handling ───────────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-canvas]')) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      commitEdits();

      const board = toBoard(e.clientX, e.clientY);
      const wantPan = tool === 'pan' || isSpaceDownRef.current || e.button === 1 || e.button === 2;
      if (wantPan) {
        dragRef.current = { kind: 'pan', startClient: { x: e.clientX, y: e.clientY } };
        return;
      }

      // Connect handle (hover affordance) → start a connector.
      const connectHandle = target.closest('[data-connect-node]') as HTMLElement | null;
      if (connectHandle) {
        const from = connectHandle.getAttribute('data-connect-node')!;
        dragRef.current = { kind: 'connect', from, cur: board };
        return;
      }

      // Resize handle (single selection).
      const handle = target.closest('[data-handle]') as HTMLElement | null;
      if (handle && selection.size === 1) {
        const nodeId = [...selection][0]!;
        const start = nodeById.get(nodeId);
        if (start) {
          dragRef.current = { kind: 'resize', nodeId, corner: handle.getAttribute('data-handle') as Corner, start };
          return;
        }
      }

      const hit = nodeAt(nodes, board);
      const shape = toolShape(tool);

      if (shape) {
        const id = createNode(shape, board);
        setSelection(new Set([id]));
        setSelectedEdge(null);
        setTool('select');
        // Defer entering label-edit until after this click settles: the
        // pointerup/click that follows this pointerdown refocuses the body, so
        // a synchronously-opened editor would blur (and self-commit) before you
        // could type. One frame later there are no more focus-stealing events.
        requestAnimationFrame(() => setTextEdit({ nodeId: id, value: '' }));
        return;
      }

      if (tool === 'connect') {
        if (hit) dragRef.current = { kind: 'connect', from: hit.id, cur: board };
        return;
      }

      // Select tool.
      if (hit) {
        setSelectedEdge(null);
        let moving = new Set(selection);
        if (e.shiftKey) {
          if (moving.has(hit.id)) moving.delete(hit.id);
          else moving.add(hit.id);
          setSelection(new Set(moving));
        } else if (!selection.has(hit.id)) {
          moving = new Set([hit.id]);
          setSelection(moving);
        }
        const origin = new Map<string, Point>();
        for (const id of moving) {
          const n = nodeById.get(id);
          if (n) origin.set(id, { x: n.x, y: n.y });
        }
        dragRef.current = { kind: 'move', startBoard: board, origin, moved: false };
      } else {
        setSelectedEdge(null);
        if (!e.shiftKey) setSelection(new Set());
        dragRef.current = { kind: 'marquee', startBoard: board, cur: board };
      }
    },
    [tool, toBoard, nodes, nodeById, selection, createNode, setTool, commitEdits],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const board = toBoard(e.clientX, e.clientY);
      if (!drag) {
        // Hover feedback for connect handles / connect-tool targeting.
        if (tool === 'select' || tool === 'connect') {
          const hit = nodeAt(nodes, board);
          setHoverNode(hit?.id ?? null);
        } else if (hoverNode) {
          setHoverNode(null);
        }
        return;
      }
      if (drag.kind === 'pan') {
        pan(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y);
        drag.startClient = { x: e.clientX, y: e.clientY };
        return;
      }
      if (drag.kind === 'move') {
        let dx = board.x - drag.startBoard.x;
        let dy = board.y - drag.startBoard.y;
        if (dx || dy) drag.moved = true;
        // Snap the whole group by aligning the anchor node to the grid, keeping
        // every node's relative offset intact (rather than snapping each one).
        if (useDiagramStore.getState().snap) {
          const anchor = drag.origin.values().next().value as Point | undefined;
          if (anchor) {
            dx = snapTo(anchor.x + dx, true) - anchor.x;
            dy = snapTo(anchor.y + dy, true) - anchor.y;
          }
        }
        room.slate.doc.transact(() => {
          for (const [id, o] of drag.origin) {
            const m = nodesMap.get(id);
            if (m) {
              m.set('x', Math.round(o.x + dx));
              m.set('y', Math.round(o.y + dy));
            }
          }
        });
        return;
      }
      if (drag.kind === 'resize') {
        const snap = useDiagramStore.getState().snap;
        const p = snap ? { x: snapTo(board.x, true), y: snapTo(board.y, true) } : board;
        applyResize(drag, p, patchNode);
        return;
      }
      if (drag.kind === 'marquee') {
        drag.cur = board;
        setDragTick((t) => t + 1);
        return;
      }
      if (drag.kind === 'connect') {
        drag.cur = board;
        setHoverNode(nodeAt(nodes, board)?.id ?? null);
        setDragTick((t) => t + 1);
        return;
      }
    },
    [tool, nodes, nodesMap, toBoard, pan, patchNode, room, hoverNode],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      const board = toBoard(e.clientX, e.clientY);
      if (drag.kind === 'marquee') {
        const r = normRect(drag.startBoard, board);
        // A click (zero-size marquee) just clears; a drag selects overlaps.
        if (r.w > 2 || r.h > 2) {
          const hits = nodes.filter((n) => rectsOverlap(r, n));
          setSelection((sel) => {
            const next = new Set(e.shiftKey ? sel : []);
            for (const n of hits) next.add(n.id);
            return next;
          });
        }
        setDragTick((t) => t + 1);
      } else if (drag.kind === 'connect') {
        const hit = nodeAt(nodes, board);
        if (hit) createEdge(drag.from, hit.id);
        setHoverNode(null);
        setDragTick((t) => t + 1);
      }
    },
    [nodes, toBoard, createEdge],
  );

  // ── Fit-to-content ─────────────────────────────────────────────────────────
  const fitContent = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (nodes.length === 0) {
      setViewport(1, r.width / 2, r.height / 2);
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const pad = 80;
    const bw = maxX - minX;
    const bh = maxY - minY;
    const z = Math.max(0.1, Math.min(1.5, Math.min((r.width - pad) / bw, (r.height - pad) / bh)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport(z, r.width / 2 - cx * z, r.height / 2 - cy * z);
  }, [nodes, setViewport]);

  // ── Wheel: pan / ctrl-zoom (native, non-passive) ───────────────────────────
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.deltaY < 0 ? 1.1 : 0.9);
      } else {
        pan(-ev.deltaX, -ev.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, pan]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      if (e.code === 'Space') {
        isSpaceDownRef.current = true;
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (ctrl && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) room.undo.redo();
        else room.undo.undo();
        return;
      }
      if (ctrl && k === 'a') {
        e.preventDefault();
        setSelection(new Set(nodes.map((n) => n.id)));
        setSelectedEdge(null);
        return;
      }

      // Clipboard.
      const copy = (): boolean => {
        const sel = selectionRef.current;
        if (sel.size === 0) return false;
        const picked = nodes.filter((n) => sel.has(n.id));
        const inSel = edges.filter((ed) => sel.has(ed.from) && sel.has(ed.to));
        clipboardRef.current = {
          nodes: picked.map((n) => ({ ...n })),
          edges: inSel.map((ed) => ({ ...ed })),
        };
        return true;
      };
      const paste = () => {
        const clip = clipboardRef.current;
        if (clip.nodes.length === 0) return;
        const now = Date.now();
        const me = room.identity.peerId;
        const idMap = new Map<string, string>();
        const newIds: string[] = [];
        room.slate.doc.transact(() => {
          for (const n of clip.nodes) {
            const id = makeId('node');
            idMap.set(n.id, id);
            newIds.push(id);
            nodesMap.set(
              id,
              toYMap({ ...n, id, x: n.x + PASTE_OFFSET, y: n.y + PASTE_OFFSET, createdAt: now, authorId: me } as unknown as Record<string, unknown>),
            );
          }
          for (const ed of clip.edges) {
            const from = idMap.get(ed.from);
            const to = idMap.get(ed.to);
            if (!from || !to) continue;
            const id = makeId('edge');
            edgesMap.set(id, toYMap({ ...ed, id, from, to, createdAt: now, authorId: me } as unknown as Record<string, unknown>));
          }
        });
        setSelection(new Set(newIds));
        setSelectedEdge(null);
      };

      if (ctrl && k === 'c') {
        if (copy()) e.preventDefault();
        return;
      }
      if (ctrl && k === 'x') {
        if (copy()) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (ctrl && k === 'v') {
        e.preventDefault();
        paste();
        return;
      }
      if (ctrl && k === 'd') {
        e.preventDefault();
        if (copy()) paste();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === 'Enter' && selectionRef.current.size === 1 && !textEdit) {
        e.preventDefault();
        editNode([...selectionRef.current][0]!);
        return;
      }
      if (e.key === 'Escape') {
        setSelection(new Set());
        setSelectedEdge(null);
        return;
      }

      // Arrow-key nudge.
      const nudges: Record<string, Point> = {
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
      };
      if (nudges[e.key] && selectionRef.current.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = nudges[e.key]!;
        room.slate.doc.transact(() => {
          for (const id of selectionRef.current) {
            const m = nodesMap.get(id);
            if (m) {
              m.set('x', (m.get('x') as number) + d.x * step);
              m.set('y', (m.get('y') as number) + d.y * step);
            }
          }
        });
        return;
      }

      if (ctrl) return;
      const map: Record<string, DiagramTool> = {
        v: 'select',
        r: 'rect',
        o: 'ellipse',
        d: 'diamond',
        n: 'note',
        p: 'pill',
        g: 'parallelogram',
        x: 'hexagon',
        y: 'cylinder',
        i: 'triangle',
        c: 'connect',
        h: 'pan',
      };
      if (map[k]) {
        e.preventDefault();
        setTool(map[k]!);
      }
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
  }, [room, nodes, edges, nodesMap, edgesMap, textEdit, deleteSelection, editNode, setTool]);

  // Publish awareness cursor (board coords) at ~30 Hz.
  useEffect(() => {
    let pending: Point | null = null;
    let lastKey = '';
    const move = (e: PointerEvent) => {
      const el = wrapperRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      pending = toBoard(e.clientX, e.clientY);
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
  }, [room, tool, toBoard]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const cursorClass =
    tool === 'pan'
      ? 'cursor-grab'
      : tool === 'connect'
        ? 'cursor-crosshair'
        : toolShape(tool)
          ? 'cursor-copy'
          : 'cursor-default';

  const drag = dragRef.current;
  const marquee = drag?.kind === 'marquee' ? normRect(drag.startBoard, drag.cur) : null;
  const connectLine = drag?.kind === 'connect' ? { from: nodeById.get(drag.from), to: drag.cur } : null;
  const singleSel = selection.size === 1 ? nodeById.get([...selection][0]!) ?? null : null;
  // Connect handles show on the hovered node in select mode (but not mid-drag,
  // and not on the node currently being text-edited).
  const handleNode =
    tool === 'select' && !drag && hoverNode && hoverNode !== textEdit?.nodeId
      ? nodeById.get(hoverNode) ?? null
      : null;

  return (
    <div
      ref={wrapperRef}
      className={cn('relative h-full w-full overflow-hidden', cursorClass)}
      style={{ background: paper, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        const edgeEl = target.closest('[data-edge]') as HTMLElement | null;
        if (edgeEl) {
          const id = edgeEl.getAttribute('data-edge')!;
          const ed = edges.find((x) => x.id === id);
          if (ed) setEdgeEdit({ edgeId: id, value: ed.label });
          return;
        }
        const hit = nodeAt(nodes, toBoard(e.clientX, e.clientY));
        if (hit) editNode(hit.id);
        else if (tool === 'select') {
          const id = createNode('rect', toBoard(e.clientX, e.clientY));
          setSelection(new Set([id]));
          setTextEdit({ nodeId: id, value: '' });
        }
      }}
    >
      <svg className="absolute inset-0 h-full w-full" style={{ display: 'block' }}>
        <defs>
          <pattern id="diagram-grid" width={24 * zoom} height={24 * zoom} patternUnits="userSpaceOnUse" x={panX} y={panY}>
            <circle cx={1} cy={1} r={1} fill={grid} />
          </pattern>
          <marker id="diagram-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
          </marker>
          <filter id="diagram-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="#000" floodOpacity="0.28" />
          </filter>
        </defs>
        <rect x={0} y={0} width="100%" height="100%" fill="url(#diagram-grid)" />

        <g transform={`translate(${panX} ${panY}) scale(${zoom})`}>
          {/* Connectors (under nodes) */}
          {edges.map((edge) => {
            const a = nodeById.get(edge.from);
            const b = nodeById.get(edge.to);
            if (!a || !b) return null;
            const { d, mid } = edgePath(a, b, edge.routing ?? 'straight');
            const sel = selectedEdge === edge.id;
            return (
              <g key={edge.id}>
                <path
                  data-edge={edge.id}
                  d={d}
                  fill="none"
                  stroke="transparent" strokeWidth={16}
                  style={{ cursor: 'pointer' }}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    commitEdits();
                    setSelectedEdge(edge.id);
                    setSelection(new Set());
                  }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke={edge.stroke}
                  strokeWidth={sel ? 3 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={edge.dashed ? '7 5' : undefined}
                  markerEnd="url(#diagram-arrow)"
                  pointerEvents="none"
                />
                {edge.label && edgeEdit?.edgeId !== edge.id && (
                  <text
                    x={mid.x} y={mid.y - 5}
                    textAnchor="middle"
                    fontSize={12}
                    fill={edge.stroke}
                    pointerEvents="none"
                    style={{ paintOrder: 'stroke', stroke: paper, strokeWidth: 4, strokeLinejoin: 'round' }}
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Live connect preview */}
          {connectLine?.from && (
            <line
              x1={nodeCenter(connectLine.from).x}
              y1={nodeCenter(connectLine.from).y}
              x2={connectLine.to.x}
              y2={connectLine.to.y}
              stroke={stroke}
              strokeWidth={2}
              strokeDasharray="6 4"
              markerEnd="url(#diagram-arrow)"
              pointerEvents="none"
            />
          )}

          {/* Nodes */}
          {nodes.map((n) => (
            <NodeShape
              key={n.id}
              node={n}
              selected={selection.has(n.id)}
              connectHover={(tool === 'connect' || !!connectLine) && hoverNode === n.id}
              hidden={textEdit?.nodeId === n.id}
            />
          ))}

          {/* Resize handles for a single selected node */}
          {singleSel && <ResizeHandles node={singleSel} zoom={zoom} />}

          {/* Connect handles on hover (select mode) */}
          {handleNode && <ConnectHandles node={handleNode} zoom={zoom} />}

          {/* Marquee */}
          {marquee && (
            <rect
              x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h}
              fill="var(--accent)" fillOpacity={0.08}
              stroke="var(--accent)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>

      {/* Inline node text editor */}
      {textEdit &&
        (() => {
          const n = nodeById.get(textEdit.nodeId);
          if (!n) return null;
          return (
            <NodeTextEditor
              node={n}
              value={textEdit.value}
              screen={{ x: n.x * zoom + panX, y: n.y * zoom + panY }}
              zoom={zoom}
              onChange={(value) => setTextEdit((s) => (s ? { ...s, value } : s))}
              onCommit={commitText}
            />
          );
        })()}

      {/* Inline edge-label editor */}
      {edgeEdit &&
        (() => {
          const ed = edges.find((x) => x.id === edgeEdit.edgeId);
          const a = ed && nodeById.get(ed.from);
          const b = ed && nodeById.get(ed.to);
          if (!ed || !a || !b) return null;
          const { mid } = edgePath(a, b, ed.routing ?? 'straight');
          return (
            <input
              data-no-canvas
              autoFocus
              value={edgeEdit.value}
              placeholder="Label…"
              onChange={(e) => setEdgeEdit((s) => (s ? { ...s, value: e.target.value } : s))}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  commitEdgeLabel();
                }
              }}
              onBlur={commitEdgeLabel}
              className="absolute z-20 w-32 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-accent/70 bg-bg/90 px-1.5 py-0.5 text-center text-xs text-text outline-none backdrop-blur-sm"
              style={{ left: mid.x * zoom + panX, top: mid.y * zoom + panY }}
            />
          );
        })()}

      <RemoteDiagramCursors />

      <DiagramToolbar
        onUndo={() => room.undo.undo()}
        onRedo={() => room.undo.redo()}
        onZoomIn={() => {
          const r = wrapperRef.current!.getBoundingClientRect();
          zoomAt(r.width / 2, r.height / 2, 1.1);
        }}
        onZoomOut={() => {
          const r = wrapperRef.current!.getBoundingClientRect();
          zoomAt(r.width / 2, r.height / 2, 0.9);
        }}
        onResetZoom={() => {
          const r = wrapperRef.current!.getBoundingClientRect();
          setViewport(1, r.width / 2, r.height / 2);
        }}
        onFit={fitContent}
        onDelete={deleteSelection}
        canDelete={selection.size > 0 || !!selectedEdge}
        zoomLabel={`${Math.round(zoom * 100)}%`}
        snap={snap}
        onToggleSnap={toggleSnap}
      />

      {nodes.length === 0 && !textEdit && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="text-sm text-text-dim">
            Pick a shape and click to drop a node — or double-click anywhere.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Node rendering ────────────────────────────────────────────────────────────

const NOTE_FOLD = 16;

function NodeShape({
  node,
  selected,
  connectHover,
  hidden,
}: {
  node: DiagramNode;
  selected: boolean;
  connectHover: boolean;
  hidden: boolean;
}) {
  const { x, y, w, h, fill, stroke, shape } = node;
  const strokeW = selected ? 2.5 : 1.5;
  const outline = connectHover ? 'var(--accent)' : stroke;
  let body: React.ReactNode;
  if (shape === 'ellipse') {
    body = <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={outline} strokeWidth={strokeW} filter="url(#diagram-shadow)" />;
  } else if (shape === 'diamond') {
    body = (
      <polygon
        points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
        fill={fill}
        stroke={outline}
        strokeWidth={strokeW}
        filter="url(#diagram-shadow)"
      />
    );
  } else if (shape === 'pill') {
    body = <rect x={x} y={y} width={w} height={h} rx={h / 2} ry={h / 2} fill={fill} stroke={outline} strokeWidth={strokeW} filter="url(#diagram-shadow)" />;
  } else if (shape === 'triangle') {
    body = (
      <polygon
        points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`}
        fill={fill}
        stroke={outline}
        strokeWidth={strokeW}
        strokeLinejoin="round"
        filter="url(#diagram-shadow)"
      />
    );
  } else if (shape === 'parallelogram') {
    const off = Math.min(w * 0.25, h);
    body = (
      <polygon
        points={`${x + off},${y} ${x + w},${y} ${x + w - off},${y + h} ${x},${y + h}`}
        fill={fill}
        stroke={outline}
        strokeWidth={strokeW}
        strokeLinejoin="round"
        filter="url(#diagram-shadow)"
      />
    );
  } else if (shape === 'hexagon') {
    const off = Math.min(w * 0.22, h / 2);
    body = (
      <polygon
        points={`${x + off},${y} ${x + w - off},${y} ${x + w},${y + h / 2} ${x + w - off},${y + h} ${x + off},${y + h} ${x},${y + h / 2}`}
        fill={fill}
        stroke={outline}
        strokeWidth={strokeW}
        strokeLinejoin="round"
        filter="url(#diagram-shadow)"
      />
    );
  } else if (shape === 'cylinder') {
    const ry = Math.min(h * 0.16, 18);
    body = (
      <g filter="url(#diagram-shadow)">
        {/* Body: side walls + bottom arc; the top rim ellipse is drawn over it. */}
        <path
          d={`M${x},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry} V${y + ry} Z`}
          fill={fill}
          stroke={outline}
          strokeWidth={strokeW}
          strokeLinejoin="round"
        />
        <ellipse cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} fill={fill} stroke={outline} strokeWidth={strokeW} />
      </g>
    );
  } else if (shape === 'note') {
    const f = Math.min(NOTE_FOLD, w / 3, h / 3);
    body = (
      <g filter="url(#diagram-shadow)">
        {/* Body with a clipped top-right corner. */}
        <path
          d={`M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + h} H${x} Z`}
          fill={fill}
          stroke={outline}
          strokeWidth={strokeW}
          strokeLinejoin="round"
        />
        {/* Folded corner. */}
        <path d={`M${x + w - f},${y} V${y + f} H${x + w} Z`} fill={outline} fillOpacity={0.25} stroke={outline} strokeWidth={strokeW} strokeLinejoin="round" />
      </g>
    );
  } else {
    body = <rect x={x} y={y} width={w} height={h} rx={8} fill={fill} stroke={outline} strokeWidth={strokeW} filter="url(#diagram-shadow)" />;
  }
  return (
    <g data-node={node.id} style={{ opacity: hidden ? 0 : 1 }}>
      {body}
      {selected && (
        <rect
          x={x - 4} y={y - 4} width={w + 8} height={h + 8}
          rx={10}
          fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="5 4"
          pointerEvents="none"
        />
      )}
      {!hidden && node.text && (
        <foreignObject x={x} y={y} width={w} height={h} pointerEvents="none">
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 10px',
              boxSizing: 'border-box',
              color: stroke,
              fontSize: 14,
              lineHeight: 1.25,
              textAlign: 'center',
              overflow: 'hidden',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            {node.text}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

function ResizeHandles({ node, zoom }: { node: DiagramNode; zoom: number }) {
  const s = 9 / zoom;
  const corners: { c: Corner; x: number; y: number; cursor: string }[] = [
    { c: 'nw', x: node.x, y: node.y, cursor: 'nwse-resize' },
    { c: 'ne', x: node.x + node.w, y: node.y, cursor: 'nesw-resize' },
    { c: 'sw', x: node.x, y: node.y + node.h, cursor: 'nesw-resize' },
    { c: 'se', x: node.x + node.w, y: node.y + node.h, cursor: 'nwse-resize' },
  ];
  return (
    <>
      {corners.map((k) => (
        <rect
          key={k.c}
          data-handle={k.c}
          x={k.x - s / 2}
          y={k.y - s / 2}
          width={s}
          height={s}
          rx={2 / zoom}
          fill="#fff"
          stroke="var(--accent)"
          strokeWidth={1.5 / zoom}
          style={{ cursor: k.cursor }}
        />
      ))}
    </>
  );
}

/** Four directional dots that start a connector when dragged. */
function ConnectHandles({ node, zoom }: { node: DiagramNode; zoom: number }) {
  const r = 5 / zoom;
  const pts = [
    { x: node.x + node.w / 2, y: node.y },
    { x: node.x + node.w, y: node.y + node.h / 2 },
    { x: node.x + node.w / 2, y: node.y + node.h },
    { x: node.x, y: node.y + node.h / 2 },
  ];
  return (
    <>
      {pts.map((p, i) => (
        <circle
          key={i}
          data-connect-node={node.id}
          cx={p.x}
          cy={p.y}
          r={r}
          fill="var(--accent)"
          stroke="#fff"
          strokeWidth={1.5 / zoom}
          style={{ cursor: 'crosshair' }}
        />
      ))}
    </>
  );
}

/** Absolutely-positioned textarea sized to the node in screen space. */
function NodeTextEditor({
  node,
  value,
  screen,
  zoom,
  onChange,
  onCommit,
}: {
  node: DiagramNode;
  value: string;
  screen: Point;
  zoom: number;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      data-no-canvas
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCommit();
        }
      }}
      onBlur={onCommit}
      spellCheck={false}
      placeholder="Label…"
      className="absolute z-20 resize-none rounded-md border-2 border-accent/70 bg-bg/90 text-center outline-none backdrop-blur-sm placeholder:text-text-dim"
      style={{
        left: screen.x,
        top: screen.y,
        width: node.w * zoom,
        height: node.h * zoom,
        padding: '6px 10px',
        color: node.stroke,
        fontSize: 14 * zoom,
        lineHeight: 1.25,
        fontFamily: 'Inter, sans-serif',
      }}
    />
  );
}

// ── Remote cursors (reads the diagram viewport transform) ─────────────────────

function RemoteDiagramCursors() {
  const room = useRoom();
  const [peers, setPeers] = useState<{ id: string; name: string; color: string; x: number; y: number }[]>([]);
  useEffect(
    () =>
      room.onAwarenessChange((states) => {
        setPeers(
          states
            .filter((s) => s.id !== room.identity.peerId && s.cursor)
            .map((s) => ({ id: s.id, name: s.name, color: s.color, x: s.cursor!.x, y: s.cursor!.y })),
        );
      }),
    [room],
  );
  const zoom = useDiagramStore((s) => s.zoom);
  const panX = useDiagramStore((s) => s.panX);
  const panY = useDiagramStore((s) => s.panY);
  if (peers.length === 0) return null;
  return (
    <>
      {peers.map((p) => (
        <div
          key={p.id}
          className="pointer-events-none absolute left-0 top-0 z-20 will-change-transform"
          style={{ transform: `translate(${p.x * zoom + panX}px, ${p.y * zoom + panY}px)` }}
          aria-hidden
        >
          <svg width="16" height="18" viewBox="0 0 16 18" className="drop-shadow-md">
            <path
              d="M1.5 1.5 L1.5 13.5 L4.6 10.7 L6.8 15.6 L9.2 14.5 L7 9.8 L11.5 9.4 Z"
              fill={p.color}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth="1"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="ml-3 -mt-0.5 block w-max max-w-[120px] truncate rounded-full px-1.5 py-px text-[10px] font-medium leading-4 text-black/85 shadow-md"
            style={{ backgroundColor: p.color }}
          >
            {p.name}
          </span>
        </div>
      ))}
    </>
  );
}

// ── Floating toolbar ──────────────────────────────────────────────────────────

const TOOL_BUTTONS: { id: DiagramTool; icon: typeof Square; label: string; key: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { id: 'rect', icon: Square, label: 'Box', key: 'R' },
  { id: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { id: 'diamond', icon: Diamond, label: 'Diamond', key: 'D' },
  { id: 'note', icon: StickyNote, label: 'Sticky note', key: 'N' },
  { id: 'connect', icon: Spline, label: 'Connector', key: 'C' },
  { id: 'pan', icon: Hand, label: 'Pan', key: 'H' },
];

function DiagramToolbar({
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
  onDelete,
  canDelete,
  zoomLabel,
  snap,
  onToggleSnap,
}: {
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFit: () => void;
  onDelete: () => void;
  canDelete: boolean;
  zoomLabel: string;
  snap: boolean;
  onToggleSnap: () => void;
}) {
  const tool = useDiagramStore((s) => s.tool);
  const setTool = useDiagramStore((s) => s.setTool);
  return (
    <div
      data-no-canvas
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg-2/95 p-1 shadow-lg backdrop-blur"
    >
      {TOOL_BUTTONS.map((b) => (
        <button
          key={b.id}
          type="button"
          title={`${b.label} (${b.key})`}
          onClick={() => setTool(b.id)}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
            tool === b.id ? 'bg-accent text-white' : 'text-text-mid hover:bg-bg-3 hover:text-text',
          )}
        >
          <b.icon size={16} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-border" />
      <ToolbarIcon title="Undo (Ctrl+Z)" onClick={onUndo}><Undo2 size={16} /></ToolbarIcon>
      <ToolbarIcon title="Redo (Ctrl+Shift+Z)" onClick={onRedo}><Redo2 size={16} /></ToolbarIcon>
      <ToolbarIcon title="Delete (Del)" onClick={onDelete} disabled={!canDelete}><Trash2 size={16} /></ToolbarIcon>
      <span className="mx-1 h-5 w-px bg-border" />
      <button
        type="button"
        title={snap ? 'Snap to grid: on' : 'Snap to grid: off'}
        aria-pressed={snap}
        onClick={onToggleSnap}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          snap ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text',
        )}
      >
        <Magnet size={16} />
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      <ToolbarIcon title="Zoom out" onClick={onZoomOut}><ZoomOut size={16} /></ToolbarIcon>
      <button
        type="button"
        onClick={onResetZoom}
        title="Reset zoom to 100%"
        className="min-w-[3rem] rounded-md px-1 text-center font-mono text-[11px] text-text-mid hover:bg-bg-3 hover:text-text"
      >
        {zoomLabel}
      </button>
      <ToolbarIcon title="Zoom in" onClick={onZoomIn}><ZoomIn size={16} /></ToolbarIcon>
      <ToolbarIcon title="Fit to content" onClick={onFit}><Maximize size={16} /></ToolbarIcon>
    </div>
  );
}

function ToolbarIcon({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-mid transition-colors hover:bg-bg-3 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ── Geometry utilities ────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function rectsOverlap(r: Rect, n: DiagramNode): boolean {
  return !(n.x > r.x + r.w || n.x + n.w < r.x || n.y > r.y + r.h || n.y + n.h < r.y);
}

function applyResize(
  drag: { nodeId: string; corner: Corner; start: DiagramNode },
  board: Point,
  patchNode: (id: string, patch: Partial<DiagramNode>) => void,
): void {
  const s = drag.start;
  let x = s.x;
  let y = s.y;
  let right = s.x + s.w;
  let bottom = s.y + s.h;
  if (drag.corner === 'nw') {
    x = Math.min(board.x, right - MIN_W);
    y = Math.min(board.y, bottom - MIN_H);
  } else if (drag.corner === 'ne') {
    right = Math.max(board.x, x + MIN_W);
    y = Math.min(board.y, bottom - MIN_H);
  } else if (drag.corner === 'sw') {
    x = Math.min(board.x, right - MIN_W);
    bottom = Math.max(board.y, y + MIN_H);
  } else {
    right = Math.max(board.x, x + MIN_W);
    bottom = Math.max(board.y, y + MIN_H);
  }
  patchNode(drag.nodeId, {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(right - x),
    h: Math.round(bottom - y),
  });
}

export default DiagramEditor;
