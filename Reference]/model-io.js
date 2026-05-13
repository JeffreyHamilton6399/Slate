/* ───────────────────────────────────────────────────────────────────────────
   Slate model I/O — import and export common 3D file formats.

   Importers
     • .obj      — OBJLoader (text, no dependencies)
     • .stl      — STLLoader (binary or text)
     • .ply      — PLYLoader (binary or text)
     • .gltf/glb — GLTFLoader (JSON + binary)
     • .fbx      — FBXLoader (binary; brings fflate via three/addons)

   Exporters
     • .obj      — OBJExporter
     • .stl      — STLExporter (binary)
     • .ply      — PLYExporter
     • .gltf     — GLTFExporter (JSON form)
     • .glb      — GLTFExporter (binary form)
     • .fbx      — re-uses the existing fbx-export.js writer

   All importers normalize incoming meshes into Slate's `meshData` polygon
   format (`{ vertices: number[], faces: number[][] }`), so post-import the
   user can immediately enter edit mode and run the same tools that work on
   primitives.
─────────────────────────────────────────────────────────────────────────── */

import * as THREE from 'three';

// ── Lazy loader / exporter helpers ────────────────────────────────────────
// We pay the network cost only for the formats the user actually picks.
async function _loaderFor(ext) {
  switch (ext) {
    case 'obj':  return (await import('three/addons/loaders/OBJLoader.js')).OBJLoader;
    case 'stl':  return (await import('three/addons/loaders/STLLoader.js')).STLLoader;
    case 'ply':  return (await import('three/addons/loaders/PLYLoader.js')).PLYLoader;
    case 'gltf':
    case 'glb':  return (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader;
    case 'fbx':  return (await import('three/addons/loaders/FBXLoader.js')).FBXLoader;
    default: throw new Error(`Unsupported import format: ${ext}`);
  }
}
async function _exporterFor(ext) {
  switch (ext) {
    case 'obj':  return (await import('three/addons/exporters/OBJExporter.js')).OBJExporter;
    case 'stl':  return (await import('three/addons/exporters/STLExporter.js')).STLExporter;
    case 'ply':  return (await import('three/addons/exporters/PLYExporter.js')).PLYExporter;
    case 'gltf':
    case 'glb':  return (await import('three/addons/exporters/GLTFExporter.js')).GLTFExporter;
    default: throw new Error(`Unsupported export format: ${ext}`);
  }
}

// ── Geometry → Slate meshData converter ───────────────────────────────────
// We can't blindly trust incoming triangles to share verts — most exporters
// duplicate corners for per-face normals, just like BoxGeometry does. We
// weld by position, build the unwelded triangle list, then merge coplanar
// pairs into quads so an imported cube round-trips as 8 verts + 6 quads.

function _weldKey(x, y, z) {
  return `${Math.round(x * 1e5)}|${Math.round(y * 1e5)}|${Math.round(z * 1e5)}`;
}

function _triNormal(verts, t) {
  const a = new THREE.Vector3(verts[t[0]*3], verts[t[0]*3+1], verts[t[0]*3+2]);
  const b = new THREE.Vector3(verts[t[1]*3], verts[t[1]*3+1], verts[t[1]*3+2]);
  const c = new THREE.Vector3(verts[t[2]*3], verts[t[2]*3+1], verts[t[2]*3+2]);
  const n = new THREE.Vector3().crossVectors(
    b.clone().sub(a),
    c.clone().sub(a),
  );
  if (n.lengthSq() < 1e-12) return null;
  return n.normalize();
}

function _trianglesCoplanar(t1, t2, verts) {
  const n1 = _triNormal(verts, t1);
  const n2 = _triNormal(verts, t2);
  if (!n1 || !n2) return false;
  // Same-facing and ≤ ~3° dihedral.
  return n1.dot(n2) >= 0.9985;
}

/** Merge a pair of triangles sharing one edge into a 4-vert quad. Returns
 *  null if the two tris don't form a clean convex quad. */
function _orderedQuadFromTwoTris(t1, t2) {
  const halves = [
    [t1[0], t1[1]], [t1[1], t1[2]], [t1[2], t1[0]],
    [t2[0], t2[1]], [t2[1], t2[2]], [t2[2], t2[0]],
  ];
  const k = (a, b) => `${a}|${b}`;
  const present = new Set(halves.map(([a, b]) => k(a, b)));
  const boundary = halves.filter(([a, b]) => !present.has(k(b, a)));
  if (boundary.length !== 4) return null;
  const next = new Map();
  for (const [a, b] of boundary) {
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const start = boundary[0][0];
  const ring = [];
  let v = start;
  for (let i = 0; i < 5; i++) {
    ring.push(v);
    v = next.get(v);
    if (v === undefined) return null;
    if (v === start) break;
  }
  if (ring.length !== 4) return null;
  return ring;
}

function _triSharesEdge(t, a, b) {
  return (
    (t[0] === a && t[1] === b) || (t[0] === b && t[1] === a) ||
    (t[1] === a && t[2] === b) || (t[1] === b && t[2] === a) ||
    (t[2] === a && t[0] === b) || (t[2] === b && t[0] === a)
  );
}

function _mergeTrianglePairsToQuads(tris, verts) {
  const used = new Array(tris.length).fill(false);
  const out = [];
  for (let ti = 0; ti < tris.length; ti++) {
    if (used[ti]) continue;
    const t1 = tris[ti];
    let merged = false;
    for (let e = 0; e < 3 && !merged; e++) {
      const a = t1[e], b = t1[(e + 1) % 3];
      for (let tj = 0; tj < tris.length; tj++) {
        if (tj === ti || used[tj]) continue;
        const t2 = tris[tj];
        if (!_triSharesEdge(t2, a, b)) continue;
        const set = new Set([t1[0], t1[1], t1[2], t2[0], t2[1], t2[2]]);
        if (set.size !== 4) continue;
        if (!_trianglesCoplanar(t1, t2, verts)) continue;
        const quad = _orderedQuadFromTwoTris(t1, t2);
        if (!quad) continue;
        out.push(quad);
        used[ti] = used[tj] = true;
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push([t1[0], t1[1], t1[2]]);
      used[ti] = true;
    }
  }
  return out;
}

/** Convert a THREE.BufferGeometry to Slate's `{ vertices, faces }` meshData. */
export function geometryToMeshData(geo, applyMatrix = null) {
  if (!geo || !geo.attributes?.position) return { vertices: [], faces: [] };

  // Clone and apply the world matrix so the imported mesh ends up positioned
  // where it sat in the source file.
  const g = geo.clone();
  if (applyMatrix) g.applyMatrix4(applyMatrix);

  const posAttr = g.getAttribute('position');
  const weldVerts = [];
  const buckets = new Map();
  const weldFor = new Int32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const k = _weldKey(x, y, z);
    let id = buckets.get(k);
    if (id === undefined) {
      id = weldVerts.length / 3;
      weldVerts.push(x, y, z);
      buckets.set(k, id);
    }
    weldFor[i] = id;
  }
  const tris = [];
  const indexAttr = g.getIndex();
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i += 3) {
      const a = weldFor[indexAttr.getX(i)];
      const b = weldFor[indexAttr.getX(i + 1)];
      const c = weldFor[indexAttr.getX(i + 2)];
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  } else {
    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      const a = weldFor[i], b = weldFor[i + 1], c = weldFor[i + 2];
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  }
  g.dispose();
  const faces = _mergeTrianglePairsToQuads(tris, weldVerts);
  return { vertices: weldVerts, faces };
}

/** Collect every Mesh in `root` and convert it to a Slate scene-object spec.
 *  Each mesh becomes one Slate object; instancing is preserved by cloning. */
function _flattenSceneToSlateObjects(root, baseName) {
  const result = [];
  let counter = 0;
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const md = geometryToMeshData(o.geometry, o.matrixWorld);
    if (!md.vertices.length || !md.faces.length) return;
    const name = o.name || `${baseName}${counter ? `_${counter}` : ''}`;
    counter++;
    // Pull a colour out of the mesh material if it exposes one.
    let color = '#cccccc';
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.color && typeof mat.color.getHexString === 'function') {
      color = '#' + mat.color.getHexString();
    }
    result.push({
      type: 'mesh',
      name,
      params: {},
      position: [0, 0, 0],          // Geometry was baked into world space.
      rotation: [0, 0, 0],
      scale:    [1, 1, 1],
      color,
      meshData: md,
    });
  });
  return result;
}

