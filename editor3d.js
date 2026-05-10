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
import { OrbitControls }       from 'three/addons/controls/OrbitControls.js';
import { TransformControls }   from 'three/addons/controls/TransformControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

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

/** Selected scene object id (object mode). The gizmo follows this id. */
let selectedId = null;
/** All selected ids — for multi-selection / box-select highlighting. */
const selectedIds = new Set();
/** Map from scene object id → THREE.Mesh */
const objMeshes = new Map();
/** Box-select state. */
let boxSelect = null;   // { x0, y0, x1, y1 } in client coords
let boxSelectEl = null; // overlay div for the rubber-band
/** Fly camera state. */
let flyEnabled  = false;
let flyControls = null;
let flyKeys     = new Set();
let flyHint     = null;
/** Peer camera markers. peerId -> { group, label, color } */
const peerCams = new Map();
/** Throttle for camera broadcasts. */
let _lastCamBroadcast = 0;
let _lastCamSent = null;

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
    case 'folder': return null;  // folders are outliner-only, no mesh
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
    // Folders are outliner-only — they don't get any Three.js mesh in the
    // scene, but we still track their id in `seen` so disposal works.
    if (obj.type === 'folder') return;
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

function selectById(id, additive = false) {
  if (!id) {
    if (!additive) {
      selectedIds.clear();
      selectedId = null;
      transform?.detach();
    }
  } else if (additive) {
    // Toggle membership; gizmo follows whichever was just clicked.
    if (selectedIds.has(id)) { selectedIds.delete(id); if (selectedId === id) selectedId = [...selectedIds].pop() || null; }
    else { selectedIds.add(id); selectedId = id; }
  } else {
    selectedIds.clear();
    selectedIds.add(id);
    selectedId = id;
  }
  if (editorMode === 'object') {
    if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
    else transform?.detach();
  }
  _refreshSelectionOutlines();
  renderHierarchy();
}

function selectAllObjects() {
  const api = window.slateScene3d;
  if (!api) return;
  selectedIds.clear();
  api.objects.forEach(o => { if (o.type !== 'folder') selectedIds.add(o.id); });
  selectedId = [...selectedIds].pop() || null;
  if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
  _refreshSelectionOutlines();
  renderHierarchy();
}

/* Apply a subtle emissive outline to every selected mesh so multi-select is
   visually obvious without needing the gizmo to attach to multiple objects. */
function _refreshSelectionOutlines() {
  objMeshes.forEach((mesh, id) => {
    if (!mesh.material) return;
    if (mesh.material.emissive) {
      if (selectedIds.has(id)) {
        mesh.material.emissive.setHex(0x4a3aff);
        mesh.material.emissiveIntensity = 0.35;
      } else {
        mesh.material.emissive.setHex(0x000000);
        mesh.material.emissiveIntensity = 0;
      }
    }
  });
}

/* Duplicate the currently selected object with a small world-space offset. */
function duplicateSelected() {
  const api = window.slateScene3d;
  if (!api || !selectedId) return;
  const src = api.find(selectedId);
  if (!src || src.type === 'folder') return;
  const spec = {
    type: src.type,
    name: src.name + ' copy',
    position: [src.position[0] + 0.6, src.position[1], src.position[2] + 0.6],
    rotation: [...src.rotation],
    scale: [...src.scale],
    visible: src.visible,
    color: src.color,
    params: { ...src.params },
    parentId: src.parentId || null,
    meshData: src.meshData ? { vertices: [...src.meshData.vertices], faces: [...src.meshData.faces] } : undefined,
  };
  const obj = api.add(spec);
  if (obj) selectById(obj.id);
}

let _downX = 0, _downY = 0, _downAt = 0;
let _boxArmed = false;
function onPointerDown(e) {
  if (!orbit) return;
  if (flyEnabled) return;
  // In object mode, Shift+left-drag starts a Blender-style box select.
  if (e.button === 0 && editorMode === 'object' && e.shiftKey) {
    e.preventDefault();
    _boxArmed = true;
    orbit.enabled = false;
    boxSelect = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, additive: true };
    _showBoxSelectOverlay();
    container.addEventListener('pointermove', _onBoxMove);
    return;
  }
  if (e.button !== 0) return;
  if (transform?.dragging) return;
  _downX = e.clientX; _downY = e.clientY; _downAt = performance.now();
}

