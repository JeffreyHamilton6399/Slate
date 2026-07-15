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
  dot,
  faceCentroid,
  faceNormal,
  length,
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
  // Splice in descending index order so replacing one face never shifts the
  // indices of faces still to be processed (splicing at a higher index leaves
  // lower indices untouched).
  const ordered = [...new Set(faceIdxs)].filter((i) => i >= 0 && i < m.faces.length).sort((a, b) => b - a);
  for (const fi of ordered) {
    const f = m.faces[fi]!;
    const c = faceCentroid(m, f);
    const inner: number[] = [];
    for (const i of f.v) {
      const v = vGet(m, i);
      const dir = sub(c, v);
      // Clamp to 90% of the way to the centroid so a thick inset on a small
      // face can never push verts past the middle and invert the face.
      const moved = add(v, scale(normalize(dir), Math.min(thickness, length(dir) * 0.9)));
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

/**
 * Bevel selected vertices by `amount` (Blender's Ctrl+Shift+B vertex bevel).
 * Each vertex is cut back along every incident edge and the resulting hole
 * is filled with a corner face, so the chamfer is watertight.
 */
export function bevelVerts(mesh: Mesh, vertIds: number[], amount: number, segments = 1): Mesh {
  if (amount <= 0 || vertIds.length === 0) return cloneMesh(mesh);
  const seg = Math.max(1, Math.round(segments));
  const m = cloneMesh(mesh);
  const sel = new Set(vertIds);

  // For segments > 1, create multiple interpolated vertices along each bevel
  // edge — this is Blender's "Segments" bevel setting (a rounded chamfer
  // instead of a single flat cut). Each segment vertex sits at a fractional
  // position along the edge.
  const edgeVerts = new Map<string, number[]>();
  const cutVerts = (cur: number, nb: number): number[] => {
    const key = `${cur}->${nb}`;
    let ids = edgeVerts.get(key);
    if (ids === undefined) {
      const c = vGet(m, cur);
      const edge = sub(vGet(m, nb), c);
      // Never step past 45% of the edge so bevels from both ends can't cross.
      const t = Math.min(amount, length(edge) * 0.45);
      ids = [];
      for (let s = 1; s <= seg; s++) {
        const frac = s / (seg + 1);
        const pos = add(c, scale(normalize(edge), t * frac));
        ids.push(vAdd(m, pos));
      }
      edgeVerts.set(key, ids);
    }
    return ids;
  };

  // Average incident-face normal per beveled vertex (orients its corner face).
  // Collected from the original faces before they're rewritten.
  const vertNormal = new Map<number, Vec3>();
  for (const f of m.faces) {
    const n = faceNormal(m, f);
    for (const vi of f.v) {
      if (!sel.has(vi)) continue;
      vertNormal.set(vi, add(vertNormal.get(vi) ?? { x: 0, y: 0, z: 0 }, n));
    }
  }

  for (let fi = 0; fi < m.faces.length; fi++) {
    const f = m.faces[fi]!;
    const newV: number[] = [];
    for (let i = 0; i < f.v.length; i++) {
      const cur = f.v[i]!;
      if (!sel.has(cur)) {
        newV.push(cur);
        continue;
      }
      const prev = f.v[(i - 1 + f.v.length) % f.v.length]!;
      const next = f.v[(i + 1) % f.v.length]!;
      // Walking the loop prev→cur→next, the boundary meets the cut on the
      // prev-side edge first (arriving from prev toward cur), then the cut
      // on the next-side edge (departing from cur toward next).
      // cutVerts returns verts ordered from cur toward the neighbour, so:
      //   - nextCuts (cur→next) are already in the correct walking direction
      //   - prevCuts (cur→prev) must be REVERSED so they go prev→cur
      // This is critical when both endpoints of an edge are beveled: without
      // the reversal, the two halves of the edge produce a zigzag boundary.
      const prevCuts = cutVerts(cur, prev);
      const nextCuts = cutVerts(cur, next);
      // Reverse a COPY — cutVerts returns a cached array shared across faces.
      newV.push(...[...prevCuts].reverse(), ...nextCuts);
    }
    m.faces[fi] = { v: newV };
  }

  // Fill the hole left at each beveled vertex with a corner strip. With
  // segments, the cut points form a fan that rounds the corner.
  for (const vi of new Set(vertIds)) {
    const ids: number[] = [];
    const prefix = `${vi}->`;
    for (const [key, cutIds] of edgeVerts) {
      if (key.startsWith(prefix)) ids.push(...cutIds);
    }
    if (ids.length < 3) continue;
    const c = vGet(m, vi);
    const n = normalize(vertNormal.get(vi) ?? { x: 0, y: 1, z: 0 });
    const seed = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const u = normalize(cross(n, seed));
    const w = cross(n, u);
    ids.sort((a, b) => {
      const pa = sub(vGet(m, a), c);
      const pb = sub(vGet(m, b), c);
      return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
    });
    // Angle-sorting around n yields CCW seen from outside; verify + flip in
    // case the vertex normal was degenerate.
    if (dot(faceNormal(m, { v: ids }), n) < 0) ids.reverse();
    m.faces.push({ v: ids });
  }

  // The original beveled vertices are now unreferenced; drop them.
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

/**
 * Loop cut (Blender Ctrl+R): starting from `faceIdx`, the cut enters each
 * quad through one edge and exits through the opposite one, walking in both
 * directions until the loop closes on itself or leaves quad territory.
 * Every crossed quad is split into `cuts + 1` strips; cut vertices are
 * shared across faces so the loop is watertight. N-gons fall back to
 * fan subdivision.
 */
/**
 * Loop-cut a quad ring. `cuts` sets how many parallel cuts; `slide` in
 * [-1, 1] shifts the whole loop along the crossed edges (0 = centered, like
 * Blender's edge-slide after the cut). The slide direction is taken from the
 * start face's crossed edge, so on prism/cube/cylinder rings — where the
 * crossed edges are parallel — the loop slides cleanly to one side.
 */
export function loopCut(mesh: Mesh, faceIdx: number, cuts = 1, slide = 0): Mesh {
  const f0 = mesh.faces[faceIdx];
  if (!f0) return cloneMesh(mesh);
  if (f0.v.length !== 4) return subdivideFace(mesh, faceIdx, cuts);
  const m = cloneMesh(mesh);
  const segs = Math.max(1, cuts) + 1;
  const ekey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const facesByEdge = new Map<string, number[]>();
  m.faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const k = ekey(f.v[i]!, f.v[(i + 1) % f.v.length]!);
      const arr = facesByEdge.get(k) ?? [];
      arr.push(fi);
      facesByEdge.set(k, arr);
    }
  });

  // faceIdx → index of one crossed edge in its loop (the pair is i and i+2).
  // The start face is cut parallel to its first edge, i.e. across edges 1/3.
  const crossed = new Map<number, number>();
  crossed.set(faceIdx, 1);
  const queue: [number, number][] = [[faceIdx, 1]];
  while (queue.length > 0) {
    const [fi, ei] = queue.pop()!;
    const face = m.faces[fi]!;
    for (const j of [ei, (ei + 2) % 4]) {
      const k = ekey(face.v[j]!, face.v[(j + 1) % 4]!);
      for (const nfi of facesByEdge.get(k) ?? []) {
        if (nfi === fi || crossed.has(nfi)) continue;
        const nf = m.faces[nfi]!;
        if (nf.v.length !== 4) continue;
        let entry = -1;
        for (let t = 0; t < 4; t++) {
          if (ekey(nf.v[t]!, nf.v[(t + 1) % 4]!) === k) {
            entry = t;
            break;
          }
        }
        if (entry < 0) continue;
        crossed.set(nfi, entry);
        queue.push([nfi, entry]);
      }
    }
  }

  // Slide direction D — the start face's crossed edge (v[1]→v[2]). Cut points
  // are measured from each edge's "D-backward" end so the slide is consistent
  // around the whole loop, not per-edge by arbitrary vertex id.
  const sa = vGet(m, f0.v[1]!);
  const sb = vGet(m, f0.v[2]!);
  let dx = sb.x - sa.x, dy = sb.y - sa.y, dz = sb.z - sa.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;

  // Cut fractions with a uniform slide offset kept strictly inside the quad
  // (|offset| < one spacing, so cuts never cross or collapse).
  const off = Math.max(-1, Math.min(1, slide)) * (1 / segs) * 0.9;
  const fracs: number[] = [];
  for (let i = 1; i < segs; i++) fracs.push(Math.min(0.98, Math.max(0.02, i / segs + off)));

  // Cut vertices per crossed edge; oriented by D so neighbors reuse the exact
  // same physical points (watertight) regardless of walk direction.
  const cutPts = new Map<string, number[]>();
  const cutBack = new Map<string, number>();
  const cutsAlong = (a: number, b: number): number[] => {
    const k = ekey(a, b);
    let ids = cutPts.get(k);
    if (!ids) {
      const va = vGet(m, a);
      const vb = vGet(m, b);
      // Orient a→b vs D: t=0 at the backward end, t=1 at the forward end.
      const dot = (vb.x - va.x) * dx + (vb.y - va.y) * dy + (vb.z - va.z) * dz;
      const back = dot >= 0 ? a : b;
      const fwd = dot >= 0 ? b : a;
      const vBack = vGet(m, back);
      const vFwd = vGet(m, fwd);
      ids = fracs.map((t) =>
        vAdd(m, {
          x: vBack.x + (vFwd.x - vBack.x) * t,
          y: vBack.y + (vFwd.y - vBack.y) * t,
          z: vBack.z + (vFwd.z - vBack.z) * t,
        }),
      );
      cutPts.set(k, ids);
      cutBack.set(k, back);
    }
    // Return in the caller's a→b order.
    return a === cutBack.get(k) ? ids : [...ids].reverse();
  };

  const out: MeshFace[] = [];
  m.faces.forEach((f, fi) => {
    const ei = crossed.get(fi);
    if (ei === undefined) {
      out.push(f);
      return;
    }
    const [a, b, c, d] = [f.v[ei]!, f.v[(ei + 1) % 4]!, f.v[(ei + 2) % 4]!, f.v[(ei + 3) % 4]!];
    // Rails run along the two crossed edges, in the same direction across
    // the quad (a→b and d→c); each pair of rail steps becomes one strip.
    const railA = [a, ...cutsAlong(a, b), b];
    const railB = [d, ...cutsAlong(d, c), c];
    for (let i = 0; i < railA.length - 1; i++) {
      out.push({ v: [railA[i]!, railA[i + 1]!, railB[i + 1]!, railB[i]!] });
    }
  });
  m.faces = out;
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

/** Triangulate the given faces (or all faces) by fanning from the first vert.
 *  Convex faces only — which is everything Slate's ops produce. */
export function triangulateSelected(mesh: Mesh, faceIdxs?: number[]): Mesh {
  const target =
    faceIdxs && faceIdxs.length > 0
      ? new Set(faceIdxs.filter((i) => i >= 0 && i < mesh.faces.length))
      : null;
  const faces: MeshFace[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi]!;
    if ((target && !target.has(fi)) || f.v.length <= 3) {
      faces.push({ v: f.v.slice() });
      continue;
    }
    for (let i = 1; i < f.v.length - 1; i++) {
      faces.push({ v: [f.v[0]!, f.v[i]!, f.v[i + 1]!] });
    }
  }
  return { vertices: mesh.vertices.slice(), faces };
}

