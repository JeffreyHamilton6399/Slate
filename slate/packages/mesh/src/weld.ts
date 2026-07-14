import type { Mesh } from './types.js';
import { vCount, vGet } from './types.js';

/** Weld vertices within `epsilon` distance, rebuilding faces with the
 *  surviving indices. Degenerate faces (after weld) are dropped. */
export function weld(mesh: Mesh, epsilon = 1e-5): Mesh {
  const n = vCount(mesh);
  if (n === 0) return { vertices: [], faces: [] };
  const buckets = new Map<string, number>();
  const remap = new Int32Array(n);
  const verts: number[] = [];
  const inv = 1 / Math.max(epsilon, 1e-9);
  for (let i = 0; i < n; i++) {
    const v = vGet(mesh, i);
    const k = `${Math.round(v.x * inv)},${Math.round(v.y * inv)},${Math.round(v.z * inv)}`;
    let idx = buckets.get(k);
    if (idx === undefined) {
      idx = verts.length / 3;
      verts.push(v.x, v.y, v.z);
      buckets.set(k, idx);
    }
    remap[i] = idx;
  }
  const faces: { v: number[] }[] = [];
  for (const face of mesh.faces) {
    const nv: number[] = [];
    let prev = -1;
    for (const i of face.v) {
      const r = remap[i]!;
      if (r !== prev) nv.push(r);
      prev = r;
    }
    while (nv.length > 1 && nv[0] === nv[nv.length - 1]) nv.pop();
    if (nv.length >= 3) faces.push({ v: nv });
  }
  return { vertices: verts, faces };
}
