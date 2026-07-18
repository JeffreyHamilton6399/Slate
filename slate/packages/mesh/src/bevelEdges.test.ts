import { describe, expect, it } from 'vitest';
import { cube } from './primitives.js';
import { allManifoldEdges, bevelEdges } from './ops.js';
import { vCount, vGet, type Mesh } from './types.js';

/** Find the vertex-pair of one top edge of the unit cube (both endpoints at
 *  y=+0.5 sharing the same z). */
function topEdge(m: Mesh): [number, number] {
  const tops: number[] = [];
  for (let i = 0; i < vCount(m); i++) if (Math.abs(vGet(m, i).y - 0.5) < 1e-9) tops.push(i);
  for (const a of tops) {
    for (const b of tops) {
      if (a >= b) continue;
      const va = vGet(m, a);
      const vb = vGet(m, b);
      // An edge of the top face runs along x or z (one coord equal).
      if (Math.abs(va.z - vb.z) < 1e-9 && Math.abs(va.x - vb.x) > 0.9) return [a, b];
    }
  }
  throw new Error('no top edge found');
}

function finite(m: Mesh): boolean {
  return m.vertices.every((v) => Number.isFinite(v));
}

describe('bevelEdges', () => {
  it('replaces a single edge with a strip and keeps geometry finite', () => {
    const c = cube(1);
    const [a, b] = topEdge(c);
    const out = bevelEdges(c, [a, b], 0.2, 1);
    expect(finite(out)).toBe(true);
    // 8 - 2 dropped originals? The edge endpoints stay (other faces use them):
    // 8 original + 4 side corners = 12 verts; 6 faces + 1 strip quad + 2 caps.
    expect(vCount(out)).toBe(12);
    expect(out.faces.length).toBe(9);
  });

  it('multi-segment profile is a circular arc, not a subdivided flat chamfer', () => {
    const c = cube(1);
    const [a, b] = topEdge(c);
    const w = 0.25;
    const seg = 4;
    const out = bevelEdges(c, [a, b], w, seg);
    expect(finite(out)).toBe(true);

    // The beveled top edge ran along x at y=0.5, z=±0.5. For a lone beveled
    // edge the end corners slide within the ADJACENT faces, so each end's arc
    // sits exactly at the original endpoint's x plane. Collect the arc points
    // there, excluding the original cube corner itself (still referenced by
    // the unbeveled faces).
    const zEdge = vGet(c, a).z;
    const xEnd = vGet(c, a).x;
    const prof: { y: number; z: number }[] = [];
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      if (Math.abs(p.x - xEnd) > 1e-6) continue;
      if (Math.abs(p.y - 0.5) < 1e-9 && Math.abs(p.z - zEdge) < 1e-9) continue; // original corner
      if (p.y < 0.5 - w - 1e-6 || Math.abs(p.z - zEdge) > w + 1e-6) continue; // other cube verts
      prof.push({ y: p.y, z: p.z });
    }
    // seg+1 = 5 profile points at each end.
    expect(prof.length).toBe(seg + 1);

    // Exact tangent-circle check: center at (y = 0.5 - w, z = zEdge -/+ w)
    // (inside the material), radius w. Every profile point must sit on it.
    const cy = 0.5 - w;
    const cz = zEdge > 0 ? zEdge - w : zEdge + w;
    for (const p of prof) {
      const r = Math.hypot(p.y - cy, p.z - cz);
      expect(Math.abs(r - w)).toBeLessThan(1e-6);
    }

    // And it must NOT be the flat chamfer: the arc midpoint is closer to the
    // original edge corner than the chord midpoint is.
    const corner = { y: 0.5, z: zEdge };
    const sorted = [...prof].sort((p, q) => p.y - q.y);
    const mid = sorted[Math.floor(seg / 2)]!;
    const chordMid = {
      y: (sorted[0]!.y + sorted[seg]!.y) / 2,
      z: (sorted[0]!.z + sorted[seg]!.z) / 2,
    };
    const dMid = Math.hypot(mid.y - corner.y, mid.z - corner.z);
    const dChord = Math.hypot(chordMid.y - corner.y, chordMid.z - corner.z);
    expect(dMid).toBeLessThan(dChord - 1e-6);
  });

  it('bevels every edge of a cube (rounded-cube case) without degenerate output', () => {
    const c = cube(1);
    const edges = allManifoldEdges(c);
    expect(edges.length).toBe(24); // 12 edges × 2 entries
    const out = bevelEdges(c, edges, 0.15, 3);
    expect(finite(out)).toBe(true);
    // 6 shrunk faces + 12 strips × 3 quads + 8 corner fans — plenty of faces.
    expect(out.faces.length).toBeGreaterThan(6 + 36);
    // All verts stay inside the original bounds (a bevel only removes material).
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      expect(Math.abs(p.x)).toBeLessThan(0.5 + 1e-6);
      expect(Math.abs(p.y)).toBeLessThan(0.5 + 1e-6);
      expect(Math.abs(p.z)).toBeLessThan(0.5 + 1e-6);
    }
    // Corner patches exist: some vertex must sit near the sphere octant of a
    // corner — i.e. inside the corner cube region but off all three planes.
    const off = (v: number) => v < 0.5 - 1e-6 && v > 0.35;
    let cornerVerts = 0;
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      if (off(Math.abs(p.x)) && off(Math.abs(p.y)) && off(Math.abs(p.z))) cornerVerts++;
    }
    expect(cornerVerts).toBeGreaterThan(0);
  });

  it('corner patch apex sits ON the octant sphere (no divot)', () => {
    const c = cube(1);
    const w = 0.15;
    const out = bevelEdges(c, allManifoldEdges(c), w, 3);
    // For the corner at (.5,.5,.5): every boundary arc lies on the sphere of
    // radius w centered at (.5-w, .5-w, .5-w). The fan apex must sit on that
    // sphere along the corner diagonal — the flat loop centroid (the old,
    // divot-producing apex) is measurably INSIDE it.
    const S = { x: 0.5 - w, y: 0.5 - w, z: 0.5 - w };
    const k = w / Math.sqrt(3);
    const expected = { x: S.x + k, y: S.y + k, z: S.z + k };
    let best = Infinity;
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      const d = Math.hypot(p.x - expected.x, p.y - expected.y, p.z - expected.z);
      if (d < best) best = d;
    }
    expect(best).toBeLessThan(5e-3);
    // And EVERY vertex strictly inside the corner region (the patch interior:
    // apex + concentric rings — strip arcs sit at one coord == 0.5-w) must be
    // ON the sphere too: a flat cone/fan interior fails this at the rings.
    let interior = 0;
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      if (p.x > S.x + 0.01 && p.y > S.y + 0.01 && p.z > S.z + 0.01) {
        interior++;
        expect(Math.abs(Math.hypot(p.x - S.x, p.y - S.y, p.z - S.z) - w)).toBeLessThan(5e-3);
      }
    }
    expect(interior).toBeGreaterThan(1); // apex + at least one ring point
  });

  it('face bevel (top 4 edges): shared slid corners — no spike at the original corners', () => {
    const c = cube(1);
    // The four edges of the top face (y = +0.5), skipping diagonals.
    const tops: number[] = [];
    for (let i = 0; i < vCount(c); i++) if (Math.abs(vGet(c, i).y - 0.5) < 1e-9) tops.push(i);
    const pairs: number[] = [];
    for (const a of tops) for (const b of tops) {
      if (a >= b) continue;
      const va = vGet(c, a), vb = vGet(c, b);
      if ((Math.abs(va.x - vb.x) < 1e-9 || Math.abs(va.z - vb.z) < 1e-9) && Math.hypot(va.x - vb.x, va.z - vb.z) < 1.5) {
        pairs.push(a, b);
      }
    }
    expect(pairs.length).toBe(8);
    const out = bevelEdges(c, pairs, 0.2, 2);
    // REGRESSION: the two side faces flanking each vertical edge used to
    // create separate coincident slid corners, breaking the corner-patch
    // loop — the fill then fanned through the ORIGINAL corner vertex,
    // leaving a triangle spike at every top corner.
    for (let i = 0; i < vCount(out); i++) {
      const p = vGet(out, i);
      const atTopCorner =
        Math.abs(p.y - 0.5) < 1e-6 &&
        Math.abs(Math.abs(p.x) - 0.5) < 1e-6 &&
        Math.abs(Math.abs(p.z) - 0.5) < 1e-6;
      expect(atTopCorner).toBe(false);
    }
  });

  it('returns the input unchanged for zero amount or empty selection', () => {
    const c = cube(1);
    expect(bevelEdges(c, [], 0.2, 2).faces.length).toBe(c.faces.length);
    const [a, b] = topEdge(c);
    expect(bevelEdges(c, [a, b], 0, 2).faces.length).toBe(c.faces.length);
  });
});
