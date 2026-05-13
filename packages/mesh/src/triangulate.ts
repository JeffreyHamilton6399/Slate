import type { Mesh, MeshFace } from './types.js';
import { vGet } from './types.js';

/** Fan-triangulate an n-gon. Works well for convex polygons which is what
 *  Slate generates from primitives + extrude/inset/bevel. */
export function triangulateFace(face: MeshFace): MeshFace[] {
  if (face.v.length === 3) return [face];
  if (face.v.length < 3) return [];
  const out: MeshFace[] = [];
  for (let i = 1; i < face.v.length - 1; i++) {
    out.push({ v: [face.v[0]!, face.v[i]!, face.v[i + 1]!] });
  }
  return out;
}

/** Convert mesh to triangles-only and return interleaved vertex + index arrays
 *  for upload to a GPU buffer. */
export function toTriIndexed(mesh: Mesh): {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
} {
  const tris: number[] = [];
  for (const face of mesh.faces) {
    for (const t of triangulateFace(face)) tris.push(...t.v);
  }
  const positions = new Float32Array(mesh.vertices);
  const indices = new Uint32Array(tris);

  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]!;
    const ib = indices[i + 1]!;
    const ic = indices[i + 2]!;
    const a = vGet(mesh, ia);
    const b = vGet(mesh, ib);
    const c = vGet(mesh, ic);
    const ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z;
    const vx = c.x - a.x,
      vy = c.y - a.y,
      vz = c.z - a.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const ii of [ia, ib, ic]) {
      normals[ii * 3] = (normals[ii * 3] ?? 0) + nx;
      normals[ii * 3 + 1] = (normals[ii * 3 + 1] ?? 0) + ny;
      normals[ii * 3 + 2] = (normals[ii * 3 + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = (normals[i] ?? 0) / l;
    normals[i + 1] = (normals[i + 1] ?? 0) / l;
    normals[i + 2] = (normals[i + 2] ?? 0) / l;
  }
  return { positions, indices, normals };
}
