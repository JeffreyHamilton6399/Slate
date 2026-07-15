/**
 * Render committed 3D objects from the scene snapshot using react-three-fiber.
 *
 * Each mesh object becomes a <mesh> with a BufferGeometry built from MeshData.
 * Light objects render as always-visible gizmos plus a real THREE light when
 * the viewport shading is 'rendered'. Empties render as a small axes cross.
 *
 * Shading modes (Blender's viewport shading):
 *   wireframe — wires only
 *   solid     — neutral studio gray, materials ignored
 *   material  — PBR materials under the built-in studio rig
 *   rendered  — PBR materials lit only by the scene's own lights
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { LightData, Material, MeshData, Object3D, Transform } from '@slate/sync-protocol';
import { triangulateFace } from '@slate/mesh';
import { applyBoxUVs, loadImageTexture, proceduralTexture } from './textures';
import { formatLength, formatArea, type LengthUnit } from './units';
import type { ShadingMode } from './store';

export interface ElementHit {
  /** Source polygon index under the cursor. */
  face: number;
  /** Hit position in the mesh's local space. */
  local: { x: number; y: number; z: number };
}

interface SceneObjectsProps {
  objects: Object3D[];
  meshes: Map<string, MeshData>;
  materials: Map<string, Material>;
  selection: Set<string>;
  onObjectPick: (id: string, additive: boolean) => void;
  /** Sub-element pick in edit mode; mode resolution happens in the caller. */
  onElementPick: (objectId: string, hit: ElementHit, additive: boolean) => void;
  selectedFaces: number[];
  selectedVerts: number[];
  /** Flat [a,b, a,b, …] vertex-index pairs. */
  selectedEdges: number[];
  shading: ShadingMode;
  /** Blender-style edit mode: show vertex/edge overlay on selected objects. */
  editMode: boolean;
  /** Animation preview poses — objects present here render at the sampled
   *  transform instead of their document transform. */
  overrides?: Map<string, Transform> | null;
  /** Camera being looked through — its glyph is hidden (you're inside it). */
  viewingCameraId?: string | null;
  /** While rendering an animation, hide ALL camera glyphs so the wireframe
   *  cones/boxes don't show up in the recording. */
  hideCameras?: boolean;
  /** Board display unit — drives CAD label formatting on selection. */
  unit?: LengthUnit;
}

export function SceneObjects({
  objects,
  meshes,
  materials,
  selection,
  onObjectPick,
  onElementPick,
  selectedFaces,
  selectedVerts,
  selectedEdges,
  shading,
  editMode,
  overrides,
  viewingCameraId,
  hideCameras,
  unit = 'm',
}: SceneObjectsProps) {
  return (
    <>
      {objects.map((rawObj) => {
        if (!rawObj.visible || rawObj.type === 'folder') return null;
        if (rawObj.id === viewingCameraId) return null;
        if (hideCameras && rawObj.type === 'camera') return null;
        const sampled = overrides?.get(rawObj.id);
        const obj = sampled ? { ...rawObj, transform: sampled } : rawObj;
        if (obj.type === 'light') {
          return (
            <LightObject
              key={obj.id}
              obj={obj}
              selected={selection.has(obj.id)}
              emitLight={shading === 'rendered'}
              onPick={(additive) => onObjectPick(obj.id, additive)}
            />
          );
        }
        if (obj.type === 'camera') {
          return (
            <CameraObject
              key={obj.id}
              obj={obj}
              selected={selection.has(obj.id)}
              onPick={(additive) => onObjectPick(obj.id, additive)}
            />
          );
        }
        if (obj.type === 'empty') {
          return (
            <EmptyObject
              key={obj.id}
              obj={obj}
              selected={selection.has(obj.id)}
              onPick={(additive) => onObjectPick(obj.id, additive)}
            />
          );
        }
        const mesh = obj.meshId ? meshes.get(obj.meshId) : undefined;
        if (!mesh) return null;
        const mat = obj.materialId ? materials.get(obj.materialId) : undefined;
        const isEditing = editMode && selection.has(obj.id);
        return (
          <SceneMesh
            key={obj.id}
            obj={obj}
            data={mesh}
            material={mat}
            selected={selection.has(obj.id)}
            onPick={(additive) => onObjectPick(obj.id, additive)}
            onElementPick={
              isEditing ? (hit, additive) => onElementPick(obj.id, hit, additive) : null
            }
            selectedFaces={isEditing ? selectedFaces : EMPTY}
            selectedVerts={isEditing ? selectedVerts : EMPTY}
            selectedEdges={isEditing ? selectedEdges : EMPTY}
            shading={shading}
            editOverlay={isEditing}
            unit={unit}
          />
        );
      })}
    </>
  );
}

