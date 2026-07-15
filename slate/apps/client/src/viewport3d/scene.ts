/**
 * Pure helpers to read the 3D scene out of Y.Doc into plain-JS arrays and
 * to commit primitives / transforms / mesh data back via Yjs transactions.
 *
 * The renderer (R3F components) listens to Y.Doc observers and rebuilds
 * scene snapshots; the commit helpers below are used by tools/panels.
 */

import * as Y from 'yjs';
import * as THREE from 'three';
import {
  materialSchema,
  meshDataSchema,
  object3DSchema,
  type LightData,
  type LightKind,
  type Material,
  type MeshData,
  type Object3D,
  type Object3DType,
  type Transform,
} from '@slate/sync-protocol';
import type { Mesh as MeshTopology } from '@slate/mesh';
import { cube, sphere, cylinder, cone, plane, torus, joinMeshes, mirrorMesh } from '@slate/mesh';
import type { SlateDoc } from '../sync/doc';
import { makeId } from '../utils/id';
import { withKey, withoutKey, sampleAnim } from './animation';

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
    light: m.get('light'),
    camera: m.get('camera'),
    anim: m.get('anim'),
  };
  const parsed = object3DSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Validating a mesh (thousands of vertices) with zod is expensive, and the
// snapshot is rebuilt on EVERY scene change — including 30 Hz transform-gizmo
// commits that never touch mesh data. Cache the parsed result per Y.Map and
// reuse it while the underlying vertices/faces arrays are the same reference
// (Yjs hands back a stable reference until the field is re-set). This makes
// object drags skip full-scene mesh revalidation, killing the gizmo lag.
const meshParseCache = new WeakMap<
  Y.Map<unknown>,
  { v: unknown; f: unknown; parsed: MeshData | null }
>();

export function readMesh(m: Y.Map<unknown>, id: string): MeshData | null {
  const v = m.get('vertices');
  const f = m.get('faces');
  const cached = meshParseCache.get(m);
  if (cached && cached.v === v && cached.f === f) return cached.parsed;
  const parsed = meshDataSchema.safeParse({ id: m.get('id') ?? id, vertices: v, faces: f });
  const result = parsed.success ? parsed.data : null;
  meshParseCache.set(m, { v, f, parsed: result });
  return result;
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
    texture: m.get('texture'),
  };
  const parsed = materialSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ── Commit helpers ──────────────────────────────────────────────────────────

export function defaultMaterial(): Material {
  return {
    id: makeId('mat'),
    kind: 'pbr',
    // Default material color is white so new objects read as neutral clay
    // (Blender's default), taking their color from lighting + the accent grid.
    color: '#ffffff',
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
  Exclude<Object3DType, 'folder' | 'mesh' | 'empty' | 'light' | 'camera'>,
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
  type: Exclude<Object3DType, 'folder' | 'mesh' | 'empty' | 'light' | 'camera'>;
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

// Point/spot use physically-correct inverse-square falloff, so intensities
// need to be high enough to survive a few units of distance.
const LIGHT_DEFAULTS: Record<LightKind, LightData> = {
  point: { kind: 'point', color: '#ffffff', intensity: 60, distance: 0, angle: 0 },
  sun: { kind: 'sun', color: '#fff4e0', intensity: 3.2, distance: 0, angle: 0 },
  spot: { kind: 'spot', color: '#ffffff', intensity: 80, distance: 0, angle: Math.PI / 6 },
  // Sky/ground ambient fill — no position needed, but we give it height.
  hemisphere: { kind: 'hemisphere', color: '#bcd4ff', intensity: 2.4, distance: 0, angle: 0 },
  // Soft rectangular panel (RectAreaLight) — angle stores the half-size.
  area: { kind: 'area', color: '#ffffff', intensity: 25, distance: 0, angle: 1 },
};

/**
 * Rotation that aims a light's local -Y axis from `from` toward `to`, so a
 * freshly added sun/spot already illuminates the scene center. After that
 * the light's own rotation (R / properties panel) steers it, like Blender.
 */
function aimRotation(from: Transform['position'], to = { x: 0, y: 0, z: 0 }) {
  const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
  if (dir.lengthSq() < 1e-6) return { x: 0, y: 0, z: 0 };
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, -1, 0),
    dir.normalize(),
  );
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { x: e.x, y: e.y, z: e.z };
}

