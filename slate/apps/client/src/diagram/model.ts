/**
 * Diagram data model helpers — read typed DiagramNode / DiagramEdge values out
 * of their Yjs maps, and route a connector between two node borders.
 *
 * Nodes and edges live in top-level Y.Maps (see doc.ts container doctrine):
 * `diagram:nodes` (id → Y.Map) and `diagram:edges` (id → Y.Map). Each entry's
 * fields are plain-JS primitives, so a shallow copy into / out of a Y.Map is
 * enough — there are no nested Y types.
 */

import * as Y from 'yjs';
import {
  diagramNodeSchema,
  diagramEdgeSchema,
  type DiagramNode,
  type DiagramEdge,
  type DiagramEdgeRouting,
} from '@slate/sync-protocol';

export function readNode(m: Y.Map<unknown>, id: string): DiagramNode | null {
  const out: Record<string, unknown> = { id };
  m.forEach((v, k) => (out[k] = v));
  const parsed = diagramNodeSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

export function readEdge(m: Y.Map<unknown>, id: string): DiagramEdge | null {
  const out: Record<string, unknown> = { id };
  m.forEach((v, k) => (out[k] = v));
  const parsed = diagramEdgeSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

/** Snapshot every node into a plain array (unsorted). */
export function readNodes(nodes: Y.Map<Y.Map<unknown>>): DiagramNode[] {
  const out: DiagramNode[] = [];
  nodes.forEach((m, id) => {
    const n = readNode(m, id);
    if (n) out.push(n);
  });
  return out;
}

/** Snapshot every edge into a plain array. */
export function readEdges(edges: Y.Map<Y.Map<unknown>>): DiagramEdge[] {
  const out: DiagramEdge[] = [];
  edges.forEach((m, id) => {
    const e = readEdge(m, id);
    if (e) out.push(e);
  });
  return out;
}

/** Build a fresh Y.Map from a plain object (node or edge). */
export function toYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) m.set(k, v);
  return m;
}

export interface Point {
  x: number;
  y: number;
}

/** Center of a node's bounding box. */
export function nodeCenter(n: DiagramNode): Point {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

/**
 * Clip a ray from a node's center toward `toward` to the node's border. Treats
 * every shape as its bounding rectangle — visually exact for rect/note and a
 * good approximation for ellipse/diamond at connector scale.
 */
export function borderPoint(n: DiagramNode, toward: Point): Point {
  const c = nodeCenter(n);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = n.w / 2;
  const hh = n.h / 2;
  // Scale the direction so it just touches the nearest rectangle edge.
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** The two clipped endpoints of a connector between nodes `from` and `to`. */
export function edgeEndpoints(from: DiagramNode, to: DiagramNode): { a: Point; b: Point } {
  return {
    a: borderPoint(from, nodeCenter(to)),
    b: borderPoint(to, nodeCenter(from)),
  };
}

/** Center of a node's left/right/top/bottom face. */
function facePoint(n: DiagramNode, side: 'l' | 'r' | 't' | 'b'): Point {
  const c = nodeCenter(n);
  if (side === 'l') return { x: n.x, y: c.y };
  if (side === 'r') return { x: n.x + n.w, y: c.y };
  if (side === 't') return { x: c.x, y: n.y };
  return { x: c.x, y: n.y + n.h };
}

/**
 * Build the SVG path `d` for a connector, plus the midpoint to anchor its
 * label. `straight`/`curved` leave each node at the center-facing border point;
 * `elbow` exits and enters through opposing face centers for clean right angles.
 */
export function edgePath(
  from: DiagramNode,
  to: DiagramNode,
  routing: DiagramEdgeRouting,
): { d: string; mid: Point } {
  const ca = nodeCenter(from);
  const cb = nodeCenter(to);
  const horiz = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);

  if (routing === 'elbow') {
    const a = horiz ? facePoint(from, cb.x >= ca.x ? 'r' : 'l') : facePoint(from, cb.y >= ca.y ? 'b' : 't');
    const b = horiz ? facePoint(to, cb.x >= ca.x ? 'l' : 'r') : facePoint(to, cb.y >= ca.y ? 't' : 'b');
    if (horiz) {
      const mx = (a.x + b.x) / 2;
      return { d: `M${f(a.x)},${f(a.y)} H${f(mx)} V${f(b.y)} H${f(b.x)}`, mid: { x: mx, y: (a.y + b.y) / 2 } };
    }
    const my = (a.y + b.y) / 2;
    return { d: `M${f(a.x)},${f(a.y)} V${f(my)} H${f(b.x)} V${f(b.y)}`, mid: { x: (a.x + b.x) / 2, y: my } };
  }

  const { a, b } = edgeEndpoints(from, to);
  if (routing === 'curved') {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const c1 = horiz ? { x: a.x + dx / 2, y: a.y } : { x: a.x, y: a.y + dy / 2 };
    const c2 = horiz ? { x: b.x - dx / 2, y: b.y } : { x: b.x, y: b.y - dy / 2 };
    // Midpoint of a cubic Bézier at t=0.5.
    const mid = {
      x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
      y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
    };
    return { d: `M${f(a.x)},${f(a.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(b.x)},${f(b.y)}`, mid };
  }

  return { d: `M${f(a.x)},${f(a.y)} L${f(b.x)},${f(b.y)}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function f(n: number): string {
  return n.toFixed(1);
}

/** Is board point p inside node n's bounding box? */
export function pointInNode(n: DiagramNode, p: Point): boolean {
  return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
}

/** Topmost node under a board point (last-created wins), or null. */
export function nodeAt(nodes: DiagramNode[], p: Point): DiagramNode | null {
  let hit: DiagramNode | null = null;
  for (const n of nodes) {
    if (pointInNode(n, p) && (!hit || n.createdAt >= hit.createdAt)) hit = n;
  }
  return hit;
}
