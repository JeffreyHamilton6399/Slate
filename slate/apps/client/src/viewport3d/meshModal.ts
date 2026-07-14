/**
 * Modal mesh editing — Blender's "press the key, geometry follows the mouse"
 * interactions for edit mode:
 *
 *   G — grab the selected verts/edges/faces in the screen plane
 *   E — extrude the selected faces, with the new cap sliding along the
 *       face normal under the mouse
 *
 * The topology change (for extrude) happens once on entry; while the modal
 * runs only vertex positions are rewritten, so collaborators see the drag
 * live. Confirm keeps the result; cancel restores the pre-modal mesh.
 */

import {
  bevelVerts,
  extrudeFaces,
  faceNormalOp,
  insetFaces,
  loopCut,
  vCount,
  type Mesh as MeshTopology,
} from '@slate/mesh';
import { setMeshData } from './scene';
import type { SlateRoom } from '../sync/provider';
import type { Vec3 } from './modalTools';

export type MeshModalKind = 'grab' | 'extrude' | 'rotate' | 'scale' | 'bevel' | 'inset' | 'loop-cut';

/** Scalar modal ops recompute topology from the base mesh each frame. */
export type ScalarMeshOp = 'bevel' | 'inset' | 'loop-cut';

export interface MeshModalState {
  kind: MeshModalKind;
  objectId: string;
  meshId: string;
  /** Full snapshot to restore on cancel. */
  baseMesh: MeshTopology;
  /** Faces selected before the modal (restored on cancel). */
  baseFaces: number[];
  /** Working topology (post-extrude); only vertices change during the drag. */
  workFaces: { v: number[] }[];
  workVertices: number[];
  /** Vertex indices that follow the mouse. */
  dragVerts: number[];
  /** Direction lock — extrude defaults to the face normal. */
  lockDir: Vec3 | null;
  pixelDelta: { x: number; y: number };
  /** Faces to leave selected after confirm (extrude caps). */
  resultFaces: number[];
  /** Pivot for rotate/scale — centroid of the dragged vertices. */
  centroid: Vec3;
  /** Present for scalar ops (bevel/inset/loop-cut) driven by amount/cuts. */
  scalar?: {
    op: ScalarMeshOp;
    /** Bevel/inset amount as a fraction of the mesh diagonal. */
    amount: number;
    /** Loop-cut count. */
    cuts: number;
    /** Loop-cut slide position in [-1, 1] (0 = centered), from mouse X. */
    slide: number;
    /** Mesh diagonal — maps pixel drag to a sensible amount range. */
    diag: number;
    /** Target faces (inset) / verts (bevel) / quad face (loop-cut). */
    faces: number[];
    verts: number[];
    loopFace: number;
  };
}

