/**
 * editor3d.js — Blender-style 3D viewport for Slate.
 *
 *  • Reads / writes window.slateScene3d (which is doc.scene3d on the host page).
 *  • Object mode: orbit/pan/zoom, TransformControls gizmos (G/R/S), add primitives,
 *    delete, frame.
 *  • Edit mode: per-mesh vertex / edge / face selection and translation. On exit the
 *    edited mesh is converted to a generic 'mesh' type and synced over the wire.
 *  • Hierarchy outliner panel is registered with the dock so it replaces the
 *    Layers panel while in 3D mode.
 */
import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

/* ─────────────────────────────────────────────────────────────────────────
   Module state
───────────────────────────────────────────────────────────────────────── */
let container = null;
let renderer  = null;
let scene     = null;
let camera    = null;
let orbit     = null;
let transform = null;
let raycaster = null;
const pointer = new THREE.Vector2();

let raf = 0;
let bound = false;
let vvResizeBound = false;

/** Selected scene object id (object mode). */
let selectedId = null;
/** Map from scene object id → THREE.Mesh */
const objMeshes = new Map();

/** Current top-level mode: 'object' | 'edit' */
let editorMode    = 'object';
let transformMode = 'translate';

/** Edit-mode sub-mode + state. */
let editSubMode  = 'vertex'; // 'vertex' | 'edge' | 'face'
let editTargetId = null;
let editHelpers  = null;     // { vertexPoints, edgeLines, faceMesh, group }
let editSelection = new Set();
let editDragHelper = null;   // Object3D the gizmo is attached to in edit mode

/** Unsub function from slateScene3d.onChange */
let unsubScene = null;

/** Hierarchy panel registration */
let hierarchyEl = null;
let hierarchyRegistered = false;

/* ─────────────────────────────────────────────────────────────────────────
   Geometry factory
───────────────────────────────────────────────────────────────────────── */
function makeGeometryFor(obj) {
  const p = obj.params || {};
  switch (obj.type) {
    case 'cube':     return new THREE.BoxGeometry(p.size ?? 1, p.size ?? 1, p.size ?? 1);
    case 'sphere':   return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 24, p.heightSegments ?? 16);
    case 'plane':    return new THREE.PlaneGeometry(p.width ?? 2, p.height ?? 2);
    case 'cylinder': return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case 'cone':     return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case 'torus':    return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.18, p.radialSegments ?? 16, p.tubularSegments ?? 32);
    case 'mesh': {
      const geo = new THREE.BufferGeometry();
      const md = obj.meshData || { vertices: [], faces: [] };
      if (md.vertices?.length) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(md.vertices), 3));
      }
      if (md.faces?.length) geo.setIndex(md.faces);
      geo.computeVertexNormals();
      return geo;
    }
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

function applyObjState(mesh, obj) {
  mesh.position.set(obj.position[0] || 0, obj.position[1] || 0, obj.position[2] || 0);
  mesh.rotation.set(obj.rotation[0] || 0, obj.rotation[1] || 0, obj.rotation[2] || 0);
  mesh.scale.set(obj.scale[0] || 1,    obj.scale[1] || 1,    obj.scale[2] || 1);
  mesh.visible = obj.visible !== false;
  if (mesh.material && mesh.material.color && obj.color) {
    try { mesh.material.color.set(obj.color); } catch (_) {}
  }
  mesh.userData.objId = obj.id;
  mesh.userData.selectable = true;
}