const EMPTY: number[] = [];

/**
 * Blender-style selection outline: the same geometry re-rendered as an
 * inverted hull (back faces only, vertices pushed out along their normals)
 * in Blender's selection orange. One shared material for all outlines.
 */
const OUTLINE_MAT = (() => {
  const m = new THREE.MeshBasicMaterial({ color: '#ff9d2e', side: THREE.BackSide, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\ttransformed += normal * 0.018;',
    );
  };
  return m;
})();

/**
 * Click-vs-drag pick handling shared by meshes, lights, and empties: select
 * on pointer-up only when the pointer barely moved (left-drag orbits).
 */
function usePickHandlers(onPick: (additive: boolean) => void) {
  const downAt = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: { button: number; clientX: number; clientY: number }) => {
      if (e.button !== 0) return;
      downAt.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: {
      button: number;
      clientX: number;
      clientY: number;
      shiftKey: boolean;
      stopPropagation: () => void;
    }) => {
      const d = downAt.current;
      downAt.current = null;
      if (!d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      e.stopPropagation();
      onPick(e.shiftKey);
    },
  };
}

function SceneMesh({
  obj,
  data,
  material,
  selected,
  onPick,
  onElementPick,
  selectedFaces,
  selectedVerts,
  selectedEdges,
  shading,
  editOverlay,
  unit,
}: {
  obj: Object3D;
  data: MeshData;
  material?: Material;
  selected: boolean;
  onPick: (additive: boolean) => void;
  onElementPick: ((hit: ElementHit, additive: boolean) => void) | null;
  selectedFaces: number[];
  selectedVerts: number[];
  selectedEdges: number[];
  shading: ShadingMode;
  editOverlay: boolean;
  unit: LengthUnit;
}) {
  // triFace maps each rendered triangle back to its source polygon so a
  // raycast hit (triangle index) resolves to a face selection. wireGeo holds
  // the REAL polygon face edges (not triangulated) for wireframe display.
  const { geometry, triFace, wireGeo } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const tris: number[] = [];
    const triFace: number[] = [];
    data.faces.forEach((face, fi) => {
      for (const t of triangulateFace(face)) {
        tris.push(...t.v);
        triFace.push(fi);
      }
    });
    const positions = new Float32Array(data.vertices);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(tris);
    if (obj.smooth) g.computeVertexNormals();
    else nonIndexedFlatNormals(g);
    // UVs for procedural textures (box projection needs the normals above).
    applyBoxUVs(g);
    g.computeBoundingSphere();
    // Build a segment list of each polygon's perimeter edges (real face
    // edges, NOT the triangulation diagonals) for wireframe display.
    const seg: number[] = [];
    for (const f of data.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        seg.push(
          data.vertices[a * 3] ?? 0,
          data.vertices[a * 3 + 1] ?? 0,
          data.vertices[a * 3 + 2] ?? 0,
          data.vertices[b * 3] ?? 0,
          data.vertices[b * 3 + 1] ?? 0,
          data.vertices[b * 3 + 2] ?? 0,
        );
      }
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    return { geometry: g, triFace, wireGeo };
  }, [data, obj.smooth]);

  // Solid shading ignores materials (Blender's neutral studio gray).
  const solid = shading === 'solid';
  const color = solid ? '#b9bac3' : (material?.color ?? '#7c6aff');
  const metalness = solid ? 0.05 : (material?.metalness ?? 0);
  const roughness = solid ? 0.65 : (material?.roughness ?? 0.5);
  const opacity = solid ? 1 : (material?.opacity ?? 1);
  const emissive = solid ? '#000000' : (material?.emissive ?? '#000000');
  const emissiveIntensity = solid ? 0 : (material?.emissiveIntensity ?? 0);
  // Procedural texture map — only where materials matter.
  const showTexture = shading === 'material' || shading === 'rendered';
  const map = useMemo(
    () => (showTexture && material?.texture ? proceduralTexture(material.texture) : null),
    [showTexture, material?.texture],
  );
  // Image textures load async: kick off the load and force a re-render when
  // it completes so the mesh picks up the texture.
  const [, forceTextureUpdate] = useState(0);
  useEffect(() => {
    if (showTexture && material?.texture?.kind === 'image' && material.texture.src) {
      loadImageTexture(material.texture.src, () => forceTextureUpdate((n) => n + 1));
    }
  }, [showTexture, material?.texture?.kind, material?.texture?.src]);

  // Select on click, not pointer-down: left-drag orbits the camera, and a
  // pick should only land when the pointer barely moved.
  const downAt = useRef<{ x: number; y: number } | null>(null);

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
        downAt.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const d = downAt.current;
        downAt.current = null;
        if (!d || e.button !== 0) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
        e.stopPropagation();
        // Editing this object: clicks select sub-elements instead of objects.
        if (onElementPick && e.faceIndex !== undefined && e.faceIndex !== null) {
          const fi = triFace[e.faceIndex];
          if (fi !== undefined) {
            const local = (e.object as THREE.Mesh).worldToLocal(e.point.clone());
            onElementPick({ face: fi, local: { x: local.x, y: local.y, z: local.z } }, e.shiftKey);
          }
          return;
        }
        onPick(e.shiftKey);
      }}
      userData={{ slateId: obj.id }}
    >
      <meshStandardMaterial
        // Remount when the map slot toggles so the shader picks up USE_MAP.
        key={map ? 'textured' : 'plain'}
        color={color}
        map={map}
        metalness={metalness}
        roughness={roughness}
        // In wireframe mode the filled surface is hidden (transparent) so
        // ONLY the real face-edge overlay below is visible — no triangulated
        // diagonals bleed through.
        transparent={opacity < 1 || shading === 'wireframe'}
        opacity={shading === 'wireframe' ? 0 : opacity}
        emissive={new THREE.Color(emissive)}
        emissiveIntensity={emissiveIntensity}
        side={THREE.DoubleSide}
      />
      {/* Wireframe overlay: real polygon face edges (not triangulated). */}
      {shading === 'wireframe' && (
        <lineSegments geometry={wireGeo} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={color} />
        </lineSegments>
      )}
      {/* Selection reads as Blender's silhouette outline, not a tint. */}
      {selected && !editOverlay && shading !== 'wireframe' && (
        <mesh geometry={geometry} material={OUTLINE_MAT} raycast={NO_RAYCAST} />
      )}
      {editOverlay && <EditOverlay data={data} />}
      {editOverlay && selectedFaces.length > 0 && (
        <FaceHighlight data={data} faces={selectedFaces} transform={obj.transform} unit={unit} />
      )}
      {editOverlay && (selectedVerts.length > 0 || selectedEdges.length > 0) && (
        <ElementHighlight
          data={data}
          verts={selectedVerts}
          edges={selectedEdges}
          transform={obj.transform}
          unit={unit}
        />
      )}
    </mesh>
  );
}

