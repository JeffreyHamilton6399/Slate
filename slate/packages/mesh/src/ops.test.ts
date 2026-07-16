import { describe, expect, it } from 'vitest';
import { cone, cube, cylinder, plane, sphere, torus } from './primitives.js';
import {
  bevelVerts,
  deleteFaces,
  extrudeFaces,
  flipFaces,
  insetFaces,
  joinMeshes,
  loopCut,
  makeFace,
  mergeAtCenter,
  mirrorMesh,
  recalculateNormals,
  shrinkFatten,
  smoothVerts,
  subdivideFace,
  translateVerts,
  triangulateSelected,
} from './ops.js';
import { faceCentroid, faceNormal, sub } from './types.js';
import { vCount } from './types.js';
import { weld } from './weld.js';

describe('primitives', () => {
  it('cube has 8 verts and 6 faces', () => {
    const m = cube(2);
    expect(vCount(m)).toBe(8);
    expect(m.faces.length).toBe(6);
  });
  it('plane segments=2 has 9 verts and 4 faces', () => {
    const m = plane(1, 2);
    expect(vCount(m)).toBe(9);
    expect(m.faces.length).toBe(4);
  });
  it('convex primitives are outward-wound (recalculateNormals is a no-op)', () => {
    for (const m of [cube(), sphere(0.5), cylinder(), cone()]) {
      expect(recalculateNormals(m).faces).toEqual(m.faces);
    }
  });
  it('plane faces point up', () => {
    const m = plane(1, 2);
    for (const f of m.faces) expect(faceNormal(m, f).y).toBeGreaterThan(0);
  });
  it('torus faces point away from the tube core', () => {
    const R = 0.5;
    const m = torus(R, 0.18);
    for (const f of m.faces) {
      const c = faceCentroid(m, f);
      const len = Math.hypot(c.x, c.z) || 1;
      const core = { x: (c.x / len) * R, y: 0, z: (c.z / len) * R };
      const n = faceNormal(m, f);
      const out = sub(c, core);
      expect(n.x * out.x + n.y * out.y + n.z * out.z).toBeGreaterThan(0);
    }
  });
});

describe('translateVerts', () => {
  it('moves selected verts only', () => {
    const m = cube();
    const r = translateVerts(m, [0], { x: 1, y: 0, z: 0 });
    expect(r.vertices[0]).toBeCloseTo(0.5);
    expect(r.vertices[3]).toBeCloseTo(0.5);
  });
});

describe('extrudeFaces', () => {
  it('extruding the +Y face of a cube doubles vertex count for that face', () => {
    const m = cube();
    const top = 4; // 5th face in our cube layout (+Y)
    const r = extrudeFaces(m, [top], { x: 0, y: 1, z: 0 });
    // Original 8 verts + 4 new for the extruded top face.
    expect(vCount(r.mesh)).toBe(12);
    // Original 6 faces stay (with the top replaced) + 4 side quads.
    expect(r.mesh.faces.length).toBe(10);
  });
});

describe('insetFaces', () => {
  it('insetting one face produces a smaller inner face and a ring', () => {
    const m = cube();
    const before = m.faces.length;
    const r = insetFaces(m, [0], 0.1);
    expect(r.faces.length).toBe(before + 4);
  });
  it('zero thickness is a no-op', () => {
    const m = cube();
    const r = insetFaces(m, [0], 0);
    expect(r.faces.length).toBe(m.faces.length);
    expect(r.vertices.length).toBe(m.vertices.length);
  });
  it('insetting every face at once does not corrupt indices', () => {
    const m = cube(); // 6 faces
    const r = insetFaces(m, [0, 1, 2, 3, 4, 5], 0.1);
    // Each of the 6 faces becomes 1 inner + 4 ring = 5 faces → 30 total.
    expect(r.faces.length).toBe(30);
    // Every face index must reference a real vertex.
    for (const f of r.faces) {
      for (const vi of f.v) {
        expect(vi).toBeGreaterThanOrEqual(0);
        expect(vi).toBeLessThan(r.vertices.length / 3);
      }
    }
  });
});

