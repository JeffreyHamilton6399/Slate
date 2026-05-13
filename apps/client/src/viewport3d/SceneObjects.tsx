/**
 * Render committed 3D objects from the scene snapshot using react-three-fiber.
 *
 * Each object becomes a <mesh> with a BufferGeometry built from MeshData.
 * Materials are PBR with smooth/flat shading toggle on the parent object.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Material, MeshData, Object3D } from '@slate/sync-protocol';
import { triangulateFace } from '@slate/mesh';

interface SceneObjectsProps {
  objects: Object3D[];
  meshes: Map<string, MeshData>;
  materials: Map<string, Material>;
  selection: Set<string>;
  onObjectPick: (id: string, additive: boolean) => void;
  wireframe: boolean;
}

export function SceneObjects({
  objects,
  meshes,
  materials,
  selection,
  onObjectPick,
  wireframe,
}: SceneObjectsProps) {
  return (
    <>
      {objects.map((obj) => {
        if (!obj.visible || obj.type === 'folder' || obj.type === 'empty') return null;
        const mesh = obj.meshId ? meshes.get(obj.meshId) : undefined;
        if (!mesh) return null;
        const mat = obj.materialId ? materials.get(obj.materialId) : undefined;
        return (
          <SceneMesh
            key={obj.id}
            obj={obj}
            data={mesh}
            material={mat}
            selected={selection.has(obj.id)}
            onPick={(additive) => onObjectPick(obj.id, additive)}
            wireframe={wireframe}
          />
        );
      })}
    </>
  );
}

function SceneMesh({
  obj,
  data,
  material,
  selected,
  onPick,
  wireframe,
}: {
  obj: Object3D;
  data: MeshData;
  material?: Material;
  selected: boolean;
  onPick: (additive: boolean) => void;
  wireframe: boolean;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const tris: number[] = [];
    for (const face of data.faces) {
      for (const t of triangulateFace(face)) tris.push(...t.v);
    }
    const positions = new Float32Array(data.vertices);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(tris);
    if (obj.smooth) g.computeVertexNormals();
    else nonIndexedFlatNormals(g);
    g.computeBoundingSphere();
    return g;
  }, [data, obj.smooth]);

  const color = material?.color ?? '#7c6aff';
  const metalness = material?.metalness ?? 0;
  const roughness = material?.roughness ?? 0.5;
  const opacity = material?.opacity ?? 1;

  return (
    <mesh
      castShadow
      receiveShadow
      position={[obj.transform.position.x, obj.transform.position.y, obj.transform.position.z]}
      rotation={[obj.transform.rotation.x, obj.transform.rotation.y, obj.transform.rotation.z]}
      scale={[obj.transform.scale.x, obj.transform.scale.y, obj.transform.scale.z]}
      geometry={geometry}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onPick(e.shiftKey);
      }}
      userData={{ slateId: obj.id }}
    >
      <meshStandardMaterial
        color={color}
        metalness={metalness}
        roughness={roughness}
        transparent={opacity < 1}
        opacity={opacity}
        emissive={selected ? new THREE.Color(0x7c6aff) : new THREE.Color(0x000000)}
        emissiveIntensity={selected ? 0.4 : 0}
        wireframe={wireframe}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function nonIndexedFlatNormals(g: THREE.BufferGeometry): void {
  // Drop the index and duplicate positions so each triangle has its own
  // flat normal. We do this only when the user explicitly requested flat
  // shading; otherwise computeVertexNormals gives smooth shading.
  const idx = g.getIndex();
  if (!idx) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const flat = new Float32Array(idx.count * 3);
  for (let i = 0; i < idx.count; i++) {
    const v = idx.getX(i);
    flat[i * 3] = pos.getX(v);
    flat[i * 3 + 1] = pos.getY(v);
    flat[i * 3 + 2] = pos.getZ(v);
  }
  g.setIndex(null);
  g.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  g.computeVertexNormals();
}
