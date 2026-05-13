/**
 * Tool implementations for the 2D canvas.
 *
 * Each tool returns a small object with start / move / end pointer handlers,
 * plus a getter for the in-progress "live" preview that the engine paints
 * on top of the committed scene. Tools never write to Yjs directly; they
 * call back into the engine via the CommitAPI.
 */

import type { Shape, ShapeKind, Stroke, StrokeKind } from '@slate/sync-protocol';
import type { BoardPoint, Rect } from './types';
import type { CanvasEngine } from './engine';
import {
  pointInShape,
  pointNearStroke,
  rectIntersects,
  shapeBounds,
  strokeBounds,
} from './geometry';
import { makeId } from '../utils/id';

export interface ToolContext {
  engine: CanvasEngine;
  authorId: string;
  layerId: string;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  fontSize: number;
  /** Multi-select toggle? Set when Shift is held during a click. */
  additive: boolean;
}

export interface PointerInput {
  /** In board space. */
  point: BoardPoint;
  /** Normalized 0..1 (pressure-or-1 if mouse). */
  pressure: number;
  /** Monotonic ms. */
  t: number;
  /** Constrain (Shift). */
  constrain: boolean;
}

export interface ToolHandlers {
  start(input: PointerInput): void;
  move(input: PointerInput): void;
  end(input: PointerInput): void;
  cancel(): void;
}

export interface ToolPreview {
  stroke: Stroke | null;
  shape: Shape | null;
  marquee: Rect | null;
  selection: Set<string> | null;
}

export interface Tool extends ToolHandlers {
  readonly id: string;
  preview(): ToolPreview;
}

// ── Pen / Highlighter / Eraser ───────────────────────────────────────────────
class InkTool implements Tool {
  readonly id: string;
  private points: number[] = [];
  private live: Stroke | null = null;
  private kind: StrokeKind;
  constructor(
    id: string,
    kind: StrokeKind,
    private ctx: ToolContext,
  ) {
    this.id = id;
    this.kind = kind;
  }
  preview(): ToolPreview {
    return { stroke: this.live, shape: null, marquee: null, selection: null };
  }
  start(input: PointerInput): void {
    this.points = [input.point.x, input.point.y, input.pressure];
    this.live = this.draft();
  }
  move(input: PointerInput): void {
    if (!this.live) return;
    const last = this.points.length - 3;
    const lx = this.points[last] ?? 0;
    const ly = this.points[last + 1] ?? 0;
    if (Math.hypot(input.point.x - lx, input.point.y - ly) < 0.5) return;
    this.points.push(input.point.x, input.point.y, input.pressure);
    this.live = this.draft();
  }
  end(_input: PointerInput): void {
    if (!this.live) return;
    if (this.points.length >= 6) {
      this.ctx.engine.commitStroke(this.live);
    }
    this.live = null;
    this.points = [];
  }
  cancel(): void {
    this.live = null;
    this.points = [];
  }
  private draft(): Stroke {
    return {
      id: this.id,
      kind: this.kind,
      layerId: this.ctx.layerId,
      color: this.ctx.stroke,
      size: this.kind === 'highlighter' ? this.ctx.strokeWidth * 4 : this.ctx.strokeWidth,
      opacity: this.kind === 'highlighter' ? 0.35 : this.ctx.strokeOpacity,
      points: this.points.slice(),
      createdAt: Date.now(),
      authorId: this.ctx.authorId,
    };
  }
}

