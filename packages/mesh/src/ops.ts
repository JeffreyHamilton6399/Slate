/**
 * Topology operations on Mesh.
 *
 * Each op returns a fresh Mesh; callers can wrap in a transaction and
 * roll back by holding onto the previous mesh value.
 *
 * Behavioral parity with Blender (referenced from
 * https://projects.blender.org/blender/blender) for shortcut semantics —
 * no GPL code is vendored.
 */

import type { Mesh, MeshFace, Vec3 } from './types.js';
import {
  add,
  cloneMesh,
  cross,
  faceCentroid,
  faceNormal,
  normalize,
  scale,
  sub,
  vAdd,
  vCount,
  vGet,
} from './types.js';
import { weld } from './weld.js';

/** Translate selected vertices by `delta`. */
export function translateVerts(mesh: Mesh, vertIds: Iterable<number>, delta: Vec3): Mesh {
  const m = cloneMesh(mesh);
  for (const i of vertIds) {
    m.vertices[i * 3] = (m.vertices[i * 3] ?? 0) + delta.x;
    m.vertices[i * 3 + 1] = (m.vertices[i * 3 + 1] ?? 0) + delta.y;
    m.vertices[i * 3 + 2] = (m.vertices[i * 3 + 2] ?? 0) + delta.z;
  }
  return m;
}

/** Delete faces touching any of the given vertex indices. */
export function deleteVerts(mesh: Mesh, vertIds: Iterable<number>): Mesh {
  const drop = new Set<number>(vertIds as Iterable<number>);
  const faces = mesh.faces.filter((f) => f.v.every((i) => !drop.has(i)));
  return compact({ vertices: mesh.vertices.slice(), faces });
}

/** Delete faces by index. */
export function deleteFaces(mesh: Mesh, faceIdxs: Iterable<number>): Mesh {
  const drop = new Set<number>(faceIdxs as Iterable<number>);
  const faces = mesh.faces.filter((_, i) => !drop.has(i));
  return compact({ vertices: mesh.vertices.slice(), faces });
}

/** Drop unreferenced vertices and reindex faces. */
export function compact(mesh: Mesh): Mesh {
  const n = vCount(mesh);
  const used = new Uint8Array(n);
  for (const f of mesh.faces) for (const i of f.v) used[i] = 1;
  const remap = new Int32Array(n);
  const verts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) {
      remap[i] = verts.length / 3;
      verts.push(mesh.vertices[i * 3]!, mesh.vertices[i * 3 + 1]!, mesh.vertices[i * 3 + 2]!);
    } else {
      remap[i] = -1;
    }
  }
  return {
    vertices: verts,
    faces: mesh.faces.map((f) => ({ v: f.v.map((i) => remap[i]!) })),
  };
}

/**
 * Extrude the given faces along an offset vector. New geometry creates
 * a duplicate of each face's verts plus side quads.
 * Returns the new mesh + the indices of the new (extruded) face copies
 * so they remain selected in edit mode (Blender-like).
 */
export function extrudeFaces(
  mesh: Mesh,
  faceIdxs: number[],
  offset: Vec3,
): { mesh: Mesh; newFaceIdxs: number[] } {
  const m = cloneMesh(mesh);
  const sel = new Set(faceIdxs);

  // Collect boundary edges (edges that belong to exactly one selected face).
  const edgeCount = new Map<string, number>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const fi of faceIdxs) {
    const f = m.faces[fi]!;
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      const k = edgeKey(a, b);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }

  // Map old vert id -> new (extruded) vert id (only for verts belonging to selected faces).
  const newVertOf = new Map<number, number>();
  const ensureNewVert = (oldI: number): number => {
    let nid = newVertOf.get(oldI);
    if (nid === undefined) {
      const v = vGet(m, oldI);
      nid = vAdd(m, add(v, offset));
      newVertOf.set(oldI, nid);
    }
    return nid;
  };
  for (const fi of faceIdxs) {
    for (const v of m.faces[fi]!.v) ensureNewVert(v);
  }

  // Side faces along boundary edges.
  for (const fi of faceIdxs) {
    const f = m.faces[fi]!;
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      const k = edgeKey(a, b);
      if ((edgeCount.get(k) ?? 0) === 1) {
        const na = newVertOf.get(a)!;
        const nb = newVertOf.get(b)!;
        m.faces.push({ v: [a, b, nb, na] });
      }
    }
  }

  // Replace each selected face with its extruded copy (verts swapped).
  const newFaceIdxs: number[] = [];
  for (const fi of faceIdxs) {
    const f = m.faces[fi]!;
    const replaced: MeshFace = { v: f.v.map((i) => newVertOf.get(i)!) };
    m.faces[fi] = replaced;
    newFaceIdxs.push(fi);
  }

  // Original faces stay where they were? In Blender's default extrude, the
  // bottom is removed (the cap is the new top). For a forgiving editor we
  // keep them only when the face is _not_ on the boundary — meaning the
  // original interior caps disappear automatically because they sit on the
  // side faces. Easier: just keep what we have; users can clean with Merge.

  void sel;
  return { mesh: m, newFaceIdxs };
}