function buildMesh(obj) {
  const geo = makeGeometryFor(obj);
  const mat = new THREE.MeshStandardMaterial({
    color: obj.color || '#7c6aff', roughness: 0.45, metalness: 0.15,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  applyObjState(mesh, obj);
  return mesh;
}

function disposeMesh(mesh) {
  if (!mesh) return;
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) {
    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose?.());
    else mesh.material.dispose?.();
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Scene sync — reconcile Three.js scene with window.slateScene3d
───────────────────────────────────────────────────────────────────────── */
function syncSceneFromDoc() {
  if (!scene) return;
  const api = window.slateScene3d;
  const objects = api?.objects || [];
  const seen = new Set();

  objects.forEach(obj => {
    seen.add(obj.id);
    let mesh = objMeshes.get(obj.id);
    if (!mesh) {
      mesh = buildMesh(obj);
      objMeshes.set(obj.id, mesh);
      scene.add(mesh);
    } else {
      // If the type/params/meshData changed, rebuild geometry.
      const cachedType = mesh.userData.objType;
      const cachedParamsHash = mesh.userData.paramsHash;
      const newHash = obj.type + '::' + JSON.stringify(obj.params || {}) +
                      (obj.type === 'mesh' ? JSON.stringify(obj.meshData || {}) : '');
      if (cachedType !== obj.type || cachedParamsHash !== newHash) {
        const newGeo = makeGeometryFor(obj);
        if (mesh.geometry) mesh.geometry.dispose();
        mesh.geometry = newGeo;
      }
      mesh.userData.objType = obj.type;
      mesh.userData.paramsHash = newHash;
      applyObjState(mesh, obj);
    }
  });

  // Remove deleted meshes
  [...objMeshes.keys()].forEach(id => {
    if (!seen.has(id)) {
      const m = objMeshes.get(id);
      if (m === transform?.object) transform.detach();
      scene.remove(m);
      disposeMesh(m);
      objMeshes.delete(id);
      if (selectedId === id)  selectedId  = null;
      if (editTargetId === id) leaveEditMode();
    }
  });

  // Reapply selection
  if (selectedId && objMeshes.has(selectedId) && editorMode === 'object') {
    transform?.attach(objMeshes.get(selectedId));
  } else if (selectedId && !objMeshes.has(selectedId)) {
    selectedId = null;
    transform?.detach();
  }

  // Refresh edit helpers if we're in edit mode on a mesh that just changed
  if (editorMode === 'edit' && editTargetId) {
    const m = objMeshes.get(editTargetId);
    if (!m) leaveEditMode();
  }

  renderHierarchy();
}

/* ─────────────────────────────────────────────────────────────────────────
   Picking / selection
───────────────────────────────────────────────────────────────────────── */
function pickObject(clientX, clientY) {
  if (!container || !camera) return null;
  const rect = container.getBoundingClientRect();
  pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  scene.traverse(o => { if (o.isMesh && o.userData.selectable && o.visible) meshes.push(o); });
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0].object : null;
}

function selectById(id) {
  selectedId = id || null;
  if (editorMode === 'object') {
    if (id && objMeshes.has(id)) transform?.attach(objMeshes.get(id));
    else transform?.detach();
  }
  renderHierarchy();
}

let _downX = 0, _downY = 0, _downAt = 0;
function onPointerDown(e) {
  if (e.button !== 0 || !orbit) return;
  if (transform?.dragging) return;
  _downX = e.clientX; _downY = e.clientY; _downAt = performance.now();
}

function onPointerUp(e) {
  if (e.button !== 0 || !orbit) return;
  if (transform?.dragging) return;
  // Treat as a click only when pointer barely moved (i.e. not a drag-orbit).
  const moved = Math.hypot(e.clientX - _downX, e.clientY - _downY);
  if (moved > 5) return;

  if (editorMode === 'edit') {
    handleEditClick(e);
    return;
  }
  const hit = pickObject(e.clientX, e.clientY);
  if (hit && hit.userData.objId) selectById(hit.userData.objId);
  else                            selectById(null);
}

/* ─────────────────────────────────────────────────────────────────────────
   Keyboard shortcuts (Blender-style: G/R/S, Tab, 1/2/3, Del, F)
───────────────────────────────────────────────────────────────────────── */
function onKeyDown(e) {
  if (!container || !container.isConnected) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  if (e.key === 'Tab') { e.preventDefault(); toggleEditMode(); return; }

  if (e.key === 'g' || e.key === 'G') { setTransformMode('translate'); e.preventDefault(); return; }
  if (e.key === 'r' || e.key === 'R') { setTransformMode('rotate');    e.preventDefault(); return; }
  if (e.key === 's' || e.key === 'S') { setTransformMode('scale');     e.preventDefault(); return; }
  if (e.key === 'f' || e.key === 'F') { frameSelected(); e.preventDefault(); return; }

  if (editorMode === 'edit') {
    if (e.key === '1') { setEditSubMode('vertex'); e.preventDefault(); return; }
    if (e.key === '2') { setEditSubMode('edge');   e.preventDefault(); return; }
    if (e.key === '3') { setEditSubMode('face');   e.preventDefault(); return; }
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && editorMode === 'object' && selectedId) {
    window.slateScene3d?.remove(selectedId);
    selectedId = null;
    transform?.detach();
    e.preventDefault();
  }
}

function setTransformMode(mode) {
  transformMode = mode;
  if (transform) transform.setMode(mode);
  document.querySelectorAll('#toolbar-3d .t3d-tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tt === mode);
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Frame selected (F)
───────────────────────────────────────────────────────────────────────── */
function frameSelected() {
  if (!orbit || !camera) return;
  let target = null;
  if (editorMode === 'object' && selectedId)         target = objMeshes.get(selectedId);
  else if (editorMode === 'edit' && editTargetId)    target = objMeshes.get(editTargetId);
  if (!target) {
    orbit.target.set(0, 0.5, 0);
    camera.position.set(4, 3.5, 6);
    orbit.update();
    return;
  }
  const box = new THREE.Box3().setFromObject(target);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3()).length();
  const dist   = Math.max(2, size * 1.6);
  const dir = new THREE.Vector3().subVectors(camera.position, orbit.target).normalize();
  orbit.target.copy(center);
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  orbit.update();
}

/* ─────────────────────────────────────────────────────────────────────────
   Edit mode (Blender-style mesh editing)
───────────────────────────────────────────────────────────────────────── */
function toggleEditMode() {
  if (editorMode === 'object') enterEditMode();
  else leaveEditMode();
}

function enterEditMode() {
  if (!selectedId) return;
  editTargetId = selectedId;
  editorMode = 'edit';
  editSelection.clear();
  buildEditHelpers();
  if (transform) transform.detach();
  updateModeButtons();
  updateToolbarVisibility();
  renderHierarchy();
}

function leaveEditMode() {
  if (editTargetId && editHelpers) commitEditChanges();
  destroyEditHelpers();
  editTargetId = null;
  editorMode = 'object';
  editSelection.clear();
  if (transform) transform.detach();
  if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
  updateModeButtons();
  updateToolbarVisibility();
  renderHierarchy();
}

function buildEditHelpers() {
  destroyEditHelpers();
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;

  // Ensure geometry has a position attribute we can clone for editing.
  const geo = mesh.geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return;

  // Hide the source mesh while editing (keep wireframe overlay for context).
  mesh.material = mesh.material.clone();
  mesh.material.transparent = true;
  mesh.material.opacity = 0.35;
  mesh.material.needsUpdate = true;

  const group = new THREE.Group();
  group.position.copy(mesh.position);
  group.rotation.copy(mesh.rotation);
  group.scale.copy(mesh.scale);
  scene.add(group);

  // Wire overlay
  const wireGeo = new THREE.WireframeGeometry(geo);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x22d3a5, depthTest: false, transparent: true, opacity: 0.85 });
  const wire = new THREE.LineSegments(wireGeo, wireMat);
  wire.renderOrder = 2;
  group.add(wire);

  // Vertex points (Points object) — local positions matching geometry
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', posAttr.clone());
  const pointsMat = new THREE.PointsMaterial({
    color: 0x000000, size: 8, sizeAttenuation: false, depthTest: false,
  });
  const points = new THREE.Points(pointsGeo, pointsMat);
  points.renderOrder = 3;
  group.add(points);

  // Selected-vertices markers (re-rendered on selection change)
  const selPointsGeo = new THREE.BufferGeometry();
  selPointsGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  const selPointsMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 11, sizeAttenuation: false, depthTest: false,
  });
  const selPoints = new THREE.Points(selPointsGeo, selPointsMat);
  selPoints.renderOrder = 4;
  group.add(selPoints);

  editHelpers = { group, wire, points, selPoints, posAttr };
}