// ── Shape drag-out tools (rect / ellipse / triangle / line / arrow) ─────────
class ShapeDragTool implements Tool {
  readonly id: string;
  private origin: BoardPoint | null = null;
  private live: Shape | null = null;
  private kind: ShapeKind;
  constructor(
    id: string,
    kind: ShapeKind,
    private ctx: ToolContext,
  ) {
    this.id = id;
    this.kind = kind;
  }
  preview(): ToolPreview {
    return { stroke: null, shape: this.live, marquee: null, selection: null };
  }
  start(input: PointerInput): void {
    this.origin = input.point;
    this.live = this.draft(input.point, input.point, input.constrain);
  }
  move(input: PointerInput): void {
    if (!this.origin) return;
    this.live = this.draft(this.origin, input.point, input.constrain);
  }
  end(_input: PointerInput): void {
    if (!this.live) return;
    const b = shapeBounds(this.live);
    if (b.w * b.h >= 4 || this.live.kind === 'line' || this.live.kind === 'arrow') {
      this.ctx.engine.commitShape(this.live);
    }
    this.live = null;
    this.origin = null;
  }
  cancel(): void {
    this.live = null;
    this.origin = null;
  }
  private draft(a: BoardPoint, b: BoardPoint, constrain: boolean): Shape {
    let w = b.x - a.x;
    let h = b.y - a.y;
    if (constrain) {
      if (this.kind === 'line' || this.kind === 'arrow') {
        const a45 = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(w, h);
        w = Math.cos(a45) * len;
        h = Math.sin(a45) * len;
      } else {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
    }
    return {
      id: this.id,
      kind: this.kind,
      layerId: this.ctx.layerId,
      x: a.x,
      y: a.y,
      w,
      h,
      rotation: 0,
      stroke: this.ctx.stroke,
      fill: this.ctx.fill,
      strokeWidth: this.ctx.strokeWidth,
      strokeOpacity: this.ctx.strokeOpacity,
      createdAt: Date.now(),
      authorId: this.ctx.authorId,
    };
  }
}

// ── Text insertion ─────────────────────────────────────────────────────────
class TextTool implements Tool {
  readonly id = 'text';
  private placed: Shape | null = null;
  preview(): ToolPreview {
    return { stroke: null, shape: this.placed, marquee: null, selection: null };
  }
  constructor(private ctx: ToolContext) {}
  start(_input: PointerInput): void {}
  move(_input: PointerInput): void {}
  end(input: PointerInput): void {
    const text = window.prompt('Text');
    if (!text) return;
    const fontSize = this.ctx.fontSize;
    const w = Math.max(40, text.length * fontSize * 0.6);
    const h = (text.split('\n').length || 1) * fontSize * 1.2;
    const shape: Shape = {
      id: makeId('shape'),
      kind: 'text',
      layerId: this.ctx.layerId,
      x: input.point.x,
      y: input.point.y,
      w,
      h,
      rotation: 0,
      stroke: this.ctx.stroke,
      fill: null,
      strokeWidth: 0,
      strokeOpacity: 1,
      text,
      fontSize,
      createdAt: Date.now(),
      authorId: this.ctx.authorId,
    };
    this.ctx.engine.commitShape(shape);
  }
  cancel(): void {}
}

// ── Marquee select / move ──────────────────────────────────────────────────
class SelectTool implements Tool {
  readonly id = 'select';
  private dragOrigin: BoardPoint | null = null;
  private movingIds: string[] = [];
  private moveOffsets = new Map<string, { dx: number; dy: number; kind: 'shape' | 'stroke' }>();
  private marquee: Rect | null = null;
  private liveSelection: Set<string> | null = null;
  constructor(
    private ctx: ToolContext,
    private getSelected: () => Set<string>,
    private setSelection: (ids: string[]) => void,
  ) {}
  preview(): ToolPreview {
    return {
      stroke: null,
      shape: null,
      marquee: this.marquee,
      selection: this.liveSelection,
    };
  }
  start(input: PointerInput): void {
    const hit = this.hit(input.point);
    if (hit) {
      const cur = new Set(this.getSelected());
      if (this.ctx.additive) {
        if (cur.has(hit)) cur.delete(hit);
        else cur.add(hit);
      } else if (!cur.has(hit)) {
        cur.clear();
        cur.add(hit);
      }
      this.setSelection([...cur]);
      this.beginMove([...cur], input.point);
    } else {
      if (!this.ctx.additive) this.setSelection([]);
      this.dragOrigin = input.point;
      this.marquee = { x: input.point.x, y: input.point.y, w: 0, h: 0 };
    }
  }
  move(input: PointerInput): void {
    if (this.movingIds.length) {
      const dx = input.point.x;
      const dy = input.point.y;
      for (const id of this.movingIds) {
        const off = this.moveOffsets.get(id);
        if (!off) continue;
        if (off.kind === 'shape') {
          this.ctx.engine.updateShape(id, { x: dx - off.dx, y: dy - off.dy });
        }
        // stroke move is intentionally skipped to keep selection cheap;
        // strokes are typically committed once and not relocated.
      }
      return;
    }
    if (!this.dragOrigin) return;
    const x = Math.min(this.dragOrigin.x, input.point.x);
    const y = Math.min(this.dragOrigin.y, input.point.y);
    const w = Math.abs(input.point.x - this.dragOrigin.x);
    const h = Math.abs(input.point.y - this.dragOrigin.y);
    this.marquee = { x, y, w, h };
    const snap = this.ctx.engine.snapshot();
    const hits = new Set<string>();
    for (const layer of snap.layers) {
      if (!layer.visible) continue;
      for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
        if (rectIntersects(this.marquee, shapeBounds(sh))) hits.add(sh.id);
      }
      for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
        if (rectIntersects(this.marquee, strokeBounds(st))) hits.add(st.id);
      }
    }
    this.liveSelection = hits;
  }
  end(_input: PointerInput): void {
    if (this.movingIds.length) {
      this.movingIds = [];
      this.moveOffsets.clear();
      return;
    }
    if (this.liveSelection) {
      const cur = this.ctx.additive ? new Set(this.getSelected()) : new Set<string>();
      for (const id of this.liveSelection) cur.add(id);
      this.setSelection([...cur]);
    }
    this.marquee = null;
    this.liveSelection = null;
    this.dragOrigin = null;
  }
  cancel(): void {
    this.marquee = null;
    this.liveSelection = null;
    this.dragOrigin = null;
    this.movingIds = [];
    this.moveOffsets.clear();
  }
  private hit(p: BoardPoint): string | null {
    const snap = this.ctx.engine.snapshot();
    for (let i = snap.layers.length - 1; i >= 0; i--) {
      const layer = snap.layers[i]!;
      if (!layer.visible || layer.locked) continue;
      const shapes = snap.shapesByLayer.get(layer.id) ?? [];
      for (let j = shapes.length - 1; j >= 0; j--) {
        const sh = shapes[j]!;
        if (pointInShape(sh, p)) return sh.id;
      }
      const strokes = snap.strokesByLayer.get(layer.id) ?? [];
      for (let j = strokes.length - 1; j >= 0; j--) {
        const st = strokes[j]!;
        if (pointNearStroke(st, p)) return st.id;
      }
    }
    return null;
  }
  private beginMove(ids: string[], origin: BoardPoint): void {
    this.movingIds = ids;
    this.moveOffsets.clear();
    const snap = this.ctx.engine.snapshot();
    const idToShape = new Map<string, Shape>();
    const idToStroke = new Map<string, Stroke>();
    for (const layer of snap.layers) {
      for (const sh of snap.shapesByLayer.get(layer.id) ?? []) idToShape.set(sh.id, sh);
      for (const st of snap.strokesByLayer.get(layer.id) ?? []) idToStroke.set(st.id, st);
    }
    for (const id of ids) {
      const sh = idToShape.get(id);
      if (sh) {
        this.moveOffsets.set(id, { dx: origin.x - sh.x, dy: origin.y - sh.y, kind: 'shape' });
        continue;
      }
      const st = idToStroke.get(id);
      if (st) this.moveOffsets.set(id, { dx: 0, dy: 0, kind: 'stroke' });
    }
  }
}