/** Add a light. Sun and spot lights shine along their rotated -Y axis. */
export function addLight(
  slate: SlateDoc,
  kind: LightKind,
  position?: Transform['position'],
): { id: string } {
  const id = makeId('obj');
  const pos = position ?? { x: 2, y: 3, z: 2 };
  const obj: Object3D = {
    id,
    parentId: null,
    type: 'light',
    name: `${capitalize(kind)} Light`,
    visible: true,
    transform: {
      position: pos,
      // Point + hemisphere are omni/world-oriented, so no aim needed.
      rotation:
        kind === 'point' || kind === 'hemisphere' ? { x: 0, y: 0, z: 0 } : aimRotation(pos),
      scale: { x: 1, y: 1, z: 1 },
    },
    meshId: null,
    materialId: null,
    light: { ...LIGHT_DEFAULTS[kind] },
  };
  slate.doc.transact(() => {
    const yo = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(obj)) yo.set(k, v);
    slate.scene3dObjects().set(id, yo);
  });
  return { id };
}

/** Add a scene camera, pre-aimed at the origin (looks along local -Y). */
export function addCamera(
  slate: SlateDoc,
  position?: Transform['position'],
): { id: string } {
  const id = makeId('obj');
  const pos = position ?? { x: 5, y: 4, z: 5 };
  const obj: Object3D = {
    id,
    parentId: null,
    type: 'camera',
    name: 'Camera',
    visible: true,
    transform: {
      position: pos,
      rotation: aimRotation(pos),
      scale: { x: 1, y: 1, z: 1 },
    },
    meshId: null,
    materialId: null,
    camera: { fov: 50 },
  };
  slate.doc.transact(() => {
    const yo = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(obj)) yo.set(k, v);
    slate.scene3dObjects().set(id, yo);
  });
  return { id };
}

/** Add an empty (null object) — a transform-only marker, like Blender's Empty. */
export function addEmpty(slate: SlateDoc, position?: Transform['position']): { id: string } {
  const id = makeId('obj');
  const obj: Object3D = {
    id,
    parentId: null,
    type: 'empty',
    name: 'Empty',
    visible: true,
    transform: {
      position: position ?? { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    meshId: null,
    materialId: null,
  };
  slate.doc.transact(() => {
    const yo = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(obj)) yo.set(k, v);
    slate.scene3dObjects().set(id, yo);
  });
  return { id };
}

/** Patch a light object's parameters. */
export function editObjectLight(slate: SlateDoc, objectId: string, patch: Partial<LightData>): void {
  const yo = slate.scene3dObjects().get(objectId);
  if (!yo) return;
  const cur = (yo.get('light') as LightData | undefined) ?? LIGHT_DEFAULTS.point;
  yo.set('light', { ...cur, ...patch });
}

/**
 * Duplicate objects (own copies of their mesh data too, so deleting one
 * never breaks the other). Returns the new object ids.
 */
export function duplicateObjects(slate: SlateDoc, ids: Iterable<string>): string[] {
  const newIds: string[] = [];
  slate.doc.transact(() => {
    const objs = slate.scene3dObjects();
    const meshes = slate.scene3dMeshes();
    for (const id of ids) {
      const yo = objs.get(id);
      if (!yo) continue;
      const src = readObject(yo, id);
      if (!src) continue;
      let meshId: string | null = null;
      if (src.meshId) {
        const ym = meshes.get(src.meshId);
        const srcMesh = ym ? readMesh(ym, src.meshId) : null;
        if (srcMesh) {
          meshId = makeId('mesh');
          const copy = new Y.Map<unknown>();
          copy.set('id', meshId);
          copy.set('vertices', srcMesh.vertices.slice());
          copy.set(
            'faces',
            srcMesh.faces.map((f) => ({ v: f.v.slice() })),
          );
          meshes.set(meshId, copy);
        }
      }
      const newId = makeId('obj');
      const dup: Object3D = {
        ...src,
        id: newId,
        name: `${src.name} Copy`,
        meshId,
        transform: {
          position: { ...src.transform.position },
          rotation: { ...src.transform.rotation },
          scale: { ...src.transform.scale },
        },
      };
      const target = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(dup)) target.set(k, v);
      objs.set(newId, target);
      newIds.push(newId);
    }
  });
  return newIds;
}