const LIGHT_FALLBACK: LightData = { kind: 'point', color: '#ffffff', intensity: 25, distance: 0, angle: Math.PI / 6 };

// RectAreaLight renders black until its BRDF LUT uniforms are initialized;
// do it once at module load.
RectAreaLightUniformsLib.init();

/**
 * A light object: selectable gizmo, plus the actual THREE light in rendered
 * shading. Sun and spot lights shine along the object's rotated -Y axis
 * (Blender-style): R re-aims them, and addLight pre-aims new ones at the
 * scene center.
 */
function LightObject({
  obj,
  selected,
  emitLight,
  onPick,
}: {
  obj: Object3D;
  selected: boolean;
  emitLight: boolean;
  onPick: (additive: boolean) => void;
}) {
  const light = obj.light ?? LIGHT_FALLBACK;
  const pick = usePickHandlers(onPick);
  const t = obj.transform;
  // Direction comes from rotation: the target sits below the light in local
  // space, so rotating the group steers sun/spot beams.
  const target = useMemo(() => new THREE.Object3D(), []);
  const gizmoColor = selected ? '#ffb84d' : light.color;
  const spotAngle = Math.max(0.05, light.angle || Math.PI / 6);

  return (
    <group
      position={[t.position.x, t.position.y, t.position.z]}
      rotation={[t.rotation.x, t.rotation.y, t.rotation.z]}
      userData={{ slateId: obj.id }}
    >
      {/* Invisible pick target — lights are tiny, give them a fat hitbox. */}
      <mesh onPointerDown={pick.onPointerDown} onPointerUp={pick.onPointerUp}>
        <sphereGeometry args={[0.3, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Gizmo core: a small glowing dot, always visible. */}
      <mesh raycast={NO_RAYCAST}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color={gizmoColor} />
      </mesh>

      {light.kind === 'point' && <PointRays color={gizmoColor} />}
      {light.kind === 'sun' && <SunGizmo color={gizmoColor} />}
      {light.kind === 'hemisphere' && <PointRays color={gizmoColor} />}
      {light.kind === 'spot' && (
        <mesh position={[0, -0.45, 0]} raycast={NO_RAYCAST}>
          <coneGeometry args={[Math.tan(spotAngle) * 0.9, 0.9, 16, 1, true]} />
          <meshBasicMaterial color={gizmoColor} wireframe transparent opacity={0.5} />
        </mesh>
      )}
      {light.kind === 'area' && (
        <mesh raycast={NO_RAYCAST}>
          <planeGeometry args={[Math.max(0.2, (light.angle || 1) * 2), Math.max(0.2, (light.angle || 1) * 2)]} />
          <meshBasicMaterial color={gizmoColor} wireframe transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      )}

      {emitLight && light.kind === 'point' && (
        <pointLight
          color={light.color}
          intensity={light.intensity}
          distance={light.distance || 0}
          castShadow
          shadow-mapSize={[512, 512]}
          shadow-bias={-0.0003}
        />
      )}
      {emitLight && light.kind === 'sun' && (
        <>
          <primitive object={target} position={[0, -10, 0]} />
          <directionalLight
            color={light.color}
            intensity={light.intensity}
            target={target}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0003}
            shadow-camera-left={-15}
            shadow-camera-right={15}
            shadow-camera-top={15}
            shadow-camera-bottom={-15}
            shadow-camera-near={0.5}
            shadow-camera-far={60}
          />
        </>
      )}
      {emitLight && light.kind === 'spot' && (
        <>
          <primitive object={target} position={[0, -10, 0]} />
          <spotLight
            color={light.color}
            intensity={light.intensity}
            distance={light.distance || 0}
            angle={spotAngle}
            penumbra={0.35}
            target={target}
            castShadow
            shadow-mapSize={[1024, 1024]}
            shadow-bias={-0.0003}
          />
        </>
      )}
      {emitLight && light.kind === 'hemisphere' && (
        // Sky color from above, a muted ground bounce from below.
        <hemisphereLight args={[light.color, '#3a3428', light.intensity]} />
      )}
      {emitLight && light.kind === 'area' && (
        // RectAreaLight faces local -Z; our aim convention points -Y, so tip
        // it forward 90° about X. No shadows (three limitation).
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <rectAreaLight
            color={light.color}
            intensity={light.intensity}
            width={Math.max(0.2, (light.angle || 1) * 2)}
            height={Math.max(0.2, (light.angle || 1) * 2)}
          />
        </group>
      )}
    </group>
  );
}