// ── Public: import a File (from input[type=file] or drag-drop) ────────────
export async function importModelFile(file) {
  if (!file) throw new Error('No file provided');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const LoaderCls = await _loaderFor(ext);
  const loader = new LoaderCls();
  let parsed;
  if (ext === 'obj' || ext === 'ply' || ext === 'stl') {
    const buf = ext === 'stl' ? await file.arrayBuffer() : await file.text();
    parsed = loader.parse(buf);
  } else if (ext === 'gltf') {
    const json = await file.text();
    parsed = await new Promise((resolve, reject) =>
      loader.parse(json, '', resolve, reject));
  } else if (ext === 'glb') {
    const buf = await file.arrayBuffer();
    parsed = await new Promise((resolve, reject) =>
      loader.parse(buf, '', resolve, reject));
  } else if (ext === 'fbx') {
    const buf = await file.arrayBuffer();
    parsed = loader.parse(buf, '');
  }

  // STL → BufferGeometry; PLY → BufferGeometry; OBJ → Group; GLTF → { scene };
  // FBX → Group.
  let root;
  if (parsed?.isBufferGeometry) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    root = new THREE.Mesh(parsed, mat);
  } else if (parsed?.scene) {
    root = parsed.scene;
  } else if (parsed?.isObject3D) {
    root = parsed;
  } else if (parsed?.isGroup) {
    root = parsed;
  } else {
    throw new Error(`Loader for .${ext} returned an unrecognised result`);
  }
  const base = (file.name.replace(/\.[^.]+$/, '') || 'import').slice(0, 32);
  return _flattenSceneToSlateObjects(root, base);
}

