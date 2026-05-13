/**
 * 2D canvas engine — owns the imperative render loop and the bridge to Yjs.
 *
 *   - Subscribes to shapes / strokes / layers / meta and rebuilds a fast
 *     plain-JS scene snapshot on change.
 *   - Renders on requestAnimationFrame when dirty.
 *   - Exposes commit* helpers that wrap Yjs transactions, so tools never
 *     touch raw Y.Map directly and validation happens once per write.
 */

import * as Y from 'yjs';
import {
  layerSchema,
  shapeSchema,
  strokeSchema,
  type Layer,
  type Shape,
  type Stroke,
} from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import {
  renderScene,
  resizeCanvas,
  type SceneFrame,
  type ViewportSize,
} from './renderer';
import type { Rect, ViewportTransform } from './types';

interface EngineOpts {
  canvas: HTMLCanvasElement;
  room: SlateRoom;
  getTransform: () => ViewportTransform;
  getSelection: () => Set<string>;
  getMarquee: () => Rect | null;
  getLivePreview: () => { stroke: Stroke | null; shape: Shape | null };
  getViewport: () => ViewportSize;
  getPaper: () => string;
}

export class CanvasEngine {
  private opts: EngineOpts;
  private rafHandle = 0;
  private dirty = true;
  private scene: SceneFrame;
  private offShapes = new Set<() => void>();
  private offStrokes = new Set<() => void>();
  private offLayers = new Set<() => void>();
  private cachedLayers: Layer[] = [];
  private cachedShapesByLayer = new Map<string, Shape[]>();
  private cachedStrokesByLayer = new Map<string, Stroke[]>();

  constructor(opts: EngineOpts) {
    this.opts = opts;
    this.scene = {
      layers: [],
      shapesByLayer: new Map(),
      strokesByLayer: new Map(),
      selection: new Set(),
      paper: opts.getPaper(),
    };
    this.attach();
    this.markDirty();
    this.loop();
  }