/** Short rays in all directions — Blender's point-light glyph. */
function PointRays({ color }: { color: string }) {
  const geo = useMemo(() => {
    const seg: number[] = [];
    const dirs: [number, number, number][] = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, -0.7, 0],
    ];
    for (const [x, y, z] of dirs) seg.push(x * 0.12, y * 0.12, z * 0.12, x * 0.24, y * 0.24, z * 0.24);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo} raycast={NO_RAYCAST}>
      <lineBasicMaterial color={color} transparent opacity={0.85} />
    </lineSegments>
  );
}

/** Circle + direction line pointing -Y (the aim direction) — sun glyph. */
function SunGizmo({ color }: { color: string }) {
  const geo = useMemo(() => {
    const seg: number[] = [];
    const R = 0.16;
    const N = 24;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      seg.push(Math.cos(a0) * R, 0, Math.sin(a0) * R, Math.cos(a1) * R, 0, Math.sin(a1) * R);
    }
    seg.push(0, 0, 0, 0, -0.8, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo} raycast={NO_RAYCAST}>
      <lineBasicMaterial color={color} transparent opacity={0.85} />
    </lineSegments>
  );
}

/** Scene camera glyph: wire frustum opening along local -Y (the view axis),
 *  plus an up-pointer triangle. Selectable; Numpad 0 looks through it. */