function onPointerUp(e) {
  if (!orbit) return;
  if (flyEnabled) return;
  // Finish box-select.
  if (_boxArmed && boxSelect) {
    _boxArmed = false;
    container.removeEventListener('pointermove', _onBoxMove);
    orbit.enabled = true;
    _hideBoxSelectOverlay();
    const w = Math.abs(boxSelect.x1 - boxSelect.x0);
    const h = Math.abs(boxSelect.y1 - boxSelect.y0);
    if (w > 4 || h > 4) _commitBoxSelect();
    boxSelect = null;
    return;
  }
  if (e.button !== 0) return;
  if (transform?.dragging) return;
  // Treat as a click only when pointer barely moved (i.e. not a drag-orbit).
  const moved = Math.hypot(e.clientX - _downX, e.clientY - _downY);
  if (moved > 5) return;

  if (editorMode === 'edit') {
    handleEditClick(e);
    return;
  }
  const hit = pickObject(e.clientX, e.clientY);
  if (hit && hit.userData.objId) selectById(hit.userData.objId, e.shiftKey);
  else if (!e.shiftKey)          selectById(null);
}

function _onBoxMove(e) {
  if (!boxSelect) return;
  boxSelect.x1 = e.clientX; boxSelect.y1 = e.clientY;
  _updateBoxSelectOverlay();
}

function _showBoxSelectOverlay() {
  if (!boxSelectEl) {
    boxSelectEl = document.createElement('div');
    boxSelectEl.className = 'box-select-overlay';
    container.appendChild(boxSelectEl);
  }
  boxSelectEl.style.display = 'block';
  _updateBoxSelectOverlay();
}
function _updateBoxSelectOverlay() {
  if (!boxSelectEl || !boxSelect || !container) return;
  const rect = container.getBoundingClientRect();
  const x = Math.min(boxSelect.x0, boxSelect.x1) - rect.left;
  const y = Math.min(boxSelect.y0, boxSelect.y1) - rect.top;
  const w = Math.abs(boxSelect.x1 - boxSelect.x0);
  const h = Math.abs(boxSelect.y1 - boxSelect.y0);
  boxSelectEl.style.left = x + 'px';
  boxSelectEl.style.top  = y + 'px';
  boxSelectEl.style.width  = w + 'px';
  boxSelectEl.style.height = h + 'px';
}
function _hideBoxSelectOverlay() {
  if (boxSelectEl) boxSelectEl.style.display = 'none';
}

/* For every object whose screen-space center lies inside the rubber-band,
   add it to the selection (additive, shift-style). */
function _commitBoxSelect() {
  if (!boxSelect || !container || !camera) return;
  const rect = container.getBoundingClientRect();
  const x0 = Math.min(boxSelect.x0, boxSelect.x1) - rect.left;
  const y0 = Math.min(boxSelect.y0, boxSelect.y1) - rect.top;
  const x1 = Math.max(boxSelect.x0, boxSelect.x1) - rect.left;
  const y1 = Math.max(boxSelect.y0, boxSelect.y1) - rect.top;
  const v = new THREE.Vector3();
  let lastHit = null;
  objMeshes.forEach((mesh, id) => {
    if (!mesh.visible) return;
    // Project the mesh's world-position into NDC then to screen.
    const center = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false);
    center.setFromMatrixPosition(mesh.matrixWorld);
    v.copy(center).project(camera);
    if (v.z > 1 || v.z < -1) return;
    const sx = (v.x * 0.5 + 0.5) * rect.width;
    const sy = (-v.y * 0.5 + 0.5) * rect.height;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) {
      selectedIds.add(id);
      lastHit = id;
    }
  });
  if (lastHit) selectedId = lastHit;
  if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
  _refreshSelectionOutlines();
  renderHierarchy();
}

/* ─────────────────────────────────────────────────────────────────────────
   Free-fly camera (Blender Shift+`)
   • PointerLockControls handles mouselook.
   • WASD to strafe / forward-back, QE for down/up, Shift = boost.
   • Esc or another Shift+` press exits.
───────────────────────────────────────────────────────────────────────── */
function toggleFlyCamera() {
  if (flyEnabled) exitFlyCamera(); else enterFlyCamera();
}

