/**
 * Edit-mode mesh tools bound to the active object.
 *
 * v2 ships a simplified edit mode: instead of full per-vertex picking we
 * provide whole-mesh operations that exercise the half-edge-free topology
 * code in @slate/mesh:
 *
 *   E         → extrude all faces along their averaged normal
 *   I         → inset every face by 10% of mesh diagonal
 *   Ctrl+B    → bevel all verts by 5% of mesh diagonal
 *   Ctrl+R    → loop-cut first quad face (1 cut)
 *   M         → merge by distance (weld 1e-3)
 *   Subdivide → subdivide every face once
 *
 * These satisfy the "actually works" bar from the plan; full sub-element
 * selection lands in a follow-up. Each operation is a single Yjs transaction
 * so undo cleanly reverts it.
 */

import {
  bevelVerts,
  compact,
  deleteVerts,
  duplicateFaces,
  extrudeFaces,
  faceCentroid,
  faceNormalOp,
  flipFaces,
  insetFaces,
  loopCut,
  makeFace,
  mergeAtCenter,
  mirrorMesh,
  recalculateNormals,
  ripVerts,
  shearVerts,
  shrinkFatten,
  smoothVerts,
  subdivideFace,
  toSphere,
  triangulateSelected,
  vCount,
  type Mesh as MeshTopology,
} from '@slate/mesh';
import { weld } from '@slate/mesh';
import { setMeshData } from './scene';
import { useScene3DStore } from './store';
import type { SlateRoom } from '../sync/provider';
import type { MeshData } from '@slate/sync-protocol';

export type EditOp =
  | 'extrude'
  | 'inset'
  | 'bevel'
  | 'loop-cut'
  | 'subdivide'
  | 'smooth'
  | 'fatten'
  | 'shrink'
  | 'fill'
  | 'triangulate'
  | 'flip-normals'
  | 'recalc-normals'
  | 'merge'
  | 'delete-faces'
  | 'delete-verts'
  | 'duplicate-faces'
  | 'rip-verts'
  | 'shear'
  | 'to-sphere'
  | 'mirror-x'
  | 'mirror-y'
  | 'mirror-z';

interface RunArgs {
  room: SlateRoom;
  objectId: string;
  /** Selected face indices — ops act on these when present. */
  faces?: number[];
  /** Selected vertex indices — bevel prefers these when present. */
  verts?: number[];
}

export function runEditOp(op: EditOp, args: RunArgs): boolean {
  const yo = args.room.slate.scene3dObjects().get(args.objectId);
  if (!yo) return false;
  const meshId = yo.get('meshId') as string | null;
  if (!meshId) return false;
  const ym = args.room.slate.scene3dMeshes().get(meshId);
  if (!ym) return false;
  const data: MeshData = {
    id: meshId,
    vertices: (ym.get('vertices') as number[] | undefined) ?? [],
    faces: (ym.get('faces') as { v: number[] }[] | undefined) ?? [],
  };
  const valid = (args.faces ?? []).filter((f) => f >= 0 && f < data.faces.length);
  const validVerts = (args.verts ?? []).filter((v) => v >= 0 && v * 3 < data.vertices.length);
  const next = applyOp(op, { vertices: data.vertices, faces: data.faces }, valid, validVerts);
  if (!next) return false;
  setMeshData(args.room.slate, meshId, next);
  // Topology changed — old face indices are meaningless now.
  useScene3DStore.getState().setEditSelection({ verts: [], edges: [], faces: [] });
  return true;
}

