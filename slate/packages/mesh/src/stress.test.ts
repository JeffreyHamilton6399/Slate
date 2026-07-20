import { describe, expect, it } from 'vitest';
import { cube, cylinder, cone, sphere, torus } from './primitives.js';
import { allManifoldEdges, bevelEdges } from './ops.js';
import { vCount, vGet, faceNormal, type Mesh } from './types.js';

function finite(m: Mesh): boolean {
  return m.vertices.every((v) => Number.isFinite(v));
}

/** Count edges by number of adjacent faces — watertight = all edges have 2. */
function edgeStats(m: Mesh): { boundary: number; nonManifold: number; total: number } {
  const count = new Map<string, number>();
  for (const f of m.faces) {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const [, n] of count) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  return { boundary, nonManifold, total: count.size };
}

/** No degenerate faces (repeated vertex ids or <3 verts). */
function degenerateFaces(m: Mesh): number {
  let bad = 0;
  for (const f of m.faces) {
    if (f.v.length < 3) { bad++; continue; }
    if (new Set(f.v).size !== f.v.length) bad++;
  }
  return bad;
}

describe('bevelEdges stress', () => {
  it('double bevel: bevel the beveled cube and stay structurally sane', () => {
    const once = bevelEdges(cube(1), allManifoldEdges(cube(1)), 0.2, 3);
    expect(finite(once)).toBe(true);
    const twice = bevelEdges(once, allManifoldEdges(once), 0.05, 2);
    expect(finite(twice)).toBe(true);
    expect(degenerateFaces(twice)).toBe(0);
    // Stays inside the original bounds.
    for (let i = 0; i < vCount(twice); i++) {
      const p = vGet(twice, i);
      expect(Math.abs(p.x)).toBeLessThan(0.501);
      expect(Math.abs(p.y)).toBeLessThan(0.501);
      expect(Math.abs(p.z)).toBeLessThan(0.501);
    }
  });

  it('cube full bevel is watertight (every edge shared by exactly 2 faces)', () => {
    const out = bevelEdges(cube(1), allManifoldEdges(cube(1)), 0.2, 3);
    const stats = edgeStats(out);
    expect(stats.boundary).toBe(0);
    expect(stats.nonManifold).toBe(0);
    expect(degenerateFaces(out)).toBe(0);
  });

  it('bevels a cylinder (n-gon caps) without degenerate output', () => {
    const c = cylinder(0.5, 1, 12);
    const out = bevelEdges(c, allManifoldEdges(c), 0.08, 3);
    expect(finite(out)).toBe(true);
    expect(degenerateFaces(out)).toBe(0);
  });

  it('bevels a cone (apex where many edges meet) without degenerate output', () => {
    const c = cone(0.5, 1, 12);
    const out = bevelEdges(c, allManifoldEdges(c), 0.08, 3);
    expect(finite(out)).toBe(true);
    expect(degenerateFaces(out)).toBe(0);
  });

  it('bevels a sphere and a torus (all-quad + tri poles) without degenerate output', () => {
    const s = sphere(0.5, 10, 8);
    const so = bevelEdges(s, allManifoldEdges(s), 0.02, 2);
    expect(finite(so)).toBe(true);
    expect(degenerateFaces(so)).toBe(0);
    const t = torus(0.5, 0.18, 12, 8);
    const to = bevelEdges(t, allManifoldEdges(t), 0.02, 2);
    expect(finite(to)).toBe(true);
    expect(degenerateFaces(to)).toBe(0);
  });

  it('outward-facing: every face of a beveled cube faces away from the origin', () => {
    const out = bevelEdges(cube(1), allManifoldEdges(cube(1)), 0.25, 4);
    let inward = 0;
    for (const f of out.faces) {
      const n = faceNormal(out, f);
      // centroid dir
      let cx = 0, cy = 0, cz = 0;
      for (const vi of f.v) { const p = vGet(out, vi); cx += p.x; cy += p.y; cz += p.z; }
      cx /= f.v.length; cy /= f.v.length; cz /= f.v.length;
      if (n.x * cx + n.y * cy + n.z * cz < -1e-6) inward++;
    }
    expect(inward).toBe(0);
  });
});
