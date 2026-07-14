/**
 * 3D scene export.
 *
 *   GLTF / GLB → THREE.GLTFExporter
 *   OBJ        → text writer (positions + faces, transforms baked)
 *   STL        → binary STL with transforms baked
 *   PLY        → ASCII PLY (positions + faces)
 *   FBX        → @slate/fbx-export (clean rewrite of v1)
 *
 * Each exporter receives the live Slate scene + the active material list
 * and returns a Blob suitable for downloading.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { exportFbxAscii } from '@slate/fbx-export';
import { triangulateFace } from '@slate/mesh';
import type { Material, MeshData, Object3D } from '@slate/sync-protocol';

export type ThreeDFormat = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply' | 'fbx';

export interface Export3DInput {
  objects: Object3D[];
  meshes: Map<string, MeshData>;
  materials: Map<string, Material>;
  boardName: string;
}

export async function export3D(format: ThreeDFormat, input: Export3DInput): Promise<Blob> {
  switch (format) {
    case 'gltf':
      return blobFromText(await exportGltf(input, false), 'application/json');
    case 'glb':
      return await exportGltfBinary(input);
    case 'obj':
      return blobFromText(exportObj(input), 'text/plain');
    case 'stl':
      return new Blob([exportStl(input)], { type: 'application/octet-stream' });
    case 'ply':
      return blobFromText(exportPly(input), 'text/plain');
    case 'fbx':
      return blobFromText(
        exportFbxAscii({
          objects: input.objects,
          meshes: mapToRecord(input.meshes),
          materials: mapToRecord(input.materials),
          creator: 'Slate',
        }),
        'application/octet-stream',
      );
  }
}

function blobFromText(s: string, type: string): Blob {
  return new Blob([s], { type });
}

function mapToRecord<V>(m: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  m.forEach((v, k) => (out[k] = v));
  return out;
}

// ── Building a transient Three scene shared by GLTF / GLB ──────────────────
function buildThreeScene(input: Export3DInput): THREE.Scene {
  const scene = new THREE.Scene();
  for (const obj of input.objects) {
    if (!obj.visible || obj.type === 'folder' || obj.type === 'empty') continue;
    const mesh = obj.meshId ? input.meshes.get(obj.meshId) : undefined;
    if (!mesh) continue;
    const g = new THREE.BufferGeometry();
    const tris: number[] = [];
    for (const face of mesh.faces) for (const t of triangulateFace(face)) tris.push(...t.v);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3));
    g.setIndex(tris);
    g.computeVertexNormals();
    const mat = obj.materialId ? input.materials.get(obj.materialId) : undefined;
    const material = new THREE.MeshStandardMaterial({
      color: mat?.color ?? '#7c6aff',
      metalness: mat?.metalness ?? 0,
      roughness: mat?.roughness ?? 0.5,
      opacity: mat?.opacity ?? 1,
      transparent: (mat?.opacity ?? 1) < 1,
    });
    const m = new THREE.Mesh(g, material);
    m.name = obj.name;
    m.position.set(obj.transform.position.x, obj.transform.position.y, obj.transform.position.z);
    m.rotation.set(obj.transform.rotation.x, obj.transform.rotation.y, obj.transform.rotation.z);
    m.scale.set(obj.transform.scale.x, obj.transform.scale.y, obj.transform.scale.z);
    scene.add(m);
  }
  return scene;
}

async function exportGltf(input: Export3DInput, binary: boolean): Promise<string> {
  const scene = buildThreeScene(input);
  const exporter = new GLTFExporter();
  return await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (binary) resolve('');
        else resolve(JSON.stringify(result, null, 2));
      },
      (err) => reject(err),
      { binary, embedImages: false },
    );
  });
}

async function exportGltfBinary(input: Export3DInput): Promise<Blob> {
  const scene = buildThreeScene(input);
  const exporter = new GLTFExporter();
  return await new Promise<Blob>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(new Blob([result], { type: 'model/gltf-binary' }));
        else reject(new Error('glb export returned non-binary'));
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

function exportObj(input: Export3DInput): string {
  const lines: string[] = [`# ${input.boardName} — exported by Slate`];
  let vertOffset = 1;
  for (const obj of input.objects) {
    if (!obj.visible || obj.type === 'folder' || obj.type === 'empty') continue;
    const mesh = obj.meshId ? input.meshes.get(obj.meshId) : undefined;
    if (!mesh) continue;
    lines.push(`o ${sanitize(obj.name)}`);
    const transformed = bakeTransform(mesh, obj);
    for (let i = 0; i < transformed.length; i += 3) {
      lines.push(`v ${fmt(transformed[i]!)} ${fmt(transformed[i + 1]!)} ${fmt(transformed[i + 2]!)}`);
    }
    for (const face of mesh.faces) {
      lines.push(`f ${face.v.map((i) => i + vertOffset).join(' ')}`);
    }
    vertOffset += transformed.length / 3;
  }
  return lines.join('\n');
}

function exportPly(input: Export3DInput): string {
  // Flatten everything into one mesh.
  let verts: number[] = [];
  const faces: number[][] = [];
  for (const obj of input.objects) {
    if (!obj.visible || obj.type === 'folder' || obj.type === 'empty') continue;
    const mesh = obj.meshId ? input.meshes.get(obj.meshId) : undefined;
    if (!mesh) continue;
    const baseIdx = verts.length / 3;
    verts = verts.concat(bakeTransform(mesh, obj));
    for (const face of mesh.faces) faces.push(face.v.map((i) => i + baseIdx));
  }
  const lines = [
    'ply',
    'format ascii 1.0',
    `comment ${input.boardName} — exported by Slate`,
    `element vertex ${verts.length / 3}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
  ];
  for (let i = 0; i < verts.length; i += 3) {
    lines.push(`${fmt(verts[i]!)} ${fmt(verts[i + 1]!)} ${fmt(verts[i + 2]!)}`);
  }
  for (const f of faces) lines.push(`${f.length} ${f.join(' ')}`);
  return lines.join('\n');
}

function exportStl(input: Export3DInput): ArrayBuffer {
  // Binary STL. Header (80 bytes) + tri count (uint32) + tris (50 bytes each).
  const triangles: { a: [number, number, number]; b: [number, number, number]; c: [number, number, number] }[] = [];
  for (const obj of input.objects) {
    if (!obj.visible || obj.type === 'folder' || obj.type === 'empty') continue;
    const mesh = obj.meshId ? input.meshes.get(obj.meshId) : undefined;
    if (!mesh) continue;
    const v = bakeTransform(mesh, obj);
    for (const face of mesh.faces) {
      for (const t of triangulateFace(face)) {
        triangles.push({
          a: [v[t.v[0]! * 3]!, v[t.v[0]! * 3 + 1]!, v[t.v[0]! * 3 + 2]!],
          b: [v[t.v[1]! * 3]!, v[t.v[1]! * 3 + 1]!, v[t.v[1]! * 3 + 2]!],
          c: [v[t.v[2]! * 3]!, v[t.v[2]! * 3 + 1]!, v[t.v[2]! * 3 + 2]!],
        });
      }
    }
  }
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, triangles.length, true);
  let off = 84;
  for (const t of triangles) {
    const ux = t.b[0] - t.a[0],
      uy = t.b[1] - t.a[1],
      uz = t.b[2] - t.a[2];
    const vx = t.c[0] - t.a[0],
      vy = t.c[1] - t.a[1],
      vz = t.c[2] - t.a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    dv.setFloat32(off, nx, true);
    dv.setFloat32(off + 4, ny, true);
    dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (const p of [t.a, t.b, t.c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buffer;
}

function bakeTransform(mesh: MeshData, obj: Object3D): number[] {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(obj.transform.rotation.x, obj.transform.rotation.y, obj.transform.rotation.z),
  );
  m.compose(
    new THREE.Vector3(obj.transform.position.x, obj.transform.position.y, obj.transform.position.z),
    q,
    new THREE.Vector3(obj.transform.scale.x, obj.transform.scale.y, obj.transform.scale.z),
  );
  const v: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const p = new THREE.Vector3(mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!);
    p.applyMatrix4(m);
    v.push(p.x, p.y, p.z);
  }
  return v;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : '0.000000';
}

function sanitize(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
}