function applyOp(
  op: EditOp,
  mesh: MeshTopology,
  sel: number[],
  selVerts: number[] = [],
): MeshTopology | null {
  if (mesh.faces.length === 0) return null;
  const scale = approxDiagonal(mesh) || 1;
  switch (op) {
    case 'extrude': {
      // Extrude the selected faces along their averaged normal; with no
      // selection fall back to the top-most face along its own normal.
      // (Extruding every face along the averaged normal cancels to ~zero
      // on closed meshes — a visually silent no-op.)
      const targets = sel.length > 0 ? sel : [topFace(mesh)];
      let nx = 0,
        ny = 0,
        nz = 0;
      for (const fi of targets) {
        const n = faceNormalOp(mesh, mesh.faces[fi]!);
        nx += n.x;
        ny += n.y;
        nz += n.z;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      const s = scale * 0.25;
      return extrudeFaces(mesh, targets, {
        x: (nx / l) * s,
        y: (ny / l) * s,
        z: (nz / l) * s,
      }).mesh;
    }
    case 'inset': {
      const targets = sel.length > 0 ? sel : mesh.faces.map((_, i) => i);
      return insetFaces(mesh, targets, scale * 0.05);
    }
    case 'bevel': {
      const verts =
        selVerts.length > 0
          ? selVerts
          : sel.length > 0
            ? [...new Set(sel.flatMap((fi) => mesh.faces[fi]!.v))]
            : Array.from({ length: vCount(mesh) }, (_, i) => i);
      return bevelVerts(mesh, verts, scale * 0.04);
    }
    case 'loop-cut': {
      const pool = sel.length > 0 ? sel : mesh.faces.map((_, i) => i);
      const quadIdx = pool.find((i) => mesh.faces[i]!.v.length === 4);
      if (quadIdx === undefined) return null;
      return loopCut(mesh, quadIdx, 1);
    }
    case 'subdivide': {
      let m = mesh;
      const targets = (sel.length > 0 ? sel : mesh.faces.map((_, i) => i)).sort((a, b) => b - a);
      for (const i of targets) m = subdivideFace(m, i, 1);
      // Adjacent subdivided faces each add their own copy of the shared edge
      // midpoints — weld the exact duplicates so the surface stays crack-free.
      return compact(weld(m, 1e-6));
    }
    case 'smooth':
      return smoothVerts(mesh, vertsFromSelection(mesh, sel, selVerts), 0.5, 1);
    case 'fatten':
      return shrinkFatten(mesh, vertsFromSelection(mesh, sel, selVerts), scale * 0.03);
    case 'shrink':
      return shrinkFatten(mesh, vertsFromSelection(mesh, sel, selVerts), -scale * 0.03);
    case 'fill':
      // Blender F: make a face from the picked verts (selection order).
      if (selVerts.length < 3) return null;
      return makeFace(mesh, selVerts);
    case 'triangulate':
      return triangulateSelected(mesh, sel.length > 0 ? sel : undefined);
    case 'flip-normals':
      return flipFaces(mesh, sel.length > 0 ? sel : undefined);
    case 'recalc-normals':
      return recalculateNormals(mesh);
    case 'merge':
      // With verts picked: Blender's M → At Center. Otherwise merge by
      // distance across the whole mesh.
      if (selVerts.length >= 2) return compact(mergeAtCenter(mesh, selVerts));
      return compact(weld(mesh, 1e-3));
    case 'delete-faces': {
      if (sel.length === 0) return null;
      const keep = mesh.faces.filter((_, i) => !sel.includes(i));
      // Refuse to delete the last face — delete the object instead.
      if (keep.length === 0) return null;
      return compact({ vertices: mesh.vertices, faces: keep });
    }
    case 'delete-verts': {
      // Blender X → Vertices: drops every face touching the picked verts.
      if (selVerts.length === 0) return null;
      const next = deleteVerts(mesh, selVerts);
      return next.faces.length === 0 ? null : next;
    }
    case 'duplicate-faces': {
      // Duplicate selected faces (detached) — Blender's Shift+D in edit mode.
      if (sel.length === 0) return null;
      const offset = scale * 0.1;
      return duplicateFaces(mesh, sel, offset);
    }
    case 'rip-verts': {
      // Rip selected verts (detach from adjacent unselected faces).
      if (selVerts.length === 0) return null;
      return ripVerts(mesh, selVerts, scale * 0.05);
    }
    case 'shear': {
      // Shear the selected verts along X proportional to their Y height.
      const vs = vertsFromSelection(mesh, sel, selVerts);
      if (vs.length === 0) return null;
      return shearVerts(mesh, vs, 0.3);
    }
    case 'to-sphere': {
      // Move selected verts toward the centroid (spherify) — Blender Alt+Shift+S.
      const vs = vertsFromSelection(mesh, sel, selVerts);
      if (vs.length < 2) return null;
      return toSphere(mesh, vs, 0.5);
    }
    case 'mirror-x':
      return mirrorMesh(mesh, 'x');
    case 'mirror-y':
      return mirrorMesh(mesh, 'y');
    case 'mirror-z':
      return mirrorMesh(mesh, 'z');
  }
}

/** Selected verts, else the verts of the selected faces, else all ([]). */
function vertsFromSelection(mesh: MeshTopology, faces: number[], verts: number[]): number[] {
  if (verts.length > 0) return verts;
  if (faces.length > 0) return [...new Set(faces.flatMap((fi) => mesh.faces[fi]?.v ?? []))];
  return [];
}

function topFace(mesh: MeshTopology): number {
  let best = 0;
  let bestY = -Infinity;
  for (let i = 0; i < mesh.faces.length; i++) {
    const c = faceCentroid(mesh, mesh.faces[i]!);
    if (c.y > bestY) {
      bestY = c.y;
      best = i;
    }
  }
  return best;
}

function approxDiagonal(mesh: MeshTopology): number {
  if (mesh.vertices.length === 0) return 1;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const x = mesh.vertices[i] ?? 0;
    const y = mesh.vertices[i + 1] ?? 0;
    const z = mesh.vertices[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