function enterFlyCamera() {
  if (!renderer || !camera || flyEnabled) return;
  if (!flyControls) {
    flyControls = new PointerLockControls(camera, renderer.domElement);
    flyControls.addEventListener('unlock', () => { if (flyEnabled) exitFlyCamera(); });
  }
  orbit.enabled = false;
  if (transform?.dragging) return;
  flyControls.lock();
  flyEnabled = true;
  flyKeys.clear();
  window.addEventListener('keydown', _onFlyKeyDown, true);
  window.addEventListener('keyup',   _onFlyKeyUp,   true);
  if (!flyHint) {
    flyHint = document.createElement('div');
    flyHint.className = 'fly-cam-hint';
    flyHint.textContent = 'Fly mode — WASD move, QE up/down, Shift boost, Esc to exit';
    container.appendChild(flyHint);
  } else {
    flyHint.style.display = '';
  }
}

function exitFlyCamera() {
  flyEnabled = false;
  flyKeys.clear();
  if (flyControls) flyControls.unlock();
  if (flyHint) flyHint.style.display = 'none';
  window.removeEventListener('keydown', _onFlyKeyDown, true);
  window.removeEventListener('keyup',   _onFlyKeyUp,   true);
  if (orbit && camera) {
    // Snap orbit.target to a point along the camera's new forward direction
    // so the next orbit doesn't whip back to the previous focus point.
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    orbit.target.copy(camera.position).add(fwd.multiplyScalar(4));
    orbit.enabled = true;
    orbit.update();
  }
}

function _onFlyKeyDown(e) {
  if (!flyEnabled) return;
  if (e.key === 'Escape') { e.preventDefault(); exitFlyCamera(); return; }
  flyKeys.add(e.key.toLowerCase());
  e.stopPropagation(); e.preventDefault();
}
function _onFlyKeyUp(e) {
  if (!flyEnabled) return;
  flyKeys.delete(e.key.toLowerCase());
  e.stopPropagation();
}

/* ─────────────────────────────────────────────────────────────────────────
   Peer cameras — broadcast my view, render others' views
───────────────────────────────────────────────────────────────────────── */
const CAM_BROADCAST_HZ = 6;            // 6 updates / second
const CAM_CHANGE_EPS   = 0.02;         // skip if camera barely moved

function _maybeBroadcastCamera(nowMs) {
  if (!document.body.classList.contains('mode-3d')) return;
  if (!camera || !orbit) return;
  if (!window.slatePeers || typeof window.slatePeers.broadcast !== 'function') return;
  if (nowMs - _lastCamBroadcast < 1000 / CAM_BROADCAST_HZ) return;
  const cur = [
    camera.position.x, camera.position.y, camera.position.z,
    orbit.target.x,    orbit.target.y,    orbit.target.z,
  ];
  if (_lastCamSent) {
    let moved = 0;
    for (let i = 0; i < 6; i++) moved = Math.max(moved, Math.abs(cur[i] - _lastCamSent[i]));
    if (moved < CAM_CHANGE_EPS) return;
  }
  _lastCamSent = cur;
  _lastCamBroadcast = nowMs;
  window.slatePeers.broadcast({
    type: 'cam-3d',
    pos: [cur[0], cur[1], cur[2]],
    target: [cur[3], cur[4], cur[5]],
  });
}

/** Called from the host page when a `cam-3d` message arrives. */
function applyPeerCamera(peerId, msg, meta) {
  if (!scene) return;
  if (!peerId || !msg || !Array.isArray(msg.pos) || !Array.isArray(msg.target)) return;
  let entry = peerCams.get(peerId);
  if (!entry) {
    const color = meta?.color || _peerColorFromId(peerId);
    const group = _buildCamMarker(color);
    scene.add(group);
    const label = document.createElement('div');
    label.className = 'peer-cam-tag';
    label.style.background = `linear-gradient(${color}cc, ${color}99)`;
    label.style.borderColor = color;
    label.textContent = meta?.name || peerId.slice(0, 6);
    if (container) container.appendChild(label);
    entry = { group, label, color };
    peerCams.set(peerId, entry);
  } else if (meta?.name && entry.label && entry.label.textContent !== meta.name) {
    entry.label.textContent = meta.name;
  }
  entry.group.position.set(msg.pos[0], msg.pos[1], msg.pos[2]);
  entry.group.lookAt(msg.target[0], msg.target[1], msg.target[2]);
}