function refreshEditHelpers() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  // Update wireframe geometry from current geometry
  const newWire = new THREE.WireframeGeometry(mesh.geometry);
  if (editHelpers.wire.geometry) editHelpers.wire.geometry.dispose();
  editHelpers.wire.geometry = newWire;

  // Update vertex points (positions match geometry)
  const posAttr = mesh.geometry.getAttribute('position');
  editHelpers.points.geometry.setAttribute('position', posAttr.clone());
  editHelpers.points.geometry.attributes.position.needsUpdate = true;

  refreshSelectionMarker();
}

function refreshSelectionMarker() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  const pts = [];
  editSelection.forEach(i => {
    if (i < posAttr.count) {
      pts.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
  });
  editHelpers.selPoints.geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(pts), 3)
  );
}

function destroyEditHelpers() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (mesh && mesh.material) {
    mesh.material.transparent = false;
    mesh.material.opacity = 1;
    mesh.material.needsUpdate = true;
  }
  if (editHelpers.group) scene.remove(editHelpers.group);
  if (editHelpers.wire?.geometry)    editHelpers.wire.geometry.dispose();
  if (editHelpers.wire?.material)    editHelpers.wire.material.dispose();
  if (editHelpers.points?.geometry)  editHelpers.points.geometry.dispose();
  if (editHelpers.points?.material)  editHelpers.points.material.dispose();
  if (editHelpers.selPoints?.geometry) editHelpers.selPoints.geometry.dispose();
  if (editHelpers.selPoints?.material) editHelpers.selPoints.material.dispose();
  if (editDragHelper) { scene.remove(editDragHelper); editDragHelper = null; }
  editHelpers = null;
}

