import type { Mesh } from './types.js';

/** Unit cube centered at origin, side length = `size`. */
export function cube(size = 1): Mesh {
  const s = size / 2;
  return {
    vertices: [
      -s, -s, -s,
       s, -s, -s,
       s,  s, -s,
      -s,  s, -s,
      -s, -s,  s,
       s, -s,  s,
       s,  s,  s,
      -s,  s,  s,
    ],
    faces: [
      { v: [0, 1, 2, 3] }, // -Z
      { v: [4, 7, 6, 5] }, // +Z
      { v: [0, 3, 7, 4] }, // -X
      { v: [1, 5, 6, 2] }, // +X
      { v: [3, 2, 6, 7] }, // +Y
      { v: [0, 4, 5, 1] }, // -Y
    ],
  };
}

/** Subdivision-friendly plane on XZ. */
export function plane(size = 1, segments = 1): Mesh {
  const verts: number[] = [];
  const faces: { v: number[] }[] = [];
  const s = size / 2;
  const step = size / segments;
  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      verts.push(-s + i * step, 0, -s + j * step);
    }
  }
  const stride = segments + 1;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride + 1;
      const d = a + stride;
      faces.push({ v: [a, b, c, d] });
    }
  }
  return { vertices: verts, faces };
}

/** UV sphere centered at origin. */
export function sphere(radius = 0.5, segments = 16, rings = 12): Mesh {
  const verts: number[] = [];
  const faces: { v: number[] }[] = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (Math.PI * j) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let i = 0; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;
      verts.push(
        radius * sinPhi * Math.cos(theta),
        radius * cosPhi,
        radius * sinPhi * Math.sin(theta),
      );
    }
  }
  const stride = segments + 1;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride + 1;
      const d = a + stride;
      if (j === 0) {
        faces.push({ v: [a, c, d] });
      } else if (j === rings - 1) {
        faces.push({ v: [a, b, c] });
      } else {
        faces.push({ v: [a, b, c, d] });
      }
    }
  }
  return { vertices: verts, faces };
}

/** Cylinder along Y axis. */
export function cylinder(radius = 0.5, height = 1, segments = 16): Mesh {
  const verts: number[] = [];
  const faces: { v: number[] }[] = [];
  const h = height / 2;
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const c = Math.cos(theta) * radius;
    const s = Math.sin(theta) * radius;
    verts.push(c, -h, s);
    verts.push(c, h, s);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % segments) * 2;
    const d = c + 1;
    faces.push({ v: [a, c, d, b] });
  }
  // bottom cap
  const bottom: number[] = [];
  for (let i = 0; i < segments; i++) bottom.push(i * 2);
  faces.push({ v: bottom.reverse() });
  // top cap
  const top: number[] = [];
  for (let i = 0; i < segments; i++) top.push(i * 2 + 1);
  faces.push({ v: top });
  return { vertices: verts, faces };
}

/** Cone along Y axis. */
export function cone(radius = 0.5, height = 1, segments = 16): Mesh {
  const verts: number[] = [];
  const faces: { v: number[] }[] = [];
  const h = height / 2;
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    verts.push(Math.cos(theta) * radius, -h, Math.sin(theta) * radius);
  }
  const apex = verts.length / 3;
  verts.push(0, h, 0);
  for (let i = 0; i < segments; i++) {
    faces.push({ v: [i, (i + 1) % segments, apex] });
  }
  const base: number[] = [];
  for (let i = 0; i < segments; i++) base.push(i);
  faces.push({ v: base.reverse() });
  return { vertices: verts, faces };
}

/** Torus around Y axis. */
export function torus(radius = 0.5, tube = 0.18, radialSegs = 24, tubularSegs = 12): Mesh {
  const verts: number[] = [];
  const faces: { v: number[] }[] = [];
  for (let j = 0; j < tubularSegs; j++) {
    const v = (j / tubularSegs) * Math.PI * 2;
    for (let i = 0; i < radialSegs; i++) {
      const u = (i / radialSegs) * Math.PI * 2;
      const x = (radius + tube * Math.cos(v)) * Math.cos(u);
      const y = tube * Math.sin(v);
      const z = (radius + tube * Math.cos(v)) * Math.sin(u);
      verts.push(x, y, z);
    }
  }
  for (let j = 0; j < tubularSegs; j++) {
    for (let i = 0; i < radialSegs; i++) {
      const a = j * radialSegs + i;
      const b = j * radialSegs + ((i + 1) % radialSegs);
      const c = ((j + 1) % tubularSegs) * radialSegs + ((i + 1) % radialSegs);
      const d = ((j + 1) % tubularSegs) * radialSegs + i;
      faces.push({ v: [a, b, c, d] });
    }
  }
  return { vertices: verts, faces };
}
