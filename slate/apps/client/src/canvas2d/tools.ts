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
  rotatedShapeAABB,
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
  /** Snap to grid (Ctrl). */
  snap?: boolean;
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
    // Fine sample threshold so the stroke tracks the cursor smoothly — larger
    // brushes still benefit from dense sampling because perfect-freehand
    // builds a smoother outline from more points (sparse sampling reads as
    // "connected circles"). Capped so extremely fast drags don't flood Yjs.
    const minDist = Math.max(0.4, this.ctx.strokeWidth * 0.12);
    if (Math.hypot(input.point.x - lx, input.point.y - ly) < minDist) return;
    this.points.push(input.point.x, input.point.y, input.pressure);
    this.live = this.draft();
  }
  end(input: PointerInput): void {
    if (!this.live) return;
    // A tap with no drag (one point) should still leave a dot — perfect-freehand
    // renders a round cap from a two-point stroke, so duplicate the point.
    if (this.points.length < 6) {
      this.points.push(input.point.x + 0.01, input.point.y + 0.01, input.pressure);
      this.live = this.draft();
    }
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
    // Brush-variant size/opacity profiles (Photoshop/Procreate-style):
    //  - pencil: thin, slightly transparent (textured feel)
    //  - marker: bold, full opacity (solid marker)
    //  - calligraphy: varies with pressure (broad strokes)
    //  - airbrush: soft, low opacity (spray)
    //  - pen: the default balanced brush
    let size = this.ctx.strokeWidth;
    let opacity = this.ctx.strokeOpacity;
    if (this.kind === 'highlighter') {
      size = this.ctx.strokeWidth * 4;
      opacity = 0.35;
    } else if (this.kind === 'pencil') {
      size = Math.max(0.5, this.ctx.strokeWidth * 0.6);
      opacity = this.ctx.strokeOpacity * 0.8;
    } else if (this.kind === 'marker') {
      size = this.ctx.strokeWidth * 1.5;
      opacity = 1;
    } else if (this.kind === 'calligraphy') {
      // Calligraphy: broader, pressure-driven (the renderer applies tapering)
      size = this.ctx.strokeWidth * 1.2;
    } else if (this.kind === 'airbrush') {
      size = this.ctx.strokeWidth * 2;
      opacity = this.ctx.strokeOpacity * 0.3;
    }
    return {
      id: this.id,
      kind: this.kind,
      layerId: this.ctx.layerId,
      color: this.ctx.stroke,
      size,
      opacity,
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
    private sides?: number,
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
  end(input: PointerInput): void {
    if (!this.live) return;
    const b = shapeBounds(this.live);
    const isLine = this.live.kind === 'line' || this.live.kind === 'arrow';
    if (b.w * b.h >= 4 || (isLine && Math.hypot(this.live.w, this.live.h) >= 2)) {
      this.ctx.engine.commitShape(this.live);
    } else if (this.origin) {
      // A click with no real drag places a default-sized shape at the point,
      // instead of the shape flashing and vanishing. Centered on the click.
      const DEF = 80;
      const o = this.origin;
      const shape = isLine
        ? { ...this.live, x: o.x - DEF / 2, y: o.y, w: DEF, h: 0 }
        : { ...this.live, x: o.x - DEF / 2, y: o.y - DEF / 2, w: DEF, h: DEF };
      this.ctx.engine.commitShape(shape);
    }
    this.live = null;
    this.origin = null;
    void input;
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
      ...(this.sides !== undefined ? { sides: this.sides } : {}),
      createdAt: Date.now(),
      authorId: this.ctx.authorId,
    };
  }
}

// ── Object eraser: deletes strokes/shapes under the pointer while dragging ──
class EraserTool implements Tool {
  readonly id = 'eraser';
  private erasing = false;
  constructor(private ctx: ToolContext) {}
  preview(): ToolPreview {
    return { stroke: null, shape: null, marquee: null, selection: null };
  }
  start(input: PointerInput): void {
    this.erasing = true;
    this.eraseAt(input.point);
  }
  move(input: PointerInput): void {
    if (this.erasing) this.eraseAt(input.point);
  }
  end(_input: PointerInput): void {
    this.erasing = false;
  }
  cancel(): void {
    this.erasing = false;
  }
  private eraseAt(p: BoardPoint): void {
    const snap = this.ctx.engine.snapshot();
    const radius = Math.max(6, this.ctx.strokeWidth * 2);
    const dead: string[] = [];
    for (const layer of snap.layers) {
      if (!layer.visible || layer.locked) continue;
      for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
        if (pointNearStroke(st, p, radius)) dead.push(st.id);
      }
      for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
        if (pointInShape(sh, p)) dead.push(sh.id);
      }
    }
    if (dead.length) this.ctx.engine.deleteIds(dead);
  }
}

