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
  vSet,
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
  //
  // Cuts are DIRECTED: cutVerts(cur, nb) creates cuts measured outward from
  // `cur` (the vertex being beveled), so the chamfer is always centered on the
  // beveled vertex itself. An earlier version anchored cuts at the edge's
  // lower-INDEX endpoint instead — beveling a vertex with a lower-numbered
  // neighbour placed the cut near the *neighbour*, eating nearly the whole
  // edge on that side and producing a visibly lopsided, off-center chamfer.
  // When BOTH endpoints of an edge are beveled, each end gets its own cuts
  // (like Blender); the 45% clamp below guarantees the two sides never cross.
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
        // Outermost cut (s=seg) lands at exactly the bevel amount, matching
        // Blender's width semantics; inner cuts shape the rounded profile.
        const frac = s / seg;
        const pos = add(c, scale(normalize(edge), t * frac));
        ids.push(vAdd(m, pos));
      }
      edgeVerts.set(key, ids);
    }
    // ids go outward from `cur` (ids[0] closest to cur, last closest to nb).
    return [...ids];
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

  // Build the canonical neighbour cycle for each beveled vertex by walking
  // the ORIGINAL face loops. For each face containing `vi`, the face's
  // vertex array gives us the (prev, vi, next) triple — the two edges
  // incident to `vi` in that face, in CCW order around the vertex (because
  // faces are wound CCW seen from outside). Chaining these pairs into a
  // single cycle gives the edges in topological CCW order.
  //
  // This is what we use to order the corner-fill edges instead of an
  // angle-based sort: the topological cycle is stable across interactive
  // edits as long as the mesh connectivity doesn't change, whereas an
  // angle sort depends on a tangent basis that flips discontinuously
  // (Math.abs(n.x) < 0.9 seed) as the vertex normal rotates — that flip
  // is what makes multi-segment bevels visibly swirl while dragging.
  const vertNeighbourCycle = new Map<number, number[]>();
  for (const vi of new Set(vertIds)) {
    const pairs: Array<{ prev: number; next: number }> = [];
    for (const f of m.faces) {
      for (let i = 0; i < f.v.length; i++) {
        if (f.v[i] !== vi) continue;
        const prev = f.v[(i - 1 + f.v.length) % f.v.length]!;
        const next = f.v[(i + 1) % f.v.length]!;
        pairs.push({ prev, next });
      }
    }
    if (pairs.length < 3) continue;
    // Chain: starting from pairs[0], the next pair is the one whose
    // prev equals the current pair's next (each shared edge appears as
    // "next" in one face and "prev" in its neighbour). Continue until
    // the cycle closes back to the start.
    const byPrev = new Map<number, { prev: number; next: number }>();
    for (const p of pairs) byPrev.set(p.prev, p);
    const order: number[] = [];
    const start = pairs[0]!;
    let cur = start;
    let safety = pairs.length + 1;
    do {
      order.push(cur.next);
      const nxt = byPrev.get(cur.next);
      if (!nxt) break; // chain broke (non-manifold / inconsistent winding)
      cur = nxt;
    } while (cur !== start && --safety > 0);
    // If we couldn't close the loop, fall back to face-iteration order —
    // still deterministic per topology, and the winding check below will
    // catch a globally-inverted ordering.
    if (order.length !== pairs.length) {
      order.length = 0;
      for (const p of pairs) order.push(p.next);
    }
    vertNeighbourCycle.set(vi, order);
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
      // For multi-segment bevels, only the OUTERMOST cut (closest to the
      // neighbour) goes into the face boundary. The intermediate cuts form
      // the rounded corner fill only — putting them in both the face AND the
      // corner fill creates non-manifold (shared) edges.
      const prevCuts = cutVerts(cur, prev);
      const nextCuts = cutVerts(cur, next);
      // prevCuts goes cur→prev; last element is closest to prev.
      // nextCuts goes cur→next; last element is closest to next.
      newV.push(prevCuts[prevCuts.length - 1]!, nextCuts[nextCuts.length - 1]!);
    }
    m.faces[fi] = { v: newV };
  }

  // Fill the hole left at each beveled vertex with a rounded corner. For
  // single-segment bevels this is a single n-gon. For multi-segment, it's a
  // fan of quad strips connecting concentric rings of cut vertices, capped
  // by a small innermost n-gon — this is what produces the smooth round.
  for (const vi of new Set(vertIds)) {
    // Map: neighbourId → cut vertex ids going outward from vi (cuts[0] is
    // closest to vi). The cache is directed, so vi's cuts are exactly the
    // entries whose key starts at vi — already in outward order.
    const cutsByNb = new Map<number, number[]>();
    for (const [key, cutIds] of edgeVerts) {
      const [aStr, bStr] = key.split('->');
      if (Number(aStr) === vi) cutsByNb.set(Number(bStr), [...cutIds]);
    }
    if (cutsByNb.size < 3) continue;

    // Order the edges by the topological neighbour cycle (computed above
    // from the original face loops) instead of by angle around the vertex
    // normal. The topological order is invariant under vertex-position
    // edits, so the multi-segment quad strips no longer swirl while the
    // user drags the bevel width.
    const cycle = vertNeighbourCycle.get(vi);
    let edges: number[][];
    if (cycle && cycle.length === cutsByNb.size) {
      edges = [];
      for (const nb of cycle) {
        const cuts = cutsByNb.get(nb);
        if (cuts) edges.push(cuts);
      }
      // If some neighbours were missing from the cycle (non-manifold),
      // fall back to the unordered iteration.
      if (edges.length !== cutsByNb.size) edges = [...cutsByNb.values()];
    } else {
      edges = [...cutsByNb.values()];
    }

    // ── Rounded profile (Blender's Shape = 0.5) ─────────────────────────────
    // The cuts were created by LINEAR interpolation along each edge, which
    // makes a multi-segment bevel just a subdivided flat chamfer — extra
    // segments added vertices but no curvature. Blender instead sweeps the
    // profile along a circular arc, so more segments = a rounder corner.
    // Reposition each INNER cut (all but the outermost, which must stay on
    // the original edge where the modified faces reference it) onto a sphere:
    //   - b = normalized average of the outgoing edge directions (points into
    //     the solid for a convex corner),
    //   - per edge, the sphere center C sits along b such that the sphere is
    //     tangent to the edge at the outermost cut ((outer-C) ⊥ edge), giving
    //     a fillet that meets the side faces smoothly,
    //   - inner cuts slerp along the arc from the apex direction (-b, the
    //     rounded-off corner tip) to the outermost cut.
    // For a cube corner this reproduces the exact sphere-octant round.
    if (seg > 1) {
      const V = vGet(m, vi);
      const dirs = edges.map((e) => normalize(sub(vGet(m, e[e.length - 1]!), V)));
      let bs: Vec3 = { x: 0, y: 0, z: 0 };
      for (const d of dirs) bs = add(bs, d);
      // Concave/flat corners (directions cancel out) keep the linear profile.
      if (length(bs) > 1e-4) {
        const b = normalize(bs);
        const p = scale(b, -1); // apex direction from the sphere center
        for (let e = 0; e < edges.length; e++) {
          const cuts = edges[e]!;
          const outer = vGet(m, cuts[cuts.length - 1]!);
          const t = length(sub(outer, V));
          const dk = dot(dirs[e]!, b);
          if (t < 1e-9 || dk < 0.15) continue; // near-tangent edge: keep linear
          const C = add(V, scale(b, t / dk)); // tangency: (outer-C)·dir = 0
          const rvec = sub(outer, C);
          const r = length(rvec);
          if (r < 1e-9) continue;
          const a = scale(rvec, 1 / r);
          const omega = Math.acos(Math.max(-1, Math.min(1, dot(a, p))));
          if (omega < 1e-4) continue;
          const sinO = Math.sin(omega);
          for (let j = 0; j < seg - 1; j++) {
            const f = (j + 1) / seg; // 0 → apex, 1 → outermost cut
            const w1 = Math.sin((1 - f) * omega) / sinO;
            const w2 = Math.sin(f * omega) / sinO;
            const dir = normalize(add(scale(p, w1), scale(a, w2)));
            vSet(m, cuts[j]!, add(C, scale(dir, r)));
          }
        }
      }
    }

    // Winding safety net: check if the outer ring faces inward.
    // CRITICAL: do NOT reverse the edges array — that would change which edges
    // are adjacent in the quad strips, causing a visual "rotation" of the
    // corner fill. Instead, compute a boolean and reverse vertex order WITHIN
    // each generated face. This fixes winding without changing topology.
    const n = normalize(vertNormal.get(vi) ?? { x: 0, y: 1, z: 0 });
    const outerRing = edges.map((e) => e[e.length - 1]!); // outermost cuts
    const windingFlip = dot(faceNormal(m, { v: outerRing }), n) < 0;

    // For single-segment (seg=1), each edge has 1 cut. The corner fill is a
    // single n-gon connecting all cuts — edges shared with the modified faces.
    if (seg === 1) {
      const ring = edges.map((e) => e[0]!);
      m.faces.push({ v: windingFlip ? [...ring].reverse() : ring });
      continue;
    }
    // For multi-segment, create concentric rings connected by quad strips.
    // Ring s (0-indexed from innermost=0 to outermost=seg-1) has one cut per edge.
    // The outermost ring (s=seg-1) has its outer edges shared with modified faces.
    // Quad strips connect ring s to ring s+1 for s = 0..seg-2.
    // The innermost ring (s=0) is capped with a small n-gon.
    const numEdges = edges.length;
    for (let s = 0; s < seg - 1; s++) {
      for (let e = 0; e < numEdges; e++) {
        const e1 = edges[e]!;
        const e2 = edges[(e + 1) % numEdges]!;
        // Normal winding: inner(s) on e1, outer(s+1) on e1, outer(s+1) on e2, inner(s) on e2
        // If windingFlip: reverse the vertex order within this quad.
        const quad = windingFlip
          ? [e2[s]!, e2[s + 1]!, e1[s + 1]!, e1[s]!]
          : [e1[s]!, e1[s + 1]!, e2[s + 1]!, e2[s]!];
        m.faces.push({ v: quad });
      }
    }
    // Innermost n-gon cap (ring 0).
    const innerRing = edges.map((e) => e[0]!);
    m.faces.push({ v: windingFlip ? [...innerRing].reverse() : innerRing });
  }

  // The original beveled vertices are now unreferenced; drop them.
  return compact(m);
}

