/**
 * Import a 3D model file (.obj / .stl / .ply / .gltf / .glb / .fbx) into
 * the current Slate scene. Uses Three.js loaders for parity with common
 * tools; flattens each loaded mesh into a Slate Object3D + MeshData.
 *
 * Unlike v1's importer this preserves per-mesh transforms by reading
 * `position` / `quaternion` / `scale` from the loader output instead of
 * baking matrixWorld into vertices.
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as Y from 'yjs';
import type { Object3D as SlateObject3D, MeshData, Material } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { ensureDefaultMaterial } from '../viewport3d/scene';
import { makeId } from '../utils/id';

export interface ParsedMesh {
  name: string;
  vertices: number[];
  faces: { v: number[] }[];
  color: string | null;
}

/** Parse a model file into plain mesh data without touching the doc — used by
 *  both the scene importer and the Assets library drop. */
export async function parseModel(file: File): Promise<ParsedMesh[]> {
  const group = await loadModelGroup(file);
  const out: ParsedMesh[] = [];
  group.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const geom = mesh.geometry instanceof THREE.BufferGeometry ? mesh.geometry : null;
    const pos = geom?.getAttribute('position');
    if (!geom || !pos) return;
    const vertices: number[] = [];
    for (let i = 0; i < pos.count; i++) vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    const idx = geom.getIndex();
    const faces: { v: number[] }[] = [];
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) faces.push({ v: [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] });
    } else {
      for (let i = 0; i < pos.count; i += 3) faces.push({ v: [i, i + 1, i + 2] });
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
    out.push({
      name: (mesh.name || child.name || 'Imported').slice(0, 60),
      vertices,
      faces,
      color: c ? `#${c.getHexString()}` : null,
    });
  });
  return out;
}

async function loadModelGroup(file: File): Promise<THREE.Object3D> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const buffer = await file.arrayBuffer();
  let group: THREE.Object3D;
  switch (ext) {
    case 'obj': {
      const txt = new TextDecoder().decode(buffer);
      group = new OBJLoader().parse(txt);
      break;
    }
    case 'stl': {
      const geom = new STLLoader().parse(buffer);
      group = new THREE.Mesh(geom);
      break;
    }
    case 'ply': {
      const geom = new PLYLoader().parse(buffer);
      group = new THREE.Mesh(geom);
      break;
    }
    case 'gltf':
    case 'glb': {
      const loader = new GLTFLoader();
      const data = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(
          buffer,
          '',
          (result) => resolve(result as unknown as { scene: THREE.Group }),
          (err) => reject(err),
        );
      });
      group = data.scene;
      break;
    }
    case 'fbx': {
      group = new FBXLoader().parse(buffer, '');
      break;
    }
    default:
      throw new Error(`unsupported 3D format .${ext}`);
  }
  return group;
}

/** Target world size (largest dimension) for a freshly imported model, so a
 *  file in mm, cm, or arbitrary units always lands at a visible, workable
 *  size centered on the origin — like dropping an asset into a Unity scene. */
const IMPORT_TARGET_SIZE = 2.5;

interface Normalization {
  scale: number;
  center: THREE.Vector3;
}

/** Import a model file into the current scene. Returns the ids of the newly
 *  created scene objects so callers can select + frame them (so the model is
 *  always visible regardless of the source file's unit scale). */
export async function importModel(room: SlateRoom, file: File): Promise<string[]> {
  const group = await loadModelGroup(file);
  group.updateMatrixWorld(true);
  // Fit the whole import into a sensible size + center it, so tiny (mm) or
  // huge models are immediately visible at whatever the user is viewing.
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const norm: Normalization = {
    scale: Number.isFinite(maxDim) && maxDim > 1e-6 ? IMPORT_TARGET_SIZE / maxDim : 1,
    center,
  };
  const materialId = ensureDefaultMaterial(room.slate);
  const newIds: string[] = [];
  room.slate.doc.transact(() => {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const id = commitMesh(room, mesh, materialId, child.name, norm);
        if (id) newIds.push(id);
      }
    });
  });
  return newIds;
}

function commitMesh(
  room: SlateRoom,
  mesh: THREE.Mesh,
  defaultMaterialId: string,
  fallbackName: string,
  norm: Normalization,
): string | null {
  const geom = mesh.geometry instanceof THREE.BufferGeometry ? mesh.geometry : null;
  if (!geom) return null;
  const pos = geom.getAttribute('position');
  if (!pos) return null;
  const indexAttr = geom.getIndex();
  const vertices: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  const faces: { v: number[] }[] = [];
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i += 3) {
      faces.push({ v: [indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2)] });
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      faces.push({ v: [i, i + 1, i + 2] });
    }
  }
  const meshId = makeId('mesh');
  const meshData: MeshData = { id: meshId, vertices, faces };
  const ym = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(meshData)) ym.set(k, v);
  room.slate.scene3dMeshes().set(meshId, ym);

  const materialId = pickMaterialFromMesh(room, mesh) ?? defaultMaterialId;

  // Use the mesh's WORLD transform (handles nested glTF nodes), then apply the
  // import normalization: scale about the model center to the target size.
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const ws = new THREE.Vector3();
  mesh.matrixWorld.decompose(wp, wq, ws);
  const npos = wp.clone().sub(norm.center).multiplyScalar(norm.scale);
  const nscale = ws.clone().multiplyScalar(norm.scale);
  const euler = new THREE.Euler().setFromQuaternion(wq, 'XYZ');

  const obj: SlateObject3D = {
    id: makeId('obj'),
    parentId: null,
    type: 'mesh',
    name: (mesh.name || fallbackName || 'Imported').slice(0, 80),
    visible: true,
    transform: {
      position: { x: npos.x, y: npos.y, z: npos.z },
      rotation: { x: euler.x, y: euler.y, z: euler.z },
      scale: { x: nscale.x, y: nscale.y, z: nscale.z },
    },
    meshId,
    materialId,
  };
  const yo = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) yo.set(k, v);
  room.slate.scene3dObjects().set(obj.id, yo);
  return obj.id;
}

function pickMaterialFromMesh(room: SlateRoom, mesh: THREE.Mesh): string | null {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!mat || !(mat as THREE.MeshStandardMaterial).color) return null;
  const c = (mat as THREE.MeshStandardMaterial).color;
  const id = makeId('mat');
  const def: Material = {
    id,
    kind: 'pbr',
    color: `#${c.getHexString()}`,
    metalness: (mat as THREE.MeshStandardMaterial).metalness ?? 0,
    roughness: (mat as THREE.MeshStandardMaterial).roughness ?? 0.5,
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: (mat as THREE.MeshStandardMaterial).opacity ?? 1,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(def)) m.set(k, v);
  room.slate.scene3dMaterials().set(id, m);
  return id;
}
