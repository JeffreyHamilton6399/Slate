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
  pointToSegmentDistance,
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

// ── Stroke eraser: erases the part of each stroke under the cursor (like a
// pen), splitting the stroke into pieces. Shapes are still deleted whole. ──
class EraserTool implements Tool {
  readonly id = 'eraser';
  private erasing = false;
  /** Latest pointer position not yet consumed by an erase pass. pointermove
   *  events fire much faster than rAF (often 4–8× per frame on a fast
   *  pointer), so we coalesce all moves within a frame into a single erase
   *  at the latest point — without this, each move snapshots the whole scene
   *  + iterates all strokes + opens a Yjs transaction, stacking work that
   *  the browser can't keep up with (the "eraser deletes weirdly" symptom). */
  private pendingPoint: BoardPoint | null = null;
  private rafScheduled = false;
  private rafId: number | null = null;
  /** Stroke ids already erased/split during the current gesture. Once a
   *  stroke has been split, its fragments have new ids — re-running the
   *  split on the (now-deleted) original id is a no-op, but re-running it
   *  on a fragment that hasn't been re-touched wastes a transaction and
   *  can shave off another tiny piece. Tracking the original id lets us
   *  skip it on subsequent erase passes; new fragment ids are picked up
   *  naturally if the cursor is still over them. */
  private erasedThisGesture = new Set<string>();
  constructor(private ctx: ToolContext) {}
  preview(): ToolPreview {
    return { stroke: null, shape: null, marquee: null, selection: null };
  }
  start(input: PointerInput): void {
    this.erasing = true;
    this.erasedThisGesture.clear();
    // Drop any leftover pending point from a previous gesture (shouldn't
    // normally happen, but cancel() may not have fired).
    this.cancelRaf();
    this.pendingPoint = null;
    this.eraseAt(input.point);
  }
  move(input: PointerInput): void {
    if (!this.erasing) return;
    // Stash the latest point and schedule ONE erase for the next frame.
    // Subsequent moves within the same frame just overwrite pendingPoint,
    // so we always erase at the most recent cursor position.
    this.pendingPoint = input.point;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      this.rafId = requestAnimationFrame(() => {
        this.rafScheduled = false;
        this.rafId = null;
        const p = this.pendingPoint;
        this.pendingPoint = null;
        if (p && this.erasing) this.eraseAt(p);
      });
    }
  }
  end(_input: PointerInput): void {
    // Flush the last pending point immediately so the final cursor position
    // is included in the erase — don't wait a frame for a gesture that's
    // already over (the user expects the eraser to have reached where they
    // released).
    this.cancelRaf();
    if (this.pendingPoint) {
      const p = this.pendingPoint;
      this.pendingPoint = null;
      this.eraseAt(p);
    }
    this.erasing = false;
  }
  cancel(): void {
    this.erasing = false;
    this.cancelRaf();
    this.pendingPoint = null;
    this.erasedThisGesture.clear();
  }
  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.rafScheduled = false;
    }
  }
  private eraseAt(p: BoardPoint): void {
    const snap = this.ctx.engine.snapshot();
    // Fixed eraser radius — DECOUPLED from the brush width. The previous
    // `Math.max(6, strokeWidth * 2)` meant a size-50 brush gave the eraser a
    // 100px radius, nuking a huge area. Now: 8px floor (usable on small
    // strokes), 40px ceiling (a huge brush setting doesn't erase an entire
    // board region in one tap), and `* 1` (not `* 2`) so the eraser feels
    // like the same size as the brush, not twice as aggressive.
    const radius = Math.min(40, Math.max(8, this.ctx.strokeWidth));
    const deadShapes: string[] = [];
    for (const layer of snap.layers) {
      if (!layer.visible || layer.locked) continue;
      // Strokes get partial erasure — split into sub-strokes at the erased
      // segments so only the part under the cursor disappears. Skip any
      // stroke we've already processed this gesture (see erasedThisGesture).
      for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
        if (this.erasedThisGesture.has(st.id)) continue;
        this.eraseStrokePartial(st, p, radius);
      }
      // Shapes are erased whole (point-in-shape test).
      for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
        if (pointInShape(sh, p)) deadShapes.push(sh.id);
      }
    }
    if (deadShapes.length) this.ctx.engine.deleteIds(deadShapes);
  }

  /** Erase the portion of `stroke` within `radius` of `p`. Splits the stroke
   *  at the erased segments and commits the remaining sub-strokes via
   *  `engine.splitStroke`. No-op if the cursor isn't over any segment. */
  private eraseStrokePartial(stroke: Stroke, p: BoardPoint, radius: number): void {
    const points = stroke.points;
    // InkTool always writes 3 values per point [x, y, pressure]. If the
    // points array isn't a multiple of 3, the stroke is malformed (a future
    // tool writing a different format, or corrupted data) — skip it rather
    // than guessing the stride and reading garbage coordinates.
    if (points.length % 3 !== 0) return;
    const stride = 3;
    const numPts = points.length / stride;
    if (numPts < 2) return; // single-point stroke — can't split, leave alone

    // Effective erase radius mirrors pointNearStroke so the partial erasure
    // matches the visual hit-test: thick strokes get a little extra slack.
    const effRadius = Math.max(stroke.size / 2 + 2, radius);

    // Mark which segments (between consecutive points) fall under the cursor.
    const erased = new Array<boolean>(numPts - 1).fill(false);
    let anyErased = false;
    for (let i = 0; i < numPts - 1; i++) {
      const ax = points[i * stride] ?? 0;
      const ay = points[i * stride + 1] ?? 0;
      const bx = points[(i + 1) * stride] ?? 0;
      const by = points[(i + 1) * stride + 1] ?? 0;
      if (pointToSegmentDistance(p.x, p.y, ax, ay, bx, by) < effRadius) {
        erased[i] = true;
        anyErased = true;
      }
    }
    if (!anyErased) return; // cursor not over this stroke — leave it alone

    // Build sub-strokes from contiguous runs of non-erased segments. A point
    // touched by an erased segment on either side ends the current run; an
    // isolated point (both neighbours erased) is dropped because a single
    // point can't form a stroke. Require ≥ 3 points (stride*3 values) per
    // sub-stroke — 2-point dots were creating tiny fragments that stacked up
    // in Yjs and cluttered the scene without adding visible ink.
    const minLen = stride * 3;
    const subStrokes: number[][] = [];
    let current: number[] = [];
    for (let i = 0; i < numPts; i++) {
      if (i > 0 && erased[i - 1]) {
        // Segment before this point was erased — close out the current run.
        if (current.length >= minLen) subStrokes.push(current);
        current = [];
      }
      if (i < numPts - 1 && erased[i]) {
        // Segment after this point is erased — include this point as the
        // tail of the current run, then close it out.
        for (let j = 0; j < stride; j++) current.push(points[i * stride + j] ?? 0);
        if (current.length >= minLen) subStrokes.push(current);
        current = [];
      } else {
        for (let j = 0; j < stride; j++) current.push(points[i * stride + j] ?? 0);
      }
    }
    if (current.length >= minLen) subStrokes.push(current);

    // Untouched — the only erased segments were at the very ends, so the
    // resulting single sub-stroke is identical to the original. Skip the
    // delete+recommit round-trip.
    if (subStrokes.length === 1 && subStrokes[0]!.length === points.length) return;

    // Mark the original stroke as processed for this gesture — whether we
    // delete it outright or split it, we don't want to re-process the same
    // id on the next erase pass (the split fragments have new ids and will
    // be picked up naturally if the cursor is still over them).
    this.erasedThisGesture.add(stroke.id);

    if (subStrokes.length === 0) {
      // Entire stroke was under the cursor — delete it outright.
      this.ctx.engine.deleteIds([stroke.id]);
      return;
    }

    // Split into multiple sub-strokes. Reuse the original's createdAt so the
    // new pieces keep the same z-order slot as the original (the engine sorts
    // by createdAt with a stable sort, and Yjs Map iteration puts new keys
    // after existing ones — so visually the pieces stay at the original's
    // stacking position).
    const newStrokes: Stroke[] = subStrokes.map((pts) => ({
      ...stroke,
      id: makeId('stroke'),
      points: pts,
    }));
    this.ctx.engine.splitStroke(stroke.id, newStrokes);
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