/** Convert clientX/Y to a NDC and find the closest vertex within a screen-space threshold. */
function pickVertex(clientX, clientY) {
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return -1;
  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return -1;
  const rect = container.getBoundingClientRect();
  const nx =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((clientY - rect.top)  / rect.height) * 2 + 1;

  const worldMat = mesh.matrixWorld;
  const v = new THREE.Vector3();
  let best = -1; let bestDist = Infinity;
  const threshold = 0.04; // NDC units
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(worldMat).project(camera);
    if (v.z > 1) continue;
    const dx = v.x - nx, dy = v.y - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; best = i; }
  }
  return Math.sqrt(bestDist) <= threshold ? best : -1;
}

/** Get the set of vertex indices that make up the closest face under the cursor. */
function pickFaceVertices(clientX, clientY) {
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return null;
  const rect = container.getBoundingClientRect();
  pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length || !hits[0].face) return null;
  const f = hits[0].face;
  return [f.a, f.b, f.c];
}

function handleEditClick(e) {
  if (!editHelpers || !editTargetId) return;
  const additive = e.shiftKey;
  let changed = false;

  if (editSubMode === 'vertex') {
    const i = pickVertex(e.clientX, e.clientY);
    if (i >= 0) {
      if (!additive) editSelection.clear();
      if (editSelection.has(i)) editSelection.delete(i); else editSelection.add(i);
      changed = true;
    } else if (!additive) {
      editSelection.clear(); changed = true;
    }
  } else if (editSubMode === 'face') {
    const verts = pickFaceVertices(e.clientX, e.clientY);
    if (verts) {
      if (!additive) editSelection.clear();
      verts.forEach(v => editSelection.add(v));
      changed = true;
    } else if (!additive) { editSelection.clear(); changed = true; }
  } else if (editSubMode === 'edge') {
    // Approximate: pick two nearest vertices to the click
    const verts = pickFaceVertices(e.clientX, e.clientY);
    if (verts && verts.length >= 2) {
      if (!additive) editSelection.clear();
      // Pick the two vertices closest to the click in screen space
      const candidates = [...new Set(verts)];
      const screenSpaceDist = idx => {
        const v = new THREE.Vector3();
        const posAttr = objMeshes.get(editTargetId).geometry.getAttribute('position');
        v.fromBufferAttribute(posAttr, idx).applyMatrix4(objMeshes.get(editTargetId).matrixWorld).project(camera);
        const rect = container.getBoundingClientRect();
        const nx =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        const ny = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
        return Math.hypot(v.x - nx, v.y - ny);
      };
      candidates.sort((a, b) => screenSpaceDist(a) - screenSpaceDist(b));
      candidates.slice(0, 2).forEach(v => editSelection.add(v));
      changed = true;
    } else if (!additive) { editSelection.clear(); changed = true; }
  }

  if (changed) {
    refreshSelectionMarker();
    attachGizmoToEditSelection();
  }
}

function attachGizmoToEditSelection() {
  if (!editHelpers || !editTargetId) { transform?.detach(); return; }
  const mesh = objMeshes.get(editTargetId);
  const posAttr = mesh?.geometry.getAttribute('position');
  if (!posAttr || editSelection.size === 0) { transform?.detach(); return; }

  // Centroid in world space
  const c = new THREE.Vector3();
  let n = 0;
  const tmp = new THREE.Vector3();
  editSelection.forEach(i => {
    tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    c.add(tmp); n++;
  });
  if (n === 0) { transform?.detach(); return; }
  c.divideScalar(n);

  if (!editDragHelper) {
    editDragHelper = new THREE.Object3D();
    scene.add(editDragHelper);
  }
  editDragHelper.position.copy(c);
  editDragHelper.rotation.set(0, 0, 0);
  editDragHelper.scale.set(1, 1, 1);
  editDragHelper.userData.lastPos = c.clone();
  editDragHelper.userData.lastQuat = editDragHelper.quaternion.clone();
  editDragHelper.userData.lastScale = editDragHelper.scale.clone();
  transform.attach(editDragHelper);
}

