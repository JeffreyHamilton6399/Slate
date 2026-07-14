export interface MeshFace {
  /** Vertex indices forming the face. Can be a tri or n-gon. */
  v: number[];
}

export interface Mesh {
  /** Interleaved [x,y,z,...]. */
  vertices: number[];
  faces: MeshFace[];
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vGet(mesh: Mesh, i: number): Vec3 {
  return {
    x: mesh.vertices[i * 3]!,
    y: mesh.vertices[i * 3 + 1]!,
    z: mesh.vertices[i * 3 + 2]!,
  };
}

export function vSet(mesh: Mesh, i: number, v: Vec3): void {
  mesh.vertices[i * 3] = v.x;
  mesh.vertices[i * 3 + 1] = v.y;
  mesh.vertices[i * 3 + 2] = v.z;
}

export function vCount(mesh: Mesh): number {
  return Math.floor(mesh.vertices.length / 3);
}

export function vAdd(mesh: Mesh, v: Vec3): number {
  const i = vCount(mesh);
  mesh.vertices.push(v.x, v.y, v.z);
  return i;
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function faceCentroid(mesh: Mesh, face: MeshFace): Vec3 {
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const i of face.v) {
    const v = vGet(mesh, i);
    cx += v.x;
    cy += v.y;
    cz += v.z;
  }
  const n = face.v.length || 1;
  return { x: cx / n, y: cy / n, z: cz / n };
}

export function faceNormal(mesh: Mesh, face: MeshFace): Vec3 {
  if (face.v.length < 3) return { x: 0, y: 0, z: 1 };
  const a = vGet(mesh, face.v[0]!);
  const b = vGet(mesh, face.v[1]!);
  const c = vGet(mesh, face.v[2]!);
  return normalize(cross(sub(b, a), sub(c, a)));
}

export function cloneMesh(mesh: Mesh): Mesh {
  return {
    vertices: mesh.vertices.slice(),
    faces: mesh.faces.map((f) => ({ v: f.v.slice() })),
  };
}

export function emptyMesh(): Mesh {
  return { vertices: [], faces: [] };
}