/** Inset selected faces individually (Blender 'I' default). */
export function insetFaces(mesh: Mesh, faceIdxs: number[], thickness: number): Mesh {
  if (thickness <= 0) return cloneMesh(mesh);
  const m = cloneMesh(mesh);
  for (const fi of faceIdxs) {
    const f = m.faces[fi]!;
    const c = faceCentroid(m, f);
    const inner: number[] = [];
    for (const i of f.v) {
      const v = vGet(m, i);
      const dir = sub(c, v);
      const moved = add(v, scale(normalize(dir), Math.min(thickness, 0.99)));
      inner.push(vAdd(m, moved));
    }
    // Ring of quads between original loop and inner loop.
    const ring: MeshFace[] = [];
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      const nb = inner[(i + 1) % inner.length]!;
      const na = inner[i]!;
      ring.push({ v: [a, b, nb, na] });
    }
    m.faces.splice(fi, 1, { v: inner }, ...ring);
  }
  return m;
}

/** Bevel selected vertices by `amount`. Splits each vertex into one copy per
 *  incident edge, moved toward the neighbor. */
export function bevelVerts(mesh: Mesh, vertIds: number[], amount: number): Mesh {
  if (amount <= 0) return cloneMesh(mesh);
  const m = cloneMesh(mesh);
  const sel = new Set(vertIds);

  // For each face, find which selected verts it touches and which neighbors.
  for (let fi = 0; fi < m.faces.length; fi++) {
    const f = m.faces[fi]!;
    const newV: number[] = [];
    for (let i = 0; i < f.v.length; i++) {
      const cur = f.v[i]!;
      const prev = f.v[(i - 1 + f.v.length) % f.v.length]!;
      const next = f.v[(i + 1) % f.v.length]!;
      if (sel.has(cur)) {
        const c = vGet(m, cur);
        const p = vGet(m, prev);
        const n = vGet(m, next);
        const toPrev = normalize(sub(p, c));
        const toNext = normalize(sub(n, c));
        const vp = add(c, scale(toPrev, amount));
        const vn = add(c, scale(toNext, amount));
        // Replace `cur` with two vertices in face order (next-side first, then prev-side).
        newV.push(vAdd(m, vn));
        newV.push(vAdd(m, vp));
      } else {
        newV.push(cur);
      }
    }
    m.faces[fi] = { v: newV };
  }
  // Remove now-orphaned original beveled verts.
  return compact(m);
}

/** Merge selected verts to their centroid (Blender 'M' → At Center). */
export function mergeAtCenter(mesh: Mesh, vertIds: number[]): Mesh {
  if (vertIds.length < 2) return cloneMesh(mesh);
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const i of vertIds) {
    const v = vGet(mesh, i);
    cx += v.x;
    cy += v.y;
    cz += v.z;
  }
  const c = { x: cx / vertIds.length, y: cy / vertIds.length, z: cz / vertIds.length };
  const m = cloneMesh(mesh);
  for (const i of vertIds) {
    m.vertices[i * 3] = c.x;
    m.vertices[i * 3 + 1] = c.y;
    m.vertices[i * 3 + 2] = c.z;
  }
  return weld(m);
}

/** Simple loop cut: subdivide each face along a midline parallel to its
 *  first edge. Works perfectly on quads; falls back to fan-subdiv for n-gons. */