// ── Public: export the current Slate scene to a Blob ──────────────────────
/** Build a THREE.Scene containing meshes for each Slate object. Used both
 *  for in-app export and for headless conversion. */
function _buildThreeSceneFromSlateObjects(objects) {
  const scene = new THREE.Scene();
  const triangulate = poly => {
    if (!Array.isArray(poly) || poly.length < 3) return [];
    const out = [];
    for (let i = 1; i < poly.length - 1; i++) out.push(poly[0], poly[i], poly[i + 1]);
    return out;
  };
  const primitiveGeo = obj => {
    const p = obj.params || {};
    switch (obj.type) {
      case 'cube':       return new THREE.BoxGeometry(p.size ?? 1, p.size ?? 1, p.size ?? 1);
      case 'sphere':     return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 24, p.heightSegments ?? 16);
      case 'plane':      return new THREE.PlaneGeometry(p.width ?? 2, p.height ?? 2);
      case 'cylinder':   return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
      case 'cone':       return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
      case 'torus':      return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.18, p.radialSegments ?? 16, p.tubularSegments ?? 32);
      case 'octahedron': return new THREE.OctahedronGeometry(p.radius ?? 0.55, p.detail ?? 0);
      case 'tetrahedron':return new THREE.TetrahedronGeometry(p.radius ?? 0.55, p.detail ?? 0);
      case 'icosahedron':return new THREE.IcosahedronGeometry(p.radius ?? 0.5, p.detail ?? 0);
      case 'capsule':    return new THREE.CapsuleGeometry(p.radius ?? 0.35, p.length ?? 0.9, p.capSegments ?? 4, p.radialSegments ?? 12);
      default:           return null;
    }
  };
  for (const obj of objects || []) {
    if (obj.type === 'folder' || obj.visible === false) continue;
    let geo;
    if (obj.type === 'mesh' && obj.meshData) {
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(
        new Float32Array(obj.meshData.vertices || []), 3));
      const idx = [];
      for (const f of (obj.meshData.faces || [])) idx.push(...triangulate(f));
      if (idx.length) geo.setIndex(idx);
      geo.computeVertexNormals();
    } else {
      geo = primitiveGeo(obj);
    }
    if (!geo) continue;
    const colorHex = (obj.color && /^#[0-9a-f]{6}$/i.test(obj.color)) ? obj.color : '#cccccc';
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colorHex) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = obj.name || `obj_${obj.id}`;
    if (Array.isArray(obj.position)) mesh.position.fromArray(obj.position);
    if (Array.isArray(obj.rotation)) mesh.rotation.fromArray(obj.rotation);
    if (Array.isArray(obj.scale))    mesh.scale.fromArray(obj.scale);
    scene.add(mesh);
  }
  return scene;
}

/** Export the supplied Slate objects as the chosen file format. Returns a
 *  Promise resolving to `{ blob, filename }` so the caller can hand it to
 *  the browser's download anchor. */
export async function exportModelAs(objects, format, baseName = 'slate-scene') {
  const ext = format.toLowerCase();
  if (ext === 'fbx') {
    // Re-use the existing ASCII writer so we don't ship two FBX paths.
    if (!window.slateExportFbx) await import('./fbx-export.js');
    if (!window.slateExportFbx) throw new Error('FBX exporter unavailable');
    const text = window.slateExportFbx({ objects, creator: 'Slate' });
    const blob = new Blob([text], { type: 'application/octet-stream' });
    return { blob, filename: `${baseName}.fbx` };
  }
  const ExporterCls = await _exporterFor(ext);
  const exporter = new ExporterCls();
  const scene = _buildThreeSceneFromSlateObjects(objects);
  if (ext === 'obj') {
    const text = exporter.parse(scene);
    return { blob: new Blob([text], { type: 'text/plain' }), filename: `${baseName}.obj` };
  }
  if (ext === 'stl') {
    // STLExporter.parse(scene, { binary: true }) returns a DataView.
    const dv = exporter.parse(scene, { binary: true });
    return { blob: new Blob([dv], { type: 'model/stl' }), filename: `${baseName}.stl` };
  }
  if (ext === 'ply') {
    const text = exporter.parse(scene, { binary: false });
    return { blob: new Blob([text], { type: 'text/plain' }), filename: `${baseName}.ply` };
  }
  if (ext === 'gltf' || ext === 'glb') {
    const binary = ext === 'glb';
    const result = await new Promise((resolve, reject) =>
      exporter.parse(scene, resolve, reject, { binary }));
    if (binary) {
      return { blob: new Blob([result], { type: 'model/gltf-binary' }), filename: `${baseName}.glb` };
    }
    return { blob: new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' }), filename: `${baseName}.gltf` };
  }
  throw new Error(`Unsupported export format: ${ext}`);
}

// ── Public: download a Blob via a hidden anchor ───────────────────────────
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