function removePeerCamera(peerId) {
  const entry = peerCams.get(peerId);
  if (!entry) return;
  if (entry.group && scene) scene.remove(entry.group);
  entry.label?.remove();
  peerCams.delete(peerId);
}

function _peerColorFromId(id) {
  // Deterministic color from the peer id so the marker matches their cursor.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 60%)`;
}

function _buildCamMarker(color) {
  const g = new THREE.Group();
  // Tiny pyramid pointing along -Z (the camera forward).
  const geo = new THREE.ConeGeometry(0.18, 0.36, 4);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -0.18);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.55,
    roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide,
  });
  const cone = new THREE.Mesh(geo, mat);
  cone.castShadow = false; cone.receiveShadow = false;
  g.add(cone);
  // Wire frustum so it reads as a camera not a generic pyramid.
  const frustum = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
  );
  g.add(frustum);
  return g;
}

/* Position the HTML labels above each peer camera every frame. */
const _camLabelTmp = new THREE.Vector3();
function _updatePeerCamMarkers() {
  if (!camera || !container) return;
  const rect = container.getBoundingClientRect();
  peerCams.forEach(entry => {
    if (!entry.group || !entry.label) return;
    _camLabelTmp.copy(entry.group.position).project(camera);
    if (_camLabelTmp.z > 1 || _camLabelTmp.z < -1) {
      entry.label.style.display = 'none';
      return;
    }
    entry.label.style.display = '';
    const sx = (_camLabelTmp.x * 0.5 + 0.5) * rect.width;
    const sy = (-_camLabelTmp.y * 0.5 + 0.5) * rect.height;
    entry.label.style.left = sx + 'px';
    entry.label.style.top  = (sy - 18) + 'px';
  });
}

function _clearAllPeerCameras() {
  peerCams.forEach(entry => {
    if (entry.group && scene) scene.remove(entry.group);
    entry.label?.remove();
  });
  peerCams.clear();
}

/* Expose the receive entry point so the host page can route incoming
   cam-3d messages here. */
window.slateScene3dRpc = Object.assign(window.slateScene3dRpc || {}, {
  applyPeerCamera,
  removePeerCamera,
  clearAllPeerCameras: _clearAllPeerCameras,
});

const _flyTmp1 = new THREE.Vector3();
const _flyTmp2 = new THREE.Vector3();
function _stepFlyCamera(dt) {
  if (!flyEnabled || !camera) return;
  const boost = flyKeys.has('shift') ? 3.0 : 1.0;
  const speed = 4.5 * boost * dt;
  let f = 0, r = 0, u = 0;
  if (flyKeys.has('w')) f += 1;
  if (flyKeys.has('s')) f -= 1;
  if (flyKeys.has('d')) r += 1;
  if (flyKeys.has('a')) r -= 1;
  if (flyKeys.has('e') || flyKeys.has(' ')) u += 1;
  if (flyKeys.has('q')) u -= 1;
  if (f === 0 && r === 0 && u === 0) return;
  camera.getWorldDirection(_flyTmp1).normalize();
  _flyTmp2.crossVectors(_flyTmp1, camera.up).normalize();
  camera.position.addScaledVector(_flyTmp1, f * speed);
  camera.position.addScaledVector(_flyTmp2, r * speed);
  camera.position.y += u * speed;
}