  /** Re-read Yjs state and rebuild the plain-JS snapshot. */
  rebuild = (): void => {
    const { slate } = this.opts.room;
    const layers = readLayers(slate.layers());
    const shapesByLayer = new Map<string, Shape[]>();
    const strokesByLayer = new Map<string, Stroke[]>();

    layers.forEach((l) => {
      shapesByLayer.set(l.id, []);
      strokesByLayer.set(l.id, []);
    });
    const fallbackLayer = layers[layers.length - 1]?.id;
    slate.shapes().forEach((m) => {
      const sh = readShape(m);
      if (!sh) return;
      const lid = shapesByLayer.has(sh.layerId)
        ? sh.layerId
        : fallbackLayer;
      if (!lid) return;
      (shapesByLayer.get(lid) ?? []).push(sh);
    });
    slate.strokes().forEach((m) => {
      const st = readStroke(m);
      if (!st) return;
      const lid = strokesByLayer.has(st.layerId)
        ? st.layerId
        : fallbackLayer;
      if (!lid) return;
      (strokesByLayer.get(lid) ?? []).push(st);
    });
    // Stable order by createdAt for reproducible composite (Yjs Map iteration
    // is insertion-order which is fine for live use but explicit sort makes
    // exports deterministic).
    for (const arr of shapesByLayer.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
    for (const arr of strokesByLayer.values()) arr.sort((a, b) => a.createdAt - b.createdAt);

    this.cachedLayers = layers;
    this.cachedShapesByLayer = shapesByLayer;
    this.cachedStrokesByLayer = strokesByLayer;
    this.markDirty();
  };

  markDirty(): void {
    this.dirty = true;
  }

  resize(size: ViewportSize): void {
    resizeCanvas(this.opts.canvas, size);
    this.markDirty();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.detach();
  }

  // ── Yjs commits ───────────────────────────────────────────────────────────
  private isDrawMuted(): boolean {
    const meta = this.opts.room.slate.meta();
    const list = (meta.get('drawMutes') as string[] | undefined) ?? [];
    return list.includes(this.opts.room.identity.peerId);
  }

  commitStroke(s: Stroke): void {
    if (this.isDrawMuted()) return;
    const parsed = strokeSchema.safeParse(s);
    if (!parsed.success) return;
    const room = this.opts.room;
    room.slate.doc.transact(() => {
      const m = new Y.Map<unknown>();
      Object.entries(parsed.data).forEach(([k, v]) => m.set(k, v));
      room.slate.strokes().set(parsed.data.id, m);
    });
  }

  commitShape(s: Shape): void {
    if (this.isDrawMuted()) return;
    const parsed = shapeSchema.safeParse(s);
    if (!parsed.success) return;
    const room = this.opts.room;
    room.slate.doc.transact(() => {
      const m = new Y.Map<unknown>();
      Object.entries(parsed.data).forEach(([k, v]) => m.set(k, v));
      room.slate.shapes().set(parsed.data.id, m);
    });
  }

  updateShape(id: string, patch: Partial<Shape>): void {
    const room = this.opts.room;
    const m = room.slate.shapes().get(id);
    if (!m) return;
    room.slate.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) m.set(k, v as unknown);
    });
  }

  updateStroke(id: string, patch: Partial<Stroke>): void {
    const room = this.opts.room;
    const m = room.slate.strokes().get(id);
    if (!m) return;
    room.slate.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) m.set(k, v as unknown);
    });
  }

  deleteIds(ids: Iterable<string>): void {
    const room = this.opts.room;
    room.slate.doc.transact(() => {
      for (const id of ids) {
        room.slate.shapes().delete(id);
        room.slate.strokes().delete(id);
      }
    });
  }

  clearAll(): void {
    const room = this.opts.room;
    room.slate.doc.transact(() => {
      const shapes = room.slate.shapes();
      const strokes = room.slate.strokes();
      shapes.forEach((_, k) => shapes.delete(k));
      strokes.forEach((_, k) => strokes.delete(k));
    });
  }

  // ── Snapshot accessors ────────────────────────────────────────────────────
  snapshot(): {
    layers: Layer[];
    shapesByLayer: Map<string, Shape[]>;
    strokesByLayer: Map<string, Stroke[]>;
  } {
    return {
      layers: this.cachedLayers,
      shapesByLayer: this.cachedShapesByLayer,
      strokesByLayer: this.cachedStrokesByLayer,
    };
  }

  // ── private ───────────────────────────────────────────────────────────────
  private attach(): void {
    const { slate } = this.opts.room;
    const shapes = slate.shapes();
    const strokes = slate.strokes();
    const layers = slate.layers();
    const meta = slate.meta();
    shapes.observeDeep(this.rebuild);
    strokes.observeDeep(this.rebuild);
    layers.observeDeep(this.rebuild);
    meta.observe(this.rebuild);
    this.offShapes.add(() => shapes.unobserveDeep(this.rebuild));
    this.offStrokes.add(() => strokes.unobserveDeep(this.rebuild));
    this.offLayers.add(() => layers.unobserveDeep(this.rebuild));
    this.offLayers.add(() => meta.unobserve(this.rebuild));
    this.rebuild();
  }

  private detach(): void {
    for (const fn of this.offShapes) fn();
    for (const fn of this.offStrokes) fn();
    for (const fn of this.offLayers) fn();
    this.offShapes.clear();
    this.offStrokes.clear();
    this.offLayers.clear();
  }

  private loop = (): void => {
    this.rafHandle = requestAnimationFrame(this.loop);
    const live = this.opts.getLivePreview();
    // Always-paint when there is a live preview (live coords change without dirty).
    if (!this.dirty && !live.stroke && !live.shape) return;
    this.dirty = false;
    const transform = this.opts.getTransform();
    const size = this.opts.getViewport();
    const paper = this.opts.getPaper();
    this.scene = {
      layers: this.cachedLayers,
      shapesByLayer: this.cachedShapesByLayer,
      strokesByLayer: this.cachedStrokesByLayer,
      selection: this.opts.getSelection(),
      marquee: this.opts.getMarquee(),
      liveStroke: live.stroke,
      liveShape: live.shape,
      paper,
    };
    renderScene(this.opts.canvas, this.scene, transform, size);
  };
}

// ── Yjs → plain-JS readers ───────────────────────────────────────────────────
function readShape(m: Y.Map<unknown>): Shape | null {
  const candidate = {
    id: m.get('id'),
    kind: m.get('kind'),
    layerId: m.get('layerId'),
    x: m.get('x'),
    y: m.get('y'),
    w: m.get('w'),
    h: m.get('h'),
    rotation: m.get('rotation'),
    stroke: m.get('stroke'),
    fill: m.get('fill'),
    strokeWidth: m.get('strokeWidth'),
    strokeOpacity: m.get('strokeOpacity'),
    text: m.get('text'),
    fontSize: m.get('fontSize'),
    createdAt: m.get('createdAt'),
    authorId: m.get('authorId'),
  };
  const parsed = shapeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readStroke(m: Y.Map<unknown>): Stroke | null {
  const candidate = {
    id: m.get('id'),
    kind: m.get('kind'),
    layerId: m.get('layerId'),
    color: m.get('color'),
    size: m.get('size'),
    opacity: m.get('opacity'),
    points: m.get('points'),
    createdAt: m.get('createdAt'),
    authorId: m.get('authorId'),
  };
  const parsed = strokeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readLayers(arr: Y.Array<Y.Map<unknown>>): Layer[] {
  const out: Layer[] = [];
  arr.forEach((m) => {
    const candidate = {
      id: m.get('id'),
      name: m.get('name'),
      visible: m.get('visible'),
      locked: m.get('locked'),
      opacity: m.get('opacity'),
    };
    const parsed = layerSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  });
  return out;
}
