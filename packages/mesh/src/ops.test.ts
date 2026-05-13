import { describe, expect, it } from 'vitest';
import { cube, plane } from './primitives.js';
import {
  bevelVerts,
  deleteFaces,
  extrudeFaces,
  insetFaces,
  loopCut,
  makeFace,
  mergeAtCenter,
  subdivideFace,
  translateVerts,
} from './ops.js';
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
});

describe('bevelVerts', () => {
  it('beveling one corner of a cube replaces it with multiple verts', () => {
    const m = cube();
    const r = bevelVerts(m, [0], 0.1);
    expect(vCount(r)).toBeGreaterThan(vCount(m));
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

describe('weld', () => {
  it('weld drops duplicate verts within epsilon', () => {
    const m = { vertices: [0, 0, 0, 0, 0, 0, 1, 0, 0], faces: [{ v: [0, 1, 2] }] };
    const r = weld(m, 1e-3);
    expect(vCount(r)).toBe(2);
    // Degenerate triangle drops.
    expect(r.faces.length).toBe(0);
  });
});