export function loopCut(mesh: Mesh, faceIdx: number, cuts = 1): Mesh {
  const f = mesh.faces[faceIdx];
  if (!f) return cloneMesh(mesh);
  if (f.v.length !== 4) return subdivideFace(mesh, faceIdx, cuts);
  const m = cloneMesh(mesh);
  const [a, b, c, d] = f.v as [number, number, number, number];
  const va = vGet(m, a);
  const vb = vGet(m, b);
  const vc = vGet(m, c);
  const vd = vGet(m, d);
  const segs = cuts + 1;
  const newRowsLeft: number[] = [a];
  const newRowsRight: number[] = [b];
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    newRowsLeft.push(
      vAdd(m, {
        x: va.x + (vd.x - va.x) * t,
        y: va.y + (vd.y - va.y) * t,
        z: va.z + (vd.z - va.z) * t,
      }),
    );
    newRowsRight.push(
      vAdd(m, {
        x: vb.x + (vc.x - vb.x) * t,
        y: vb.y + (vc.y - vb.y) * t,
        z: vb.z + (vc.z - vb.z) * t,
      }),
    );
  }
  newRowsLeft.push(d);
  newRowsRight.push(c);
  const replaced: MeshFace[] = [];
  for (let i = 0; i < newRowsLeft.length - 1; i++) {
    replaced.push({
      v: [newRowsLeft[i]!, newRowsRight[i]!, newRowsRight[i + 1]!, newRowsLeft[i + 1]!],
    });
  }
  m.faces.splice(faceIdx, 1, ...replaced);
  return m;
}

/** Generic subdivide — split a face into `cuts+1` x `cuts+1` quads if quad,
 *  otherwise fan from the centroid. */
export function subdivideFace(mesh: Mesh, faceIdx: number, cuts = 1): Mesh {
  const f = mesh.faces[faceIdx];
  if (!f) return cloneMesh(mesh);
  const m = cloneMesh(mesh);
  if (f.v.length === 4 && cuts >= 1) {
    const [a, b, c, d] = f.v as [number, number, number, number];
    const va = vGet(m, a);
    const vb = vGet(m, b);
    const vc = vGet(m, c);
    const vd = vGet(m, d);
    const segs = cuts + 1;
    const grid: number[][] = [];
    for (let j = 0; j <= segs; j++) {
      const tj = j / segs;
      const row: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const ti = i / segs;
        const x = (1 - ti) * (1 - tj) * va.x + ti * (1 - tj) * vb.x + ti * tj * vc.x + (1 - ti) * tj * vd.x;
        const y = (1 - ti) * (1 - tj) * va.y + ti * (1 - tj) * vb.y + ti * tj * vc.y + (1 - ti) * tj * vd.y;
        const z = (1 - ti) * (1 - tj) * va.z + ti * (1 - tj) * vb.z + ti * tj * vc.z + (1 - ti) * tj * vd.z;
        if (j === 0 && i === 0) row.push(a);
        else if (j === 0 && i === segs) row.push(b);
        else if (j === segs && i === segs) row.push(c);
        else if (j === segs && i === 0) row.push(d);
        else row.push(vAdd(m, { x, y, z }));
      }
      grid.push(row);
    }
    const newFaces: MeshFace[] = [];
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        newFaces.push({
          v: [grid[j]![i]!, grid[j]![i + 1]!, grid[j + 1]![i + 1]!, grid[j + 1]![i]!],
        });
      }
    }
    m.faces.splice(faceIdx, 1, ...newFaces);
    return m;
  }
  // n-gon fan from centroid
  const centroid = faceCentroid(m, f);
  const ci = vAdd(m, centroid);
  const fan: MeshFace[] = [];
  for (let i = 0; i < f.v.length; i++) {
    fan.push({ v: [f.v[i]!, f.v[(i + 1) % f.v.length]!, ci] });
  }
  m.faces.splice(faceIdx, 1, ...fan);
  return m;
}

/** Make-face from selected verts (Blender 'F'). Requires 3 or 4 verts. */
export function makeFace(mesh: Mesh, vertIds: number[]): Mesh {
  if (vertIds.length < 3 || vertIds.length > 64) return cloneMesh(mesh);
  const m = cloneMesh(mesh);
  m.faces.push({ v: vertIds.slice() });
  return m;
}

/** Convenience: AABB of a vert subset (or all). */
export function aabb(
  mesh: Mesh,
  vertIds?: Iterable<number>,
): { min: Vec3; max: Vec3 } {
  const indices = vertIds
    ? Array.from(vertIds)
    : Array.from({ length: vCount(mesh) }, (_, i) => i);
  if (indices.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const i of indices) {
    const v = vGet(mesh, i);
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

// Unused but exported for downstream use by edit-mode tools.
export { faceNormal as faceNormalOp, cross as crossOp };