/* ─────────────────────────────────────────────────────────────────────────
   Keyboard shortcuts (Blender-style: G/R/S, Tab, 1/2/3, Del, F)
───────────────────────────────────────────────────────────────────────── */
function onKeyDown(e) {
  if (!container || !container.isConnected) return;
  // Only handle 3D shortcuts while the 3D viewport is the active workspace.
  if (!document.body.classList.contains('mode-3d')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  // 3D shortcuts swallow these keys so they don't also fire 2D shortcuts.
  const swallow = () => { e.preventDefault(); e.stopPropagation(); };

  if (e.key === 'Tab')        { swallow(); toggleEditMode(); return; }
  if (e.key === 'g' || e.key === 'G') { swallow(); setTransformMode('translate'); return; }
  if (e.key === 'r' || e.key === 'R') { swallow(); setTransformMode('rotate');    return; }
  if (e.key === 's' || e.key === 'S') { swallow(); setTransformMode('scale');     return; }
  if (e.key === 'f' || e.key === 'F') { swallow(); frameSelected(); return; }
  if ((e.key === 'a' || e.key === 'A') && editorMode === 'object') { swallow(); selectAllObjects(); return; }
  if ((e.key === 'd' || e.key === 'D') && (e.shiftKey) && editorMode === 'object' && selectedId) {
    swallow(); duplicateSelected(); return;
  }
  if ((e.key === '`' || e.key === '~') && e.shiftKey) { swallow(); toggleFlyCamera(); return; }

  if (editorMode === 'edit') {
    if (e.key === '1') { swallow(); setEditSubMode('vertex'); return; }
    if (e.key === '2') { swallow(); setEditSubMode('edge');   return; }
    if (e.key === '3') { swallow(); setEditSubMode('face');   return; }
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && editorMode === 'object' && selectedId) {
    window.slateScene3d?.remove(selectedId);
    selectedId = null;
    transform?.detach();
    swallow();
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
  _gridHelper = grid;

  // Axis helper at origin
  const axes = new THREE.AxesHelper(0.8);
  axes.userData.helper = true;
  scene.add(axes);
  _axesHelper = axes;

  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.06;
}

let _gridHelper = null;
let _axesHelper = null;
function toggleGrid() {
  if (_gridHelper) _gridHelper.visible = !_gridHelper.visible;
  if (_axesHelper) _axesHelper.visible = _gridHelper?.visible !== false;
  const btn = document.getElementById('t3d-grid-btn');
  if (btn) btn.classList.toggle('active', _gridHelper?.visible !== false);
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

let _lastLoopTs = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  if (!renderer || !scene || !camera || !container?.isConnected) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - (_lastLoopTs || now)) / 1000);
  _lastLoopTs = now;
  if (flyEnabled) _stepFlyCamera(dt);
  if (orbit && !flyEnabled) orbit.update();
  _updatePeerCamMarkers();
  _maybeBroadcastCamera(now);
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
    if (editorMode !== 'object') return;
    const api = window.slateScene3d;
    if (!api) return;
    const ids = [...selectedIds];
    if (!ids.length && selectedId) ids.push(selectedId);
    ids.forEach(id => api.remove(id));
    selectedIds.clear(); selectedId = null;
    transform?.detach();
  });
  document.getElementById('t3d-frame-btn')?.addEventListener('click', frameSelected);
  document.getElementById('t3d-duplicate-btn')?.addEventListener('click', duplicateSelected);
  document.getElementById('t3d-fly-btn')?.addEventListener('click', toggleFlyCamera);
  document.getElementById('t3d-grid-btn')?.addEventListener('click', toggleGrid);
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
          display:flex;align-items:center;gap:6px;flex-shrink:0">
          <span style="flex:1">Scene</span>
          <button id="hierarchy-add-folder" class="out-tool-btn" title="New folder" style="font-weight:500">
            <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor"><path d="M1.5 3.7h4l1 1.2h6a.7.7 0 0 1 .7.7v6a.7.7 0 0 1-.7.7H1.5a.7.7 0 0 1-.7-.7V4.4a.7.7 0 0 1 .7-.7z"/></svg>
            <span>Folder</span>
          </button>
          <span id="hierarchy-count" style="font-weight:500;color:var(--text-mid);text-transform:none;letter-spacing:0;margin-left:4px">0</span>
        </div>
        <div id="hierarchy-list" style="flex:1;min-height:0;overflow-y:auto"></div>
      `;
      hierarchyEl = el.querySelector('#hierarchy-list');
      el.querySelector('#hierarchy-add-folder')?.addEventListener('click', () => {
        const folder = window.slateScene3d?.createFolder('Folder');
        if (folder) selectById(folder.id);
      });
      renderHierarchy();
    },
  });
  hierarchyRegistered = true;
}

/* Build a tree map: parentId -> [child, ...] in current array order. */
function _buildHierarchyTree(objects) {
  const byParent = new Map();
  const valid = new Set(objects.map(o => o.id));
  for (const o of objects) {
    const pid = o.parentId && valid.has(o.parentId) ? o.parentId : null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(o);
  }
  return byParent;
}

function _renderRow(obj, depth, hasChildren) {
  const sel = obj.id === selectedId || obj.id === editTargetId;
  const visible = obj.visible !== false;
  const isFolder = obj.type === 'folder';
  const collapsed = !!obj.collapsed;
  const icon = OUTLINER_ICONS[obj.type] || OUTLINER_ICONS.default;
  const expander = isFolder
    ? `<span class="out-twisty${collapsed ? '' : ' open'}" data-oid="${obj.id}">${
        collapsed
          ? `<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5L7 5 3 8.5z"/></svg>`
          : `<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M1.5 3l3.5 4 3.5-4z"/></svg>`
      }</span>`
    : `<span class="out-twisty-spacer"></span>`;
  return `<div class="outliner-row${sel ? ' selected' : ''}${visible ? '' : ' hidden-obj'}${isFolder ? ' is-folder' : ''}"
    draggable="true" data-oid="${obj.id}" data-folder="${isFolder ? '1' : '0'}"
    style="padding-left:${6 + depth * 14}px">
    ${expander}
    <span class="out-icon">${icon}</span>
    <span class="out-name" data-oid="${obj.id}" draggable="false" title="Double-click to rename">${_escape(obj.name)}</span>
    <button class="out-vis-btn" data-oid="${obj.id}" title="Toggle visibility">
      ${visible
        ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="6.5" cy="6.5" rx="5.5" ry="3.5"/><circle cx="6.5" cy="6.5" r="2"/></svg>`
        : `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><line x1="2" y1="2" x2="11" y2="11"/><path d="M4.5 4.5a5 5 0 0 0-3 2 5.5 5.5 0 0 0 9 1M8 3.5A5.5 5.5 0 0 1 12 6.5"/></svg>`}
    </button>
    <button class="out-del-btn" data-oid="${obj.id}" title="Delete">
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4h7M5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 6.5a1 1 0 0 0 1 .9h2a1 1 0 0 0 1-.9L9 4"/></svg>
    </button>
  </div>`;
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

  const byParent = _buildHierarchyTree(objects);
  const html = [];
  function walk(parentId, depth) {
    const kids = byParent.get(parentId) || [];
    for (const obj of kids) {
      const children = byParent.get(obj.id) || [];
      html.push(_renderRow(obj, depth, children.length > 0));
      if (obj.type === 'folder' && !obj.collapsed && children.length) {
        walk(obj.id, depth + 1);
      }
    }
  }
  walk(null, 0);
  hierarchyEl.innerHTML = html.join('');
  _bindOutlinerRootDrop();

  hierarchyEl.querySelectorAll('.outliner-row').forEach(row => {
    const oid = row.dataset.oid;
    row.addEventListener('click', e => {
      if (e.target.closest('.out-vis-btn') || e.target.closest('.out-del-btn') || e.target.closest('.out-twisty')) return;
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
      _removeWithChildren(oid);
    });
    row.querySelector('.out-twisty')?.addEventListener('click', e => {
      e.stopPropagation();
      const obj = window.slateScene3d?.find(oid);
      if (obj && obj.type === 'folder') {
        window.slateScene3d.setCollapsed(oid, !obj.collapsed);
      }
    });
    bindOutlinerDrag(row);
  });
}