const CAMERA_LINES = (() => {
  const w = 0.32, h = 0.22, d = 0.7; // half-extents of the far rect + depth
  const seg: number[] = [];
  const corners = [
    [-w, -d, h], [w, -d, h], [w, -d, -h], [-w, -d, -h],
  ];
  for (const c of corners) seg.push(0, 0, 0, ...c);
  for (let i = 0; i < 4; i++) seg.push(...corners[i]!, ...corners[(i + 1) % 4]!);
  // Up indicator on the top edge (+z side is "up" for a -Y-aimed camera).
  seg.push(-w * 0.4, -d, h, 0, -d, h + 0.14);
  seg.push(0, -d, h + 0.14, w * 0.4, -d, h);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
  return g;
})();

function CameraObject({
  obj,
  selected,
  onPick,
}: {
  obj: Object3D;
  selected: boolean;
  onPick: (additive: boolean) => void;
}) {
  const pick = usePickHandlers(onPick);
  const t = obj.transform;
  return (
    <group
      position={[t.position.x, t.position.y, t.position.z]}
      rotation={[t.rotation.x, t.rotation.y, t.rotation.z]}
      userData={{ slateId: obj.id }}
    >
      <mesh onPointerDown={pick.onPointerDown} onPointerUp={pick.onPointerUp}>
        <sphereGeometry args={[0.35, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <lineSegments geometry={CAMERA_LINES} raycast={NO_RAYCAST}>
        <lineBasicMaterial color={selected ? '#ffb84d' : '#c9c9dd'} transparent opacity={0.95} />
      </lineSegments>
      <mesh raycast={NO_RAYCAST}>
        <boxGeometry args={[0.18, 0.26, 0.14]} />
        <meshBasicMaterial color={selected ? '#ffb84d' : '#8f8fa3'} wireframe />
      </mesh>
    </group>
  );
}

/** A selectable axes cross for empties (Blender's plain-axes empty). */
function EmptyObject({
  obj,
  selected,
  onPick,
}: {
  obj: Object3D;
  selected: boolean;
  onPick: (additive: boolean) => void;
}) {
  const pick = usePickHandlers(onPick);
  const geo = useMemo(() => {
    const s = 0.35;
    const seg = [-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    return g;
  }, []);
  const t = obj.transform;
  return (
    <group
      position={[t.position.x, t.position.y, t.position.z]}
      rotation={[t.rotation.x, t.rotation.y, t.rotation.z]}
      scale={[t.scale.x, t.scale.y, t.scale.z]}
      userData={{ slateId: obj.id }}
    >
      <mesh onPointerDown={pick.onPointerDown} onPointerUp={pick.onPointerUp}>
        <sphereGeometry args={[0.3, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <lineSegments geometry={geo} raycast={NO_RAYCAST}>
        <lineBasicMaterial color={selected ? '#ffb84d' : '#8f8fa3'} />
      </lineSegments>
    </group>
  );
}

/** Compose a world matrix from a Slate Transform (position + Euler rotation +
 *  scale). Used to project mesh-local vertices into world space for CAD
 *  measurement math, which must respect object rotation (not just scale). */
function worldMatrix(t: Transform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(t.position.x, t.position.y, t.position.z),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z),
    ),
    new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
  );
}

/** Orange markers for selected vertices and edges, with on-edge length labels
 *  (CAD-style — the measurement sits on the line itself, not in a HUD).
 *  Length is measured in WORLD space (through the object's full transform,
 *  so rotation is respected), then formatted in the board's display unit. */
function ElementHighlight({
  data,
  verts,
  edges,
  transform,
  unit,
}: {
  data: MeshData;
  verts: number[];
  edges: number[];
  transform: Transform;
  unit: LengthUnit;
}) {
  const { vGeo, eGeo, edgeLabels } = useMemo(() => {
    const vPos: number[] = [];
    for (const vi of verts) {
      vPos.push(data.vertices[vi * 3] ?? 0, data.vertices[vi * 3 + 1] ?? 0, data.vertices[vi * 3 + 2] ?? 0);
    }
    const ePos: number[] = [];
    const edgeLabels: { pos: [number, number, number]; len: string }[] = [];
    const m = worldMatrix(transform);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a = edges[i]!;
      const b = edges[i + 1]!;
      const ax = data.vertices[a * 3] ?? 0;
      const ay = data.vertices[a * 3 + 1] ?? 0;
      const az = data.vertices[a * 3 + 2] ?? 0;
      const bx = data.vertices[b * 3] ?? 0;
      const by = data.vertices[b * 3 + 1] ?? 0;
      const bz = data.vertices[b * 3 + 2] ?? 0;
      ePos.push(ax, ay, az, bx, by, bz);
      // World-space length (respects rotation + scale + position), label at the midpoint.
      va.set(ax, ay, az).applyMatrix4(m);
      vb.set(bx, by, bz).applyMatrix4(m);
      edgeLabels.push({
        pos: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
        len: formatLength(va.distanceTo(vb), unit),
      });
    }
    const vGeo = new THREE.BufferGeometry();
    vGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vPos), 3));
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ePos), 3));
    return { vGeo, eGeo, edgeLabels };
  }, [data, verts, edges, transform, unit]);

  return (
    <>
      {edges.length > 0 && (
        <lineSegments geometry={eGeo} raycast={NO_RAYCAST}>
          <lineBasicMaterial color="#ffb84d" transparent opacity={0.95} depthTest={false} />
        </lineSegments>
      )}
      {/* On-edge length labels (CAD-style, sit on the line itself). */}
      {edgeLabels.map((lbl, i) => (
        <Html key={i} position={lbl.pos} center distanceFactor={6} occlude={false} zIndexRange={[20, 0]}>
          <div className="pointer-events-none select-none whitespace-nowrap rounded-sm bg-warn/90 px-0.5 py-0 font-mono text-[7px] font-medium text-black shadow">
            {lbl.len}
          </div>
        </Html>
      ))}
      {verts.length > 0 && (
        <points geometry={vGeo} raycast={NO_RAYCAST}>
          <pointsMaterial color="#ffb84d" size={8} sizeAttenuation={false} depthTest={false} />
        </points>
      )}
    </>
  );
}