describe('triangulateSelected', () => {
  it('turns a cube (6 quads) into 12 triangles', () => {
    const r = triangulateSelected(cube());
    expect(r.faces.length).toBe(12);
    expect(r.faces.every((f) => f.v.length === 3)).toBe(true);
  });
  it('only triangulates the selected face', () => {
    const r = triangulateSelected(cube(), [0]);
    // Face 0 → 2 tris, other 5 quads untouched → 7 faces.
    expect(r.faces.length).toBe(7);
  });
});

describe('flipFaces', () => {
  it('reverses winding so the normal points the other way', () => {
    const m = cube();
    const n0 = faceNormal(m, m.faces[0]!);
    const r = flipFaces(m, [0]);
    const n1 = faceNormal(r, r.faces[0]!);
    expect(n1.x).toBeCloseTo(-n0.x);
    expect(n1.y).toBeCloseTo(-n0.y);
    expect(n1.z).toBeCloseTo(-n0.z);
  });
});

describe('recalculateNormals', () => {
  it('orients every cube face outward (normal agrees with centroid→face)', () => {
    // Start from a cube with all faces flipped inward.
    const flipped = flipFaces(cube());
    const r = recalculateNormals(flipped);
    // Cube centroid is the origin.
    for (const f of r.faces) {
      const fc = faceCentroid(r, f);
      const nrm = faceNormal(r, f);
      const out = sub(fc, { x: 0, y: 0, z: 0 });
      const dot = nrm.x * out.x + nrm.y * out.y + nrm.z * out.z;
      expect(dot).toBeGreaterThan(0);
    }
  });
  it('is idempotent — a second pass changes nothing', () => {
    const once = recalculateNormals(cube());
    const twice = recalculateNormals(once);
    expect(twice.faces).toEqual(once.faces);
  });
});