/** Bake an object's transform into its mesh vertices (world space). */
function bakeVertices(mesh: MeshData, t: Transform): number[] {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(t.position.x, t.position.y, t.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z)),
    new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
  );
  const out: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    p.set(mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!).applyMatrix4(m);
    out.push(p.x, p.y, p.z);
  }
  return out;
}

/**
 * Join objects into one (Blender Ctrl+J): every mesh is baked to world space
 * and merged into the first id; the others are deleted. Returns the joined
 * object's id, or null when fewer than two mesh objects were given.
 */
export function joinObjects(slate: SlateDoc, ids: string[]): string | null {
  const objs = slate.scene3dObjects();
  const meshesMap = slate.scene3dMeshes();
  const parts: { id: string; meshId: string; baked: MeshTopology }[] = [];
  for (const id of ids) {
    const yo = objs.get(id);
    const obj = yo ? readObject(yo, id) : null;
    if (!obj?.meshId) continue;
    const ym = meshesMap.get(obj.meshId);
    const mesh = ym ? readMesh(ym, obj.meshId) : null;
    if (!mesh) continue;
    parts.push({
      id,
      meshId: obj.meshId,
      baked: { vertices: bakeVertices(mesh, obj.transform), faces: mesh.faces.map((f) => ({ v: f.v.slice() })) },
    });
  }
  if (parts.length < 2) return null;
  const combined = parts.map((p) => p.baked).reduce((a, b) => joinMeshes(a, b));
  const first = parts[0]!;
  slate.doc.transact(() => {
    setMeshData(slate, first.meshId, combined);
    // The verts are world-space now; the survivor sits at the identity.
    setTransform(slate, first.id, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    for (const p of parts.slice(1)) {
      meshesMap.delete(p.meshId);
      objs.delete(p.id);
    }
  });
  return first.id;
}

/** Mirror each object's mesh across a local axis (winding kept outward). */
export function mirrorObjects(slate: SlateDoc, ids: Iterable<string>, axis: 'x' | 'y' | 'z'): void {
  const objs = slate.scene3dObjects();
  const meshesMap = slate.scene3dMeshes();
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = objs.get(id);
      const meshId = yo?.get('meshId') as string | null | undefined;
      if (!meshId) continue;
      const ym = meshesMap.get(meshId);
      const mesh = ym ? readMesh(ym, meshId) : null;
      if (!mesh) continue;
      setMeshData(slate, meshId, mirrorMesh({ vertices: mesh.vertices, faces: mesh.faces }, axis));
    }
  });
}

/** Drop objects so their lowest point rests on the ground plane (y = 0). */
export function dropToFloor(slate: SlateDoc, ids: Iterable<string>): void {
  const objs = slate.scene3dObjects();
  const meshesMap = slate.scene3dMeshes();
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = objs.get(id);
      const obj = yo ? readObject(yo, id) : null;
      if (!obj?.meshId) continue;
      const ym = meshesMap.get(obj.meshId);
      const mesh = ym ? readMesh(ym, obj.meshId) : null;
      if (!mesh || mesh.vertices.length === 0) continue;
      const world = bakeVertices(mesh, obj.transform);
      let minY = Infinity;
      for (let i = 1; i < world.length; i += 3) minY = Math.min(minY, world[i]!);
      if (!Number.isFinite(minY) || Math.abs(minY) < 1e-9) continue;
      setTransform(slate, id, { position: { ...obj.transform.position, y: obj.transform.position.y - minY } });
    }
  });
}

/** Reset selected objects to the identity transform — location 0, rotation 0,
 *  scale 1 (Blender's Alt+G / Alt+R / Alt+S rolled into one button). */