/**
 * Recalculate normals to point outward — reverse any face whose normal points
 * back toward the mesh centroid. Exact for convex meshes (all of Slate's
 * primitives) and a sensible default elsewhere; Blender's flood-fill variant
 * is only needed for pathological concave topology.
 */
export function recalculateNormals(mesh: Mesh): Mesh {
  const n = vCount(mesh);
  if (n === 0) return cloneMesh(mesh);
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < n; i++) {
    const v = vGet(mesh, i);
    cx += v.x;
    cy += v.y;
    cz += v.z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const faces = mesh.faces.map((f) => {
    if (f.v.length < 3) return { v: f.v.slice() };
    const fc = faceCentroid(mesh, f);
    const nrm = faceNormal(mesh, f);
    const dot = nrm.x * (fc.x - cx) + nrm.y * (fc.y - cy) + nrm.z * (fc.z - cz);
    return dot < 0 ? { v: [...f.v].reverse() } : { v: f.v.slice() };
  });
  return { vertices: mesh.vertices.slice(), faces };
}

/** Reverse the winding of the given faces (or all), flipping their normals. */
export function flipFaces(mesh: Mesh, faceIdxs?: number[]): Mesh {
  const target =
    faceIdxs && faceIdxs.length > 0
      ? new Set(faceIdxs.filter((i) => i >= 0 && i < mesh.faces.length))
      : null;
  return {
    vertices: mesh.vertices.slice(),
    faces: mesh.faces.map((f, i) =>
      !target || target.has(i) ? { v: [...f.v].reverse() } : { v: f.v.slice() },
    ),
  };
}