function applyEditTransformDelta() {
  if (!editHelpers || !editTargetId || !editDragHelper) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return;

  const invWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const last = editDragHelper.userData.lastPos.clone();
  const curr = editDragHelper.position.clone();
  const lastQuat = editDragHelper.userData.lastQuat.clone();
  const currQuat = editDragHelper.quaternion.clone();
  const lastScl = editDragHelper.userData.lastScale.clone();
  const currScl = editDragHelper.scale.clone();

  // Local-space pivot = last gizmo center in local space.
  const pivotLocal = last.clone().applyMatrix4(invWorld);
  const newPivotLocal = curr.clone().applyMatrix4(invWorld);

  // Compute local quaternion delta. Convert delta from world space to local.
  const deltaQuatW = currQuat.clone().multiply(lastQuat.clone().invert());
  const meshWorldQuat = new THREE.Quaternion();
  mesh.getWorldQuaternion(meshWorldQuat);
  const invMeshQuat = meshWorldQuat.clone().invert();
  const deltaQuatL = invMeshQuat.clone().multiply(deltaQuatW).multiply(meshWorldQuat);

  // Scale ratio
  const sx = (currScl.x || 1) / (lastScl.x || 1);
  const sy = (currScl.y || 1) / (lastScl.y || 1);
  const sz = (currScl.z || 1) / (lastScl.z || 1);

  const v = new THREE.Vector3();
  editSelection.forEach(i => {
    v.fromBufferAttribute(posAttr, i);
    // Apply: subtract old pivot → scale → rotate → add new pivot
    v.sub(pivotLocal);
    if (transformMode === 'scale')      v.set(v.x * sx, v.y * sy, v.z * sz);
    if (transformMode === 'rotate')     v.applyQuaternion(deltaQuatL);
    v.add(newPivotLocal);
    posAttr.setXYZ(i, v.x, v.y, v.z);
  });
  posAttr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  refreshEditHelpers();

  // Refresh "lasts" so subsequent gizmo motion is delta-based.
  editDragHelper.userData.lastPos = curr.clone();
  editDragHelper.userData.lastQuat = currQuat.clone();
  editDragHelper.userData.lastScale = currScl.clone();
}

function commitEditChanges() {
  if (!editTargetId) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return;
  const vertices = Array.from(posAttr.array);
  const indexAttr = mesh.geometry.getIndex();
  const faces = indexAttr ? Array.from(indexAttr.array) : (() => {
    // Generate trivial face list from triangle soup
    const arr = []; for (let i = 0; i < posAttr.count; i++) arr.push(i); return arr;
  })();
  window.slateScene3d?.setMeshData(editTargetId, { vertices, faces });
}

function setEditSubMode(mode) {
  editSubMode = mode;
  editSelection.clear();
  refreshSelectionMarker();
  transform?.detach();
  document.querySelectorAll('#toolbar-3d .t3d-esel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sel === mode);
  });
}

function updateModeButtons() {
  document.querySelectorAll('#toolbar-3d .t3d-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === editorMode);
  });
}
function updateToolbarVisibility() {
  const editGroup = document.getElementById('t3d-edit-select-group');
  const sep = document.getElementById('t3d-edit-sep');
  if (editGroup) editGroup.style.display = editorMode === 'edit' ? 'flex' : 'none';
  if (sep)       sep.style.display       = editorMode === 'edit' ? 'block' : 'none';
}

/* ─────────────────────────────────────────────────────────────────────────
   Scene setup / render loop
───────────────────────────────────────────────────────────────────────── */
function ensureScene() {
  if (scene) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121a);

  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
  camera.position.set(4, 3.5, 6);

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(4, 10, 6);
  scene.add(dir);

  // Floor grid (Blender-style infinite-ish ground reference).
  const grid = new THREE.GridHelper(40, 40, 0x3a3a4d, 0x252530);
  grid.userData.helper = true;
  scene.add(grid);

  // Axis helper at origin
  const axes = new THREE.AxesHelper(0.8);
  axes.userData.helper = true;
  scene.add(axes);

  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.06;
}