// ── Text insertion — placement is delegated to the canvas so it can show an
// inline editor at the click point instead of a blocking prompt. ────────────
class TextTool implements Tool {
  readonly id = 'text';
  preview(): ToolPreview {
    return { stroke: null, shape: null, marquee: null, selection: null };
  }
  constructor(private onPlace: (p: BoardPoint) => void) {}
  start(_input: PointerInput): void {}
  move(_input: PointerInput): void {}
  end(input: PointerInput): void {
    this.onPlace(input.point);
  }
  cancel(): void {}
}

// ── Marquee select / move ──────────────────────────────────────────────────
class SelectTool implements Tool {
  readonly id = 'select';
  private dragOrigin: BoardPoint | null = null;
  private moveOrigin: BoardPoint | null = null;
  private moveShapes = new Map<string, { x: number; y: number }>();
  private moveStrokes = new Map<string, number[]>();
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
    if (this.moveOrigin) {
      let dx = input.point.x - this.moveOrigin.x;
      let dy = input.point.y - this.moveOrigin.y;
      if (input.snap) {
        // Ctrl: snap movement to the 10-unit grid.
        dx = Math.round(dx / 10) * 10;
        dy = Math.round(dy / 10) * 10;
      }
      for (const [id, base] of this.moveShapes) {
        this.ctx.engine.updateShape(id, { x: base.x + dx, y: base.y + dy });
      }
      for (const [id, basePoints] of this.moveStrokes) {
        const next = basePoints.slice();
        for (let i = 0; i < next.length; i += 3) {
          next[i] = (next[i] ?? 0) + dx;
          next[i + 1] = (next[i + 1] ?? 0) + dy;
        }
        this.ctx.engine.updateStroke(id, { points: next });
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
        if (rectIntersects(this.marquee, rotatedShapeAABB(sh))) hits.add(sh.id);
      }
      for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
        if (rectIntersects(this.marquee, strokeBounds(st))) hits.add(st.id);
      }
    }
    this.liveSelection = hits;
  }
  end(_input: PointerInput): void {
    if (this.moveOrigin) {
      this.moveOrigin = null;
      this.moveShapes.clear();
      this.moveStrokes.clear();
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
    this.moveOrigin = null;
    this.moveShapes.clear();
    this.moveStrokes.clear();
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
    this.moveOrigin = origin;
    this.moveShapes.clear();
    this.moveStrokes.clear();
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
        this.moveShapes.set(id, { x: sh.x, y: sh.y });
        continue;
      }
      const st = idToStroke.get(id);
      if (st) this.moveStrokes.set(id, st.points.slice());
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
  onTextInsert: (p: BoardPoint) => void;
  /** Polygon vertex / star point count for the polygon + star tools. */
  polySides?: number;
};

export function createTool(opts: ToolFactoryOptions): Tool | null {
  const { toolId, context } = opts;
  const id = makeId(toolId);
  switch (toolId) {
    case 'pen':
    case 'pencil':
    case 'marker':
    case 'calligraphy':
    case 'airbrush':
      return new InkTool(id, toolId, context);
    case 'highlighter':
      return new InkTool(id, 'highlighter', context);
    case 'eraser':
      return new EraserTool(context);
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
    case 'polygon':
      return new ShapeDragTool(id, 'polygon', context, opts.polySides ?? 6);
    case 'star':
      return new ShapeDragTool(id, 'star', context, opts.polySides ?? 5);
    case 'heart':
      return new ShapeDragTool(id, 'heart', context);
    case 'cloud':
      return new ShapeDragTool(id, 'cloud', context);
    case 'speech':
      return new ShapeDragTool(id, 'speech', context);
    case 'diamond':
      return new ShapeDragTool(id, 'diamond', context);
    case 'pentagon':
      return new ShapeDragTool(id, 'pentagon', context);
    case 'hexagon':
      return new ShapeDragTool(id, 'hexagon', context);
    case 'parallelogram':
      return new ShapeDragTool(id, 'parallelogram', context);
    case 'trapezoid':
      return new ShapeDragTool(id, 'trapezoid', context);
    case 'cross':
      return new ShapeDragTool(id, 'cross', context);
    case 'text':
      return new TextTool(opts.onTextInsert);
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
