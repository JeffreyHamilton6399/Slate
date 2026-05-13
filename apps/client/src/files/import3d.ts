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

export async function importModel(room: SlateRoom, file: File): Promise<number> {
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

  const materialId = ensureDefaultMaterial(room.slate);
  let count = 0;
  room.slate.doc.transact(() => {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (commitMesh(room, mesh, materialId, child.name)) count++;
      }
    });
  });
  return count;
}

function commitMesh(
  room: SlateRoom,
  mesh: THREE.Mesh,
  defaultMaterialId: string,
  fallbackName: string,
): boolean {
  const geom = mesh.geometry instanceof THREE.BufferGeometry ? mesh.geometry : null;
  if (!geom) return false;
  const pos = geom.getAttribute('position');
  if (!pos) return false;
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

  const obj: SlateObject3D = {
    id: makeId('obj'),
    parentId: null,
    type: 'mesh',
    name: (mesh.name || fallbackName || 'Imported').slice(0, 80),
    visible: true,
    transform: {
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      rotation: { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z },
      scale: { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z },
    },
    meshId,
    materialId,
  };
  const yo = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) yo.set(k, v);
  room.slate.scene3dObjects().set(obj.id, yo);
  return true;
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