/** Translucent fill over the currently selected faces, PLUS CAD measurement
 *  labels: each face's perimeter edges show their world-space length, and each
 *  face's centroid shows its world-space area. Mirrors ElementHighlight's
 *  label style so selecting a face reads like a tape measure + area callout. */
function FaceHighlight({
  data,
  faces,
  transform,
  unit,
}: {
  data: MeshData;
  faces: number[];
  transform: Transform;
  unit: LengthUnit;
}) {
  const { geo, edgeLabels, areaLabels } = useMemo(() => {
    const pos: number[] = [];
    const edgeLabels: { pos: [number, number, number]; len: string }[] = [];
    const areaLabels: { pos: [number, number, number]; area: string }[] = [];
    const m = worldMatrix(transform);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (const fi of faces) {
      const face = data.faces[fi];
      if (!face) continue;
      // Reuse the triangulated fill geometry for the highlight surface.
      for (const t of triangulateFace(face)) {
        for (const vi of t.v) {
          pos.push(
            data.vertices[vi * 3] ?? 0,
            data.vertices[vi * 3 + 1] ?? 0,
            data.vertices[vi * 3 + 2] ?? 0,
          );
        }
      }
      // Perimeter edges (consecutive vertex pairs, wrap-around). Each edge
      // endpoint is projected into world space before measuring, so rotated
      // faces read correctly. Label sits at the local-space midpoint (the
      // <Html> is parented under the mesh, which applies the transform).
      for (let i = 0; i < face.v.length; i++) {
        const a = face.v[i]!;
        const b = face.v[(i + 1) % face.v.length]!;
        const ax = data.vertices[a * 3] ?? 0;
        const ay = data.vertices[a * 3 + 1] ?? 0;
        const az = data.vertices[a * 3 + 2] ?? 0;
        const bx = data.vertices[b * 3] ?? 0;
        const by = data.vertices[b * 3 + 1] ?? 0;
        const bz = data.vertices[b * 3 + 2] ?? 0;
        va.set(ax, ay, az).applyMatrix4(m);
        vb.set(bx, by, bz).applyMatrix4(m);
        edgeLabels.push({
          pos: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
          len: formatLength(va.distanceTo(vb), unit),
        });
      }
      // Face area in world space = sum of fan-triangulated triangle areas,
      // each measured as half the cross-product magnitude. Local-space
      // centroid (vertex average) is the label anchor.
      let area = 0;
      let cx = 0,
        cy = 0,
        cz = 0;
      for (let i = 0; i < face.v.length; i++) {
        const vi = face.v[i]!;
        cx += data.vertices[vi * 3] ?? 0;
        cy += data.vertices[vi * 3 + 1] ?? 0;
        cz += data.vertices[vi * 3 + 2] ?? 0;
      }
      const n = face.v.length || 1;
      const tris = triangulateFace(face);
      for (const t of tris) {
        const [ia, ib, ic] = t.v;
        if (ia === undefined || ib === undefined || ic === undefined) continue;
        va.set(data.vertices[ia * 3] ?? 0, data.vertices[ia * 3 + 1] ?? 0, data.vertices[ia * 3 + 2] ?? 0).applyMatrix4(m);
        vb.set(data.vertices[ib * 3] ?? 0, data.vertices[ib * 3 + 1] ?? 0, data.vertices[ib * 3 + 2] ?? 0).applyMatrix4(m);
        vc.set(data.vertices[ic * 3] ?? 0, data.vertices[ic * 3 + 1] ?? 0, data.vertices[ic * 3 + 2] ?? 0).applyMatrix4(m);
        ab.subVectors(vb, va);
        ac.subVectors(vc, va);
        cross.crossVectors(ab, ac);
        area += cross.length() * 0.5;
      }
      areaLabels.push({
        pos: [cx / n, cy / n, cz / n],
        area: formatArea(area, unit),
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    return { geo: g, edgeLabels, areaLabels };
  }, [data, faces, transform, unit]);

  return (
    <>
      <mesh geometry={geo} raycast={() => null}>
        <meshBasicMaterial
          color="#ffb84d"
          transparent
          opacity={0.4}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
        />
      </mesh>
      {/* Perimeter edge length labels (CAD-style, sit on each edge midpoint). */}
      {edgeLabels.map((lbl, i) => (
        <Html key={`e${i}`} position={lbl.pos} center distanceFactor={6} occlude={false} zIndexRange={[20, 0]}>
          <div className="pointer-events-none select-none whitespace-nowrap rounded-sm bg-warn/90 px-0.5 py-0 font-mono text-[7px] font-medium text-black shadow">
            {lbl.len}
          </div>
        </Html>
      ))}
      {/* Face area label at the centroid (small pill so it doesn't dominate the callout). */}
      {areaLabels.map((lbl, i) => (
        <Html key={`a${i}`} position={lbl.pos} center distanceFactor={6} occlude={false} zIndexRange={[20, 0]}>
          <div className="pointer-events-none select-none whitespace-nowrap rounded-sm bg-warn px-0.5 py-0 font-mono text-[7px] font-semibold text-black shadow">
            {lbl.area}
          </div>
        </Html>
      ))}
    </>
  );
}

/** Vertex dots + polygon edges for the object being edited. */
function EditOverlay({ data }: { data: MeshData }) {
  const { pointsGeo, edgesGeo } = useMemo(() => {
    const verts = new Float32Array(data.vertices);
    const seg: number[] = [];
    for (const f of data.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i]!;
        const b = f.v[(i + 1) % f.v.length]!;
        seg.push(
          data.vertices[a * 3] ?? 0,
          data.vertices[a * 3 + 1] ?? 0,
          data.vertices[a * 3 + 2] ?? 0,
          data.vertices[b * 3] ?? 0,
          data.vertices[b * 3 + 1] ?? 0,
          data.vertices[b * 3 + 2] ?? 0,
        );
      }
    }
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const edgesGeo = new THREE.BufferGeometry();
    edgesGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    return { pointsGeo, edgesGeo };
  }, [data]);

  // raycast disabled: the overlay must never swallow face-picking clicks
  // (THREE.Points' default pick threshold is a whole world unit).
  return (
    <>
      <lineSegments geometry={edgesGeo} raycast={NO_RAYCAST}>
        <lineBasicMaterial color="#7c6aff" transparent opacity={0.9} />
      </lineSegments>
      <points geometry={pointsGeo} raycast={NO_RAYCAST}>
        <pointsMaterial color="#ffffff" size={5} sizeAttenuation={false} depthTest={false} />
      </points>
    </>
  );
}

function NO_RAYCAST() {
  /* not pickable */
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