export function resetTransform(slate: SlateDoc, ids: Iterable<string>): void {
  slate.doc.transact(() => {
    for (const id of ids) {
      setTransform(slate, id, {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
    }
  });
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

/** Auto-key (Blender's Auto Keying): after transforming an object that is
 *  ALREADY animated, record its new pose at the playhead so scrubbing/playback
 *  reflects the edit instead of snapping back to the nearest existing key.
 *  Objects with no keyframes are left untouched — animation only starts once
 *  you insert the first key by hand. Returns how many objects were keyed. */
export function autoKeyframe(slate: SlateDoc, ids: Iterable<string>, t: number): number {
  const objs = slate.scene3dObjects();
  let keyed = 0;
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = objs.get(id);
      const obj = yo ? readObject(yo, id) : null;
      if (!yo || !obj || (obj.anim?.length ?? 0) === 0) continue;
      // Use the SAMPLED transform at time t (what the user sees), not the
      // base transform — otherwise keyframing at a scrubbed position stores
      // the wrong pose. If sampling returns null (t outside track), use base.
      const sampled = sampleAnim(obj.anim, t);
      const transform = sampled ?? obj.transform;
      yo.set('anim', withKey(obj.anim, t, transform));
      keyed++;
    }
  });
  return keyed;
}

/** Key the object's CURRENT transform at time `t` (Blender's I). */
export function insertKeyframe(slate: SlateDoc, ids: Iterable<string>, t: number): number {
  const objs = slate.scene3dObjects();
  let keyed = 0;
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = objs.get(id);
      const obj = yo ? readObject(yo, id) : null;
      if (!yo || !obj) continue;
      // Use the SAMPLED transform at time t (what the user sees), not the
      // base transform — so keyframing at a scrubbed position captures the
      // visible pose. If no animation yet, use the base transform.
      const sampled = obj.anim && obj.anim.length > 0 ? sampleAnim(obj.anim, t) : null;
      const transform = sampled ?? obj.transform;
      yo.set('anim', withKey(obj.anim, t, transform));
      keyed++;
    }
  });
  return keyed;
}

/** Remove the keyframe nearest `t` on each object (within tolerance). */
export function deleteKeyframe(slate: SlateDoc, ids: Iterable<string>, t: number): void {
  const objs = slate.scene3dObjects();
  slate.doc.transact(() => {
    for (const id of ids) {
      const yo = objs.get(id);
      const obj = yo ? readObject(yo, id) : null;
      if (!yo || !obj?.anim?.length) continue;
      const next = withoutKey(obj.anim, t);
      if (next.length === 0) yo.delete('anim');
      else if (next !== obj.anim) yo.set('anim', next);
    }
  });
}

/** Retime the keyframe nearest `fromT` to `toT` (drag to move a key, Blender-style).
 *  `fromT` is the key's CURRENT time (updated each drag tick by the caller) so
 *  the key can be tracked across the whole drag, not just the first move. */
export function moveKeyframe(
  slate: SlateDoc,
  id: string,
  fromT: number,
  toT: number,
): void {
  const objs = slate.scene3dObjects();
  const yo = objs.get(id);
  const obj = yo ? readObject(yo, id) : null;
  if (!yo || !obj?.anim?.length) return;
  // Find the nearest key to fromT — use a generous tolerance so the key stays
  // grabbable across the whole drag (the key moves with the cursor each tick).
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < obj.anim.length; i++) {
    const d = Math.abs(obj.anim[i]!.t - fromT);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  // Only move if we found a key reasonably close (avoids grabbing a distant
  // key on a stray event).
  if (bestIdx < 0 || bestDist > 1.0) return;
  const key = obj.anim[bestIdx]!;
  // No-op if the key is already at the target time.
  if (Math.abs(key.t - Math.max(0, toT)) < 1e-4) return;
  const next = obj.anim.filter((_, i) => i !== bestIdx);
  next.push({ t: Math.max(0, toT), transform: key.transform });
  next.sort((a, b) => a.t - b.t);
  slate.doc.transact(() => {
    yo.set('anim', next);
  });
}