/** Make-face from selected verts (Blender 'F'). Requires 3 or 4 verts. */
export function makeFace(mesh: Mesh, vertIds: number[]): Mesh {
  if (vertIds.length < 3 || vertIds.length > 64) return cloneMesh(mesh);
  const m = cloneMesh(mesh);
  m.faces.push({ v: vertIds.slice() });
  return m;
}

/**
 * Laplacian vertex smooth (Blender's Vertex → Smooth): each selected vertex
 * moves `factor` of the way toward the average of its edge-connected
 * neighbors. Empty `vertIds` smooths every vertex.
 */
export function smoothVerts(
  mesh: Mesh,
  vertIds: number[],
  factor = 0.5,
  iterations = 1,
): Mesh {
  const m = cloneMesh(mesh);
  const sel = vertIds.length > 0 ? new Set(vertIds) : null;
  const nbrs = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = nbrs.get(a);
    if (!s) {
      s = new Set();
      nbrs.set(a, s);
    }
    s.add(b);
  };
  for (const f of m.faces) {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      link(a, b);
      link(b, a);
    }
  }
  for (let it = 0; it < Math.max(1, iterations); it++) {
    const next = m.vertices.slice();
    for (const [vi, ns] of nbrs) {
      if (sel && !sel.has(vi)) continue;
      if (ns.size === 0) continue;
      let ax = 0,
        ay = 0,
        az = 0;
      for (const n of ns) {
        const p = vGet(m, n);
        ax += p.x;
        ay += p.y;
        az += p.z;
      }
      const c = vGet(m, vi);
      next[vi * 3] = c.x + (ax / ns.size - c.x) * factor;
      next[vi * 3 + 1] = c.y + (ay / ns.size - c.y) * factor;
      next[vi * 3 + 2] = c.z + (az / ns.size - c.z) * factor;
    }
    m.vertices = next;
  }
  return m;
}