function resize() {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth  || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!renderer || !scene || !camera || !container?.isConnected) return;
  if (orbit) orbit.update();
  renderer.render(scene, camera);
}

function onVisualViewportChange() { resize(); }

function bindEvents() {
  if (bound || !container) return;
  bound = true;
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeyDown, true);
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointerup',   onPointerUp);
  if (window.visualViewport && !vvResizeBound) {
    vvResizeBound = true;
    window.visualViewport.addEventListener('resize', onVisualViewportChange);
    window.visualViewport.addEventListener('scroll', onVisualViewportChange);
  }
}
function unbindEvents() {
  if (!bound) return;
  bound = false;
  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onKeyDown, true);
  if (container) {
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointerup',   onPointerUp);
  }
  if (window.visualViewport && vvResizeBound) {
    vvResizeBound = false;
    window.visualViewport.removeEventListener('resize', onVisualViewportChange);
    window.visualViewport.removeEventListener('scroll', onVisualViewportChange);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Toolbar wiring (idempotent)
───────────────────────────────────────────────────────────────────────── */
let toolbarBound = false;
function bindToolbar() {
  if (toolbarBound) return;
  const tb = document.getElementById('toolbar-3d');
  if (!tb) return;
  toolbarBound = true;

  tb.querySelectorAll('.t3d-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTransformMode(btn.dataset.tt));
  });
  tb.querySelectorAll('.t3d-add-btn').forEach(btn => {
    btn.addEventListener('click', () => addPrimitive(btn.dataset.prim));
  });
  tb.querySelectorAll('.t3d-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const want = btn.dataset.mode;
      if (want === editorMode) return;
      if (want === 'edit') enterEditMode(); else leaveEditMode();
    });
  });
  tb.querySelectorAll('.t3d-esel-btn').forEach(btn => {
    btn.addEventListener('click', () => setEditSubMode(btn.dataset.sel));
  });
  document.getElementById('t3d-delete-btn')?.addEventListener('click', () => {
    if (editorMode === 'object' && selectedId) window.slateScene3d?.remove(selectedId);
  });
  document.getElementById('t3d-frame-btn')?.addEventListener('click', frameSelected);
}

function addPrimitive(kind) {
  if (!window.slateScene3d) return;
  const presets = {
    cube:     { type: 'cube',     name: 'Cube',     params: { size: 1 },      position: [0, 0.5, 0],  color: '#7c6aff' },
    sphere:   { type: 'sphere',   name: 'Sphere',   params: { radius: 0.5 },  position: [0, 0.5, 0],  color: '#22d3a5' },
    plane:    { type: 'plane',    name: 'Plane',    params: { width: 2, height: 2 }, position: [0, 0.001, 0], rotation: [-Math.PI / 2, 0, 0], color: '#a3a3a3' },
    cylinder: { type: 'cylinder', name: 'Cylinder', params: { radiusTop: 0.5, radiusBottom: 0.5, height: 1 }, position: [0, 0.5, 0], color: '#f59e0b' },
    cone:     { type: 'cone',     name: 'Cone',     params: { radius: 0.5, height: 1 }, position: [0, 0.5, 0], color: '#ef4444' },
    torus:    { type: 'torus',    name: 'Torus',    params: { radius: 0.5, tube: 0.18 }, position: [0, 0.5, 0], color: '#38bdf8' },
  };
  const spec = presets[kind] || presets.cube;
  const obj = window.slateScene3d.add(spec);
  if (obj) selectById(obj.id);
}

/* ─────────────────────────────────────────────────────────────────────────
   Hierarchy outliner — Blender-style tree (currently flat list)
───────────────────────────────────────────────────────────────────────── */
function ensureHierarchyPanel() {
  if (hierarchyRegistered) return;
  if (!window.slateDock || typeof window.slateDock.registerPanel !== 'function') {
    // Dock not ready yet; try again next frame.
    requestAnimationFrame(ensureHierarchyPanel);
    return;
  }
  window.slateDock.registerPanel({
    id: 'hierarchy',
    title: 'Hierarchy',
    order: 4,   // appears before Layers (order 10)
    mount(el) {
      el.innerHTML = `
        <div style="padding:8px 10px 6px;font-size:.68rem;font-weight:600;color:var(--text-dim);
          letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border);
          display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          Scene
          <span id="hierarchy-count" style="font-weight:500;color:var(--text-mid);text-transform:none;letter-spacing:0">0</span>
        </div>
        <div id="hierarchy-list" style="flex:1;min-height:0;overflow-y:auto"></div>
      `;
      hierarchyEl = el.querySelector('#hierarchy-list');
      renderHierarchy();
    },
  });
  hierarchyRegistered = true;
}

