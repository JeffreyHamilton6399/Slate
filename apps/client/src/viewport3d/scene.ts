/**
 * Pure helpers to read the 3D scene out of Y.Doc into plain-JS arrays and
 * to commit primitives / transforms / mesh data back via Yjs transactions.
 *
 * The renderer (R3F components) listens to Y.Doc observers and rebuilds
 * scene snapshots; the commit helpers below are used by tools/panels.
 */

import * as Y from 'yjs';
import {
  materialSchema,
  meshDataSchema,
  object3DSchema,
  type Material,
  type MeshData,
  type Object3D,
  type Object3DType,
  type Transform,
} from '@slate/sync-protocol';
import type { Mesh as MeshTopology } from '@slate/mesh';
import { cube, sphere, cylinder, cone, plane, torus } from '@slate/mesh';
import type { SlateDoc } from '../sync/doc';
import { makeId } from '../utils/id';

export interface SceneSnapshot {
  objects: Object3D[];
  meshes: Map<string, MeshData>;
  materials: Map<string, Material>;
}

export function readSceneSnapshot(slate: SlateDoc): SceneSnapshot {
  const objects: Object3D[] = [];
  slate.scene3dObjects().forEach((m, id) => {
    const o = readObject(m, id);
    if (o) objects.push(o);
  });
  objects.sort((a, b) => a.name.localeCompare(b.name));

  const meshes = new Map<string, MeshData>();
  slate.scene3dMeshes().forEach((m, id) => {
    const md = readMesh(m, id);
    if (md) meshes.set(md.id, md);
  });

  const materials = new Map<string, Material>();
  slate.scene3dMaterials().forEach((m, id) => {
    const mat = readMaterial(m, id);
    if (mat) materials.set(mat.id, mat);
  });

  return { objects, meshes, materials };
}

export function readObject(m: Y.Map<unknown>, id: string): Object3D | null {
  const candidate = {
    id: m.get('id') ?? id,
    parentId: m.get('parentId') ?? null,
    type: m.get('type'),
    name: m.get('name'),
    visible: m.get('visible'),
    transform: m.get('transform'),
    meshId: m.get('meshId') ?? null,
    materialId: m.get('materialId') ?? null,
    collapsed: m.get('collapsed'),
    smooth: m.get('smooth'),
  };
  const parsed = object3DSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function readMesh(m: Y.Map<unknown>, id: string): MeshData | null {
  const candidate = {
    id: m.get('id') ?? id,
    vertices: m.get('vertices'),
    faces: m.get('faces'),
  };
  const parsed = meshDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function readMaterial(m: Y.Map<unknown>, id: string): Material | null {
  const candidate = {
    id: m.get('id') ?? id,
    kind: m.get('kind') ?? 'pbr',
    color: m.get('color'),
    metalness: m.get('metalness'),
    roughness: m.get('roughness'),
    emissive: m.get('emissive') ?? '#000000',
    emissiveIntensity: m.get('emissiveIntensity') ?? 0,
    opacity: m.get('opacity'),
  };
  const parsed = materialSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ── Commit helpers ──────────────────────────────────────────────────────────
export function defaultMaterial(): Material {
  return {
    id: makeId('mat'),
    kind: 'pbr',
    color: '#7c6aff',
    metalness: 0,
    roughness: 0.5,
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: 1,
  };
}

export function ensureDefaultMaterial(slate: SlateDoc): string {
  let foundId: string | null = null;
  slate.scene3dMaterials().forEach((_, id) => {
    if (foundId === null) foundId = id;
  });
  if (foundId) return foundId;
  const def = defaultMaterial();
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(def)) m.set(k, v);
  slate.scene3dMaterials().set(def.id, m);
  return def.id;
}

const PRIMITIVE_BUILDERS: Record<
  Exclude<Object3DType, 'folder' | 'mesh' | 'empty'>,
  () => MeshTopology
> = {
  cube: () => cube(1),
  sphere: () => sphere(0.6),
  cylinder: () => cylinder(0.5, 1.2),
  cone: () => cone(0.6, 1.2),
  plane: () => plane(1.5, 1),
  torus: () => torus(0.5, 0.18),
};

export interface AddPrimitiveOptions {
  type: Exclude<Object3DType, 'folder' | 'mesh' | 'empty'>;
  position?: Transform['position'];
}

/** Add a primitive at world origin (or specified position) and return its id. */
export function addPrimitive(
  slate: SlateDoc,
  opts: AddPrimitiveOptions,
): { id: string; meshId: string; materialId: string } {
  const id = makeId('obj');
  const meshId = makeId('mesh');
  const materialId = ensureDefaultMaterial(slate);
  const topology = PRIMITIVE_BUILDERS[opts.type]();
  const meshData: MeshData = {
    id: meshId,
    vertices: topology.vertices.slice(),
    faces: topology.faces.map((f) => ({ v: f.v.slice() })),
  };
  const obj: Object3D = {
    id,
    parentId: null,
    type: opts.type,
    name: capitalize(opts.type),
    visible: true,
    transform: {
      position: opts.position ?? { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    meshId,
    materialId,
  };
  slate.doc.transact(() => {
    const ym = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(meshData)) ym.set(k, v);
    slate.scene3dMeshes().set(meshId, ym);
    const yo = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(obj)) yo.set(k, v);
    slate.scene3dObjects().set(id, yo);
  });
  return { id, meshId, materialId };
}

export function deleteObjects(slate: SlateDoc, ids: Iterable<string>): void {
  slate.doc.transact(() => {
    const objs = slate.scene3dObjects();
    const meshes = slate.scene3dMeshes();
    for (const id of ids) {
      const yo = objs.get(id);
      if (!yo) continue;
      const meshId = yo.get('meshId') as string | null;
      if (meshId) meshes.delete(meshId);
      objs.delete(id);
    }
  });
}

export function setTransform(
  slate: SlateDoc,
  id: string,
  patch: Partial<Transform>,
): void {
  const yo = slate.scene3dObjects().get(id);
  if (!yo) return;
  const cur = yo.get('transform') as Transform | undefined;
  if (!cur) return;
  const next: Transform = {
    position: { ...cur.position, ...(patch.position ?? {}) },
    rotation: { ...cur.rotation, ...(patch.rotation ?? {}) },
    scale: { ...cur.scale, ...(patch.scale ?? {}) },
  };
  yo.set('transform', next);
}

export function setMeshData(slate: SlateDoc, meshId: string, data: MeshTopology): void {
  const m = slate.scene3dMeshes().get(meshId);
  if (!m) return;
  slate.doc.transact(() => {
    m.set('vertices', data.vertices.slice());
    m.set(
      'faces',
      data.faces.map((f) => ({ v: f.v.slice() })),
    );
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