function diagonalOf(mesh: MeshTopology): number {
  if (mesh.vertices.length === 0) return 1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const x = mesh.vertices[i] ?? 0, y = mesh.vertices[i + 1] ?? 0, z = mesh.vertices[i + 2] ?? 0;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

/**
 * Start a scalar modal (bevel/inset/loop-cut). Topology is recomputed from the
 * base mesh each frame from the current amount/cuts, so dragging the mouse (or
 * scrolling for loop-cut) previews live and a click confirms — like Blender.
 */
export function startMeshScalar(
  room: SlateRoom,
  objectId: string,
  op: ScalarMeshOp,
  selectedFaces: number[],
  selectedVerts: number[],
): MeshModalState | null {
  const found = readMesh(room, objectId);
  if (!found) return null;
  const mesh = found.mesh;
  if (mesh.faces.length === 0) return null;

  const faces = selectedFaces.filter((f) => f >= 0 && f < mesh.faces.length);
  const verts =
    selectedVerts.length > 0
      ? selectedVerts
      : faces.length > 0
        ? [...new Set(faces.flatMap((fi) => mesh.faces[fi]!.v))]
        : Array.from({ length: vCount(mesh) }, (_, i) => i);

  let loopFace = -1;
  if (op === 'loop-cut') {
    const pool = faces.length > 0 ? faces : mesh.faces.map((_, i) => i);
    const q = pool.find((i) => mesh.faces[i]!.v.length === 4);
    if (q === undefined) return null; // no quad to cut
    loopFace = q;
  }

  return {
    kind: op,
    objectId,
    meshId: found.meshId,
    baseMesh: mesh,
    baseFaces: selectedFaces.slice(),
    workFaces: mesh.faces,
    workVertices: mesh.vertices.slice(),
    dragVerts: [],
    lockDir: null,
    pixelDelta: { x: 0, y: 0 },
    resultFaces: selectedFaces.slice(),
    centroid: { x: 0, y: 0, z: 0 },
    scalar: {
      op,
      // Start with a small visible amount so the preview shows immediately
      // (Blender shows the bevel/cut the moment you press the shortcut).
      amount: op === 'bevel' ? 0.05 : 0,
      cuts: 1,
      slide: 0,
      diag: diagonalOf(mesh),
      faces: faces.length > 0 ? faces : mesh.faces.map((_, i) => i),
      verts,
      loopFace,
    },
  };
}

/** Recompute a scalar op from the base mesh at the current amount/cuts. */
export function applyMeshScalar(room: SlateRoom, state: MeshModalState): void {
  const s = state.scalar;
  if (!s) return;
  const base = state.baseMesh;
  let next: MeshTopology | null = null;
  if (s.op === 'bevel') {
    next = bevelVerts(base, s.verts, Math.max(0, s.amount) * s.diag, Math.max(1, Math.round(s.cuts ?? 1)));
  } else if (s.op === 'inset') {
    next = insetFaces(base, s.faces, Math.max(0, s.amount) * s.diag);
  } else if (s.op === 'loop-cut') {
    next = loopCut(base, s.loopFace, Math.max(1, Math.round(s.cuts)), s.slide);
  }
  if (next) setMeshData(room.slate, state.meshId, next);
}

function centroidOf(vertices: number[], verts: number[]): Vec3 {
  let x = 0,
    y = 0,
    z = 0;
  for (const vi of verts) {
    x += vertices[vi * 3] ?? 0;
    y += vertices[vi * 3 + 1] ?? 0;
    z += vertices[vi * 3 + 2] ?? 0;
  }
  const n = verts.length || 1;
  return { x: x / n, y: y / n, z: z / n };
}

function readMesh(room: SlateRoom, objectId: string): { meshId: string; mesh: MeshTopology } | null {
  const yo = room.slate.scene3dObjects().get(objectId);
  if (!yo) return null;
  const meshId = yo.get('meshId') as string | null;
  if (!meshId) return null;
  const ym = room.slate.scene3dMeshes().get(meshId);
  if (!ym) return null;
  return {
    meshId,
    mesh: {
      vertices: ((ym.get('vertices') as number[] | undefined) ?? []).slice(),
      faces: ((ym.get('faces') as { v: number[] }[] | undefined) ?? []).map((f) => ({
        v: f.v.slice(),
      })),
    },
  };
}

export function startMeshGrab(
  room: SlateRoom,
  objectId: string,
  dragVerts: number[],
  selectedFaces: number[],
  kind: 'grab' | 'rotate' | 'scale' = 'grab',
): MeshModalState | null {
  if (dragVerts.length === 0) return null;
  const found = readMesh(room, objectId);
  if (!found) return null;
  return {
    kind,
    objectId,
    meshId: found.meshId,
    baseMesh: found.mesh,
    baseFaces: selectedFaces.slice(),
    workFaces: found.mesh.faces,
    workVertices: found.mesh.vertices.slice(),
    dragVerts,
    lockDir: null,
    pixelDelta: { x: 0, y: 0 },
    resultFaces: selectedFaces.slice(),
    centroid: centroidOf(found.mesh.vertices, dragVerts),
  };
}

export function startMeshExtrude(
  room: SlateRoom,
  objectId: string,
  faces: number[],
): MeshModalState | null {
  if (faces.length === 0) return null;
  const found = readMesh(room, objectId);
  if (!found) return null;
  const valid = faces.filter((f) => f >= 0 && f < found.mesh.faces.length);
  if (valid.length === 0) return null;

  // Average normal of the source faces — the extrusion axis.
  let nx = 0,
    ny = 0,
    nz = 0;
  for (const fi of valid) {
    const n = faceNormalOp(found.mesh, found.mesh.faces[fi]!);
    nx += n.x;
    ny += n.y;
    nz += n.z;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  const lockDir = { x: nx / l, y: ny / l, z: nz / l };

  // Topology change happens once, with zero offset; the drag supplies it.
  const { mesh: extruded, newFaceIdxs } = extrudeFaces(found.mesh, valid, { x: 0, y: 0, z: 0 });
  const dragVerts = [...new Set(newFaceIdxs.flatMap((fi) => extruded.faces[fi]?.v ?? []))];
  setMeshData(room.slate, found.meshId, extruded);

  return {
    kind: 'extrude',
    objectId,
    meshId: found.meshId,
    baseMesh: found.mesh,
    baseFaces: faces.slice(),
    workFaces: extruded.faces,
    workVertices: extruded.vertices.slice(),
    dragVerts,
    lockDir,
    pixelDelta: { x: 0, y: 0 },
    resultFaces: newFaceIdxs,
    centroid: centroidOf(extruded.vertices, dragVerts),
  };
}

/** Rotate the dragged verts around the centroid on the given axis. */
export function rotateVertices(state: MeshModalState, axis: Vec3, angle: number): number[] {
  const vertices = state.workVertices.slice();
  const c = state.centroid;
  const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const ux = axis.x / l,
    uy = axis.y / l,
    uz = axis.z / l;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const vi of state.dragVerts) {
    const px = (vertices[vi * 3] ?? 0) - c.x;
    const py = (vertices[vi * 3 + 1] ?? 0) - c.y;
    const pz = (vertices[vi * 3 + 2] ?? 0) - c.z;
    // Rodrigues' rotation formula.
    const dot = ux * px + uy * py + uz * pz;
    const rx = px * cos + (uy * pz - uz * py) * sin + ux * dot * (1 - cos);
    const ry = py * cos + (uz * px - ux * pz) * sin + uy * dot * (1 - cos);
    const rz = pz * cos + (ux * py - uy * px) * sin + uz * dot * (1 - cos);
    vertices[vi * 3] = c.x + rx;
    vertices[vi * 3 + 1] = c.y + ry;
    vertices[vi * 3 + 2] = c.z + rz;
  }
  return vertices;
}

/** Scale the dragged verts about the centroid (per-axis factors). */
export function scaleVertices(state: MeshModalState, factor: Vec3): number[] {
  const vertices = state.workVertices.slice();
  const c = state.centroid;
  for (const vi of state.dragVerts) {
    vertices[vi * 3] = c.x + ((vertices[vi * 3] ?? 0) - c.x) * factor.x;
    vertices[vi * 3 + 1] = c.y + ((vertices[vi * 3 + 1] ?? 0) - c.y) * factor.y;
    vertices[vi * 3 + 2] = c.z + ((vertices[vi * 3 + 2] ?? 0) - c.z) * factor.z;
  }
  return vertices;
}

/** Write raw vertex positions (used by rotate/scale paths). */
export function writeVertices(room: SlateRoom, state: MeshModalState, vertices: number[]): void {
  setMeshData(room.slate, state.meshId, { vertices, faces: state.workFaces });
}

/** Write the dragged vertex positions for the given world-space delta. */
export function applyMeshModal(room: SlateRoom, state: MeshModalState, delta: Vec3): void {
  const vertices = state.workVertices.slice();
  for (const vi of state.dragVerts) {
    vertices[vi * 3] = (vertices[vi * 3] ?? 0) + delta.x;
    vertices[vi * 3 + 1] = (vertices[vi * 3 + 1] ?? 0) + delta.y;
    vertices[vi * 3 + 2] = (vertices[vi * 3 + 2] ?? 0) + delta.z;
  }
  setMeshData(room.slate, state.meshId, { vertices, faces: state.workFaces });
}

export function cancelMeshModal(room: SlateRoom, state: MeshModalState): void {
  setMeshData(room.slate, state.meshId, state.baseMesh);
}

export function meshModalLabel(state: MeshModalState): string {
  if (state.scalar) {
    const s = state.scalar;
    if (s.op === 'loop-cut') {
      const pos = Math.round(s.slide * 100);
      return `Loop cut • ${Math.max(1, Math.round(s.cuts))} cuts • slide ${pos > 0 ? '+' : ''}${pos}% • scroll = count · move = slide · click to confirm`;
    }
    const pct = Math.round(Math.max(0, s.amount) * 100);
    const segs = Math.max(1, Math.round(s.cuts ?? 1));
    return `${s.op === 'bevel' ? 'Bevel' : 'Inset'} • ${pct}% • ${s.op === 'bevel' ? `${segs} seg` : ''} • scroll = segments · move = size · click to confirm`.replace('  •', ' •');
  }
  const verb =
    state.kind === 'extrude'
      ? 'Extrude'
      : state.kind === 'rotate'
        ? 'Rotate'
        : state.kind === 'scale'
          ? 'Scale'
          : 'Move';
  const dir = state.lockDir
    ? state.kind === 'extrude'
      ? 'along normal'
      : 'axis'
    : 'free';
  return `${verb} • ${dir}`;
}