describe('bevelVerts', () => {
  it('beveling one cube corner yields a watertight chamfer with a corner face', () => {
    const m = cube();
    const r = bevelVerts(m, [0], 0.1);
    // Corner vert replaced by 3 cut verts (one per incident edge): 8-1+3.
    expect(vCount(r)).toBe(10);
    // 6 faces + 1 triangular corner fill.
    expect(r.faces.length).toBe(7);
    const corner = r.faces.find((f) => f.v.length === 3);
    expect(corner).toBeDefined();
    // Watertight: every edge must be shared by exactly 2 faces.
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
  it('chamfer stays centered on the beveled vertex (high-index corner)', () => {
    // Vertex 7 of the cube has ONLY lower-index neighbours (3, 4, 6). A past
    // bug anchored cut positions at the edge's lower-index endpoint, so
    // beveling a high-index vertex placed the cuts near its NEIGHBOURS —
    // a huge lopsided chamfer instead of a small one centered on the vertex.
    const m = cube(); // corner 7 at (-0.5, 0.5, 0.5)
    const amount = 0.1;
    const r = bevelVerts(m, [7], amount);
    const corner = r.faces.find((f) => f.v.length === 3);
    expect(corner).toBeDefined();
    // Every cut vertex of the corner face must sit within `amount` of the
    // original corner — that's what "centered on the vertex" means.
    for (const vi of corner!.v) {
      const dx = r.vertices[vi * 3]! - -0.5;
      const dy = r.vertices[vi * 3 + 1]! - 0.5;
      const dz = r.vertices[vi * 3 + 2]! - 0.5;
      expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(amount + 1e-9);
    }
    // And it must stay watertight.
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
  it('adjacent beveled verts (edge bevel) keep distinct cuts per end — watertight', () => {
    // Both endpoints of edge 0-1 beveled: each end must get its OWN cut on the
    // shared edge (a past version shared one cut vertex between both corners,
    // creating a degenerate repeated vertex in the rewritten faces).
    const r = bevelVerts(cube(), [0, 1], 0.1, 1);
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        expect(f.v[i]).not.toBe(f.v[(i + 1) % f.v.length]); // no repeated verts
      }
    }
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
  it('corner face points outward and clipped faces keep a sane winding', () => {
    const r = recalculateNormals(bevelVerts(cube(), [0], 0.1));
    // recalculateNormals must be a no-op if bevel wound everything outward.
    const again = bevelVerts(cube(), [0], 0.1);
    expect(r.faces).toEqual(again.faces);
  });
  it('clamps a huge amount instead of folding the mesh inside out', () => {
    const r = bevelVerts(cube(), [0], 100);
    // Cut points stay within the cube's AABB.
    for (let i = 0; i < r.vertices.length; i++) {
      expect(Math.abs(r.vertices[i]!)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
  it('multi-segment bevel of one corner is watertight', () => {
    const m = cube();
    const r = bevelVerts(m, [0], 0.1, 3);
    // Every edge must be shared by exactly 2 faces (no zigzag boundary).
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
  it('multi-segment bevel curves the corner (round profile, not a flat chamfer)', () => {
    // With a linear profile every cut vertex sits ON a cube edge — i.e. at
    // least two of its coordinates equal ±0.5. A rounded (Blender-style)
    // profile must push the inner cuts OFF the edges, onto the sphere arc.
    const r = bevelVerts(cube(), [0], 0.3, 3);
    const offEdge: number[] = [];
    for (let i = 0; i < vCount(r); i++) {
      let boundaryCoords = 0;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(Math.abs(r.vertices[i * 3 + c]!) - 0.5) < 1e-9) boundaryCoords++;
      }
      if (boundaryCoords < 2) offEdge.push(i);
    }
    // seg=3 → 2 inner cuts per incident edge × 3 edges = 6 curved vertices.
    expect(offEdge.length).toBe(6);
    // All curved vertices lie on the corner's fillet sphere: for a cube corner
    // with amount t the sphere has center V + b·t√3 and radius t√2 (b = unit
    // diagonal into the cube). That's the exact sphere-octant round.
    const t = 0.3;
    const C = { x: -0.5 + t, y: -0.5 + t, z: -0.5 + t };
    const radius = t * Math.sqrt(2);
    for (const vi of offEdge) {
      const dx = r.vertices[vi * 3]! - C.x;
      const dy = r.vertices[vi * 3 + 1]! - C.y;
      const dz = r.vertices[vi * 3 + 2]! - C.z;
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(radius, 6);
    }
    // Still watertight after repositioning.
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
  it('multi-segment bevel of an edge (two corners) produces rounded geometry', () => {
    const m = cube();
    // Bevel two adjacent corners (an edge bevel). Multi-segment edge bevels
    // produce rounded geometry with more vertices than single-segment.
    const r1 = bevelVerts(m, [0, 1], 0.1, 1);
    const r3 = bevelVerts(m, [0, 1], 0.1, 3);
    // Multi-segment should produce more vertices (rounded corners).
    expect(vCount(r3)).toBeGreaterThan(vCount(r1));
  });
});

describe('mergeAtCenter', () => {
  it('merges welds two coincident verts', () => {
    const m = cube();
    const r = mergeAtCenter(m, [0, 1]);
    expect(vCount(r)).toBeLessThan(vCount(m));
  });
});

describe('loopCut', () => {
  it('loop cut on a quad face creates two faces', () => {
    const m = plane(1, 1);
    const r = loopCut(m, 0, 1);
    expect(r.faces.length).toBe(2);
  });
  it('loop cut with cuts=2 creates three faces', () => {
    const m = plane(1, 1);
    const r = loopCut(m, 0, 2);
    expect(r.faces.length).toBe(3);
  });
  it('slide moves the cut toward one edge without changing topology', () => {
    const centered = loopCut(cube(), 0, 1, 0);
    const slid = loopCut(cube(), 0, 1, 0.8);
    // Same topology (count/watertightness unaffected by the slide).
    expect(slid.faces.length).toBe(centered.faces.length);
    expect(vCount(slid)).toBe(vCount(centered));
    // The new cut vertices (indices 8..11 for a cube) shift off center.
    const cutY = (mm: typeof centered) => {
      let sum = 0;
      for (let i = 8; i < vCount(mm); i++) sum += Math.abs(mm.vertices[i * 3 + 1]!);
      return sum;
    };
    // Cube spans y in [-0.5, 0.5]; centered cuts sit at y=0 (sum 0), a slide
    // pushes them off center (sum > 0).
    expect(cutY(centered)).toBeCloseTo(0, 5);
    expect(cutY(slid)).toBeGreaterThan(0.5);
  });
  it('rings around a cube: 4 quads split, 2 untouched, cut verts shared', () => {
    const r = loopCut(cube(), 0, 1);
    // The loop crosses 4 faces of the ring (each → 2 quads) + 2 caps stay.
    expect(r.faces.length).toBe(10);
    // 4 crossed edges → 4 new midpoint verts, shared between neighbors.
    expect(vCount(r)).toBe(12);
    // Watertight: every edge shared by exactly 2 faces.
    const edgeCount = new Map<string, number>();
    for (const f of r.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const [, n] of edgeCount) expect(n).toBe(2);
  });
});

describe('subdivideFace', () => {
  it('subdivides a quad into 4 quads with cuts=1', () => {
    const m = plane(1, 1);
    const r = subdivideFace(m, 0, 1);
    expect(r.faces.length).toBe(4);
  });
});

describe('deleteFaces / makeFace', () => {
  it('delete face removes it, make face adds it back', () => {
    const m = cube();
    const r = deleteFaces(m, [0]);
    expect(r.faces.length).toBe(m.faces.length - 1);
    const r2 = makeFace(r, [0, 1, 2, 3]);
    expect(r2.faces.length).toBe(r.faces.length + 1);
  });
});

describe('smoothVerts', () => {
  it('pulls a translated vertex back toward its neighbors', () => {
    const m = translateVerts(cube(), [0], { x: 1, y: 0, z: 0 });
    const before = Math.abs(m.vertices[0]!);
    const r = smoothVerts(m, [0], 0.5);
    expect(Math.abs(r.vertices[0]!)).toBeLessThan(before);
    // Unselected verts untouched.
    expect(r.vertices[3]).toBe(m.vertices[3]);
  });
  it('empty selection smooths everything without exploding vert count', () => {
    const r = smoothVerts(cube(), [], 0.5, 2);
    expect(vCount(r)).toBe(8);
  });
});

describe('shrinkFatten', () => {
  it('positive offset pushes cube verts outward, negative pulls in', () => {
    const grow = shrinkFatten(cube(), [], 0.1);
    const shrink = shrinkFatten(cube(), [], -0.1);
    // Corner vert magnitude grows / shrinks along the averaged normal.
    const mag = (m: { vertices: number[] }) => Math.hypot(m.vertices[0]!, m.vertices[1]!, m.vertices[2]!);
    expect(mag(grow)).toBeGreaterThan(mag(cube()));
    expect(mag(shrink)).toBeLessThan(mag(cube()));
  });
});

describe('mirrorMesh', () => {
  it('negates the axis and keeps normals outward', () => {
    const r = mirrorMesh(cube(), 'x');
    expect(r.vertices[0]).toBeCloseTo(-cube().vertices[0]!);
    expect(recalculateNormals(r).faces).toEqual(r.faces);
  });
});

describe('joinMeshes', () => {
  it('concatenates verts and reindexes the second mesh faces', () => {
    const r = joinMeshes(cube(), cube());
    expect(vCount(r)).toBe(16);
    expect(r.faces.length).toBe(12);
    for (const f of r.faces.slice(6)) for (const vi of f.v) expect(vi).toBeGreaterThanOrEqual(8);
  });
});

describe('weld', () => {
  it('weld drops duplicate verts within epsilon', () => {
    const m = { vertices: [0, 0, 0, 0, 0, 0, 1, 0, 0], faces: [{ v: [0, 1, 2] }] };
    const r = weld(m, 1e-3);
    expect(vCount(r)).toBe(2);
    // Degenerate triangle drops.
    expect(r.faces.length).toBe(0);
  });
});