/* Remove an object and all of its descendants. */
function _removeWithChildren(id) {
  const api = window.slateScene3d;
  if (!api) return;
  const stack = [id];
  const toRemove = [];
  while (stack.length) {
    const cur = stack.pop();
    toRemove.push(cur);
    api.objects.filter(o => o.parentId === cur).forEach(c => stack.push(c.id));
  }
  toRemove.forEach(rid => api.remove(rid));
}

const OUTLINER_ICONS = {
  cube:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M7 1.5L12.5 4 7 6.5 1.5 4z"/><path d="M1.5 4v6L7 12.5V6.5"/><path d="M12.5 4v6L7 12.5"/></svg>`,
  sphere:   `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5.5"/><ellipse cx="7" cy="7" rx="5.5" ry="2.3"/></svg>`,
  plane:    `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4.5L7 2l5.5 2.5L7 7z"/></svg>`,
  cylinder: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="3" rx="4.5" ry="1.5"/><path d="M2.5 3v8a4.5 1.5 0 0 0 9 0V3"/></svg>`,
  cone:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 1.5L12 12H2z"/><ellipse cx="7" cy="12" rx="5" ry="1.3"/></svg>`,
  torus:    `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="7" rx="5.5" ry="2.5"/></svg>`,
  mesh:     `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4l5-2 5 2v6l-5 2-5-2z M2 4l5 2 5-2M7 6v6"/></svg>`,
  folder:   `<svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor"><path d="M1.2 3.5h4l1 1.2H12.8a.7.7 0 0 1 .7.7v6a.7.7 0 0 1-.7.7H1.2a.7.7 0 0 1-.7-.7v-7.2a.7.7 0 0 1 .7-.7z"/></svg>`,
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
function _clearDragCues() {
  document.querySelectorAll('.outliner-row').forEach(r => {
    r.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}
function bindOutlinerDrag(row) {
  row.addEventListener('dragstart', e => {
    _dragOutlinerId = row.dataset.oid;
    row.style.opacity = '0.4';
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragOutlinerId); } catch {}
  });
  row.addEventListener('dragend', () => {
    row.style.opacity = '';
    _dragOutlinerId = null;
    _clearDragCues();
  });
  row.addEventListener('dragover', e => {
    if (!_dragOutlinerId || _dragOutlinerId === row.dataset.oid) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    _clearDragCues();
    const rect = row.getBoundingClientRect();
    const isFolder = row.dataset.folder === '1';
    const rel = (e.clientY - rect.top) / rect.height;
    if (isFolder && rel > 0.25 && rel < 0.75) {
      row.classList.add('drop-into');
    } else if (rel < 0.5) {
      row.classList.add('drop-before');
    } else {
      row.classList.add('drop-after');
    }
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
  row.addEventListener('drop', e => {
    e.preventDefault();
    if (!_dragOutlinerId || _dragOutlinerId === row.dataset.oid) { _clearDragCues(); return; }
    const dropOnId = row.dataset.oid;
    const into  = row.classList.contains('drop-into');
    const after = row.classList.contains('drop-after');
    _clearDragCues();
    const api = window.slateScene3d;
    if (!api) return;
    const dragged = api.find(_dragOutlinerId);
    const target  = api.find(dropOnId);
    if (!dragged || !target) return;
    // Prevent dropping a folder into its own descendant.
    let cur = target.id;
    while (cur) {
      if (cur === dragged.id) return;
      const p = api.find(cur);
      cur = p ? p.parentId : null;
    }
    if (into && target.type === 'folder') {
      api.setParent(dragged.id, target.id);
      // Make sure the folder opens so the user sees the drop.
      if (target.collapsed) api.setCollapsed(target.id, false);
      const targetIdx = api.objects.findIndex(o => o.id === target.id);
      api.move(dragged.id, targetIdx + 1);
    } else {
      // Same-parent reorder: drop next to the target row.
      api.setParent(dragged.id, target.parentId || null);
      const targetIdx = api.objects.findIndex(o => o.id === target.id);
      api.move(dragged.id, after ? targetIdx + 1 : targetIdx);
    }
  });
}

/* Dragging onto the empty area of the list reparents to the root. */
function _bindOutlinerRootDrop() {
  if (!hierarchyEl || hierarchyEl._rootDropBound) return;
  hierarchyEl._rootDropBound = true;
  hierarchyEl.addEventListener('dragover', e => {
    if (!_dragOutlinerId) return;
    if (e.target === hierarchyEl) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
    }
  });
  hierarchyEl.addEventListener('drop', e => {
    if (!_dragOutlinerId || e.target !== hierarchyEl) return;
    e.preventDefault();
    const api = window.slateScene3d;
    if (api) {
      api.setParent(_dragOutlinerId, null);
      api.move(_dragOutlinerId, api.objects.length - 1);
    }
    _clearDragCues();
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