/** All unique manifold edges (shared by exactly 2 faces) as a flat pair list
 *  [a0,b0, a1,b1, …] — the "bevel everything" default when nothing is selected
 *  (Blender: Ctrl+B with the whole mesh selected bevels every edge). */
export function allManifoldEdges(mesh: Mesh): number[] {
  const count = new Map<string, [number, number, number]>(); // key → [a, b, faceCount]
  for (const f of mesh.faces) {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % f.v.length]!;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = count.get(key);
      if (e) e[2] += 1;
      else count.set(key, [a, b, 1]);
    }
  }
  const out: number[] = [];
  for (const [, [a, b, n]] of count) if (n === 2) out.push(a, b);
  return out;
}

/**
 * Bevel selected EDGES by `amount` — Blender's Ctrl+B edge bevel. Each edge
 * is replaced by a strip of `segments` quads whose cross-section is a
 * CIRCULAR ARC tangent to both adjacent faces (Blender's Shape = 0.5 rounded
 * profile), so more segments = a rounder edge, not just a subdivided flat
 * chamfer.
 *
 * `edgePairsFlat` is a flat [a0,b0, a1,b1, …] vertex-pair list (the editor's
 * edge-selection format). Non-manifold edges (not shared by exactly 2 faces)
 * are skipped.
 *
 * Geometry per face corner at a beveled vertex:
 *   - corner between two beveled edges → the exact offset-line intersection
 *     X = v + (t1+t2)·w/(1+t1·t2)  (t = in-face perpendiculars of the edges),
 *   - corner between a beveled and an unbeveled edge → the corner SLIDES
 *     along the unbeveled edge to where the beveled edge's offset line meets
 *     it (Blender's edge-slide termination).
 * The arc between a strip's two side-corners is sampled from the rational
 * quadratic Bézier with control point on the original edge and weight
 * cos(θ/2) — an EXACT circle tangent to both faces.
 *
 * Ends: a vertex touched by ONE beveled edge gets a fan cap from the original
 * vertex; a vertex where 2+ beveled edges meet gets a rounded corner patch
 * (fan from the centroid of the closed loop formed by the meeting arcs) —
 * the sphere-octant corner on a fully beveled cube.
 */