function renderHierarchy() {
  if (!hierarchyEl) {
    hierarchyEl = document.getElementById('hierarchy-list');
    if (!hierarchyEl) return;
  }
  const objects = window.slateScene3d?.objects || [];
  const countEl = document.getElementById('hierarchy-count');
  if (countEl) countEl.textContent = objects.length;

  if (!objects.length) {
    hierarchyEl.innerHTML = `<div class="outliner-empty">No objects yet. Use the Add menu in the toolbar.</div>`;
    return;
  }

  hierarchyEl.innerHTML = objects.map(obj => {
    const sel = obj.id === selectedId || obj.id === editTargetId;
    const visible = obj.visible !== false;
    const icon = OUTLINER_ICONS[obj.type] || OUTLINER_ICONS.default;
    return `<div class="outliner-row${sel ? ' selected' : ''}${visible ? '' : ' hidden-obj'}" draggable="true" data-oid="${obj.id}">
      <span class="out-icon">${icon}</span>
      <span class="out-name" data-oid="${obj.id}">${_escape(obj.name)}</span>
      <button class="out-vis-btn" data-oid="${obj.id}" title="Toggle visibility">
        ${visible
          ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="6.5" cy="6.5" rx="5.5" ry="3.5"/><circle cx="6.5" cy="6.5" r="2"/></svg>`
          : `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><line x1="2" y1="2" x2="11" y2="11"/><path d="M4.5 4.5a5 5 0 0 0-3 2 5.5 5.5 0 0 0 9 1M8 3.5A5.5 5.5 0 0 1 12 6.5"/></svg>`}
      </button>
      <button class="out-del-btn" data-oid="${obj.id}" title="Delete">
        <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4h7M5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 6.5a1 1 0 0 0 1 .9h2a1 1 0 0 0 1-.9L9 4"/></svg>
      </button>
    </div>`;
  }).join('');

  hierarchyEl.querySelectorAll('.outliner-row').forEach(row => {
    const oid = row.dataset.oid;
    row.addEventListener('click', e => {
      if (e.target.closest('.out-vis-btn') || e.target.closest('.out-del-btn')) return;
      if (row.querySelector('.out-name input')) return;
      selectById(oid);
    });
    row.querySelector('.out-name')?.addEventListener('dblclick', e => {
      e.stopPropagation();
      beginOutlinerRename(row.querySelector('.out-name'));
    });
    row.querySelector('.out-vis-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const obj = window.slateScene3d?.find(oid);
      if (obj) window.slateScene3d.setVisible(oid, !obj.visible);
    });
    row.querySelector('.out-del-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      window.slateScene3d?.remove(oid);
    });
    bindOutlinerDrag(row);
  });
}

const OUTLINER_ICONS = {
  cube:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M7 1.5L12.5 4 7 6.5 1.5 4z"/><path d="M1.5 4v6L7 12.5V6.5"/><path d="M12.5 4v6L7 12.5"/></svg>`,
  sphere:   `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5.5"/><ellipse cx="7" cy="7" rx="5.5" ry="2.3"/></svg>`,
  plane:    `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4.5L7 2l5.5 2.5L7 7z"/></svg>`,
  cylinder: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="3" rx="4.5" ry="1.5"/><path d="M2.5 3v8a4.5 1.5 0 0 0 9 0V3"/></svg>`,
  cone:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 1.5L12 12H2z"/><ellipse cx="7" cy="12" rx="5" ry="1.3"/></svg>`,
  torus:    `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="7" rx="5.5" ry="2.5"/></svg>`,
  mesh:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4l5-2 5 2v6l-5 2-5-2z M2 4l5 2 5-2M7 6v6"/></svg>`,
  default:  `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="5"/></svg>`,
};
function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function beginOutlinerRename(span) {
  const id = span.dataset.oid;
  const obj = window.slateScene3d?.find(id);
  if (!obj) return;
  const original = obj.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 40;
  input.style.cssText = 'flex:1;min-width:0;font-size:.78rem;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:3px;padding:1px 4px;outline:none';
  span.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const val = input.value.trim();
    if (val && val !== original) window.slateScene3d.rename(id, val);
    renderHierarchy();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); committed = true; renderHierarchy(); }
  });
}
let _dragOutlinerId = null;
function bindOutlinerDrag(row) {
  row.addEventListener('dragstart', e => {
    _dragOutlinerId = row.dataset.oid;
    row.style.opacity = '0.4';
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragOutlinerId); } catch {}
  });
  row.addEventListener('dragend', () => {
    row.style.opacity = '';
    _dragOutlinerId = null;
    document.querySelectorAll('.outliner-row').forEach(r => r.style.borderTop = '');
  });
  row.addEventListener('dragover', e => {
    if (!_dragOutlinerId || _dragOutlinerId === row.dataset.oid) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    row.style.borderTop = '2px solid var(--accent)';
  });
  row.addEventListener('dragleave', () => { row.style.borderTop = ''; });
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.style.borderTop = '';
    if (!_dragOutlinerId || _dragOutlinerId === row.dataset.oid) return;
    const list = window.slateScene3d?.objects || [];
    const dropIdx = list.findIndex(o => o.id === row.dataset.oid);
    if (dropIdx < 0) return;
    window.slateScene3d.move(_dragOutlinerId, dropIdx);
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Lifecycle
───────────────────────────────────────────────────────────────────────── */
export function initEditor3D(rootEl) {
  if (!rootEl) return;
  if (container === rootEl && renderer) {
    resize(); bindEvents();
    cancelAnimationFrame(raf); loop();
    return;
  }
  disposeEditor3D();
  container = rootEl;
  container.style.touchAction = 'none';
  ensureScene();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.06;
  orbit.target.set(0, 0.4, 0);
  orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  transform = new TransformControls(camera, renderer.domElement);
  transform.setMode(transformMode);
  transform.addEventListener('dragging-changed', ev => {
    orbit.enabled = !ev.value;
    if (ev.value && editorMode === 'edit' && editDragHelper) {
      // Capture starting transforms so apply-delta works
      editDragHelper.userData.lastPos   = editDragHelper.position.clone();
      editDragHelper.userData.lastQuat  = editDragHelper.quaternion.clone();
      editDragHelper.userData.lastScale = editDragHelper.scale.clone();
    }
    if (!ev.value && editorMode === 'edit' && editTargetId) {
      // On drag end, commit final mesh data so remote peers get the result.
      commitEditChanges();
    }
  });
  transform.addEventListener('objectChange', () => {
    if (editorMode === 'edit') {
      applyEditTransformDelta();
    } else if (transform.object?.userData.objId) {
      // Push transform back to scene state continuously so other peers see motion.
      const mesh = transform.object;
      const id = mesh.userData.objId;
      window.slateScene3d?.setTransform(id, {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        scale:    [mesh.scale.x,    mesh.scale.y,    mesh.scale.z],
      });
    }
  });
  scene.add(transform);

  resize();
  bindEvents();
  bindToolbar();
  ensureHierarchyPanel();

  // Sync from current doc state and subscribe for future changes.
  syncSceneFromDoc();
  unsubScene = window.slateScene3d?.onChange(syncSceneFromDoc);
  updateModeButtons();
  updateToolbarVisibility();

  cancelAnimationFrame(raf);
  loop();
}

export function disposeEditor3D() {
  cancelAnimationFrame(raf);
  unbindEvents();

  if (typeof unsubScene === 'function') { unsubScene(); unsubScene = null; }

  destroyEditHelpers();
  editTargetId = null;
  editorMode = 'object';
  selectedId = null;

  if (transform) {
    transform.detach();
    if (scene) scene.remove(transform);
    if (typeof transform.dispose === 'function') transform.dispose();
    transform = null;
  }
  if (orbit) { orbit.dispose(); orbit = null; }

  if (renderer && renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  if (renderer) { renderer.dispose(); renderer = null; }

  if (scene) {
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose && m.dispose());
        else if (o.material.dispose) o.material.dispose();
      }
    });
  }
  scene = null;
  camera = null;
  objMeshes.clear();
  container = null;
}

// Register the hierarchy panel eagerly — it should exist even before the
// first 3D activation so the dock can switch to it immediately.
ensureHierarchyPanel();

window.addEventListener('slate-3d-activate', () => {
  const el = document.getElementById('canvas-area-3d');
  if (el) initEditor3D(el);
});
window.addEventListener('slate-3d-deactivate', () => {
  disposeEditor3D();
});