/** Delete objects plus all their descendants (folders), including mesh data. */
export function deleteObjectsWithChildren(slate: SlateDoc, rootIds: Iterable<string>): void {
  const objs = slate.scene3dObjects();
  const doomed = new Set<string>(rootIds);
  // Fixed-point sweep: keep absorbing children of doomed parents.
  let grew = true;
  while (grew) {
    grew = false;
    objs.forEach((m, id) => {
      if (doomed.has(id)) return;
      const pid = m.get('parentId') as string | null;
      if (pid && doomed.has(pid)) {
        doomed.add(id);
        grew = true;
      }
    });
  }
  deleteObjects(slate, doomed);
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
  // Wrap in a transaction so the Y.UndoManager treats this as one undoable
  // op (gizmo drags commit at ~30Hz inside one transact → one undo step).
  slate.doc.transact(() => {
    yo.set('transform', next);
  });
}

/**
 * Edit an object's material. New primitives share one default material, so a
 * naive write would recolor every object that references it. This forks the
 * material into a private copy the first time a *shared* material is edited
 * (copy-on-write), then applies the patch.
 */
export function editObjectMaterial(
  slate: SlateDoc,
  objectId: string,
  patch: Partial<Omit<Material, 'id' | 'kind'>>,
): void {
  slate.doc.transact(() => {
    const objs = slate.scene3dObjects();
    const mats = slate.scene3dMaterials();
    const yo = objs.get(objectId);
    if (!yo) return;
    let matId = yo.get('materialId') as string | null;

    // Count how many objects reference this material.
    let refs = 0;
    if (matId) objs.forEach((m) => { if ((m.get('materialId') as string | null) === matId) refs++; });

    const existing = matId ? mats.get(matId) : undefined;
    const needsFork = !existing || refs > 1;
    if (needsFork) {
      const src = existing ? readMaterial(existing, matId!) : null;
      const base = src ?? defaultMaterial();
      const newId = makeId('mat');
      const copy: Material = { ...base, ...patch, id: newId, kind: 'pbr' };
      const nm = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(copy)) nm.set(k, v);
      mats.set(newId, nm);
      yo.set('materialId', newId);
      matId = newId;
      return;
    }

    const nm = mats.get(matId!);
    if (!nm) return;
    for (const [k, v] of Object.entries(patch)) nm.set(k, v);
  });
}

/**
 * Instantiate a library asset (from slate.assets()) into the scene at an
 * optional world position. Mesh assets become a new object; material assets
 * apply to the given selection. Returns the new object id (mesh) or null.
 */
export function instantiateAsset(
  slate: SlateDoc,
  assetId: string,
  opts: { position?: Transform['position']; selection?: string[] } = {},
): string | null {
  const asset = slate.assets().get(assetId);
  if (!asset) return null;
  const kind = asset.get('kind');

  if (kind === 'mesh') {
    const mesh = asset.get('mesh') as { vertices: number[]; faces: { v: number[] }[] } | undefined;
    if (!mesh) return null;
    const meshId = makeId('mesh');
    const objId = makeId('obj');
    slate.doc.transact(() => {
      const ym = new Y.Map<unknown>();
      ym.set('id', meshId);
      ym.set('vertices', mesh.vertices.slice());
      ym.set('faces', mesh.faces.map((f) => ({ v: f.v.slice() })));
      slate.scene3dMeshes().set(meshId, ym);
      const obj: Object3D = {
        id: objId,
        parentId: null,
        type: 'mesh',
        name: (asset.get('name') as string) ?? 'Asset',
        visible: true,
        transform: {
          position: opts.position ?? { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        meshId,
        materialId: null,
      };
      const yo = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(obj)) yo.set(k, v);
      slate.scene3dObjects().set(objId, yo);
    });
    return objId;
  }

  if (kind === 'material') {
    const mat = asset.get('material') as Material | undefined;
    const targets = opts.selection ?? [];
    if (!mat || targets.length === 0) return null;
    const matId = makeId('mat');
    slate.doc.transact(() => {
      const nm = new Y.Map<unknown>();
      for (const [k, v] of Object.entries({ ...mat, id: matId })) nm.set(k, v);
      slate.scene3dMaterials().set(matId, nm);
      for (const id of targets) {
        const yo = slate.scene3dObjects().get(id);
        if (yo && yo.get('meshId')) yo.set('materialId', matId);
      }
    });
    return null;
  }
  return null;
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