export function bevelEdges(
  mesh: Mesh,
  edgePairsFlat: number[],
  amount: number,
  segments = 1,
): Mesh {
  if (amount <= 0 || edgePairsFlat.length < 2) return cloneMesh(mesh);
  const seg = Math.max(1, Math.round(segments));
  const m = cloneMesh(mesh);
  const ekey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // Adjacent faces per edge (from the ORIGINAL topology).
  const facesByEdge = new Map<string, number[]>();
  m.faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const k = ekey(f.v[i]!, f.v[(i + 1) % f.v.length]!);
      const arr = facesByEdge.get(k) ?? [];
      arr.push(fi);
      facesByEdge.set(k, arr);
    }
  });

  interface BEdge { a: number; b: number; f1: number; f2: number; key: string; w: number }
  const bedges: BEdge[] = [];
  const selected = new Map<string, BEdge>();
  for (let i = 0; i + 1 < edgePairsFlat.length; i += 2) {
    const a = edgePairsFlat[i]!;
    const b = edgePairsFlat[i + 1]!;
    if (a === b) continue;
    const key = ekey(a, b);
    if (selected.has(key)) continue;
    const fs = facesByEdge.get(key);
    if (!fs || fs.length !== 2) continue;
    // Clamp the width to 45% of the edge so the two end profiles never cross.
    const w = Math.min(amount, length(sub(vGet(m, b), vGet(m, a))) * 0.45);
    if (w < 1e-9) continue;
    const e: BEdge = { a, b, f1: fs[0]!, f2: fs[1]!, key, w };
    selected.set(key, e);
    bedges.push(e);
  }
  if (bedges.length === 0) return cloneMesh(mesh);

  // Face normals + centroids from the ORIGINAL mesh (faces get rewritten below).
  const N = m.faces.map((f) => faceNormal(m, f));
  const FC = m.faces.map((f) => faceCentroid(m, f));

  /** In-face perpendicular of edge a→b pointing INTO face fi. */
  const inFacePerp = (fi: number, a: number, b: number): Vec3 => {
    const e = normalize(sub(vGet(m, b), vGet(m, a)));
    let t = cross(N[fi]!, e);
    const mid = scale(add(vGet(m, a), vGet(m, b)), 0.5);
    if (dot(t, sub(FC[fi]!, mid)) < 0) t = scale(t, -1);
    return normalize(t);
  };

  // Rewrite every face that borders a selected edge, recording the corner
  // vertex chosen for each (edge, endpoint, face) — the strips and corner
  // patches share those exact vertices, keeping the result watertight.
  const sideCorner = new Map<string, number>(); // `${edgeKey}:${vert}:${face}` → vert id
  // Slid corners are SHARED per (vertex, unbeveled edge): the two faces
  // flanking an unbeveled edge both slide this corner along that same edge.
  // Creating one vertex per face left two coincident-but-distinct ids, so
  // the corner-patch loop below couldn't chain through them and fell back
  // to fanning through the ORIGINAL vertex — a spike sticking out of every
  // corner where a beveled region met an unbeveled edge (e.g. beveling the
  // four edges of a cube's top face left all four top corners as spikes).
  const slidCorner = new Map<string, number>(); // `${vert}|${unbeveledEdgeKey}` → vert id
  m.faces.forEach((f, fi) => {
    const n = f.v.length;
    let touches = false;
    for (let i = 0; i < n; i++) {
      if (selected.has(ekey(f.v[i]!, f.v[(i + 1) % n]!))) { touches = true; break; }
    }
    if (!touches) return;
    const newV: number[] = [];
    for (let i = 0; i < n; i++) {
      const cur = f.v[i]!;
      const prev = f.v[(i - 1 + n) % n]!;
      const next = f.v[(i + 1) % n]!;
      const ePrev = selected.get(ekey(prev, cur));
      const eNext = selected.get(ekey(cur, next));
      if (!ePrev && !eNext) {
        newV.push(cur);
        continue;
      }
      const V = vGet(m, cur);
      let id: number;
      if (ePrev && eNext) {
        // Corner between two beveled edges: offset-line intersection.
        // 1/(1+c) explodes as the corner angle collapses (c → -1, a sliver
        // corner — common on second-generation bevels where strip edges meet
        // at grazing angles), throwing the point far OUTSIDE the mesh. Cap
        // the displacement at a few widths and fall back to a plain
        // perpendicular offset beyond that.
        const t1 = inFacePerp(fi, prev, cur);
        const t2 = inFacePerp(fi, cur, next);
        const c = dot(t1, t2);
        const w = Math.min(ePrev.w, eNext.w);
        let off = c > -0.99 ? scale(add(t1, t2), w / (1 + c)) : scale(t1, w);
        if (length(off) > w * 4) {
          const bisec = add(t1, t2);
          off = scale(length(bisec) > 1e-6 ? normalize(bisec) : t1, w);
        }
        id = vAdd(m, add(V, off));
      } else {
        // One beveled edge: slide the corner along the UNBEVELED loop edge to
        // where the beveled edge's offset line crosses it. The slid vertex is
        // shared with the face on the other side of that unbeveled edge (see
        // slidCorner above); when both faces want it, keep the FARTHER slide
        // so the wider strip's offset is honored.
        const bev = (eNext ?? ePrev)!;
        const tperp = eNext ? inFacePerp(fi, cur, next) : inFacePerp(fi, prev, cur);
        const other = eNext ? prev : next; // the unbeveled edge's far endpoint
        const u = sub(vGet(m, other), V);
        const ul = length(u);
        const ud = ul > 1e-9 ? scale(u, 1 / ul) : tperp;
        const k = dot(ud, tperp);
        const onEdge = k > 0.05;
        const s = onEdge ? Math.min(bev.w / k, ul * 0.9) : bev.w;
        const X = add(V, onEdge ? scale(ud, s) : scale(tperp, bev.w));
        const slideKey = `${cur}|${ekey(cur, other)}`;
        const existing = slidCorner.get(slideKey);
        if (existing !== undefined) {
          id = existing;
          // Only points ON the unbeveled edge can be merged meaningfully.
          if (onEdge && length(sub(X, V)) > length(sub(vGet(m, id), V))) vSet(m, id, X);
        } else {
          id = vAdd(m, X);
          if (onEdge) slidCorner.set(slideKey, id);
        }
      }
      newV.push(id);
      if (ePrev) sideCorner.set(`${ePrev.key}:${cur}:${fi}`, id);
      if (eNext) sideCorner.set(`${eNext.key}:${cur}:${fi}`, id);
    }
    m.faces[fi] = { v: newV };
  });

  /** Sample the circular-arc profile at one strip end: from side corner A
   *  (on f1) to side corner B (on f2), bulging toward the original edge —
   *  rational quadratic Bézier with control point on the edge line and
   *  weight cos(θ/2) traces the exact tangent circle. Returns seg+1 vertex
   *  ids, reusing A and B at the ends. */
  const arcCache = new Map<string, number[]>(); // `${edgeKey}:${vert}` → ids f1→f2
  const endArc = (e: BEdge, endVert: number): number[] | null => {
    const cacheKey = `${e.key}:${endVert}`;
    const hit = arcCache.get(cacheKey);
    if (hit) return hit;
    const idA = sideCorner.get(`${e.key}:${endVert}:${e.f1}`);
    const idB = sideCorner.get(`${e.key}:${endVert}:${e.f2}`);
    if (idA === undefined || idB === undefined) return null;
    const A = vGet(m, idA);
    const B = vGet(m, idB);
    // Control point: the tangent lines through A and B meet on the original
    // edge line — project both and average for robustness. The projection
    // parameter is clamped to the edge SEGMENT: skewed corners (grazing-angle
    // faces on second-generation bevels) can project past the endpoints,
    // which would bulge the arc outside the mesh.
    const P0 = vGet(m, e.a);
    const eLen = length(sub(vGet(m, e.b), P0));
    const d = normalize(sub(vGet(m, e.b), P0));
    const proj = (p: Vec3) => add(P0, scale(d, Math.max(0, Math.min(eLen, dot(sub(p, P0), d)))));
    const ctrl = scale(add(proj(A), proj(B)), 0.5);
    const u1 = normalize(sub(A, ctrl));
    const u2 = normalize(sub(B, ctrl));
    const cosT = Math.max(-1, Math.min(1, dot(u1, u2)));
    const wgt = Math.sqrt(Math.max(0, (1 + cosT) / 2)); // cos(θ/2)
    const ids: number[] = [idA];
    for (let k = 1; k < seg; k++) {
      const t = k / seg;
      const b0 = (1 - t) * (1 - t);
      const b1 = 2 * t * (1 - t) * wgt;
      const b2 = t * t;
      const den = b0 + b1 + b2 || 1;
      ids.push(vAdd(m, {
        x: (b0 * A.x + b1 * ctrl.x + b2 * B.x) / den,
        y: (b0 * A.y + b1 * ctrl.y + b2 * B.y) / den,
        z: (b0 * A.z + b1 * ctrl.z + b2 * B.z) / den,
      }));
    }
    ids.push(idB);
    arcCache.set(cacheKey, ids);
    return ids;
  };

  // Strip quads per edge (both end arcs ordered f1→f2, so rows pair up).
  for (const e of bedges) {
    const arcA = endArc(e, e.a);
    const arcB = endArc(e, e.b);
    if (!arcA || !arcB) continue;
    const outward = normalize(add(N[e.f1]!, N[e.f2]!));
    for (let k = 0; k < seg; k++) {
      const quad = [arcA[k]!, arcB[k]!, arcB[k + 1]!, arcA[k + 1]!];
      const flip = dot(faceNormal(m, { v: quad }), outward) < 0;
      m.faces.push({ v: flip ? quad.reverse() : quad });
    }
  }

  // End caps + corner patches.
  const edgesAtVert = new Map<number, BEdge[]>();
  for (const e of bedges) {
    for (const v of [e.a, e.b]) {
      const arr = edgesAtVert.get(v) ?? [];
      arr.push(e);
      edgesAtVert.set(v, arr);
    }
  }
  for (const [v, list] of edgesAtVert) {
    // Outward direction at the vertex (average normal of its original faces).
    let vn: Vec3 = { x: 0, y: 0, z: 0 };
    mesh.faces.forEach((f, fi) => { if (f.v.includes(v)) vn = add(vn, N[fi]!); });
    vn = normalize(vn);
    const pushFan = (center: number, ring: number[]) => {
      for (let i = 0; i + 1 < ring.length; i++) {
        const tri = [center, ring[i]!, ring[i + 1]!];
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
        const flip = dot(faceNormal(m, { v: tri }), vn) < 0;
        m.faces.push({ v: flip ? tri.reverse() : tri });
      }
    };
    if (list.length === 1) {
      // Single strip ending here: taper into the (still-referenced) vertex.
      const arc = endArc(list[0]!, v);
      if (arc) pushFan(v, arc);
      continue;
    }
    /** Push a polygon oriented outward at this vertex (dedupes repeated ids). */
    const pushPoly = (poly: number[]) => {
      const uniq = poly.filter((id, i, a) => a.indexOf(id) === i);
      if (uniq.length < 3) return;
      const flip = dot(faceNormal(m, { v: uniq }), vn) < 0;
      m.faces.push({ v: flip ? uniq.reverse() : uniq });
    };
    const remaining = list
      .map((e) => endArc(e, v))
      .filter((a): a is number[] => !!a && a.length >= 2);
    if (remaining.length < 2) continue;
    // EXACTLY TWO strips meeting (a face-bevel corner: two beveled edges +
    // an unbeveled one): the two end arcs share BOTH endpoints, bounding a
    // narrow lens. The sphere grid below is wrong for that shape — a lens is
    // nowhere near a sphere cap, and the fitted apex ended up far off the
    // surface, extruding a pinched "tent" sliver down the unbeveled edge.
    // The right fill is a LADDER: rungs between corresponding points of the
    // two arcs (triangles at the shared ends, quads between). Nearly flat,
    // no new vertices, blends the two strips like Blender's terminating
    // corner.
    if (remaining.length === 2) {
      const a1 = remaining[0]!;
      let a2 = remaining[1]!;
      const last = (a: number[]) => a[a.length - 1]!;
      const sharedBoth =
        (a1[0] === a2[0] && last(a1) === last(a2)) ||
        (a1[0] === last(a2) && last(a1) === a2[0]);
      if (sharedBoth) {
        if (a1[0] !== a2[0]) a2 = [...a2].reverse();
        for (let i = 0; i + 1 < a1.length; i++) {
          pushPoly([a1[i]!, a1[i + 1]!, a2[i + 1]!, a2[i]!]);
        }
        continue;
      }
    }
    // 3+ strips meet: chain their end arcs (they share side-corner vertices)
    // into one closed loop for the rounded corner patch.
    const loop: number[] = [...remaining[0]!];
    remaining.splice(0, 1);
    let closed = false;
    let guard = remaining.length + 2;
    while (remaining.length > 0 && guard-- > 0) {
      const tail = loop[loop.length - 1]!;
      const idx = remaining.findIndex((a) => a[0] === tail || a[a.length - 1] === tail);
      if (idx < 0) break;
      const nextArc = remaining.splice(idx, 1)[0]!;
      const pts = nextArc[0] === tail ? nextArc : [...nextArc].reverse();
      loop.push(...pts.slice(1));
    }
    if (loop.length >= 3 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      closed = true;
    }
    if (closed && remaining.length === 0) {
      // Corner patch. A single fan from one apex approximates the rounded
      // corner with a flat CONE — fine when the bevel is narrow, but at wide
      // bevels the corner sphere is huge and the cone's long skinny triangles
      // crease visibly and sag inside the sphere (the "messed-up corner").
      // Instead: fit the sphere the boundary arcs lie on (center constrained
      // to the line from the loop centroid toward the ORIGINAL corner vertex,
      // 1-D least squares via ternary search), then build a SPHERICAL GRID —
      // an apex on the sphere plus seg-1 concentric rings slerped between the
      // apex direction and each boundary point's direction. For a fully
      // beveled cube corner every boundary point lies exactly on the octant
      // sphere, so the patch reproduces the true sphere octant like Blender.
      // A poor fit (irregular loop) falls back to the flat centroid fan.
      const pts = loop.map((id) => vGet(m, id));
      let cx = 0, cy = 0, cz = 0;
      for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
      const C0: Vec3 = { x: cx / pts.length, y: cy / pts.length, z: cz / pts.length };
      const V = vGet(m, v);
      const dir = sub(V, C0);
      const dl = length(dir);
      let fit: { S: Vec3; R: number; dhat: Vec3 } | null = null;
      if (seg > 1 && dl > 1e-9) {
        const dhat = scale(dir, 1 / dl);
        const spread = (t: number): { mean: number; varr: number } => {
          const S = add(C0, scale(dir, t));
          let mean = 0;
          const ds = pts.map((p) => length(sub(p, S)));
          for (const d of ds) mean += d;
          mean /= ds.length;
          let varr = 0;
          for (const d of ds) varr += (d - mean) * (d - mean);
          return { mean, varr };
        };
        // Sphere center sits on the far side of the loop from the corner
        // (t < 0); search a generous bracket.
        let lo = -8, hi = 0.5;
        for (let it = 0; it < 48; it++) {
          const t1 = lo + (hi - lo) / 3;
          const t2 = hi - (hi - lo) / 3;
          if (spread(t1).varr <= spread(t2).varr) hi = t2;
          else lo = t1;
        }
        const t = (lo + hi) / 2;
        const { mean: R, varr } = spread(t);
        // Accept only when (a) the points genuinely fit a sphere AND (b) the
        // sphere's size is commensurate with how far the ORIGINAL corner
        // vertex rises above the loop (R ≲ 2·dl). A near-FLAT corner — e.g.
        // the pole vertex of a previous bevel's corner patch when beveling a
        // second time — has dl ≈ 0, but its surrounding loop still lies on
        // many small "equatorial" spheres; building the cap of one of those
        // extrudes a hemisphere BUMP through the surface. Flat corners take
        // the flat fan below, which is exactly right for them.
        if (R > 1e-9 && Math.sqrt(varr / pts.length) < R * 0.2 && R <= dl * 2) {
          fit = { S: add(C0, scale(dir, t)), R, dhat };
        }
      }
      if (fit) {
        const { S, R, dhat } = fit;
        const n = loop.length;
        const apexId = vAdd(m, add(S, scale(dhat, R)));
        const pushOriented = (poly: number[]) => {
          const flip = dot(faceNormal(m, { v: poly }), vn) < 0;
          m.faces.push({ v: flip ? [...poly].reverse() : poly });
        };
        // Concentric rings between the apex (t=0) and the boundary loop
        // (t=1): directions slerp from the apex direction to each boundary
        // point's direction; radii lerp to each point's true distance so
        // slightly-off-sphere boundaries still join seamlessly.
        const rings: number[][] = [];
        for (let r = 1; r < seg; r++) {
          const tt = r / seg;
          const ring: number[] = [];
          for (let i = 0; i < n; i++) {
            const u1 = normalize(sub(pts[i]!, S));
            const cosO = Math.max(-1, Math.min(1, dot(dhat, u1)));
            const om = Math.acos(cosO);
            let d2: Vec3;
            if (om < 1e-4) d2 = u1;
            else {
              const so = Math.sin(om);
              d2 = normalize(add(scale(dhat, Math.sin((1 - tt) * om) / so), scale(u1, Math.sin(tt * om) / so)));
            }
            const Ri = R * (1 - tt) + length(sub(pts[i]!, S)) * tt;
            ring.push(vAdd(m, add(S, scale(d2, Ri))));
          }
          rings.push(ring);
        }
        const r1 = rings[0] ?? loop;
        for (let i = 0; i < n; i++) pushOriented([apexId, r1[i]!, r1[(i + 1) % n]!]);
        for (let r = 0; r < rings.length; r++) {
          const cur = rings[r]!;
          const nxt = r + 1 < rings.length ? rings[r + 1]! : loop;
          for (let i = 0; i < n; i++) {
            pushOriented([cur[i]!, cur[(i + 1) % n]!, nxt[(i + 1) % n]!, nxt[i]!]);
          }
        }
      } else {
        const c = vAdd(m, C0);
        pushFan(c, [...loop, loop[0]!]);
      }
    } else {
      // Open chain (mixed selected/unselected edges at this corner): close
      // through the original vertex, which the unselected faces still use.
      pushFan(v, [...loop, v]);
    }
  }

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