// ── Eyedropper / fill / pan (minor) ─────────────────────────────────────────
class EyedropperTool implements Tool {
  readonly id = 'eyedropper';
  preview(): ToolPreview {
    return { stroke: null, shape: null, marquee: null, selection: null };
  }
  constructor(
    private ctx: ToolContext,
    private onSample: (color: string) => void,
  ) {}
  start(input: PointerInput): void {
    const snap = this.ctx.engine.snapshot();
    for (let i = snap.layers.length - 1; i >= 0; i--) {
      const layer = snap.layers[i]!;
      for (let j = (snap.shapesByLayer.get(layer.id) ?? []).length - 1; j >= 0; j--) {
        const sh = snap.shapesByLayer.get(layer.id)![j]!;
        if (pointInShape(sh, input.point)) {
          this.onSample(sh.stroke);
          return;
        }
      }
      for (let j = (snap.strokesByLayer.get(layer.id) ?? []).length - 1; j >= 0; j--) {
        const st = snap.strokesByLayer.get(layer.id)![j]!;
        if (pointNearStroke(st, input.point)) {
          this.onSample(st.color);
          return;
        }
      }
    }
  }
  move(): void {}
  end(): void {}
  cancel(): void {}
}

class FillTool implements Tool {
  readonly id = 'fill';
  preview(): ToolPreview {
    return { stroke: null, shape: null, marquee: null, selection: null };
  }
  constructor(private ctx: ToolContext) {}
  start(input: PointerInput): void {
    const snap = this.ctx.engine.snapshot();
    for (let i = snap.layers.length - 1; i >= 0; i--) {
      const layer = snap.layers[i]!;
      const shapes = snap.shapesByLayer.get(layer.id) ?? [];
      for (let j = shapes.length - 1; j >= 0; j--) {
        const sh = shapes[j]!;
        if (pointInShape(sh, input.point)) {
          this.ctx.engine.updateShape(sh.id, { fill: this.ctx.stroke });
          return;
        }
      }
    }
  }
  move(): void {}
  end(): void {}
  cancel(): void {}
}

// ── Factory ────────────────────────────────────────────────────────────────
export type ToolFactoryOptions = {
  toolId: string;
  context: ToolContext;
  getSelected: () => Set<string>;
  setSelection: (ids: string[]) => void;
  onSampleColor: (c: string) => void;
};

export function createTool(opts: ToolFactoryOptions): Tool | null {
  const { toolId, context } = opts;
  const id = makeId(toolId);
  switch (toolId) {
    case 'pen':
      return new InkTool(id, 'pen', context);
    case 'highlighter':
      return new InkTool(id, 'highlighter', context);
    case 'eraser':
      return new InkTool(id, 'eraser', context);
    case 'rect':
      return new ShapeDragTool(id, 'rect', context);
    case 'ellipse':
      return new ShapeDragTool(id, 'ellipse', context);
    case 'triangle':
      return new ShapeDragTool(id, 'triangle', context);
    case 'line':
      return new ShapeDragTool(id, 'line', context);
    case 'arrow':
      return new ShapeDragTool(id, 'arrow', context);
    case 'text':
      return new TextTool(context);
    case 'select':
      return new SelectTool(context, opts.getSelected, opts.setSelection);
    case 'eyedropper':
      return new EyedropperTool(context, opts.onSampleColor);
    case 'fill':
      return new FillTool(context);
    default:
      return null;
  }
}