/**
 * Shrink/fatten (Blender Alt+S): move selected vertices along their averaged
 * incident-face normals. Positive offset fattens, negative shrinks. Empty
 * `vertIds` moves every vertex.
 */
export function shrinkFatten(mesh: Mesh, vertIds: number[], offset: number): Mesh {
  const m = cloneMesh(mesh);
  const sel = vertIds.length > 0 ? new Set(vertIds) : null;
  const acc = new Map<number, Vec3>();
  for (const f of m.faces) {
    const n = faceNormal(m, f);
    for (const vi of f.v) {
      if (sel && !sel.has(vi)) continue;
      acc.set(vi, add(acc.get(vi) ?? { x: 0, y: 0, z: 0 }, n));
    }
  }
  for (const [vi, n] of acc) {
    const d = normalize(n);
    m.vertices[vi * 3] = (m.vertices[vi * 3] ?? 0) + d.x * offset;
    m.vertices[vi * 3 + 1] = (m.vertices[vi * 3 + 1] ?? 0) + d.y * offset;
    m.vertices[vi * 3 + 2] = (m.vertices[vi * 3 + 2] ?? 0) + d.z * offset;
  }
  return m;
}

/** Mirror across a local axis; winding reversed so normals stay outward. */
export function mirrorMesh(mesh: Mesh, axis: 'x' | 'y' | 'z'): Mesh {
  const m = cloneMesh(mesh);
  const o = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let i = o; i < m.vertices.length; i += 3) m.vertices[i] = -(m.vertices[i] ?? 0);
  m.faces = m.faces.map((f) => ({ v: [...f.v].reverse() }));
  return m;
}

/** Concatenate two meshes into one (Blender Ctrl+J building block). */
export function joinMeshes(a: Mesh, b: Mesh): Mesh {
  const base = vCount(a);
  return {
    vertices: [...a.vertices, ...b.vertices],
    faces: [
      ...a.faces.map((f) => ({ v: f.v.slice() })),
      ...b.faces.map((f) => ({ v: f.v.map((i) => i + base) })),
    ],
  };
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

/** Duplicate the given faces as detached copies, offset slightly so they're
 *  visible — Blender's Shift+D in edit mode (face duplicate without extrude). */
export function duplicateFaces(mesh: Mesh, faceIdxs: number[], offset: number): Mesh {
  const m = cloneMesh(mesh);
  const vertMap = new Map<number, number>();
  for (const fi of faceIdxs) {
    const f = m.faces[fi];
    if (!f) continue;
    const newV: number[] = [];
    for (const vi of f.v) {
      let nv = vertMap.get(vi);
      if (nv === undefined) {
        const p = vGet(m, vi);
        nv = vAdd(m, { x: p.x + offset, y: p.y + offset, z: p.z + offset });
        vertMap.set(vi, nv);
      }
      newV.push(nv);
    }
    m.faces.push({ v: newV });
  }
  return m;
}

/** Rip selected verts: duplicate them and reassign only the selected faces
 *  to use the copies, so the selected region detaches from the mesh. */
export function ripVerts(mesh: Mesh, vertIds: number[], offset: number): Mesh {
  const m = cloneMesh(mesh);
  const sel = new Set(vertIds);
  const vertMap = new Map<number, number>();
  const ensureRip = (vi: number): number => {
    let nv = vertMap.get(vi);
    if (nv === undefined) {
      const p = vGet(m, vi);
      nv = vAdd(m, { x: p.x + offset, y: p.y + offset, z: p.z + offset });
      vertMap.set(vi, nv);
    }
    return nv;
  };
  // For each face: if ALL its verts are selected, reassign them to ripped copies.
  for (let fi = 0; fi < m.faces.length; fi++) {
    const f = m.faces[fi]!;
    if (f.v.every((vi) => sel.has(vi))) {
      m.faces[fi] = { v: f.v.map((vi) => ensureRip(vi)) };
    }
  }
  return m;
}

/** Shear selected verts: shift X proportional to Y height within the selection.
 *  Blender's Alt+Ctrl+Shift+S. */
export function shearVerts(mesh: Mesh, vertIds: number[], factor: number): Mesh {
  const m = cloneMesh(mesh);
  if (vertIds.length === 0) return m;
  const box = aabb(m, vertIds);
  const yMin = box.min.y;
  const yRange = box.max.y - yMin || 1;
  const sel = new Set(vertIds);
  for (let i = 0; i < m.vertices.length; i += 3) {
    const vi = i / 3;
    if (!sel.has(vi)) continue;
    const y = m.vertices[i + 1] ?? 0;
    const t = (y - yMin) / yRange; // 0 at bottom, 1 at top
    m.vertices[i] = (m.vertices[i] ?? 0) + t * factor * yRange;
  }
  return m;
}

/** Move selected verts toward (or away from) the centroid — Blender's
 *  To Sphere (Alt+Shift+S). factor=0 = no move, factor=1 = all at centroid. */
export function toSphere(mesh: Mesh, vertIds: number[], factor: number): Mesh {
  const m = cloneMesh(mesh);
  if (vertIds.length < 2) return m;
  // Centroid
  let cx = 0, cy = 0, cz = 0;
  for (const vi of vertIds) {
    const p = vGet(m, vi);
    cx += p.x; cy += p.y; cz += p.z;
  }
  cx /= vertIds.length; cy /= vertIds.length; cz /= vertIds.length;
  // Average distance from centroid
  let avgDist = 0;
  for (const vi of vertIds) {
    const p = vGet(m, vi);
    avgDist += Math.hypot(p.x - cx, p.y - cy, p.z - cz);
  }
  avgDist /= vertIds.length || 1;
  if (avgDist < 1e-9) return m;
  const sel = new Set(vertIds);
  const f = Math.max(0, Math.min(1, factor));
  for (let i = 0; i < m.vertices.length; i += 3) {
    const vi = i / 3;
    if (!sel.has(vi)) continue;
    const x = m.vertices[i] ?? 0;
    const y = m.vertices[i + 1] ?? 0;
    const z = m.vertices[i + 2] ?? 0;
    // Move toward the point on the sphere of radius avgDist centered at centroid.
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const tx = cx + (dx / dist) * avgDist;
    const ty = cy + (dy / dist) * avgDist;
    const tz = cz + (dz / dist) * avgDist;
    m.vertices[i] = x + (tx - x) * f;
    m.vertices[i + 1] = y + (ty - y) * f;
    m.vertices[i + 2] = z + (tz - z) * f;
  }
  return m;
}
