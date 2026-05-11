/**
 * editor3d.js — Blender-style 3D viewport for Slate.
 *
 *  • Reads / writes window.slateScene3d (which is doc.scene3d on the host page).
 *  • Object mode: orbit/pan/zoom, TransformControls gizmos (G/R/S), add primitives via
 *    + menu or viewport context menu, delete, frame. Hold ` (grave) for free-look fly.
 *  • Edit mode: per-mesh vertex / edge / face selection and translation. On exit the
 *    edited mesh is converted to a generic 'mesh' type and synced over the wire.
 *  • Hierarchy outliner panel is registered with the dock so it replaces the
 *    Layers panel while in 3D mode.
 */
import * as THREE from 'three';
import { OrbitControls }       from 'three/addons/controls/OrbitControls.js';
import { TransformControls }   from 'three/addons/controls/TransformControls.js';
// PointerLockControls used to power free-look but its lock semantics were
// flaky across browsers — we now drive yaw/pitch from raw mousemove deltas
// directly in `_onFlyMouseMove`, which works with or without an actual lock.

/* ─────────────────────────────────────────────────────────────────────────
   Module state
───────────────────────────────────────────────────────────────────────── */
let container = null;
let renderer  = null;
let scene     = null;
let camera    = null;
let orbit     = null;
let transform = null;
let transformHelper = null; // three r170+: TransformControls extends Controls, gizmo lives in getHelper()
let raycaster = null;
/** Small ortho scene rendered in the viewport corner (axis navigation). */
let viewGizmoScene = null;
let viewGizmoCam = null;
let viewGizmoRoot = null;
const viewGizmoPickables = [];
let viewGizmoRaycaster = null;
const pointer = new THREE.Vector2();
const _extrudePlaneThree = new THREE.Plane();
const _extrudeHitVec = new THREE.Vector3();
const _extrudeDelta = new THREE.Vector3();
let _lastMouseClientX = null;
let _lastMouseClientY = null;
/** Meshes eligible for raycast selection (rebuilt in syncSceneFromDoc). */
const _selectableList = [];
let _loopFrame = 0;
let snapEnabled = false;
let transformSpace = 'world';

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
/** Fly camera state.
 *  - `flyArmed`   : user toggled the free-look button on; RMB-hold will now
 *                   enter fly mode instead of orbiting / panning.
 *  - `flyEnabled` : actively in fly mode (looking around with mouse, WASD to
 *                   move). True only while RMB is held (or briefly between
 *                   arming and the first release in toggle scenarios).
 */
let flyArmed   = (typeof localStorage !== 'undefined'
                    && localStorage.getItem('slate_fly_armed') === '1');
let flyEnabled = false;
let flyKeys    = new Set();
let flyHint    = null;
/** Yaw/pitch we track manually because we don't use PointerLockControls
 *  anymore — raw mousemove deltas drive these and we rebuild the camera
 *  quaternion every frame the mouse moves while in fly mode. */
let _flyYaw   = 0;
let _flyPitch = 0;
/** Peer camera markers. peerId -> { group, label, color, tgtPos, tgtQuat } */
const peerCams = new Map();
/** Smooth orthographic view snap when using the corner axis gizmo. */
let _camViewAnim = null;
const _camAnimFromPos = new THREE.Vector3();
const _camAnimToPos = new THREE.Vector3();
const _camAnimTarget = new THREE.Vector3();
const _peerCamQuatTmp = new THREE.Quaternion();
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
let editSelection = new Set();    // welded logical vertex indices (derived)
let editEdgeSelection = new Set();// canonical edge keys "min|max"
let editFaceSelection = new Map();// faceKey -> ordered logical vertex array
let editDragHelper = null;   // Object3D the gizmo is attached to in edit mode

function _edgeKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function _edgeKeyToVerts(k) { return k.split('|').map(Number); }
function _faceKey(verts) {
  if (!Array.isArray(verts) || !verts.length) return '';
  // Canonicalize so the same face hashes identically regardless of winding /
  // starting vertex.
  const sorted = [...verts].sort((a, b) => a - b);
  return sorted.join(',');
}

/** Sorted corner position keys — stable across weld/remap of logical indices. */
function _facePositionSignatureFromLogicals(weld, posAttr, logicals) {
  if (!weld || !posAttr || !logicals?.length) return '';
  const keys = [];
  for (const logical of logicals) {
    const idxs = weld.logicalToIdxs[logical];
    if (!idxs || !idxs.length) return '';
    const g = idxs[0];
    keys.push(_weldKey(posAttr.getX(g), posAttr.getY(g), posAttr.getZ(g)));
  }
  keys.sort();
  return keys.join(',');
}

function _facePositionSignatureFromGeomFace(pa, faceIdxs) {
  if (!pa || !faceIdxs?.length) return '';
  const keys = [];
  for (const i of faceIdxs) {
    keys.push(_weldKey(pa.getX(i), pa.getY(i), pa.getZ(i)));
  }
  keys.sort();
  return keys.join(',');
}

/** Recompute the welded-vertex set that the gizmo / transform pipeline uses,
 *  from the current edge / face structural selections. Vertex-mode keeps
 *  editSelection authoritative. */
function _syncDerivedVertSelection() {
  if (editSubMode === 'vertex') return; // editSelection is authoritative here
  editSelection.clear();
  if (editSubMode === 'edge') {
    editEdgeSelection.forEach(k => {
      const [a, b] = _edgeKeyToVerts(k);
      editSelection.add(a); editSelection.add(b);
    });
  } else if (editSubMode === 'face') {
    editFaceSelection.forEach(verts => {
      verts.forEach(v => editSelection.add(v));
    });
  }
}

/** Unsub function from slateScene3d.onChange */
let unsubScene = null;

/** Hierarchy panel registration */
let hierarchyEl = null;
let hierarchyRegistered = false;

/** Modal grab (Blender-style: G to start, X/Y/Z to constrain, click confirm, RMB/Esc cancel). */
let grabState = null;
let _ctxMenuEl = null;

/* ─────────────────────────────────────────────────────────────────────────
   Mesh faces: stored as nested polygons [[i0..], …] or legacy flat triangles.
   GPU paths triangulate; commit merges obvious triangle pairs into quads.
───────────────────────────────────────────────────────────────────────── */
function _triangulatedIndicesFromMeshFaces(faces) {
  const out = [];
  if (!faces?.length) return out;
  if (Array.isArray(faces[0])) {
    for (const poly of faces) {
      if (!Array.isArray(poly) || poly.length < 3) continue;
      const p = poly.map(Number);
      for (let i = 1; i < p.length - 1; i++) {
        out.push(p[0], p[i], p[i + 1]);
      }
    }
  } else {
    for (let i = 0; i < faces.length; i++) out.push(Number(faces[i]));
  }
  return out;
}

function _triSharesUndirectedEdge(t, a, b) {
  const pairs = [
    [t[0], t[1]], [t[1], t[2]], [t[2], t[0]],
  ];
  for (const [u, v] of pairs) {
    if ((u === a && v === b) || (u === b && v === a)) return true;
  }
  return false;
}

/** Two CCW-wound triangles sharing one internal edge → one ordered quad.
 *  We walk DIRECTED half-edges: the shared edge appears in opposite directions
 *  in the two tris, so it cancels out and the remaining 4 form a clean cycle.
 *  Using undirected edges (the old approach) failed when two boundary edges
 *  happened to share a starting vertex — the `next` map collided. */
function _orderedQuadFromTwoTris(t1, t2) {
  const halves = [
    [t1[0], t1[1]], [t1[1], t1[2]], [t1[2], t1[0]],
    [t2[0], t2[1]], [t2[1], t2[2]], [t2[2], t2[0]],
  ];
  const k = (a, b) => `${a}|${b}`;
  const present = new Set(halves.map(([a, b]) => k(a, b)));
  // A half-edge is interior iff its reverse is also present (the two tris share
  // it). Anything else is on the outer boundary of the merged quad.
  const boundary = halves.filter(([a, b]) => !present.has(k(b, a)));
  if (boundary.length !== 4) return null;
  const next = new Map();
  for (const [a, b] of boundary) {
    if (next.has(a)) return null;        // shouldn't happen with CCW winding
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

function _trisCoplanar(t1, t2, verts) {
  function p(i) {
    return new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
  }
  const a = p(t1[0]), b = p(t1[1]), c = p(t1[2]);
  const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
  if (n.lengthSq() < 1e-12) return false;
  n.normalize();
  for (const i of t2) {
    const off = p(i).sub(a).dot(n);
    if (Math.abs(off) > 1e-4) return false;
  }
  return true;
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
        if (!_triSharesUndirectedEdge(t2, a, b)) continue;
        const set = new Set([t1[0], t1[1], t1[2], t2[0], t2[1], t2[2]]);
        if (set.size !== 4) continue;
        // Coplanar check prevents merging triangles that share an edge but
        // bend over a feature (e.g. cube neighbours that share an edge
        // across two perpendicular faces).
        if (verts && !_trisCoplanar(t1, t2, verts)) continue;
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

function _cloneFacesArray(faces) {
  if (!faces?.length) return [];
  if (Array.isArray(faces[0])) return faces.map(p => (Array.isArray(p) ? [...p.map(Number)] : []));
  return [...faces.map(Number)];
}

function _cloneMeshDataDeep(md) {
  if (!md) return undefined;
  return {
    vertices: [...(md.vertices || []).map(Number)],
    faces: _cloneFacesArray(md.faces),
  };
}

/* Track last pointer position so G can compute a starting world point from
   the cursor without needing a mousemove first. */
function _onContainerPointerTrack(e) {
  _lastMouseClientX = e.clientX;
  _lastMouseClientY = e.clientY;
  if (document.body.classList.contains('mode-3d') && container && !flyEnabled && !_camViewAnim) {
    const over = _viewGizmoPickView(e.clientX, e.clientY);
    container.style.cursor = over ? 'pointer' : '';
  }
  // Movement during an RMB hold → enter fly mode early instead of waiting for
  // the full hold timer. Keeps the gesture feeling instant when you start
  // dragging right away.
  if (_rmbArmed && !flyEnabled && !_rmbFlyTriggered && flyArmed) {
    const moved = Math.hypot(e.clientX - _rmbDownX, e.clientY - _rmbDownY);
    if (moved > RMB_FLY_MOVE_PX) {
      _cancelRmbFlyTimer();
      _rmbFlyTriggered = true;
      enterFlyCamera();
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Blender-style modal grab
   ──────────────────────────────────────────────────────────────────────── */
function _projectMouseOntoGrabPlane(clientX, clientY, out) {
  if (!grabState || !container) return false;
  const rect = container.getBoundingClientRect();
  pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return !!raycaster.ray.intersectPlane(grabState.dragPlane, out);
}

function _enterModalGrab() {
  if (editorMode !== 'object') return;
  if (!camera || !container) return;
  const ids = [...selectedIds];
  if (!ids.length && selectedId) ids.push(selectedId);
  if (!ids.length) return;

  const originalById = new Map();
  ids.forEach(id => {
    const m = objMeshes.get(id);
    if (m) originalById.set(id, [m.position.x, m.position.y, m.position.z]);
  });
  if (originalById.size === 0) return;

  const primary = objMeshes.get(selectedId) || objMeshes.get(ids[0]);
  primary.updateWorldMatrix(true, false);
  const anchor = new THREE.Vector3().setFromMatrixPosition(primary.matrixWorld);
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.clone().negate(), anchor);

  grabState = {
    mode: 'object',
    ids,
    originalById,
    axisLock: null,
    anchor,
    dragPlane,
    dragStartWorld: null,
    lastDelta: new THREE.Vector3(),
  };

  if (transform) {
    transform.enabled = false;
    transform.detach();
  }
  if (transformHelper) transformHelper.visible = false;
  if (orbit) orbit.enabled = false;
  window.slateScene3dBeginAction?.();

  container.addEventListener('pointermove', _onGrabPointerMove, true);
  _showGrabHint();
  try { window.slateSfx?.play('grab-start'); } catch (_) {}

  if (_lastMouseClientX != null) {
    const start = new THREE.Vector3();
    if (_projectMouseOntoGrabPlane(_lastMouseClientX, _lastMouseClientY, start)) {
      grabState.dragStartWorld = start.clone();
    }
  }
}

/** Edit-mode version: grab the currently-selected verts/edges/faces and
 *  slide them along a screen-aligned drag plane. X/Y/Z lock to axes, click
 *  to confirm, RMB / Esc to cancel — same Blender feel as the object grab. */
function _enterModalEditGrab() {
  if (editorMode !== 'edit' || !editTargetId) return;
  if (bevelState || extrudeState || insetState) return;
  if (!camera || !container || !editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  // Make sure editSelection mirrors the structural (edge/face) selection.
  _syncDerivedVertSelection();
  if (editSelection.size === 0) {
    _showEditHint('Nothing to grab — select something first');
    return;
  }

  const weld = editHelpers.weldMap;
  const posAttr = mesh.geometry.getAttribute('position');
  const originalPositions = new Map(); // logical -> [x, y, z] (LOCAL coords)
  const centroidLocal = new THREE.Vector3();
  editSelection.forEach(logical => {
    const indices = weld.logicalToIdxs[logical];
    if (!indices?.length) return;
    const g = indices[0];
    const p = [posAttr.getX(g), posAttr.getY(g), posAttr.getZ(g)];
    originalPositions.set(logical, p);
    centroidLocal.add(new THREE.Vector3(p[0], p[1], p[2]));
  });
  if (originalPositions.size === 0) {
    _showEditHint('Nothing to grab — selection is empty');
    return;
  }
  centroidLocal.divideScalar(originalPositions.size);

  mesh.updateWorldMatrix(true, false);
  const anchor = centroidLocal.clone().applyMatrix4(mesh.matrixWorld);
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.clone().negate(), anchor);

  // World→local conversion matrix for translating screen-space drag deltas
  // into the mesh's local frame (so the gizmo stays consistent when the
  // mesh has been rotated / scaled).
  const worldToLocal = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4().copy(mesh.matrixWorld).invert()
  );

  grabState = {
    mode: 'edit',
    targetMesh: mesh,
    originalPositions,
    worldToLocal,
    axisLock: null,
    anchor,
    dragPlane,
    dragStartWorld: null,
    lastDelta: new THREE.Vector3(),
  };

  if (transform) {
    transform.enabled = false;
    transform.detach();
  }
  if (transformHelper) transformHelper.visible = false;
  if (orbit) orbit.enabled = false;
  window.slateScene3dBeginAction?.();

  container.addEventListener('pointermove', _onGrabPointerMove, true);
  _showGrabHint();
  try { window.slateSfx?.play('grab-start'); } catch (_) {}

  if (_lastMouseClientX != null) {
    const start = new THREE.Vector3();
    if (_projectMouseOntoGrabPlane(_lastMouseClientX, _lastMouseClientY, start)) {
      grabState.dragStartWorld = start.clone();
    }
  }
}

function _onGrabPointerMove(ev) {
  if (!grabState) return;
  _lastMouseClientX = ev.clientX;
  _lastMouseClientY = ev.clientY;
  _applyGrabFromMouse(ev.clientX, ev.clientY);
}

function _applyGrabFromMouse(clientX, clientY) {
  if (!grabState) return;
  const cur = new THREE.Vector3();
  if (!_projectMouseOntoGrabPlane(clientX, clientY, cur)) return;
  if (!grabState.dragStartWorld) {
    grabState.dragStartWorld = cur.clone();
    return;
  }
  const delta = cur.clone().sub(grabState.dragStartWorld);
  if (grabState.axisLock === 'x') { delta.y = 0; delta.z = 0; }
  else if (grabState.axisLock === 'y') { delta.x = 0; delta.z = 0; }
  else if (grabState.axisLock === 'z') { delta.x = 0; delta.y = 0; }
  grabState.lastDelta.copy(delta);

  if (grabState.mode === 'edit') {
    // Translate the world-space delta into the mesh's LOCAL frame so the
    // gizmo math matches what the user sees (the mesh might be rotated /
    // scaled).
    const localDelta = delta.clone().applyMatrix3(grabState.worldToLocal);
    const mesh = grabState.targetMesh;
    const posAttr = mesh.geometry.getAttribute('position');
    const weld = editHelpers?.weldMap;
    if (!posAttr || !weld) return;
    grabState.originalPositions.forEach((orig, logical) => {
      const indices = weld.logicalToIdxs[logical] || [];
      indices.forEach(g => {
        posAttr.setXYZ(g, orig[0] + localDelta.x, orig[1] + localDelta.y, orig[2] + localDelta.z);
      });
    });
    posAttr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
    _refreshEditPoints();
    refreshSelectionMarker();
  } else {
    grabState.originalById.forEach((orig, id) => {
      const m = objMeshes.get(id);
      if (!m) return;
      m.position.set(orig[0] + delta.x, orig[1] + delta.y, orig[2] + delta.z);
      window.slateScene3d?.setTransform(id, {
        position: [m.position.x, m.position.y, m.position.z],
      });
    });
  }
  _updateGrabHint();
}

function _setGrabAxis(axis) {
  if (!grabState) return;
  grabState.axisLock = grabState.axisLock === axis ? null : axis;
  if (_lastMouseClientX != null) _applyGrabFromMouse(_lastMouseClientX, _lastMouseClientY);
  _updateGrabHint();
  try { window.slateSfx?.play('axis-lock'); } catch (_) {}
}

function _exitGrabCleanup() {
  if (!grabState) return;
  container.removeEventListener('pointermove', _onGrabPointerMove, true);
  grabState = null;
  if (transform) {
    transform.enabled = true;
    if (selectedId && objMeshes.has(selectedId)) transform.attach(objMeshes.get(selectedId));
  }
  if (transformHelper) transformHelper.visible = true;
  if (orbit) orbit.enabled = true;
  _hideGrabHint();
}

function _grabConfirm() {
  if (grabState?.mode === 'edit') {
    // Persist the new vertex positions through commitEditChanges → setMeshData,
    // so the doc state and undo stack stay in sync with what the user sees.
    commitEditChanges();
  }
  _exitGrabCleanup();
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}

function _grabCancel() {
  if (!grabState) return;
  if (grabState.mode === 'edit') {
    const mesh = grabState.targetMesh;
    const posAttr = mesh?.geometry?.getAttribute('position');
    const weld = editHelpers?.weldMap;
    if (posAttr && weld) {
      grabState.originalPositions.forEach((orig, logical) => {
        const indices = weld.logicalToIdxs[logical] || [];
        indices.forEach(g => posAttr.setXYZ(g, orig[0], orig[1], orig[2]));
      });
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
      _refreshEditPoints();
      refreshSelectionMarker();
    }
  } else {
    grabState.originalById?.forEach((orig, id) => {
      const m = objMeshes.get(id);
      if (m) {
        m.position.set(orig[0], orig[1], orig[2]);
        window.slateScene3d?.setTransform(id, { position: [...orig] });
      }
    });
  }
  _exitGrabCleanup();
  try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
}

let _grabHintEl = null;
function _showGrabHint() {
  if (!container) return;
  if (!_grabHintEl) {
    _grabHintEl = document.createElement('div');
    _grabHintEl.className = 'fly-cam-hint';
    container.appendChild(_grabHintEl);
  }
  _grabHintEl.style.display = '';
  _updateGrabHint();
}
function _updateGrabHint() {
  if (!_grabHintEl || !grabState) return;
  const lock = grabState.axisLock ? ` · locked ${grabState.axisLock.toUpperCase()}` : '';
  const d = grabState.lastDelta;
  const dx = Number(d.x).toFixed(2);
  const dy = Number(d.y).toFixed(2);
  const dz = Number(d.z).toFixed(2);
  _grabHintEl.textContent = `Grab${lock} · (${dx}, ${dy}, ${dz}) · X/Y/Z lock · click confirm · RMB / Esc cancel`;
}
function _hideGrabHint() {
  if (_grabHintEl) _grabHintEl.style.display = 'none';
}

const ADD_PRIMITIVE_ORDER = [
  'cube', 'sphere', 'plane', 'cylinder', 'cone', 'torus',
  'octahedron', 'tetrahedron', 'icosahedron', 'capsule',
];
const ADD_PRIMITIVE_LABELS = {
  cube: 'Cube',
  sphere: 'Sphere',
  plane: 'Plane',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
  octahedron: 'Octahedron',
  tetrahedron: 'Tetrahedron',
  icosahedron: 'Icosphere',
  capsule: 'Capsule',
};

const ADD_PRIMITIVE_PRESETS = {
  cube:     { type: 'cube',     name: 'Cube',     params: { size: 1 },      position: [0, 0.5, 0],  color: '#7c6aff' },
  sphere:   { type: 'sphere',   name: 'Sphere',   params: { radius: 0.5 },  position: [0, 0.5, 0],  color: '#22d3a5' },
  plane:    { type: 'plane',    name: 'Plane',    params: { width: 2, height: 2 }, position: [0, 0.001, 0], rotation: [-Math.PI / 2, 0, 0], color: '#a3a3a3' },
  cylinder: { type: 'cylinder', name: 'Cylinder', params: { radiusTop: 0.5, radiusBottom: 0.5, height: 1 }, position: [0, 0.5, 0], color: '#f59e0b' },
  cone:     { type: 'cone',     name: 'Cone',     params: { radius: 0.5, height: 1 }, position: [0, 0.5, 0], color: '#ef4444' },
  torus:    { type: 'torus',    name: 'Torus',    params: { radius: 0.5, tube: 0.18 }, position: [0, 0.5, 0], color: '#38bdf8' },
  octahedron: { type: 'octahedron', name: 'Octahedron', params: { radius: 0.55 }, position: [0, 0.55, 0], color: '#c084fc' },
  tetrahedron: { type: 'tetrahedron', name: 'Tetrahedron', params: { radius: 0.55 }, position: [0, 0.45, 0], color: '#fb7185' },
  icosahedron: { type: 'icosahedron', name: 'Icosphere', params: { radius: 0.5 }, position: [0, 0.5, 0], color: '#4ade80' },
  capsule:  { type: 'capsule',  name: 'Capsule',  params: { radius: 0.35, length: 0.9 }, position: [0, 0.55, 0], color: '#94a3b8' },
};

function _closeViewportCtxMenu() {
  if (_ctxMenuEl) {
    _ctxMenuEl.remove();
    _ctxMenuEl = null;
  }
  window.removeEventListener('pointerdown', _onDocCloseCtx, true);
  window.removeEventListener('keydown', _onKeyCloseCtx, true);
}

function _onDocCloseCtx(e) {
  if (_ctxMenuEl && !_ctxMenuEl.contains(e.target)) _closeViewportCtxMenu();
}

function _onKeyCloseCtx(e) {
  if (e.key === 'Escape') _closeViewportCtxMenu();
}

function _openAddPrimitiveMenu(clientX, clientY) {
  _closeViewportCtxMenu();
  const div = document.createElement('div');
  div.className = 't3d-viewport-ctx';
  div.innerHTML = `<div class="t3d-ctx-head">Add</div>${
    ADD_PRIMITIVE_ORDER.map(kind => `<button type="button" data-prim="${kind}">${ADD_PRIMITIVE_LABELS[kind] || kind}</button>`).join('')
  }`;
  document.body.appendChild(div);
  _ctxMenuEl = div;
  div.querySelectorAll('button[data-prim]').forEach(btn => {
    btn.addEventListener('click', () => {
      addPrimitive(btn.dataset.prim);
      _closeViewportCtxMenu();
    });
  });
  const pad = 8;
  let x = clientX;
  let y = clientY;
  div.style.left = `${x}px`;
  div.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const w = div.offsetWidth;
    const h = div.offsetHeight;
    if (x + w + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - w - pad);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
  });
  setTimeout(() => {
    window.addEventListener('pointerdown', _onDocCloseCtx, true);
    window.addEventListener('keydown', _onKeyCloseCtx, true);
  }, 0);
}

function _onViewportContextMenu(e) {
  // We always suppress the browser's native menu — it is replaced by either an
  // orbit/pan drag (right-mouse drag) or our own add-object menu, decided in
  // onPointerUp once we know whether the user dragged or not.
  e.preventDefault();
  if (grabState) _grabCancel();
}

/* ─────────────────────────────────────────────────────────────────────────
   Free-look (fly) camera
   Press-and-hold right-mouse to enter fly mode (with PointerLock + WASD).
   Release right-mouse to exit. A quick right-click without hold / movement
   falls through to the add-object context menu via onPointerUp.
───────────────────────────────────────────────────────────────────────── */
const RMB_FLY_HOLD_MS = 160; // hold beyond this triggers fly mode
const RMB_FLY_MOVE_PX = 5;   // or move beyond this while held
let _rmbHoldTimer = null;
let _rmbFlyTriggered = false;

function _cancelRmbFlyTimer() {
  if (_rmbHoldTimer) { clearTimeout(_rmbHoldTimer); _rmbHoldTimer = null; }
}
function _maybeStartRmbFlyOnHold() {
  if (flyEnabled || !flyArmed) return;
  _rmbFlyTriggered = false;
  _cancelRmbFlyTimer();
  _rmbHoldTimer = setTimeout(() => {
    _rmbHoldTimer = null;
    if (_rmbArmed && !flyEnabled && !transform?.dragging && flyArmed) {
      _rmbFlyTriggered = true;
      enterFlyCamera();
    }
  }, RMB_FLY_HOLD_MS);
}

/* The fly button arms / disarms free-look. When armed, holding the right
   mouse button enters fly mode; release exits. When NOT armed, right-mouse
   drag pans through OrbitControls and a quick tap opens the context menu. */
function _persistFlyArmed() {
  try { localStorage.setItem('slate_fly_armed', flyArmed ? '1' : '0'); } catch (_) {}
}
function _applyFlyArmedToOrbit() {
  if (!orbit) return;
  // When fly is armed we don't want OrbitControls intercepting the right
  // button at all — that would fight our fly-on-hold gesture. When it's
  // disarmed, RMB-drag pans the camera (which is what the user expects
  // from "right-click to pan").
  orbit.mouseButtons.RIGHT = flyArmed ? null : THREE.MOUSE.PAN;
}
function setFlyArmed(v) {
  flyArmed = !!v;
  _persistFlyArmed();
  _applyFlyArmedToOrbit();
  if (!flyArmed && flyEnabled) exitFlyCamera();
  _updateFlyButtonUI();
}
function _onFlyCamBtnDown(e) {
  e.preventDefault();
  setFlyArmed(!flyArmed);
}
function _updateFlyButtonUI() {
  const btn = document.getElementById('t3d-fly-btn');
  if (!btn) return;
  btn.classList.toggle('active', !!flyArmed);
  btn.title = flyEnabled
    ? 'Fly view active — release right-mouse to exit'
    : flyArmed
      ? 'Fly view armed — hold right-mouse to fly. Click to disarm.'
      : 'Fly view — click to arm, then hold right-mouse to fly';
}
function makeGeometryFor(obj) {
  const p = obj.params || {};
  switch (obj.type) {
    case 'cube':     return new THREE.BoxGeometry(p.size ?? 1, p.size ?? 1, p.size ?? 1);
    case 'sphere':   return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 24, p.heightSegments ?? 16);
    case 'plane':    return new THREE.PlaneGeometry(p.width ?? 2, p.height ?? 2);
    case 'cylinder': return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case 'cone':     return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case 'torus':    return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.18, p.radialSegments ?? 16, p.tubularSegments ?? 32);
    case 'octahedron':
      return new THREE.OctahedronGeometry(p.radius ?? 0.55, p.detail ?? 0);
    case 'tetrahedron':
      return new THREE.TetrahedronGeometry(p.radius ?? 0.55, p.detail ?? 0);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(p.radius ?? 0.5, p.detail ?? 0);
    case 'capsule':
      return new THREE.CapsuleGeometry(p.radius ?? 0.35, p.length ?? 0.9, p.capSegments ?? 4, p.radialSegments ?? 12);
    case 'mesh': {
      const geo = new THREE.BufferGeometry();
      const md = obj.meshData || { vertices: [], faces: [] };
      if (md.vertices?.length) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(md.vertices), 3));
      }
      const idx = _triangulatedIndicesFromMeshFaces(md.faces);
      if (idx.length) geo.setIndex(idx);
      // Convert to non-indexed so each triangle gets its own verts, giving
      // FLAT (per-face) shading — same look as the primitives that ship with
      // split corners. Editor helpers re-weld by position on their side so
      // logical-vert editing still treats coincident corners as one.
      let final = geo;
      if (idx.length > 0) {
        try {
          final = geo.toNonIndexed();
          geo.dispose();
        } catch (_) { /* fall back to indexed smooth shading */ }
      }
      final.computeVertexNormals();
      return final;
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
  mesh.castShadow = false;
  mesh.receiveShadow = false;
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
  // Track whether the geometry under the edit target was just rebuilt — if
  // so we have to rebuild edit helpers from the new posAttr, otherwise stale
  // vertex dots / wireframe haunt the previous state (the "ghost geometry
  // after undo" bug).
  let editTargetGeomChanged = false;

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
      if (obj.id === editTargetId) editTargetGeomChanged = true;
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
        // Wireframe overlay (if enabled) needs to rebuild against new geometry.
        if (_wireframeOverlay) { _removeWireOverlayFor(mesh); _addWireOverlayFor(mesh); }
        if (obj.id === editTargetId) editTargetGeomChanged = true;
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
      _removeWireOverlayFor(m);
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

  // Refresh edit helpers if we're in edit mode on a mesh that just changed.
  // Without this, undo would leave the OLD vertex dots / wireframe behind,
  // pointing at indices that no longer exist on the rebuilt geometry.
  if (editorMode === 'edit' && editTargetId) {
    const m = objMeshes.get(editTargetId);
    if (!m) {
      leaveEditMode();
    } else if (editTargetGeomChanged) {
      editSelection.clear();
      editEdgeSelection.clear();
      editFaceSelection.clear();
      buildEditHelpers();
      attachGizmoToEditSelection();
    }
  }

  renderHierarchy();

  _selectableList.length = 0;
  objMeshes.forEach(m => {
    if (m.visible && m.userData.selectable) _selectableList.push(m);
  });

  // Keep the wireframe overlay (if enabled) in sync with current meshes —
  // newly added objects need overlays attached, deleted ones already lost
  // their overlay as a child of their disposed mesh.
  if (_wireframeOverlay) _syncWireOverlays();
  _updateObjectColorPicker();
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
  if (!_selectableList.length) return null;
  const hits = raycaster.intersectObjects(_selectableList, false);
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
  // Only update which rows look "selected" rather than rebuilding the DOM —
  // a full re-render destroys the row the user just clicked, which would
  // break the dblclick → rename flow that fires immediately after.
  _refreshHierarchySelection();
  _updateObjectColorPicker();
}

function selectAllObjects() {
  const api = window.slateScene3d;
  if (!api) return;
  selectedIds.clear();
  api.objects.forEach(o => { if (o.type !== 'folder') selectedIds.add(o.id); });
  selectedId = [...selectedIds].pop() || null;
  if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
  _refreshSelectionOutlines();
  _refreshHierarchySelection();
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
  window.slateScene3dBeginAction?.();
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
    meshData: _cloneMeshDataDeep(src.meshData),
  };
  const obj = api.add(spec);
  if (obj) selectById(obj.id);
}

let _downX = 0, _downY = 0, _downAt = 0;
let _boxArmed = false;
let _rmbDownX = 0, _rmbDownY = 0, _rmbArmed = false;
function onPointerDown(e) {
  if (!orbit) return;
  if (flyEnabled) return;
  if (!grabState && !bevelState && !extrudeState && !insetState && e.button === 0) {
    const gv = _viewGizmoPickView(e.clientX, e.clientY);
    if (gv) {
      e.preventDefault(); e.stopPropagation();
      beginCameraViewPresetAnim(gv);
      try { window.slateSfx?.play('view-snap'); } catch (_) {}
      return;
    }
  }
  // Modal grab is active: left-click confirms, right-click cancels.
  if (grabState) {
    if (e.button === 0) {
      e.preventDefault(); e.stopPropagation();
      _grabConfirm();
    } else if (e.button === 2) {
      e.preventDefault(); e.stopPropagation();
      _grabCancel();
    }
    return;
  }
  // Modal bevel is active: same click semantics — LMB confirm, RMB cancel.
  if (bevelState) {
    if (e.button === 0) {
      e.preventDefault(); e.stopPropagation();
      _bevelConfirm();
    } else if (e.button === 2) {
      e.preventDefault(); e.stopPropagation();
      _bevelCancel();
    }
    return;
  }
  if (extrudeState) {
    if (e.button === 0) {
      e.preventDefault(); e.stopPropagation();
      _extrudeConfirm();
    } else if (e.button === 2) {
      e.preventDefault(); e.stopPropagation();
      _extrudeCancel();
    }
    return;
  }
  if (insetState) {
    if (e.button === 0) {
      e.preventDefault(); e.stopPropagation();
      _insetConfirm();
    } else if (e.button === 2) {
      e.preventDefault(); e.stopPropagation();
      _insetCancel();
    }
    return;
  }
  // Track right-button presses so onPointerUp can decide between two
  // gestures:
  //   1. Quick tap (no movement, released before the hold timer fires) →
  //      open the add-object menu on empty space.
  //   2. Hold ≥ RMB_FLY_HOLD_MS or drag > RMB_FLY_MOVE_PX → enter free-look
  //      (PointerLock + WASD navigation); releasing exits.
  if (e.button === 2) {
    _rmbArmed = true;
    _rmbDownX = e.clientX;
    _rmbDownY = e.clientY;
    _maybeStartRmbFlyOnHold();
    return;
  }
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
  // Right-mouse up: three gestures to disambiguate.
  if (e.button === 2 && _rmbArmed) {
    _rmbArmed = false;
    _cancelRmbFlyTimer();
    // If we entered fly-mode on the hold (even if user pressed Esc to exit
    // first), releasing right-mouse should NOT also fall through to opening
    // the add-object menu.
    const wasFly = _rmbFlyTriggered || flyEnabled;
    _rmbFlyTriggered = false;
    if (wasFly) {
      if (flyEnabled) exitFlyCamera();
      return;
    }
    if (grabState || bevelState || extrudeState || insetState) return;
    if (transform?.dragging) return;
    const moved = Math.hypot(e.clientX - _rmbDownX, e.clientY - _rmbDownY);
    if (moved > 5) return;
    const hit = pickObject(e.clientX, e.clientY);
    if (hit) return;
    _openAddPrimitiveMenu(e.clientX, e.clientY);
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
  if (hit && hit.userData.objId) {
    selectById(hit.userData.objId, e.shiftKey);
    try { window.slateSfx?.play('select'); } catch (_) {}
  } else if (!e.shiftKey) {
    if (selectedId || selectedIds.size) {
      try { window.slateSfx?.play('deselect'); } catch (_) {}
    }
    selectById(null);
  }
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
  _refreshHierarchySelection();
}

/* ─────────────────────────────────────────────────────────────────────────
   Free-fly camera
   • Arm via the toolbar fly button (or settings). When armed, holding the
     right mouse button enters fly mode; releasing exits cleanly.
   • In fly mode, mouse movement looks around (yaw/pitch tracked manually
     so we don't depend on browser PointerLock — that mode was flaky on
     some browsers, leading to "activates but can't look around").
   • WASD strafe/forward-back, Q/E down/up, Shift = boost.
   • Esc exits without disarming. Toolbar click again disarms.
───────────────────────────────────────────────────────────────────────── */
const FLY_LOOK_SENSITIVITY = 0.0022; // radians per mouse-pixel
const FLY_PITCH_LIMIT = Math.PI / 2 - 0.001;

function enterFlyCamera() {
  if (!renderer || !camera || flyEnabled) return;
  if (transform?.dragging) return;
  orbit.enabled = false;
  flyEnabled = true;
  flyKeys.clear();
  // Initialize yaw/pitch from the current camera quaternion so we don't snap.
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  _flyYaw   = euler.y;
  _flyPitch = euler.x;
  window.addEventListener('keydown',  _onFlyKeyDown,    true);
  window.addEventListener('keyup',    _onFlyKeyUp,      true);
  window.addEventListener('mousemove', _onFlyMouseMove, true);
  // PointerLock is a "nice to have" — if the browser grants it, we get
  // unbounded mouse movement (great for big rotations). If it doesn't, the
  // mousemove handler still rotates the camera with normal pointer deltas.
  try { renderer.domElement.requestPointerLock?.(); } catch (_) {}
  if (!flyHint) {
    flyHint = document.createElement('div');
    flyHint.className = 'fly-cam-hint';
    container.appendChild(flyHint);
  }
  flyHint.textContent = 'WASD move · mouse look · release right-mouse to exit';
  flyHint.style.display = '';
  _updateFlyButtonUI();
}

function exitFlyCamera() {
  if (!flyEnabled) return;
  flyEnabled = false;
  flyKeys.clear();
  window.removeEventListener('keydown',  _onFlyKeyDown,    true);
  window.removeEventListener('keyup',    _onFlyKeyUp,      true);
  window.removeEventListener('mousemove', _onFlyMouseMove, true);
  try { if (document.pointerLockElement) document.exitPointerLock?.(); } catch (_) {}
  if (flyHint) flyHint.style.display = 'none';
  if (orbit && camera) {
    // Snap orbit.target to a point along the camera's new forward direction
    // so the next orbit doesn't whip back to the previous focus point.
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    orbit.target.copy(camera.position).add(fwd.multiplyScalar(4));
    orbit.enabled = true;
    orbit.update();
  }
  _updateFlyButtonUI();
}

function _onFlyMouseMove(e) {
  if (!flyEnabled || !camera) return;
  const dx = e.movementX || 0;
  const dy = e.movementY || 0;
  if (!dx && !dy) return;
  _flyYaw   -= dx * FLY_LOOK_SENSITIVITY;
  _flyPitch -= dy * FLY_LOOK_SENSITIVITY;
  if (_flyPitch >  FLY_PITCH_LIMIT) _flyPitch =  FLY_PITCH_LIMIT;
  if (_flyPitch < -FLY_PITCH_LIMIT) _flyPitch = -FLY_PITCH_LIMIT;
  const e2 = new THREE.Euler(_flyPitch, _flyYaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(e2);
}

function _onFlyKeyDown(e) {
  if (!flyEnabled) return;
  if (e.code === 'Backquote') return;
  if (e.key === 'Escape') { e.preventDefault(); exitFlyCamera(); return; }
  flyKeys.add(e.key.toLowerCase());
  e.stopPropagation(); e.preventDefault();
}
function _onFlyKeyUp(e) {
  if (!flyEnabled) return;
  if (e.code === 'Backquote') return;
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

  /* In fly mode orbit.target is stale, so derive a point along the camera's
     forward axis instead. Either way, peers receive a target the marker can
     look at to show direction. */
  let tx, ty, tz;
  if (flyEnabled) {
    const f = new THREE.Vector3();
    camera.getWorldDirection(f).normalize();
    tx = camera.position.x + f.x * 4;
    ty = camera.position.y + f.y * 4;
    tz = camera.position.z + f.z * 4;
  } else {
    tx = orbit.target.x; ty = orbit.target.y; tz = orbit.target.z;
  }
  const cur = [
    camera.position.x, camera.position.y, camera.position.z,
    tx, ty, tz,
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
    quat: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
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
    // Honor the user's "Show peer cameras" preference for newly-discovered peers.
    if (!_persistedPeerCamsVisible) {
      group.visible = false;
      label.style.display = 'none';
    }
  } else if (meta?.name && entry.label && entry.label.textContent !== meta.name) {
    entry.label.textContent = meta.name;
  }
  if (!entry.tgtPos) {
    entry.tgtPos = new THREE.Vector3();
    entry.tgtQuat = new THREE.Quaternion();
    entry.tgtPos.copy(entry.group.position);
    entry.tgtQuat.copy(entry.group.quaternion);
  }
  entry.tgtPos.set(msg.pos[0], msg.pos[1], msg.pos[2]);
  if (Array.isArray(msg.quat) && msg.quat.length === 4) {
    entry.tgtQuat.set(
      Number(msg.quat[0]),
      Number(msg.quat[1]),
      Number(msg.quat[2]),
      Number(msg.quat[3]),
    ).normalize();
  } else {
    _peerCamQuatTmp.copy(entry.group.quaternion);
    entry.group.rotation.set(0, 0, 0);
    entry.group.lookAt(msg.target[0], msg.target[1], msg.target[2]);
    entry.group.rotateY(Math.PI);
    entry.tgtQuat.copy(entry.group.quaternion);
    entry.group.quaternion.copy(_peerCamQuatTmp);
  }
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
  /* Polished “video camera” silhouette: rounded body + lens ring, −Z forward. */
  const bodyMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.94,
    depthTest: true,
  });
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.065, 0.082, 0.14, 20, 1, false),
    bodyMat,
  );
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0, 0.06);
  g.add(body);
  const lensMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a24,
    transparent: true,
    opacity: 0.92,
    depthTest: true,
  });
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.04, 24, 1, false), lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.02);
  g.add(lens);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.056, 0.008, 10, 28),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthTest: true }),
  );
  ring.rotation.y = Math.PI / 2;
  ring.position.set(0, 0, -0.04);
  g.add(ring);

  /* View frustum — a proper pyramid with a rectangular base, apex at the
     camera origin and base out in -Z. Clearly shows the look direction. */
  const apex = new THREE.Vector3(0, 0, 0);
  const fNear = 0.0;
  const fFar  = 0.85;
  const halfW = 0.45, halfH = 0.30;
  const farTL = new THREE.Vector3(-halfW,  halfH, -fFar);
  const farTR = new THREE.Vector3( halfW,  halfH, -fFar);
  const farBL = new THREE.Vector3(-halfW, -halfH, -fFar);
  const farBR = new THREE.Vector3( halfW, -halfH, -fFar);
  const segs = [
    apex, farTL,  apex, farTR,  apex, farBL,  apex, farBR,
    farTL, farTR, farTR, farBR, farBR, farBL, farBL, farTL,
  ];
  const fGeo = new THREE.BufferGeometry().setFromPoints(segs);
  const fMat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.85, depthTest: false,
  });
  const frustum = new THREE.LineSegments(fGeo, fMat);
  frustum.renderOrder = 2;
  g.add(frustum);

  /* A thin solid "look" ray cuts through the center of the frustum so even
     at distance you can tell which way they're facing. */
  const rayGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -fFar - 0.3),
  ]);
  const rayMat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false,
  });
  const ray = new THREE.Line(rayGeo, rayMat);
  ray.renderOrder = 3;
  g.add(ray);

  /* Up-vector indicator — a tiny tick above the body so users can also see
     roll, just like Blender shows the camera's up axis. */
  const upGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, halfH * 0.55, -fFar * 0.45),
    new THREE.Vector3(0, halfH * 1.05, -fFar * 0.45),
  ]);
  const upMat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false,
  });
  g.add(new THREE.Line(upGeo, upMat));

  return g;
}

/* Position the HTML labels above each peer camera every frame. */
const _camLabelTmp = new THREE.Vector3();
function _updatePeerCamMarkers() {
  if (!camera || !container) return;
  const allowVisible = _persistedPeerCamsVisible;
  const rect = container.getBoundingClientRect();
  const k = 0.24;
  peerCams.forEach(entry => {
    if (!entry.group || !entry.label) return;
    if (!allowVisible) {
      entry.group.visible = false;
      entry.label.style.display = 'none';
      return;
    }
    entry.group.visible = true;
    if (entry.tgtPos && entry.tgtQuat) {
      entry.group.position.lerp(entry.tgtPos, k);
      entry.group.quaternion.slerp(entry.tgtQuat, k);
    }
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

/* Persisted viewport prefs — initialized from localStorage so the very first
   scene the renderer paints already matches the user's settings (the host
   page's Settings UI may not have wired up by the time ensureScene() runs). */
let _persistedViewportBg = '#12121a';
let _persistedFov = 55;
let _persistedGridVisible = true;
let _persistedPeerCamsVisible = true;
try {
  if (typeof localStorage !== 'undefined') {
    const bg  = localStorage.getItem('slate_viewport_bg');
    const fov = localStorage.getItem('slate_viewport_fov');
    const grd = localStorage.getItem('slate_viewport_grid');
    const pcm = localStorage.getItem('slate_peer_cameras');
    if (bg && /^#[0-9a-fA-F]{6}$/.test(bg)) _persistedViewportBg = bg;
    if (fov) { const v = parseInt(fov, 10); if (Number.isFinite(v)) _persistedFov = Math.max(15, Math.min(140, v)); }
    if (grd != null) _persistedGridVisible = grd !== '0';
    if (pcm != null) _persistedPeerCamsVisible = pcm !== '0';
  }
} catch (_) {}

/* Expose the receive entry point so the host page can route incoming
   cam-3d messages here, plus a small RPC surface that the Settings panel
   uses to live-tune the viewport. */
function setViewportBackground(hex) {
  _persistedViewportBg = hex || '#12121a';
  if (scene && scene.background) {
    try { scene.background.set(_persistedViewportBg); } catch (_) {}
  } else if (scene) {
    scene.background = new THREE.Color(_persistedViewportBg);
  }
}
function setCameraFov(deg) {
  const v = Math.max(15, Math.min(140, Number(deg) || 55));
  _persistedFov = v;
  if (camera) { camera.fov = v; camera.updateProjectionMatrix(); }
}
function setGridVisible(visible) {
  _persistedGridVisible = !!visible;
  if (_gridHelper) _gridHelper.visible = !!visible;
  if (_axesHelper) _axesHelper.visible = !!visible;
  const btn = document.getElementById('t3d-grid-btn');
  if (btn) btn.classList.toggle('active', !!visible);
}
function setPeerCamerasVisible(visible) {
  _persistedPeerCamsVisible = !!visible;
  peerCams.forEach(entry => {
    if (entry.group) entry.group.visible = !!visible;
    if (entry.label) entry.label.style.display = visible ? '' : 'none';
  });
}

window.slateScene3dRpc = Object.assign(window.slateScene3dRpc || {}, {
  applyPeerCamera,
  removePeerCamera,
  clearAllPeerCameras: _clearAllPeerCameras,
  setViewportBackground,
  setCameraFov,
  setGridVisible,
  setPeerCamerasVisible,
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
  if (!document.body.classList.contains('mode-3d')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  const swallow = () => { e.preventDefault(); e.stopPropagation(); };

  /* Undo / redo (Blender-style; capture before single-letter tools). */
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' || e.key === 'Z') {
      swallow();
      if (e.shiftKey) window.slateScene3dRedo?.();
      else window.slateScene3dUndo?.();
      return;
    }
    if (e.key === 'y' || e.key === 'Y') {
      swallow();
      window.slateScene3dRedo?.();
      return;
    }
  }

  if (flyEnabled) return;

  // Modal grab takes priority over almost everything else.
  if (grabState) {
    if (e.key === 'Escape') { swallow(); _grabCancel(); return; }
    if (e.key === 'Enter' || e.key === ' ') { swallow(); _grabConfirm(); return; }
    const k = e.key.toLowerCase();
    if ((k === 'x' || k === 'y' || k === 'z') && !e.ctrlKey && !e.metaKey) {
      swallow();
      _setGrabAxis(k);
      return;
    }
    // Swallow other keys so they don't trigger tool shortcuts.
    swallow();
    return;
  }
  // Modal bevel — Esc cancel / Enter confirm; everything else passes through
  // (we don't want to swallow Ctrl+Z if the user really wants to undo).
  if (bevelState) {
    if (e.key === 'Escape') { swallow(); _bevelCancel(); return; }
    if (e.key === 'Enter')  { swallow(); _bevelConfirm(); return; }
    swallow();
    return;
  }
  if (extrudeState) {
    if (e.key === 'Escape') { swallow(); _extrudeCancel(); return; }
    if (e.key === 'Enter') { swallow(); _extrudeConfirm(); return; }
    swallow();
    return;
  }
  if (insetState) {
    if (e.key === 'Escape') { swallow(); _insetCancel(); return; }
    if (e.key === 'Enter') { swallow(); _insetConfirm(); return; }
    swallow();
    return;
  }

  if (e.key === 'Tab') { swallow(); toggleEditMode(); return; }

  // Edit-mode tool shortcuts that take priority (run BEFORE rotate/scale
  // because Ctrl+R / Ctrl+B should not get eaten by setTransformMode('rotate')
  // and the topology delete should beat the object-mode 'x' handler below).
  if (editorMode === 'edit') {
    // Blender-style hotkeys. Use stopImmediatePropagation so the 2D
    // keyboard handlers (e/r/i/etc. for picking tools) don't fire when
    // we're driving the 3D editor.
    const swallowHard = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    if ((e.key === 'r' || e.key === 'R') && e.ctrlKey && !e.metaKey) {
      swallowHard(); _runMeshOp('Loop cut', () => loopCutSelectedFaces()); return;
    }
    if ((e.key === 'b' || e.key === 'B') && e.ctrlKey && !e.metaKey) {
      swallowHard(); _runMeshOp('Bevel', () => bevelSelectedVerts()); return;
    }
    if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey) {
      swallowHard(); _runMeshOp('Extrude', () => extrudeSelectedFaces()); return;
    }
    if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey) {
      swallowHard(); _runMeshOp('Inset', () => insetSelectedFaces()); return;
    }
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) {
      swallowHard(); _runMeshOp('Merge', () => mergeSelectedToCenter()); return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace' ||
         ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey))) {
      swallowHard(); _runMeshOp('Delete', () => deleteSelectedTopology()); return;
    }
    if (e.key === '1') { swallowHard(); setEditSubMode('vertex'); return; }
    if (e.key === '2') { swallowHard(); setEditSubMode('edge');   return; }
    if (e.key === '3') { swallowHard(); setEditSubMode('face');   return; }
  }

  if (e.key === 'g' || e.key === 'G') {
    swallow();
    setTransformMode('translate');
    if (editorMode === 'object' && (selectedId || selectedIds.size > 0)) {
      _enterModalGrab();
    } else if (editorMode === 'edit' && editTargetId) {
      _enterModalEditGrab();
    }
    return;
  }
  if (e.key === 'r' || e.key === 'R') { swallow(); setTransformMode('rotate'); return; }
  if (e.key === 's' || e.key === 'S') { swallow(); setTransformMode('scale');  return; }
  if (e.key === 'f' || e.key === 'F') { swallow(); frameSelected(); return; }
  if ((e.key === 'a' || e.key === 'A') && editorMode === 'object') { swallow(); selectAllObjects(); return; }
  if ((e.key === 'd' || e.key === 'D') && e.shiftKey && editorMode === 'object' && selectedId) {
    swallow(); duplicateSelected(); return;
  }

  if (e.key === ',' && editorMode === 'object') { swallow(); cycleTransformSpace(); return; }
  if (e.key === '.' && editorMode === 'object') { swallow(); toggleGrid(); return; }
  if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && editorMode === 'object' && selectedId) {
    swallow();
    window.slateScene3dBeginAction?.();
    const ids = [...selectedIds];
    if (!ids.length && selectedId) ids.push(selectedId);
    ids.forEach(id => window.slateScene3d?.remove(id));
    selectedIds.clear();
    selectedId = null;
    transform?.detach();
    return;
  }
  if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && editorMode === 'object' && selectedId) {
    swallow();
    const api = window.slateScene3d;
    const o = api?.find(selectedId);
    if (o) api.setVisible(selectedId, o.visible === false);
    return;
  }


  if ((e.key === 'Delete' || e.key === 'Backspace') && editorMode === 'object' && selectedId) {
    window.slateScene3dBeginAction?.();
    const ids = [...selectedIds];
    if (!ids.length && selectedId) ids.push(selectedId);
    ids.forEach(id => window.slateScene3d?.remove(id));
    selectedIds.clear();
    selectedId = null;
    transform?.detach();
    swallow();
  }
}

function setTransformMode(mode) {
  transformMode = mode;
  if (transform) {
    transform.setMode(mode);
    transform.setSpace(transformSpace);
    transform.showX = transform.showY = transform.showZ = true;
    // Re-apply our gizmo customization. Three.js' TransformControls toggles
    // visibility of whole sub-groups when switching modes; our hidden
    // children stay hidden but re-running is cheap and survives any future
    // internal rebuild.
    _customizeTransformGizmo();
  }
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
  _animateModeToggle();
  if (editorMode === 'object') enterEditMode();
  else leaveEditMode();
}

function enterEditMode() {
  if (!selectedId) return;
  editTargetId = selectedId;
  editorMode = 'edit';
  editSelection.clear();
  editEdgeSelection.clear();
  editFaceSelection.clear();
  buildEditHelpers();
  if (transform) transform.detach();
  updateModeButtons();
  updateToolbarVisibility();
  renderHierarchy();
  _updateObjectColorPicker();
  try { window.slateSfx?.play('mode-switch'); } catch (_) {}
}

function leaveEditMode() {
  if (editTargetId && editHelpers) commitEditChanges();
  destroyEditHelpers();
  editTargetId = null;
  editorMode = 'object';
  editSelection.clear();
  editEdgeSelection.clear();
  editFaceSelection.clear();
  if (transform) transform.detach();
  if (selectedId && objMeshes.has(selectedId)) transform?.attach(objMeshes.get(selectedId));
  updateModeButtons();
  updateToolbarVisibility();
  renderHierarchy();
  _updateObjectColorPicker();
  try { window.slateSfx?.play('mode-switch'); } catch (_) {}
}

/* Build a position-weld map: many primitives split coincident vertices for
   per-face normals/UVs, but for editing we want ONE logical vertex per
   distinct world position. Selection / transform / picking all run on the
   welded logical indices so moving "a vertex" moves all of its duplicates. */
function _weldKey(x, y, z) {
  return `${Math.round(x * 1e5)}|${Math.round(y * 1e5)}|${Math.round(z * 1e5)}`;
}
function _buildWeldMap(posAttr) {
  const logicalForIdx = new Int32Array(posAttr.count);
  const logicalToIdxs = [];
  const buckets = new Map();
  for (let i = 0; i < posAttr.count; i++) {
    const k = _weldKey(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    let logical = buckets.get(k);
    if (logical === undefined) {
      logical = logicalToIdxs.length;
      logicalToIdxs.push([]);
      buckets.set(k, logical);
    }
    logicalForIdx[i] = logical;
    logicalToIdxs[logical].push(i);
  }
  return { logicalForIdx, logicalToIdxs };
}

/* Make a topologically welded clone of a geometry, JUST for the
   edges-overlay computation. BoxGeometry & friends ship with split corner
   vertices (per-face normals) — that defeats EdgesGeometry's feature-edge
   detection so every triangle edge gets drawn. Welding by position before
   the EdgesGeometry pass means coplanar diagonals are hidden, so quads
   look like one face. */
function _weldedGeometryFor(geo) {
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return geo;
  const verts = [];
  const buckets = new Map();
  const weldFor = new Int32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const k = _weldKey(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    let id = buckets.get(k);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      buckets.set(k, id);
    }
    weldFor[i] = id;
  }
  const idx = [];
  const indexAttr = geo.getIndex();
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i++) idx.push(weldFor[indexAttr.getX(i)]);
  } else {
    for (let i = 0; i < posAttr.count; i++) idx.push(weldFor[i]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts), 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}

function buildEditHelpers() {
  destroyEditHelpers();
  // Defensive: vertex dots / edge overlay / selected-face fill must NEVER
  // exist while the user is back in object mode. If something accidentally
  // calls us outside edit mode, bail cleanly.
  if (editorMode !== 'edit' || !editTargetId) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;

  const geo = mesh.geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return;

  // Hide the source mesh's fill while editing — clone the edit overlay material
  // ONCE per edit session; re-cloning every rebuild (e.g. inset/extrude preview)
  // leaked materials and broke tools.
  if (!mesh.userData._slateEditBaseMaterial) {
    mesh.userData._slateEditBaseMaterial = mesh.material;
  }
  if (mesh.userData._slateEditOverlayMaterial && mesh.material !== mesh.userData._slateEditBaseMaterial) {
    try { mesh.userData._slateEditOverlayMaterial.dispose?.(); } catch (_) {}
  }
  mesh.material = mesh.userData._slateEditOverlayMaterial = mesh.userData._slateEditBaseMaterial.clone();
  mesh.material.transparent = true;
  mesh.material.opacity = 0.35;
  mesh.material.needsUpdate = true;

  const group = new THREE.Group();
  group.position.copy(mesh.position);
  group.rotation.copy(mesh.rotation);
  group.scale.copy(mesh.scale);
  scene.add(group);

  // Feature-edges overlay — a SUBTLE structural hint so users can see the
  // polygon outline without it visually competing with the selection overlay.
  // Welding by position before EdgesGeometry hides triangulation diagonals on
  // coplanar quads. depthTest:true so edges don't bleed through the mesh.
  const weldGeoForEdges = _weldedGeometryFor(geo);
  const edgesGeo = new THREE.EdgesGeometry(weldGeoForEdges, 1);
  weldGeoForEdges.dispose();
  const edgesMat = new THREE.LineBasicMaterial({
    color: 0xffffff, depthTest: true,
    transparent: true, opacity: 0.18,
  });
  const edges = new THREE.LineSegments(edgesGeo, edgesMat);
  edges.renderOrder = 2;
  group.add(edges);

  const weldMap = _buildWeldMap(posAttr);

  // Vertex points — ONE point per welded logical vertex.
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.Float32BufferAttribute(
    new Float32Array(weldMap.logicalToIdxs.length * 3), 3,
  ));
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

  // Selected-edges highlight (Blender-style bright edges layered on top).
  const selEdgesGeo = new THREE.BufferGeometry();
  selEdgesGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  const selEdgesMat = new THREE.LineBasicMaterial({
    color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95, linewidth: 2,
  });
  const selEdges = new THREE.LineSegments(selEdgesGeo, selEdgesMat);
  selEdges.renderOrder = 5;
  selEdges.visible = false;
  group.add(selEdges);

  // Selected-face translucent fill.
  const selFacesGeo = new THREE.BufferGeometry();
  selFacesGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  const selFacesMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.32,
    depthTest: false, side: THREE.DoubleSide,
  });
  const selFaces = new THREE.Mesh(selFacesGeo, selFacesMat);
  selFaces.renderOrder = 1; // under the edge overlay
  selFaces.visible = false;
  group.add(selFaces);

  editHelpers = { group, edges, points, selPoints, selEdges, selFaces, weldMap };
  _refreshEditPoints();
}

function _refreshEditPoints() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  const weld = editHelpers.weldMap;
  const arr = new Float32Array(weld.logicalToIdxs.length * 3);
  for (let i = 0; i < weld.logicalToIdxs.length; i++) {
    const g = weld.logicalToIdxs[i][0];
    arr[i * 3]     = posAttr.getX(g);
    arr[i * 3 + 1] = posAttr.getY(g);
    arr[i * 3 + 2] = posAttr.getZ(g);
  }
  editHelpers.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  editHelpers.points.geometry.attributes.position.needsUpdate = true;
}

function refreshEditHelpers() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const weldGeoForEdges = _weldedGeometryFor(mesh.geometry);
  const newEdges = new THREE.EdgesGeometry(weldGeoForEdges, 1);
  weldGeoForEdges.dispose();
  if (editHelpers.edges.geometry) editHelpers.edges.geometry.dispose();
  editHelpers.edges.geometry = newEdges;
  _refreshEditPoints();
  refreshSelectionMarker();
}

function refreshSelectionMarker() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  const weld = editHelpers.weldMap;
  const safe = logical => logical >= 0 && logical < weld.logicalToIdxs.length;
  const pos = logical => {
    const g = weld.logicalToIdxs[logical][0];
    return [posAttr.getX(g), posAttr.getY(g), posAttr.getZ(g)];
  };

  // ── Vertex dots — only in vertex mode (or as a subtle fallback). ──
  const showVertexDots = editSubMode === 'vertex';
  editHelpers.selPoints.visible = showVertexDots;
  if (showVertexDots) {
    const pts = [];
    editSelection.forEach(l => { if (safe(l)) pts.push(...pos(l)); });
    editHelpers.selPoints.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(pts), 3),
    );
    editHelpers.selPoints.geometry.attributes.position.needsUpdate = true;
  }

  // ── Edge highlights — only in edge mode. ──
  const showEdges = editSubMode === 'edge';
  editHelpers.selEdges.visible = showEdges;
  if (showEdges) {
    const segs = [];
    editEdgeSelection.forEach(k => {
      const [a, b] = _edgeKeyToVerts(k);
      if (!safe(a) || !safe(b)) return;
      segs.push(...pos(a), ...pos(b));
    });
    editHelpers.selEdges.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(segs), 3),
    );
    editHelpers.selEdges.geometry.attributes.position.needsUpdate = true;
  }

  // ── Face highlights — only in face mode. ──
  const showFaces = editSubMode === 'face';
  editHelpers.selFaces.visible = showFaces;
  if (showFaces) {
    const verts = [];
    editFaceSelection.forEach(face => {
      if (!Array.isArray(face) || face.length < 3) return;
      if (!face.every(safe)) return;
      // Fan-triangulate the polygon.
      const p0 = pos(face[0]);
      for (let i = 1; i < face.length - 1; i++) {
        verts.push(...p0, ...pos(face[i]), ...pos(face[i + 1]));
      }
    });
    editHelpers.selFaces.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(verts), 3),
    );
    editHelpers.selFaces.geometry.attributes.position.needsUpdate = true;
  }
}

function destroyEditHelpers() {
  if (!editHelpers) return;
  const mesh = objMeshes.get(editTargetId);
  if (mesh && mesh.userData._slateEditBaseMaterial) {
    if (mesh.material && mesh.material !== mesh.userData._slateEditBaseMaterial) {
      try { mesh.material.dispose?.(); } catch (_) {}
    }
    mesh.material = mesh.userData._slateEditBaseMaterial;
    mesh.material.transparent = false;
    mesh.material.opacity = 1;
    mesh.material.needsUpdate = true;
    delete mesh.userData._slateEditBaseMaterial;
    delete mesh.userData._slateEditOverlayMaterial;
  } else if (mesh && mesh.material) {
    mesh.material.transparent = false;
    mesh.material.opacity = 1;
    mesh.material.needsUpdate = true;
  }
  if (editHelpers.group) scene.remove(editHelpers.group);
  if (editHelpers.edges?.geometry)    editHelpers.edges.geometry.dispose();
  if (editHelpers.edges?.material)    editHelpers.edges.material.dispose();
  if (editHelpers.points?.geometry)   editHelpers.points.geometry.dispose();
  if (editHelpers.points?.material)   editHelpers.points.material.dispose();
  if (editHelpers.selPoints?.geometry) editHelpers.selPoints.geometry.dispose();
  if (editHelpers.selPoints?.material) editHelpers.selPoints.material.dispose();
  if (editHelpers.selEdges?.geometry)  editHelpers.selEdges.geometry.dispose();
  if (editHelpers.selEdges?.material)  editHelpers.selEdges.material.dispose();
  if (editHelpers.selFaces?.geometry)  editHelpers.selFaces.geometry.dispose();
  if (editHelpers.selFaces?.material)  editHelpers.selFaces.material.dispose();
  if (editDragHelper) { scene.remove(editDragHelper); editDragHelper = null; }
  editHelpers = null;
}

/** Find the welded logical vertex closest to (clientX, clientY) in screen space. */
function pickVertex(clientX, clientY) {
  const mesh = objMeshes.get(editTargetId);
  if (!mesh || !editHelpers) return -1;
  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return -1;
  const weld = editHelpers.weldMap;
  const rect = container.getBoundingClientRect();
  const nx =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((clientY - rect.top)  / rect.height) * 2 + 1;

  const worldMat = mesh.matrixWorld;
  const v = new THREE.Vector3();
  let best = -1, bestDist = Infinity;
  const threshold = 0.04; // NDC units
  for (let i = 0; i < weld.logicalToIdxs.length; i++) {
    const g = weld.logicalToIdxs[i][0];
    v.fromBufferAttribute(posAttr, g).applyMatrix4(worldMat).project(camera);
    if (v.z > 1 || v.z < -1) continue;
    const dx = v.x - nx, dy = v.y - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; best = i; }
  }
  return Math.sqrt(bestDist) <= threshold ? best : -1;
}

function _logicalVertWorld(logical) {
  const mesh = objMeshes.get(editTargetId);
  if (!mesh || !editHelpers) return null;
  const weld = editHelpers.weldMap;
  if (logical < 0 || logical >= weld.logicalToIdxs.length) return null;
  const posAttr = mesh.geometry.getAttribute('position');
  const g = weld.logicalToIdxs[logical][0];
  return new THREE.Vector3(posAttr.getX(g), posAttr.getY(g), posAttr.getZ(g))
    .applyMatrix4(mesh.matrixWorld);
}

function _triNormalLogical(logical3) {
  const a = _logicalVertWorld(logical3[0]);
  const b = _logicalVertWorld(logical3[1]);
  const c = _logicalVertWorld(logical3[2]);
  if (!a || !b || !c) return null;
  const e1 = b.sub(a);
  const e2 = c.sub(a);
  return new THREE.Vector3().crossVectors(e1, e2).normalize();
}

/** Return the ordered logical vertices forming the face under the cursor.
 *  Flood-fills across coplanar-connected triangles so an n-gon split into N-2
 *  triangles is reported as a single polygon. Curved surfaces (sphere/cylinder
 *  walls) stop at the coplanarity boundary so each rendered quad stays its
 *  own face. */
function pickFaceLogical(clientX, clientY) {
  const mesh = objMeshes.get(editTargetId);
  if (!mesh || !editHelpers) return null;
  const rect = container.getBoundingClientRect();
  pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length || !hits[0].face) return null;

  const weld = editHelpers.weldMap;
  const indexAttr = mesh.geometry.getIndex();
  const triCount = indexAttr
    ? (indexAttr.count / 3)
    : (mesh.geometry.getAttribute('position').count / 3);

  // Read a triangle as a logical-vert triple, dedup'd.
  const readTri = (t) => {
    let a, b, c;
    if (indexAttr) {
      a = weld.logicalForIdx[indexAttr.getX(t * 3)];
      b = weld.logicalForIdx[indexAttr.getX(t * 3 + 1)];
      c = weld.logicalForIdx[indexAttr.getX(t * 3 + 2)];
    } else {
      a = weld.logicalForIdx[t * 3];
      b = weld.logicalForIdx[t * 3 + 1];
      c = weld.logicalForIdx[t * 3 + 2];
    }
    if (a === b || b === c || a === c) return null;
    return [a, b, c];
  };

  const startTri = hits[0].faceIndex;
  const baseTri  = readTri(startTri);
  if (!baseTri) {
    const f = hits[0].face;
    return [...new Set([
      weld.logicalForIdx[f.a],
      weld.logicalForIdx[f.b],
      weld.logicalForIdx[f.c],
    ])];
  }

  const baseNormal = _triNormalLogical(baseTri);
  if (!baseNormal) return [...new Set(baseTri)];

  // Edge -> [triIndices] adjacency, built lazily once per pick.
  const edgeMap = new Map();
  const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  for (let t = 0; t < triCount; t++) {
    const tri = readTri(t);
    if (!tri) continue;
    const ek1 = edgeKey(tri[0], tri[1]);
    const ek2 = edgeKey(tri[1], tri[2]);
    const ek3 = edgeKey(tri[2], tri[0]);
    [ek1, ek2, ek3].forEach(k => {
      let arr = edgeMap.get(k);
      if (!arr) { arr = []; edgeMap.set(k, arr); }
      arr.push(t);
    });
  }

  // Flood-fill across coplanar neighbours. An edge is a boundary edge of the
  // polygon ONLY if it has no coplanar same-facing neighbour at all. Edges
  // that lead to a coplanar tri (visited or not) are interior.
  const visited = new Set([startTri]);
  const queue = [startTri];
  const member = new Set(baseTri);
  const boundaryEdges = []; // [a, b] tuples — half-edges in walk order
  const triEdges = (tri) => [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];

  while (queue.length) {
    const t = queue.shift();
    const tri = readTri(t);
    if (!tri) continue;
    for (const [a, b] of triEdges(tri)) {
      const k = edgeKey(a, b);
      const others = (edgeMap.get(k) || []).filter(o => o !== t);
      let connectsToCoplanar = false;
      for (const o of others) {
        const otri = readTri(o);
        if (!otri) continue;
        const n2 = _triNormalLogical(otri);
        if (!n2) continue;
        // Require same-facing AND nearly parallel (≈ <3° dihedral).
        // Use signed dot so a backface (opposite normal) doesn't merge.
        if (baseNormal.dot(n2) <= 0.9985) continue;
        connectsToCoplanar = true;
        if (visited.has(o)) continue;
        visited.add(o);
        queue.push(o);
        otri.forEach(v => member.add(v));
      }
      if (!connectsToCoplanar) boundaryEdges.push([a, b]);
    }
  }

  // Walk the boundary half-edges to produce an ordered polygon ring.
  // boundaryEdges may contain duplicate undirected edges (shared between two
  // triangles whose third vertex is in the same plane on opposite sides — rare
  // but defensive). Drop edges whose undirected key appears twice.
  const undirCount = new Map();
  boundaryEdges.forEach(([a, b]) => {
    const k = edgeKey(a, b);
    undirCount.set(k, (undirCount.get(k) || 0) + 1);
  });
  const cleanEdges = boundaryEdges.filter(([a, b]) => undirCount.get(edgeKey(a, b)) === 1);

  if (cleanEdges.length < 3) return [...member];

  // Build a next-vertex lookup. Some edges may go in reverse — accept either
  // direction; we'll greedily walk.
  const next = new Map();
  cleanEdges.forEach(([a, b]) => {
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(b);
  });
  const start = cleanEdges[0][0];
  const ring  = [start];
  let cur = start;
  const used = new Set();
  for (let safety = 0; safety < cleanEdges.length + 1; safety++) {
    const opts = next.get(cur) || [];
    let chosen = null;
    for (const n of opts) {
      const k = `${cur}->${n}`;
      if (used.has(k)) continue;
      // Avoid going back to ring[ring.length - 2] if there's another option.
      if (ring.length >= 2 && n === ring[ring.length - 2] && opts.length > 1) continue;
      chosen = n;
      used.add(k);
      break;
    }
    if (chosen == null) break;
    if (chosen === start) break;
    ring.push(chosen);
    cur = chosen;
  }
  if (ring.length < 3) return [...member];
  return ring;
}

function handleEditClick(e) {
  if (bevelState || extrudeState || insetState) return;
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
    const verts = pickFaceLogical(e.clientX, e.clientY);
    if (verts && verts.length >= 3) {
      const fk = _faceKey(verts);
      if (!additive) editFaceSelection.clear();
      if (editFaceSelection.has(fk)) editFaceSelection.delete(fk);
      else editFaceSelection.set(fk, [...verts]);
      _syncDerivedVertSelection();
      changed = true;
    } else if (!additive) {
      editFaceSelection.clear();
      _syncDerivedVertSelection();
      changed = true;
    }
  } else if (editSubMode === 'edge') {
    const verts = pickFaceLogical(e.clientX, e.clientY);
    if (verts && verts.length >= 2) {
      // Snap to the edge of the picked face that's closest to the cursor in
      // screen space — same heuristic as before but stable per edge.
      const rect = container.getBoundingClientRect();
      const nx =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const ny = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      const project = logical => {
        const wp = _logicalVertWorld(logical);
        if (!wp) return null;
        wp.project(camera);
        return { x: wp.x, y: wp.y };
      };
      // Build polygon boundary edges (consecutive pairs in the face ring).
      let bestKey = null, bestDist = Infinity;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const pa = project(a), pb = project(b);
        if (!pa || !pb) continue;
        // Distance from cursor to the projected edge segment.
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((nx - pa.x) * dx + (ny - pa.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = pa.x + dx * t, py = pa.y + dy * t;
        const d = Math.hypot(px - nx, py - ny);
        if (d < bestDist) { bestDist = d; bestKey = _edgeKey(a, b); }
      }
      if (bestKey) {
        if (!additive) editEdgeSelection.clear();
        if (editEdgeSelection.has(bestKey)) editEdgeSelection.delete(bestKey);
        else editEdgeSelection.add(bestKey);
        _syncDerivedVertSelection();
        changed = true;
      } else if (!additive) {
        editEdgeSelection.clear();
        _syncDerivedVertSelection();
        changed = true;
      }
    } else if (!additive) {
      editEdgeSelection.clear();
      _syncDerivedVertSelection();
      changed = true;
    }
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
  const weld = editHelpers.weldMap;

  // Centroid in world space across welded logical verts.
  const c = new THREE.Vector3();
  let n = 0;
  const tmp = new THREE.Vector3();
  editSelection.forEach(logical => {
    if (logical < 0 || logical >= weld.logicalToIdxs.length) return;
    const g = weld.logicalToIdxs[logical][0];
    tmp.fromBufferAttribute(posAttr, g).applyMatrix4(mesh.matrixWorld);
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
  const weld = editHelpers.weldMap;

  const invWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const last = editDragHelper.userData.lastPos.clone();
  const curr = editDragHelper.position.clone();
  const lastQuat = editDragHelper.userData.lastQuat.clone();
  const currQuat = editDragHelper.quaternion.clone();
  const lastScl = editDragHelper.userData.lastScale.clone();
  const currScl = editDragHelper.scale.clone();

  const pivotLocal = last.clone().applyMatrix4(invWorld);
  const newPivotLocal = curr.clone().applyMatrix4(invWorld);

  const deltaQuatW = currQuat.clone().multiply(lastQuat.clone().invert());
  const meshWorldQuat = new THREE.Quaternion();
  mesh.getWorldQuaternion(meshWorldQuat);
  const invMeshQuat = meshWorldQuat.clone().invert();
  const deltaQuatL = invMeshQuat.clone().multiply(deltaQuatW).multiply(meshWorldQuat);

  const sx = (currScl.x || 1) / (lastScl.x || 1);
  const sy = (currScl.y || 1) / (lastScl.y || 1);
  const sz = (currScl.z || 1) / (lastScl.z || 1);

  const v = new THREE.Vector3();
  editSelection.forEach(logical => {
    if (logical < 0 || logical >= weld.logicalToIdxs.length) return;
    const idxs = weld.logicalToIdxs[logical];
    for (const g of idxs) {
      v.fromBufferAttribute(posAttr, g);
      v.sub(pivotLocal);
      if (transformMode === 'scale')  v.set(v.x * sx, v.y * sy, v.z * sz);
      if (transformMode === 'rotate') v.applyQuaternion(deltaQuatL);
      v.add(newPivotLocal);
      posAttr.setXYZ(g, v.x, v.y, v.z);
    }
  });
  posAttr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  refreshEditHelpers();

  editDragHelper.userData.lastPos = curr.clone();
  editDragHelper.userData.lastQuat = currQuat.clone();
  editDragHelper.userData.lastScale = currScl.clone();
}

/* ─────────────────────────────────────────────────────────────────────────
   Mesh-editing operators (Blender-style): extrude, inset, bevel, loop-cut,
   subdivide, merge, delete. All operators work on the canonical meshData
   (welded polygons) — they call _editFreshMeshData() to make sure the doc
   reflects any in-flight vertex transforms first.
───────────────────────────────────────────────────────────────────────── */
function _editFreshMeshData() {
  if (!editTargetId) return null;
  // Commit any pending in-flight transforms so the doc has the latest verts.
  commitEditChanges();
  const obj = window.slateScene3d?.find(editTargetId);
  if (!obj || !obj.meshData) return null;
  return {
    vertices: [...(obj.meshData.vertices || []).map(Number)],
    faces: _cloneFacesArray(obj.meshData.faces),
  };
}

/** Wraps a mesh operator so any thrown error surfaces as a visible hint and
 *  the rest of the editor stays usable. Without this, a typo in one operator
 *  silently kills the keystroke and the user can't tell what's wrong. */
function _runMeshOp(name, fn) {
  if (!editTargetId) {
    _showEditHint(`${name}: enter edit mode first (Tab)`);
    return;
  }
  try {
    fn();
  } catch (err) {
    console.error(`[slate3d] ${name} failed:`, err);
    _showEditHint(`${name} error: ${err?.message || err}`);
  }
}

/** Small ephemeral hint shown bottom-center of the viewport when a mesh tool
 *  needs a different selection. Avoids silent failures. */
let _editHintEl = null;
let _editHintTimer = null;
function _showEditHint(msg) {
  if (!container) return;
  if (!_editHintEl) {
    _editHintEl = document.createElement('div');
    _editHintEl.style.cssText = `
      position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
      background: rgba(15, 15, 22, 0.92); color: #f1f1f5;
      border: 1px solid rgba(124, 106, 255, 0.4);
      padding: 6px 14px; border-radius: 8px;
      font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px;
      pointer-events: none; opacity: 0; transition: opacity 0.15s;
      z-index: 30; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    `;
    container.appendChild(_editHintEl);
  }
  _editHintEl.textContent = msg;
  _editHintEl.style.opacity = '1';
  if (_editHintTimer) clearTimeout(_editHintTimer);
  _editHintTimer = setTimeout(() => {
    if (_editHintEl) _editHintEl.style.opacity = '0';
  }, 1800);
}

/** Derive a face selection from the current selection when face mode is
 *  expected but the user is in vertex/edge mode or face mode has no entries.
 *  Returns an array of vert-index arrays (each a face). Returns [] if nothing
 *  reasonable can be derived. */
function _deriveFaceSelection(md) {
  if (!md || !Array.isArray(md.faces)) return [];
  const polys = md.faces.filter(f => Array.isArray(f));

  // Face mode with explicit selection — easy.
  if (editSubMode === 'face' && editFaceSelection.size) {
    return [...editFaceSelection.values()].map(v => [...v]);
  }
  // Edge mode: every face that contains the selected edge.
  if (editSubMode === 'edge' && editEdgeSelection.size) {
    const wantPairs = [...editEdgeSelection].map(_edgeKeyToVerts);
    const seen = new Set();
    const out = [];
    polys.forEach(f => {
      for (const [a, b] of wantPairs) {
        for (let i = 0; i < f.length; i++) {
          const x = f[i], y = f[(i + 1) % f.length];
          if ((x === a && y === b) || (x === b && y === a)) {
            const k = _faceKey(f);
            if (!seen.has(k)) { seen.add(k); out.push([...f]); }
            return;
          }
        }
      }
    });
    return out;
  }
  // Vertex mode: every face whose every vertex is in the selection.
  if (editSubMode === 'vertex' && editSelection.size) {
    const sel = editSelection;
    return polys.filter(f => f.every(v => sel.has(v))).map(f => [...f]);
  }
  return [];
}

function _vecFromArr(verts, i) {
  return new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
}
function _faceNormalFromVerts(verts, face) {
  // Newell's method — robust against non-planar polygons.
  const n = new THREE.Vector3();
  for (let i = 0; i < face.length; i++) {
    const a = _vecFromArr(verts, face[i]);
    const b = _vecFromArr(verts, face[(i + 1) % face.length]);
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-10) return new THREE.Vector3(0, 1, 0);
  return n.normalize();
}
function _faceCentroidFromVerts(verts, face) {
  const c = new THREE.Vector3();
  for (const idx of face) c.add(_vecFromArr(verts, idx));
  return c.divideScalar(Math.max(1, face.length));
}

/** Find the index in `faces` of any polygon whose vertex set equals `targetSet`.
 *  Used to look up "the same" face that was selected before the rebuild.
 *  Falls back to a "best overlap" match if no perfect match exists — handy
 *  when the picker reports a slightly different polygon than what's stored
 *  (e.g. a quad picked as 3 verts because a coplanar diagonal is missing). */
function _findFaceIndex(faces, targetVerts) {
  if (!Array.isArray(targetVerts) || targetVerts.length < 3) return -1;
  const want = new Set(targetVerts);

  // Exact match first.
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!Array.isArray(f) || f.length !== targetVerts.length) continue;
    if (f.every(v => want.has(v))) return i;
  }

  // Fallback: pick the polygon with the most shared verts (>=3 overlap and
  // the overlap covers the majority of the stored polygon).
  let bestIdx = -1, bestShare = 0;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!Array.isArray(f) || f.length < 3) continue;
    let shared = 0;
    for (const v of f) if (want.has(v)) shared++;
    if (shared > bestShare && shared >= 3 && shared >= f.length - 1) {
      bestShare = shared;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Undirected edge → face indices that contain that edge (polygon mesh). */
function _buildMeshEdgeFaces(faces) {
  const m = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    if (!Array.isArray(f) || f.length < 3) continue;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = _edgeKey(a, b);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(fi);
    }
  }
  return m;
}

/** Opposite edge in a quad face given one directed edge (a,b) on that face. */
function _oppositeVertsInQuad(face, a, b) {
  if (!face || face.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const x = face[i], y = face[(i + 1) % 4];
    if ((x === a && y === b) || (x === b && y === a)) {
      return [face[(i + 2) % 4], face[(i + 3) % 4]];
    }
  }
  return null;
}

/** Walk a quad-only edge loop through `seedKey` and return split ops (face index + opposite edge pair). */
function _loopCutQuadRingOps(faces, seedKey, edgeFaces) {
  const seedFis = edgeFaces.get(seedKey) || [];
  if (!seedFis.length) return null;
  const ops = [];
  const seenFi = new Set();
  let fi = seedFis[0];
  let [curA, curB] = _edgeKeyToVerts(seedKey);
  const startKey = seedKey;
  for (let guard = 0; guard < 20000; guard++) {
    const face = faces[fi];
    if (!face || face.length !== 4) break;
    const opp = _oppositeVertsInQuad(face, curA, curB);
    if (!opp) break;
    const [nextA, nextB] = opp;
    if (!seenFi.has(fi)) {
      seenFi.add(fi);
      ops.push({ fi, e1a: curA, e1b: curB, e2a: nextA, e2b: nextB });
    }
    const nextKey = _edgeKey(nextA, nextB);
    if (nextKey === startKey) break;
    const nf = edgeFaces.get(nextKey) || [];
    const nfi = nf.find(fdx => fdx !== fi);
    if (nfi === undefined) break;
    curA = nextA;
    curB = nextB;
    fi = nfi;
  }
  return ops.length ? ops : null;
}

/** Split one quad by midpoints of two opposite edges; replaces faces[fi] with first quad, appends second. */
function _splitQuadAlongOppositeMids(verts, faces, fi, getEdgeMid, e1a, e1b, e2a, e2b) {
  const face = faces[fi];
  if (!face || face.length !== 4) return null;
  let i0 = -1;
  for (let i = 0; i < 4; i++) {
    const x = face[i], y = face[(i + 1) % 4];
    if ((x === e1a && y === e1b) || (x === e1b && y === e1a)) { i0 = i; break; }
  }
  if (i0 < 0) return null;
  const i1 = (i0 + 1) % 4, i2 = (i0 + 2) % 4, i3 = (i0 + 3) % 4;
  const x2 = face[i2], y2 = face[(i2 + 1) % 4];
  if (!((x2 === e2a && y2 === e2b) || (x2 === e2b && y2 === e2a))) return null;
  const m1 = getEdgeMid(face[i0], face[i1]);
  const m2 = getEdgeMid(face[i2], face[(i2 + 1) % 4]);
  const q1 = [face[i0], m1, m2, face[i3]];
  const q2 = [m1, face[i1], face[i2], m2];
  faces[fi] = q1;
  faces.push(q2);
  return { q1, q2 };
}

/** Average centroid + averaged face normals for interactive extrude depth. */
function _buildExtrudePlane(md, targets) {
  if (!md || !targets?.length) return null;
  const faces = md.faces.map(f => (Array.isArray(f) ? [...f] : f));
  const verts = md.vertices;
  const C = new THREE.Vector3();
  const N = new THREE.Vector3();
  let n = 0;
  for (const sel of targets) {
    const fi = _findFaceIndex(faces, sel);
    if (fi < 0) continue;
    const face = faces[fi];
    const nrm = _faceNormalFromVerts(verts, face);
    if (nrm.lengthSq() < 1e-20) continue;
    nrm.normalize();
    C.add(_faceCentroidFromVerts(verts, face));
    N.add(nrm);
    n++;
  }
  if (!n) return null;
  C.divideScalar(n);
  if (N.lengthSq() < 1e-16) return null;
  N.normalize();
  return { origin: C, normal: N };
}

/** Signed extrusion distance along `plane.normal` from ray–plane hit (screen mouse). */
function _extrudeSignedDistanceFromPointer(clientX, clientY, plane) {
  if (!container || !camera || !raycaster || !plane) return 0;
  const rect = container.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  _extrudePlaneThree.setFromNormalAndCoplanarPoint(plane.normal, plane.origin);
  const hit = raycaster.ray.intersectPlane(_extrudePlaneThree, _extrudeHitVec);
  if (!hit) return 0;
  _extrudeDelta.subVectors(_extrudeHitVec, plane.origin);
  return _extrudeDelta.dot(plane.normal);
}

function _computeExtrude(md, targets, distance) {
  if (!md || !targets?.length) return null;
  const verts = md.vertices.slice();
  const faces = md.faces.map(f => Array.isArray(f) ? [...f] : f);
  const newFaceSelections = [];
  for (const sel of targets) {
    const fi = _findFaceIndex(faces, sel);
    if (fi < 0) continue;
    const face = faces[fi];
    const n = _faceNormalFromVerts(verts, face);
    if (n.lengthSq() < 1e-20) continue;
    n.normalize().multiplyScalar(distance);
    const newIdxs = face.map(oldIdx => {
      const p = _vecFromArr(verts, oldIdx).clone().add(n);
      verts.push(p.x, p.y, p.z);
      return (verts.length / 3) - 1;
    });
    faces[fi] = newIdxs.slice();
    newFaceSelections.push(newIdxs.slice());
    for (let i = 0; i < face.length; i++) {
      const j = (i + 1) % face.length;
      faces.push([face[i], face[j], newIdxs[j], newIdxs[i]]);
    }
  }
  if (!newFaceSelections.length) return null;
  return { vertices: verts, faces, newFaceSelections };
}

function _computeInset(md, targets, factor) {
  if (!md || !targets?.length) return null;
  const fClamped = Math.max(0.001, Math.min(0.49, factor));
  const verts = md.vertices.slice();
  const faces = md.faces.map(f => Array.isArray(f) ? [...f] : f);
  const newFaceSelections = [];
  for (const sel of targets) {
    const fi = _findFaceIndex(faces, sel);
    if (fi < 0) continue;
    const face = faces[fi];
    if (face.length < 3) continue;
    const centroid = _faceCentroidFromVerts(verts, face);
    const innerIdxs = face.map(oldIdx => {
      const p = _vecFromArr(verts, oldIdx).clone().lerp(centroid, fClamped);
      verts.push(p.x, p.y, p.z);
      return (verts.length / 3) - 1;
    });
    faces[fi] = innerIdxs.slice();
    newFaceSelections.push(innerIdxs.slice());
    for (let i = 0; i < face.length; i++) {
      const j = (i + 1) % face.length;
      faces.push([face[i], face[j], innerIdxs[j], innerIdxs[i]]);
    }
  }
  if (!newFaceSelections.length) return null;
  return { vertices: verts, faces, newFaceSelections };
}

/** Apply new mesh data, then rebuild edit helpers and restore the structural
 *  selections supplied by the caller (already expressed in NEW vertex
 *  indices). Falls back to clearing selections if anything looks off. */
function _editApplyMeshData(meshData, nextSel) {
  window.slateScene3d?.setMeshData(editTargetId, meshData);
  if (editorMode !== 'edit' || !editTargetId) return;
  buildEditHelpers();
  editSelection.clear();
  editEdgeSelection.clear();
  editFaceSelection.clear();
  const weldCount = editHelpers ? editHelpers.weldMap.logicalToIdxs.length : 0;
  const inRange = i => i >= 0 && i < weldCount;
  if (nextSel?.verts)  nextSel.verts.forEach(v => { if (inRange(v)) editSelection.add(v); });
  if (nextSel?.edges)  nextSel.edges.forEach(([a, b]) => {
    if (inRange(a) && inRange(b)) editEdgeSelection.add(_edgeKey(a, b));
  });
  if (nextSel?.faces)  nextSel.faces.forEach(verts => {
    if (Array.isArray(verts) && verts.every(inRange)) {
      editFaceSelection.set(_faceKey(verts), [...verts]);
    }
  });
  _syncDerivedVertSelection();
  refreshSelectionMarker();
  attachGizmoToEditSelection();
}

/** Extrude — interactive: move mouse / scroll for distance, LMB / Enter confirm, RMB / Esc cancel. */
let _extrudeHintEl = null;

function extrudeSelectedFaces(distance) {
  if (editorMode !== 'edit') return;
  if (grabState || bevelState || extrudeState || insetState) return;
  const md = _editFreshMeshData();
  if (!md) { _showEditHint('Nothing to extrude — select a face first'); return; }
  const targets = _deriveFaceSelection(md);
  if (!targets.length) {
    _showEditHint('Select a face to extrude (press 3 for face mode)');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  if (typeof distance === 'number' && Number.isFinite(distance)) {
    const result = _computeExtrude(md, targets, distance);
    if (!result) return;
    window.slateScene3dBeginAction?.();
    setEditSubMode('face');
    _editApplyMeshData({ vertices: result.vertices, faces: result.faces }, { faces: result.newFaceSelections });
    try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
    return;
  }
  const plane = _buildExtrudePlane(md, targets);
  if (!plane) {
    _showEditHint('Could not compute extrusion direction for selection');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  extrudeState = {
    snapshot: _cloneMeshDataDeep(md),
    targets,
    plane,
    wheelOffset: 0,
    distance: 0,
    didSetFaceMode: false,
  };
  window.slateScene3dBeginAction?.();
  if (orbit) orbit.enabled = false;
  if (transform) { transform.enabled = false; transform.detach(); }
  if (transformHelper) transformHelper.visible = false;
  container.addEventListener('pointermove', _onExtrudePointerMove, true);
  container.addEventListener('wheel', _onExtrudeWheel, { capture: true, passive: false });
  _showExtrudeHint();
  try { window.slateSfx?.play('grab-start'); } catch (_) {}
  _applyExtrude();
}
function _onExtrudePointerMove(e) {
  if (!extrudeState) return;
  _lastMouseClientX = e.clientX;
  _lastMouseClientY = e.clientY;
  _applyExtrude();
}
function _onExtrudeWheel(e) {
  if (!extrudeState) return;
  e.preventDefault(); e.stopPropagation();
  extrudeState.wheelOffset += e.deltaY < 0 ? 0.06 : -0.06;
  _applyExtrude();
}
function _applyExtrude() {
  if (!extrudeState) return;
  const cx = _lastMouseClientX ?? 0;
  const cy = _lastMouseClientY ?? 0;
  const raw = _extrudeSignedDistanceFromPointer(cx, cy, extrudeState.plane) + extrudeState.wheelOffset;
  extrudeState.distance = Math.max(-6, Math.min(6, raw));
  const result = _computeExtrude(extrudeState.snapshot, extrudeState.targets, extrudeState.distance);
  if (!result) return;
  if (!extrudeState.didSetFaceMode) {
    extrudeState.didSetFaceMode = true;
    editSubMode = 'face';
    document.querySelectorAll('#toolbar-3d .t3d-esel-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.sel === 'face');
    });
  }
  _editApplyMeshData(
    { vertices: result.vertices, faces: result.faces },
    { faces: result.newFaceSelections },
  );
  _updateExtrudeHint();
}
function _extrudeConfirm() {
  if (!extrudeState) return;
  container.removeEventListener('pointermove', _onExtrudePointerMove, true);
  container.removeEventListener('wheel', _onExtrudeWheel, { capture: true });
  extrudeState = null;
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideExtrudeHint();
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}
function _extrudeCancel() {
  if (!extrudeState) return;
  const snap = extrudeState.snapshot;
  container.removeEventListener('pointermove', _onExtrudePointerMove, true);
  container.removeEventListener('wheel', _onExtrudeWheel, { capture: true });
  extrudeState = null;
  _editApplyMeshData(snap, {});
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideExtrudeHint();
  try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
}
function _showExtrudeHint() {
  if (!container) return;
  if (!_extrudeHintEl) {
    _extrudeHintEl = document.createElement('div');
    _extrudeHintEl.className = 'fly-cam-hint';
    container.appendChild(_extrudeHintEl);
  }
  _extrudeHintEl.style.display = '';
  _updateExtrudeHint();
}
function _updateExtrudeHint() {
  if (!_extrudeHintEl || !extrudeState) return;
  _extrudeHintEl.textContent =
    `Extrude · ${extrudeState.distance.toFixed(3)} · move mouse / scroll · click to confirm · RMB / Esc cancel`;
}
function _hideExtrudeHint() {
  if (_extrudeHintEl) _extrudeHintEl.style.display = 'none';
}

/** Inset — interactive depth like Blender; LMB confirms, RMB / Esc cancels. */
let _insetHintEl = null;

function insetSelectedFaces(factor) {
  if (editorMode !== 'edit') return;
  if (grabState || bevelState || extrudeState || insetState) return;
  const md = _editFreshMeshData();
  if (!md) { _showEditHint('Nothing to inset — select a face first'); return; }
  const targets = _deriveFaceSelection(md);
  if (!targets.length) {
    _showEditHint('Select a face to inset (press 3 for face mode)');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  if (typeof factor === 'number' && Number.isFinite(factor)) {
    const result = _computeInset(md, targets, factor);
    if (!result) return;
    window.slateScene3dBeginAction?.();
    setEditSubMode('face');
    _editApplyMeshData({ vertices: result.vertices, faces: result.faces }, { faces: result.newFaceSelections });
    try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
    return;
  }
  insetState = {
    snapshot: _cloneMeshDataDeep(md),
    targets,
    startX: _lastMouseClientX ?? 0,
    wheelOffset: 0,
    factor: 0.12,
    didSetFaceMode: false,
  };
  window.slateScene3dBeginAction?.();
  if (orbit) orbit.enabled = false;
  if (transform) { transform.enabled = false; transform.detach(); }
  if (transformHelper) transformHelper.visible = false;
  container.addEventListener('pointermove', _onInsetPointerMove, true);
  container.addEventListener('wheel', _onInsetWheel, { capture: true, passive: false });
  _showInsetHint();
  try { window.slateSfx?.play('grab-start'); } catch (_) {}
  _applyInset();
}
function _onInsetPointerMove(e) {
  if (!insetState) return;
  _lastMouseClientX = e.clientX;
  _lastMouseClientY = e.clientY;
  _applyInset();
}
function _onInsetWheel(e) {
  if (!insetState) return;
  e.preventDefault(); e.stopPropagation();
  insetState.wheelOffset += e.deltaY < 0 ? 0.02 : -0.02;
  _applyInset();
}
function _applyInset() {
  if (!insetState) return;
  const clientX = _lastMouseClientX ?? insetState.startX;
  const dx = clientX - insetState.startX;
  const raw = dx * 0.0022 + insetState.wheelOffset;
  insetState.factor = Math.max(0.01, Math.min(0.48, 0.12 + raw));
  const result = _computeInset(insetState.snapshot, insetState.targets, insetState.factor);
  if (!result) return;
  if (!insetState.didSetFaceMode) {
    insetState.didSetFaceMode = true;
    editSubMode = 'face';
    document.querySelectorAll('#toolbar-3d .t3d-esel-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.sel === 'face');
    });
  }
  _editApplyMeshData(
    { vertices: result.vertices, faces: result.faces },
    { faces: result.newFaceSelections },
  );
  _updateInsetHint();
}
function _insetConfirm() {
  if (!insetState) return;
  container.removeEventListener('pointermove', _onInsetPointerMove, true);
  container.removeEventListener('wheel', _onInsetWheel, { capture: true });
  insetState = null;
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideInsetHint();
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}
function _insetCancel() {
  if (!insetState) return;
  const snap = insetState.snapshot;
  container.removeEventListener('pointermove', _onInsetPointerMove, true);
  container.removeEventListener('wheel', _onInsetWheel, { capture: true });
  insetState = null;
  _editApplyMeshData(snap, {});
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideInsetHint();
  try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
}
function _showInsetHint() {
  if (!container) return;
  if (!_insetHintEl) {
    _insetHintEl = document.createElement('div');
    _insetHintEl.className = 'fly-cam-hint';
    container.appendChild(_insetHintEl);
  }
  _insetHintEl.style.display = '';
  _updateInsetHint();
}
function _updateInsetHint() {
  if (!_insetHintEl || !insetState) return;
  _insetHintEl.textContent =
    `Inset · ${insetState.factor.toFixed(3)} · drag / scroll · click confirm · RMB / Esc cancel`;
}
function _hideInsetHint() {
  if (_insetHintEl) _insetHintEl.style.display = 'none';
}

/** Subdivide faces: each **quad** becomes **four** corner quads (edge midpoints
 *  + face center). Tris become three corner quads; n-gons become n quads around
 *  the centroid. When no face is selected, subdivides every face ("Subdivide all").
 *
 *  For partial subdivisions, neighbouring faces that share an edge with a
 *  subdivided face get edge-split midpoints inserted so the mesh stays manifold. */
function subdivideSelectedFaces() {
  if (editorMode !== 'edit') return;
  const md = _editFreshMeshData();
  if (!md) { _showEditHint('Nothing to subdivide'); return; }
  let targets = _deriveFaceSelection(md);
  const subdivideAll = !targets.length;
  if (subdivideAll) {
    targets = md.faces.filter(f => Array.isArray(f) && f.length >= 3).map(f => [...f]);
  }
  if (!targets.length) {
    _showEditHint('Mesh has no polygonal faces yet — enter edit mode first');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  window.slateScene3dBeginAction?.();
  const verts = md.vertices.slice();
  const faces = md.faces.map(f => Array.isArray(f) ? [...f] : f);

  // Cache shared edge midpoints by edgeKey so neighbour faces share verts.
  const edgeMid = new Map();
  function getEdgeMid(a, b) {
    const k = _edgeKey(a, b);
    if (edgeMid.has(k)) return edgeMid.get(k);
    const pa = _vecFromArr(verts, a), pb = _vecFromArr(verts, b);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    verts.push(mid.x, mid.y, mid.z);
    const idx = (verts.length / 3) - 1;
    edgeMid.set(k, idx);
    return idx;
  }

  // First pass: emit the subdivided quads for each target face and mark the
  // original index for removal. We touch `getEdgeMid` here so subsequent
  // passes see all the new midpoints.
  const removeAt = new Set();
  const newFaceSelections = [];
  const targetFaceIdxs = new Set();
  for (const sel of targets) {
    const fi = _findFaceIndex(faces, sel);
    if (fi < 0) continue;
    targetFaceIdxs.add(fi);
    const face = faces[fi];
    removeAt.add(fi);
    const centroid = _faceCentroidFromVerts(verts, face);
    verts.push(centroid.x, centroid.y, centroid.z);
    const cIdx = (verts.length / 3) - 1;
    const n = face.length;
    const mids = face.map((_, i) => getEdgeMid(face[i], face[(i + 1) % n]));
    // Quads → exactly four corner quads (equal topological split).
    if (n === 4) {
      for (let i = 0; i < 4; i++) {
        const prev = (i + 3) % 4;
        const quad = [face[i], mids[i], cIdx, mids[prev]];
        faces.push(quad);
        newFaceSelections.push(quad.slice());
      }
    } else {
      for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const quad = [face[i], mids[i], cIdx, mids[prev]];
        faces.push(quad);
        newFaceSelections.push(quad.slice());
      }
    }
  }

  // Second pass: walk every UN-subdivided face and edge-split any of its edges
  // that gained a midpoint in pass 1. Without this the mesh ends up with
  // T-junctions where one side has [A, M, B] and the other still has [A, B].
  if (!subdivideAll) {
    for (let fi = 0; fi < faces.length; fi++) {
      if (removeAt.has(fi) || targetFaceIdxs.has(fi)) continue;
      const f = faces[fi];
      if (!Array.isArray(f) || f.length < 3) continue;
      const out = [];
      let split = false;
      for (let i = 0; i < f.length; i++) {
        out.push(f[i]);
        const a = f[i], b = f[(i + 1) % f.length];
        const k = _edgeKey(a, b);
        if (edgeMid.has(k)) {
          out.push(edgeMid.get(k));
          split = true;
        }
      }
      if (split) faces[fi] = out;
    }
  }

  const compact = faces.filter((_, i) => !removeAt.has(i));
  setEditSubMode('face');
  _editApplyMeshData({ vertices: verts, faces: compact }, { faces: newFaceSelections });
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}

/** Loop cut — follows a quad edge loop through the selected edge (or first edge of a face). */
function loopCutSelectedFaces() {
  if (editorMode !== 'edit') return;
  const md = _editFreshMeshData();
  if (!md) { _showEditHint('Nothing to cut — select an edge or face first'); return; }
  const verts = md.vertices.slice();
  const faces = md.faces.map(f => Array.isArray(f) ? [...f] : f);
  const edgeFaces = _buildMeshEdgeFaces(faces);
  const seeds = [];
  if (editSubMode === 'edge' && editEdgeSelection.size) {
    editEdgeSelection.forEach(k => seeds.push(k));
  } else if (editSubMode === 'face' && editFaceSelection.size) {
    const ring = [...editFaceSelection.values()][0];
    if (ring && ring.length >= 2) seeds.push(_edgeKey(ring[0], ring[1]));
  } else {
    const derived = _deriveFaceSelection(md);
    if (derived.length && derived[0].length >= 2) {
      seeds.push(_edgeKey(derived[0][0], derived[0][1]));
    }
  }
  if (!seeds.length) {
    _showEditHint('Loop cut: select an edge (2) or face (3), or use Ctrl+R on a face');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }

  window.slateScene3dBeginAction?.();
  const edgeMid = new Map();
  function getEdgeMid(a, b) {
    const k = _edgeKey(a, b);
    if (edgeMid.has(k)) return edgeMid.get(k);
    const pa = _vecFromArr(verts, a), pb = _vecFromArr(verts, b);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    verts.push(mid.x, mid.y, mid.z);
    const idx = (verts.length / 3) - 1;
    edgeMid.set(k, idx);
    return idx;
  }

  const newFaceSelections = [];
  const appliedFi = new Set();
  let didRing = false;
  for (const seed of seeds) {
    const ops = _loopCutQuadRingOps(faces, seed, edgeFaces);
    if (!ops) continue;
    const sorted = [...ops].sort((a, b) => b.fi - a.fi);
    for (const op of sorted) {
      if (appliedFi.has(op.fi)) continue;
      const got = _splitQuadAlongOppositeMids(
        verts, faces, op.fi, getEdgeMid, op.e1a, op.e1b, op.e2a, op.e2b,
      );
      if (got) {
        appliedFi.add(op.fi);
        didRing = true;
        newFaceSelections.push(got.q1.slice(), got.q2.slice());
      }
    }
  }

  if (didRing) {
    setEditSubMode('face');
    _editApplyMeshData({ vertices: verts, faces }, { faces: newFaceSelections });
    try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
    return;
  }

  // Fallback: per-face cut (tris / n-gons / non-loop quads).
  const targets = _deriveFaceSelection(md);
  if (!targets.length) {
    _showEditHint('Could not find a quad edge loop from this selection');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  const verts2 = md.vertices.slice();
  const faces2 = md.faces.map(f => Array.isArray(f) ? [...f] : f);
  const edgeMid2 = new Map();
  function getEdgeMid2(a, b) {
    const k = _edgeKey(a, b);
    if (edgeMid2.has(k)) return edgeMid2.get(k);
    const pa = _vecFromArr(verts2, a), pb = _vecFromArr(verts2, b);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    verts2.push(mid.x, mid.y, mid.z);
    const idx = (verts2.length / 3) - 1;
    edgeMid2.set(k, idx);
    return idx;
  }
  const removeAt = new Set();
  const newFaceSel2 = [];
  for (const sel of targets) {
    const fi = _findFaceIndex(faces2, sel);
    if (fi < 0) continue;
    const face = faces2[fi];
    removeAt.add(fi);
    if (face.length === 4) {
      const len = (a, b) => _vecFromArr(verts2, a).distanceTo(_vecFromArr(verts2, b));
      const e0 = len(face[0], face[1]) + len(face[2], face[3]);
      const e1 = len(face[1], face[2]) + len(face[3], face[0]);
      let i0, i1, i2, i3;
      if (e0 >= e1) { i0 = 0; i1 = 1; i2 = 2; i3 = 3; }
      else          { i0 = 1; i1 = 2; i2 = 3; i3 = 0; }
      const m1 = getEdgeMid2(face[i0], face[i1]);
      const m2 = getEdgeMid2(face[i2], face[i3]);
      const q1 = [face[i0], m1, m2, face[i3]];
      const q2 = [m1, face[i1], face[i2], m2];
      faces2.push(q1); faces2.push(q2);
      newFaceSel2.push(q1.slice(), q2.slice());
    } else if (face.length === 3) {
      let longest = 0, lLen = 0;
      for (let i = 0; i < 3; i++) {
        const d = _vecFromArr(verts2, face[i]).distanceTo(_vecFromArr(verts2, face[(i + 1) % 3]));
        if (d > lLen) { lLen = d; longest = i; }
      }
      const a = face[longest], b = face[(longest + 1) % 3], c = face[(longest + 2) % 3];
      const m = getEdgeMid2(a, b);
      faces2.push([a, m, c]);
      faces2.push([m, b, c]);
      newFaceSel2.push([a, m, c], [m, b, c]);
    } else {
      const centroid = _faceCentroidFromVerts(verts2, face);
      verts2.push(centroid.x, centroid.y, centroid.z);
      const cIdx = (verts2.length / 3) - 1;
      for (let i = 0; i < face.length; i++) {
        const tri = [face[i], face[(i + 1) % face.length], cIdx];
        faces2.push(tri);
        newFaceSel2.push(tri.slice());
      }
    }
  }
  const compact = faces2.filter((_, i) => !removeAt.has(i));
  setEditSubMode('face');
  _editApplyMeshData({ vertices: verts2, faces: compact }, { faces: newFaceSel2 });
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}

/** Vertex bevel — for each selected vertex, push it apart along its connected
 *  edges by `amount`, replacing the vertex with a small polygon (chamfer).
 *  Auto-derives a vertex selection from edge / face selections so the tool
 *  works regardless of submode. */
/** Pure: compute the bevelled mesh data for `amount` without touching state.
 *  Used by both the one-shot bevel and the interactive modal so dragging
 *  the bevel amount in real-time produces consistent results.
 *
 *  Two non-obvious bits that prevent face-inversion bugs:
 *   1. The amount is clamped per-vertex to ~45% of the SHORTEST adjacent edge
 *      length so the pulled-back verts never cross the next vertex.
 *   2. The cap polygon is oriented so its normal points along the AVERAGE of
 *      the adjacent face normals at the target vertex — otherwise the cap
 *      can flip inward on convex/concave corners and disappear from view. */
function _computeBevel(md, vertTargets, amountRequested) {
  const verts = md.vertices.slice();
  const faces = md.faces.map(f => Array.isArray(f) ? [...f] : f);
  const newVertSel = new Set();

  for (const targetIdx of vertTargets) {
    // Find every face containing this vertex.
    const incidentFaces = [];
    faces.forEach((f, fi) => {
      const p = f.indexOf(targetIdx);
      if (p >= 0) incidentFaces.push({ fi, p });
    });
    if (incidentFaces.length === 0) continue;

    const center = _vecFromArr(verts, targetIdx);

    // ── Safety clamp ──
    // The pulled-back vert moves `amount` units along each adjacent edge from
    // `center`. If amount exceeds half the edge length it crosses the next
    // corner and produces a self-intersecting (inverted) face. 0.45 leaves a
    // small margin and matches Blender's "clamp overlap" default.
    let maxSafe = Infinity;
    for (const { fi, p } of incidentFaces) {
      const f = faces[fi];
      const prevV = f[(p - 1 + f.length) % f.length];
      const nextV = f[(p + 1) % f.length];
      const dPrev = _vecFromArr(verts, prevV).distanceTo(center);
      const dNext = _vecFromArr(verts, nextV).distanceTo(center);
      if (dPrev > 1e-6) maxSafe = Math.min(maxSafe, dPrev * 0.45);
      if (dNext > 1e-6) maxSafe = Math.min(maxSafe, dNext * 0.45);
    }
    const amount = Math.max(0.001, Math.min(amountRequested, maxSafe));

    // ── Compute the OUTWARD direction at this vertex ──
    // Average of adjacent face normals. We use this both to orient the cap
    // and to sort the cap verts so winding is consistent.
    const outward = new THREE.Vector3();
    for (const { fi } of incidentFaces) {
      const n = _faceNormalFromVerts(verts, faces[fi]);
      if (n.lengthSq() > 1e-12) outward.add(n);
    }
    if (outward.lengthSq() > 1e-10) outward.normalize();

    // For each incident face: replace targetIdx with two NEW verts pulled
    // along the two adjacent edges by `amount`.
    const replacements = []; // { fi, p, leftIdx, rightIdx, prevV, nextV }
    for (const { fi, p } of incidentFaces) {
      const f = faces[fi];
      const prevV = f[(p - 1 + f.length) % f.length];
      const nextV = f[(p + 1) % f.length];
      const dirPrev = _vecFromArr(verts, prevV).sub(center).normalize().multiplyScalar(amount);
      const dirNext = _vecFromArr(verts, nextV).sub(center).normalize().multiplyScalar(amount);
      const pL = center.clone().add(dirPrev);
      const pR = center.clone().add(dirNext);
      verts.push(pL.x, pL.y, pL.z);
      const leftIdx = (verts.length / 3) - 1;
      verts.push(pR.x, pR.y, pR.z);
      const rightIdx = (verts.length / 3) - 1;
      replacements.push({ fi, p, leftIdx, rightIdx, prevV, nextV });
    }
    // Apply the replacements: swap targetIdx with [leftIdx, rightIdx]
    // in each face's vertex ring (in winding order).
    replacements.sort((a, b) => b.fi - a.fi);
    for (const r of replacements) {
      const f = faces[r.fi];
      const out = [];
      for (let i = 0; i < f.length; i++) {
        if (i === r.p) out.push(r.leftIdx, r.rightIdx);
        else out.push(f[i]);
      }
      faces[r.fi] = out;
    }
    replacements.forEach(r => { newVertSel.add(r.leftIdx); newVertSel.add(r.rightIdx); });

    // ── Build the cap polygon connecting all new verts ──
    if (replacements.length >= 3) {
      const ringIdxs = [];
      replacements.forEach(r => { ringIdxs.push(r.leftIdx, r.rightIdx); });
      const cap = new THREE.Vector3();
      ringIdxs.forEach(i => cap.add(_vecFromArr(verts, i)));
      cap.divideScalar(ringIdxs.length);
      // Sort the cap verts by angle around the OUTWARD normal so the resulting
      // polygon is convex and its winding matches the rest of the mesh.
      // If `outward` is degenerate (e.g. flat planar cluster), fall back to
      // a per-cap Newell normal.
      let n = outward.clone();
      if (n.lengthSq() < 1e-10) {
        for (let i = 0; i < ringIdxs.length; i++) {
          const a = _vecFromArr(verts, ringIdxs[i]).sub(cap);
          const b = _vecFromArr(verts, ringIdxs[(i + 1) % ringIdxs.length]).sub(cap);
          n.add(a.cross(b));
        }
        if (n.lengthSq() > 1e-10) n.normalize(); else continue;
      }
      const ref = _vecFromArr(verts, ringIdxs[0]).sub(cap);
      const refLen = ref.length();
      if (refLen < 1e-6) continue;
      ref.divideScalar(refLen);
      // CCW around `n` so the cap's normal ends up pointing along +n (outward).
      const right = new THREE.Vector3().crossVectors(n, ref).normalize();
      const angleOf = i => {
        const v = _vecFromArr(verts, i).sub(cap);
        return Math.atan2(v.dot(right), v.dot(ref));
      };
      ringIdxs.sort((a, b) => angleOf(a) - angleOf(b));
      // Double-check winding: if the resulting polygon normal points OPPOSITE
      // to `n` we reverse the ring so the cap faces outward.
      let polyN = new THREE.Vector3();
      for (let i = 0; i < ringIdxs.length; i++) {
        const a = _vecFromArr(verts, ringIdxs[i]);
        const b = _vecFromArr(verts, ringIdxs[(i + 1) % ringIdxs.length]);
        polyN.add(new THREE.Vector3().crossVectors(a.clone().sub(cap), b.clone().sub(cap)));
      }
      if (polyN.dot(n) < 0) ringIdxs.reverse();
      faces.push(ringIdxs);
    }
  }

  // Original verts are left as orphans — the next commit prunes them.
  return { vertices: verts, faces, newVertSel: [...newVertSel] };
}

/** Derive the vertex target list used by `_computeBevel` from whatever
 *  submode the user is currently in (vertex / edge / face). */
function _bevelTargetsFromSelection() {
  let vertTargets = [...editSelection];
  if (!vertTargets.length && editSubMode === 'edge' && editEdgeSelection.size) {
    const seen = new Set();
    editEdgeSelection.forEach(k => {
      const [a, b] = _edgeKeyToVerts(k);
      if (!seen.has(a)) { seen.add(a); vertTargets.push(a); }
      if (!seen.has(b)) { seen.add(b); vertTargets.push(b); }
    });
  } else if (!vertTargets.length && editSubMode === 'face' && editFaceSelection.size) {
    const seen = new Set();
    editFaceSelection.forEach(verts => verts.forEach(v => {
      if (!seen.has(v)) { seen.add(v); vertTargets.push(v); }
    }));
  }
  return vertTargets;
}

/** Modal state for the interactive Ctrl+B bevel. Lives at module scope so
 *  the keyboard/pointer handlers can check it without depending on call
 *  order. */
let bevelState = null;
let extrudeState = null;
let insetState = null;

/** Blender-style Ctrl+B: enter an interactive modal where horizontal mouse
 *  movement controls the bevel amount. Click to confirm, RMB / Esc to cancel.
 *  Replaces the previous one-shot bevel which silently dumped a hard-coded
 *  amount with no preview. */
function bevelSelectedVerts(amount) {
  if (editorMode !== 'edit') return;
  // Don't stack on top of an existing grab/bevel/extrude/inset modal.
  if (grabState || bevelState || extrudeState || insetState) return;
  const md = _editFreshMeshData();
  if (!md) { _showEditHint('Nothing to bevel — select a vertex first'); return; }
  const vertTargets = _bevelTargetsFromSelection();
  if (!vertTargets.length) {
    _showEditHint('Select something to bevel (press 1 for vertices)');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  // Snap-shot for the modal so each mouse-move recomputes from the same base.
  const snapshot = _cloneMeshDataDeep(md);
  if (typeof amount === 'number' && amount >= 0) {
    // Non-modal invocation (e.g. external programmatic call) — apply directly.
    const result = _computeBevel(snapshot, vertTargets, amount);
    if (!result) return;
    window.slateScene3dBeginAction?.();
    setEditSubMode('vertex');
    _editApplyMeshData({ vertices: result.vertices, faces: result.faces },
                       { verts: result.newVertSel });
    try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
    return;
  }
  _enterModalBevel(snapshot, vertTargets);
}

function _enterModalBevel(snapshot, vertTargets) {
  bevelState = {
    snapshot,
    vertTargets,
    startX: _lastMouseClientX ?? 0,
    // Track the wheel-driven offset separately from the drag offset so they
    // compose: dragging adds to the wheel-set base and vice versa.
    wheelOffset: 0,
    amount: 0.05,
  };
  window.slateScene3dBeginAction?.();
  if (orbit) orbit.enabled = false;
  if (transform) { transform.enabled = false; transform.detach(); }
  if (transformHelper) transformHelper.visible = false;
  container.addEventListener('pointermove', _onBevelPointerMove, true);
  container.addEventListener('wheel',       _onBevelWheel,       { capture: true, passive: false });
  _showBevelHint();
  try { window.slateSfx?.play('grab-start'); } catch (_) {}
  _applyBevel();
}
function _onBevelPointerMove(e) {
  if (!bevelState) return;
  _lastMouseClientX = e.clientX;
  _lastMouseClientY = e.clientY;
  _applyBevel();
}
function _onBevelWheel(e) {
  if (!bevelState) return;
  // Block OrbitControls' wheel zoom while bevelling.
  e.preventDefault(); e.stopPropagation();
  // Normalize delta direction (`deltaY < 0` = scroll up = grow).
  const step = e.deltaY < 0 ? 0.04 : -0.04;
  bevelState.wheelOffset += step;
  _applyBevel();
}
function _applyBevel() {
  if (!bevelState) return;
  const clientX = _lastMouseClientX ?? bevelState.startX;
  const dx = clientX - bevelState.startX;
  // Combined amount: drag offset + wheel-driven offset, clamped sanely.
  const raw = dx * 0.0025 + bevelState.wheelOffset;
  bevelState.amount = Math.max(0.001, Math.min(2, raw));
  const result = _computeBevel(bevelState.snapshot, bevelState.vertTargets, bevelState.amount);
  if (!result) return;
  bevelState.lastResult = result;
  _editApplyMeshData(
    { vertices: result.vertices, faces: result.faces },
    { verts: result.newVertSel },
  );
  _updateBevelHint();
}
function _bevelConfirm() {
  if (!bevelState) return;
  container.removeEventListener('pointermove', _onBevelPointerMove, true);
  container.removeEventListener('wheel',       _onBevelWheel,       { capture: true });
  // _applyBevel already pushed the latest result through _editApplyMeshData,
  // so the scene is up-to-date. Just clean up modal state.
  bevelState = null;
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideBevelHint();
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}
function _bevelCancel() {
  if (!bevelState) return;
  const snap = bevelState.snapshot;
  container.removeEventListener('pointermove', _onBevelPointerMove, true);
  container.removeEventListener('wheel',       _onBevelWheel,       { capture: true });
  bevelState = null;
  // Restore original mesh data — selection follows the snapshot exactly.
  _editApplyMeshData(snap, {});
  if (orbit) orbit.enabled = true;
  if (transform) transform.enabled = true;
  if (transformHelper) transformHelper.visible = true;
  _hideBevelHint();
  try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
}
let _bevelHintEl = null;
function _showBevelHint() {
  if (!container) return;
  if (!_bevelHintEl) {
    _bevelHintEl = document.createElement('div');
    _bevelHintEl.className = 'fly-cam-hint';
    container.appendChild(_bevelHintEl);
  }
  _bevelHintEl.style.display = '';
  _updateBevelHint();
}
function _updateBevelHint() {
  if (!_bevelHintEl || !bevelState) return;
  _bevelHintEl.textContent =
    `Bevel · ${bevelState.amount.toFixed(3)} · drag / scroll to adjust · click confirm · RMB / Esc cancel`;
}
function _hideBevelHint() {
  if (_bevelHintEl) _bevelHintEl.style.display = 'none';
}

/** Move all selected vertices to their shared centroid (meshData path + weld). */
function mergeSelectedToCenter() {
  if (editorMode !== 'edit') return;
  _syncDerivedVertSelection();
  if (!editSelection.size) {
    _showEditHint('Select vertices, edges, or faces to merge');
    try { window.slateSfx?.play('grab-cancel'); } catch (_) {}
    return;
  }
  const md = _editFreshMeshData();
  if (!md) return;
  const verts = md.vertices.slice();
  const sel = [...editSelection].filter(i => i >= 0 && (i * 3 + 2) < verts.length);
  if (!sel.length) return;
  const c = new THREE.Vector3();
  sel.forEach(i => c.add(_vecFromArr(verts, i)));
  c.divideScalar(sel.length);
  sel.forEach(i => {
    verts[i * 3] = c.x;
    verts[i * 3 + 1] = c.y;
    verts[i * 3 + 2] = c.z;
  });
  window.slateScene3dBeginAction?.();
  window.slateScene3d?.setMeshData(editTargetId, { vertices: verts, faces: md.faces });
  buildEditHelpers();
  setEditSubMode('vertex');
  const mesh = objMeshes.get(editTargetId);
  const posAttr = mesh?.geometry.getAttribute('position');
  const weld = editHelpers?.weldMap;
  if (posAttr && weld) {
    const eps2 = 1e-12;
    for (let l = 0; l < weld.logicalToIdxs.length; l++) {
      const g = weld.logicalToIdxs[l][0];
      const p = new THREE.Vector3(posAttr.getX(g), posAttr.getY(g), posAttr.getZ(g));
      if (p.distanceToSquared(c) <= eps2) {
        editSelection.add(l);
        break;
      }
    }
  }
  commitEditChanges();
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}

/** Delete the selected faces (or, for vertex/edge modes, every face touching
 *  the selection). Orphan vertices are stripped on the next commit. */
function deleteSelectedTopology() {
  if (editorMode !== 'edit') return;
  const md = _editFreshMeshData();
  if (!md) return;
  let touchedFaces = [];
  if (editSubMode === 'face' && editFaceSelection.size) {
    touchedFaces = [...editFaceSelection.values()];
  } else if (editSubMode === 'edge' && editEdgeSelection.size) {
    const edgePairs = [...editEdgeSelection].map(_edgeKeyToVerts);
    md.faces.forEach((f, fi) => {
      for (const [a, b] of edgePairs) {
        for (let i = 0; i < f.length; i++) {
          const x = f[i], y = f[(i + 1) % f.length];
          if ((x === a && y === b) || (x === b && y === a)) { touchedFaces.push(f); return; }
        }
      }
    });
  } else if (editSubMode === 'vertex' && editSelection.size) {
    md.faces.forEach(f => {
      if (f.some(v => editSelection.has(v))) touchedFaces.push(f);
    });
  }
  if (!touchedFaces.length) { try { window.slateSfx?.play('grab-cancel'); } catch (_) {} return; }
  window.slateScene3dBeginAction?.();
  const kill = new Set(touchedFaces.map(f => _faceKey(f)));
  const keptFaces = md.faces.filter(f => !kill.has(_faceKey(f)));
  _editApplyMeshData({ vertices: md.vertices, faces: keptFaces }, {});
  try { window.slateSfx?.play('grab-confirm'); } catch (_) {}
}

function commitEditChanges() {
  if (!editTargetId) return;
  const mesh = objMeshes.get(editTargetId);
  if (!mesh) return;
  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return;

  // Weld coincident verts so primitives that ship with split corners
  // (BoxGeometry has 24 verts for 8 corners, etc.) collapse to one logical
  // vertex each. Stored faces use the welded indices so a cube round-trips
  // as 8 verts + 6 quads instead of 24 + 12 triangles.
  const weldVerts = [];
  const buckets = new Map();
  const weldFor = new Int32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
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
  const indexAttr = mesh.geometry.getIndex();
  if (indexAttr) {
    const arr = indexAttr.array;
    for (let i = 0; i < arr.length; i += 3) {
      const a = weldFor[arr[i]], b = weldFor[arr[i + 1]], c = weldFor[arr[i + 2]];
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  } else {
    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      const a = weldFor[i], b = weldFor[i + 1], c = weldFor[i + 2];
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  }
  const facesOut = _mergeTrianglePairsToQuads(tris, weldVerts);
  window.slateScene3d?.setMeshData(editTargetId, { vertices: weldVerts, faces: facesOut });

  // setMeshData synchronously triggers syncSceneFromDoc, which rebuilds the
  // mesh geometry from the new welded data. Our edit overlays are now stale
  // (their weldMap indexes the OLD posAttr). Rebuild them and re-attach the
  // gizmo to the same logical selection so the user can keep editing.
  if (editorMode === 'edit' && editTargetId && editHelpers) {
    const prevSelection = [...editSelection];
    const prevEdges = [...editEdgeSelection];
    const prevFaces = [...editFaceSelection.entries()];
    const weldBefore = editHelpers.weldMap;
    const faceSigSet = new Set();
    if (editSubMode === 'face' && weldBefore && prevFaces.length) {
      for (const [, verts] of prevFaces) {
        const sig = _facePositionSignatureFromLogicals(weldBefore, posAttr, verts);
        if (sig) faceSigSet.add(sig);
      }
    }
    buildEditHelpers();
    editSelection.clear();
    editEdgeSelection.clear();
    editFaceSelection.clear();
    // After welding, logical index ranges can shrink (coincident verts merge),
    // so remap face picks by corner position signatures instead of raw indices.
    const weldCount = editHelpers ? editHelpers.weldMap.logicalToIdxs.length : 0;
    const inRange = i => i >= 0 && i < weldCount;
    prevSelection.forEach(l => { if (inRange(l)) editSelection.add(l); });
    prevEdges.forEach(k => {
      const [a, b] = _edgeKeyToVerts(k);
      if (inRange(a) && inRange(b)) editEdgeSelection.add(k);
    });
    if (editSubMode === 'face' && faceSigSet.size) {
      const mesh2 = objMeshes.get(editTargetId);
      const pa2 = mesh2?.geometry?.getAttribute('position');
      const wm = editHelpers?.weldMap;
      if (pa2 && wm) {
        const sigToLogicalFace = new Map();
        for (const f of facesOut) {
          if (!Array.isArray(f) || f.length < 3) continue;
          const sig = _facePositionSignatureFromGeomFace(pa2, f);
          if (!sigToLogicalFace.has(sig)) {
            const logicalFace = f.map(i => wm.logicalForIdx[i]);
            sigToLogicalFace.set(sig, logicalFace);
          }
        }
        for (const sig of faceSigSet) {
          const lf = sigToLogicalFace.get(sig);
          if (lf) editFaceSelection.set(_faceKey(lf), [...lf]);
        }
      }
    } else {
      prevFaces.forEach(([k, verts]) => {
        if (verts.every(inRange)) editFaceSelection.set(k, verts);
      });
    }
    refreshSelectionMarker();
    attachGizmoToEditSelection();
  }
}

function setEditSubMode(mode) {
  editSubMode = mode;
  editSelection.clear();
  editEdgeSelection.clear();
  editFaceSelection.clear();
  refreshSelectionMarker();
  transform?.detach();
  document.querySelectorAll('#toolbar-3d .t3d-esel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sel === mode);
  });
}

function updateModeButtons() {
  const btn = document.getElementById('t3d-mode-toggle-btn');
  const lbl = document.getElementById('t3d-mode-toggle-label');
  if (btn) {
    const isEdit = editorMode === 'edit';
    btn.classList.toggle('active', isEdit);
    btn.setAttribute('aria-pressed', isEdit ? 'true' : 'false');
    btn.title = isEdit
      ? 'Currently in Edit mode — click or press Tab to return to Object mode'
      : 'Currently in Object mode — click or press Tab to enter Edit mode';
  }
  if (lbl) lbl.textContent = editorMode === 'edit' ? 'Edit' : 'Object';
}

// Small label-flip animation when toggling the mode button, so the change
// reads as a deliberate state swap rather than a static text update.
function _animateModeToggle() {
  const btn = document.getElementById('t3d-mode-toggle-btn');
  if (!btn) return;
  btn.classList.remove('is-swapping');
  void btn.offsetWidth;
  btn.classList.add('is-swapping');
  setTimeout(() => btn.classList.remove('is-swapping'), 320);
}
function updateToolbarVisibility() {
  const editGroup = document.getElementById('t3d-edit-select-group');
  const sep = document.getElementById('t3d-edit-sep');
  const inEdit = editorMode === 'edit';
  if (editGroup) editGroup.style.display = inEdit ? 'flex' : 'none';
  if (sep)       sep.style.display       = inEdit ? 'block' : 'none';
  document.querySelectorAll('#toolbar-3d .t3d-edit-only').forEach(el => {
    if (!el) return;
    if (el.classList.contains('toolbar-sep')) el.style.display = inEdit ? 'block' : 'none';
    else el.style.display = inEdit ? 'flex' : 'none';
  });
}

function _initViewGizmo() {
  _disposeViewGizmo();
  viewGizmoRaycaster = new THREE.Raycaster();
  viewGizmoScene = new THREE.Scene();
  viewGizmoCam = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 12);
  viewGizmoCam.position.set(0, 0, 6);
  viewGizmoCam.lookAt(0, 0, 0);
  viewGizmoRoot = new THREE.Group();
  viewGizmoScene.add(viewGizmoRoot);
  viewGizmoPickables.length = 0;

  function addArrow(dir, color, viewPreset) {
    const d = dir.clone().normalize();
    const mat = new THREE.MeshBasicMaterial({ color });
    const r = 0.055;
    const shaftH = 0.32;
    const tipH = 0.2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, shaftH, 8), mat);
    shaft.position.y = shaftH / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(r, tipH, 10), mat);
    tip.position.y = shaftH + tipH / 2;
    const arm = new THREE.Group();
    arm.add(shaft, tip);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    shaft.userData.axisView = viewPreset;
    tip.userData.axisView = viewPreset;
    viewGizmoPickables.push(shaft, tip);
    viewGizmoRoot.add(arm);
  }
  addArrow(new THREE.Vector3(1, 0, 0), 0xff4444, 'right');
  addArrow(new THREE.Vector3(-1, 0, 0), 0xaa2222, 'left');
  addArrow(new THREE.Vector3(0, 1, 0), 0x44dd66, 'top');
  addArrow(new THREE.Vector3(0, -1, 0), 0x228844, 'bottom');
  addArrow(new THREE.Vector3(0, 0, 1), 0x5599ff, 'front');
  addArrow(new THREE.Vector3(0, 0, -1), 0x3366cc, 'back');

  const ctr = new THREE.Mesh(
    new THREE.SphereGeometry(0.082, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xb8b8e8, transparent: true, opacity: 0.95 }),
  );
  ctr.userData.axisView = 'persp';
  viewGizmoPickables.push(ctr);
  viewGizmoRoot.add(ctr);
}

function _disposeViewGizmo() {
  viewGizmoPickables.length = 0;
  if (viewGizmoRoot) {
    viewGizmoRoot.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose?.();
    });
  }
  viewGizmoScene = null;
  viewGizmoCam = null;
  viewGizmoRoot = null;
  viewGizmoRaycaster = null;
}

function _renderViewGizmo() {
  if (!renderer || !viewGizmoScene || !viewGizmoCam || !viewGizmoRoot || !camera) return;
  if (!document.body.classList.contains('mode-3d')) return;
  viewGizmoRoot.quaternion.copy(camera.quaternion).invert();
  const bufW = renderer.domElement.width;
  const bufH = renderer.domElement.height;
  if (bufW < 8 || bufH < 8) return;
  const sz = Math.max(72, Math.min(130, Math.round(bufH * 0.2)));
  const pad = Math.round(Math.max(10, bufH * 0.02));
  const vx = bufW - sz - pad;
  const vy = bufH - sz - pad;
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setViewport(vx, vy, sz, sz);
  renderer.setScissor(vx, vy, sz, sz);
  renderer.setScissorTest(true);
  renderer.clearDepth();
  renderer.render(viewGizmoScene, viewGizmoCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, bufW, bufH);
  renderer.autoClear = prevAuto;
}

function _viewGizmoPickView(clientX, clientY) {
  if (!renderer?.domElement || !viewGizmoScene || !viewGizmoCam || !viewGizmoRaycaster) return null;
  if (!document.body.classList.contains('mode-3d')) return null;
  const el = renderer.domElement;
  const rect = el.getBoundingClientRect();
  const bufW = el.width;
  const bufH = el.height;
  if (bufW < 8 || bufH < 8) return null;
  const sz = Math.max(72, Math.min(130, Math.round(bufH * 0.2)));
  const pad = Math.round(Math.max(10, bufH * 0.02));
  const vx = bufW - sz - pad;
  const vy = bufH - sz - pad;
  const sx = rect.width / bufW;
  const sy = rect.height / bufH;
  const left = rect.left + vx * sx;
  const right = rect.left + (vx + sz) * sx;
  const top = rect.top + rect.height - (vy + sz) * sy;
  const bottom = rect.top + rect.height - vy * sy;
  if (clientX < left || clientX > right || clientY < top || clientY > bottom) return null;
  const u = (clientX - left) / (right - left);
  const v = (clientY - top) / (bottom - top);
  const x = u * 2 - 1;
  const y = -(v * 2 - 1);
  viewGizmoRaycaster.setFromCamera({ x, y }, viewGizmoCam);
  const hits = viewGizmoRaycaster.intersectObjects(viewGizmoPickables, false);
  const hit = hits[0]?.object;
  const axis = hit?.userData?.axisView;
  return typeof axis === 'string' ? axis : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Scene setup / render loop
───────────────────────────────────────────────────────────────────────── */
function ensureScene() {
  if (scene) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(_persistedViewportBg);

  camera = new THREE.PerspectiveCamera(_persistedFov, 1, 0.05, 500);
  camera.position.set(4, 3.5, 6);

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(4, 10, 6);
  scene.add(dir);

  // Floor grid (Blender-style infinite-ish ground reference).
  const grid = new THREE.GridHelper(40, 40, 0x3a3a4d, 0x252530);
  grid.userData.helper = true;
  grid.visible = _persistedGridVisible;
  scene.add(grid);
  _gridHelper = grid;

  // Axis helper at origin
  const axes = new THREE.AxesHelper(0.8);
  axes.userData.helper = true;
  axes.visible = _persistedGridVisible;
  scene.add(axes);
  _axesHelper = axes;

  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.06;
}

let _gridHelper = null;
let _axesHelper = null;
function toggleGrid() {
  const next = !(_gridHelper?.visible !== false);
  setGridVisible(next);
  // Keep the settings checkbox in sync if it exists.
  const set = document.getElementById('viewport-grid-toggle');
  if (set && set.checked !== next) set.checked = next;
  try { localStorage.setItem('slate_viewport_grid', next ? '1' : '0'); } catch (_) {}
}

/* ─────────────────────────────────────────────────────────────────────────
   Wireframe overlay — adds thin black/white edge lines on top of shaded
   meshes so the topology is always visible (Blender-style "wire" view).
───────────────────────────────────────────────────────────────────────── */
let _wireframeOverlay = false;
const _wireOverlays = new Map(); // objId → LineSegments overlay child
function _addWireOverlayFor(mesh) {
  if (!mesh || _wireOverlays.has(mesh.userData.objId)) return;
  try {
    const edges = new THREE.EdgesGeometry(mesh.geometry, 1);
    const mat = new THREE.LineBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.55, depthTest: true,
    });
    const lines = new THREE.LineSegments(edges, mat);
    lines.renderOrder = 999;
    lines.userData._wireOverlay = true;
    mesh.add(lines);
    _wireOverlays.set(mesh.userData.objId, lines);
  } catch (_) {}
}
function _removeWireOverlayFor(mesh) {
  if (!mesh) return;
  const id = mesh.userData?.objId;
  const lines = id ? _wireOverlays.get(id) : null;
  if (lines) {
    if (lines.parent) lines.parent.remove(lines);
    lines.geometry?.dispose();
    lines.material?.dispose();
    _wireOverlays.delete(id);
  }
}
function _syncWireOverlays() {
  if (_wireframeOverlay) {
    objMeshes.forEach((mesh) => _addWireOverlayFor(mesh));
  } else {
    objMeshes.forEach((mesh) => _removeWireOverlayFor(mesh));
  }
}
function toggleWireframeOverlay() {
  _wireframeOverlay = !_wireframeOverlay;
  _syncWireOverlays();
  const btn = document.getElementById('t3d-wireframe-btn');
  if (btn) btn.classList.toggle('active', _wireframeOverlay);
}

/* Reset the camera to its default "home" position. */
function resetCameraHome() {
  if (!orbit || !camera) return;
  orbit.target.set(0, 0.4, 0);
  camera.position.set(4, 3.5, 6);
  camera.up.set(0, 1, 0);
  orbit.update();
}

/** Compute camera position for an axis view; writes into `out`. */
function _cameraPositionForPreset(name, target, dist, out) {
  const t = target;
  switch (name) {
    case 'front':  out.set(t.x, t.y,         t.z + dist); break;
    case 'back':   out.set(t.x, t.y,         t.z - dist); break;
    case 'right':  out.set(t.x + dist, t.y, t.z);         break;
    case 'left':   out.set(t.x - dist, t.y, t.z);         break;
    case 'top':    out.set(t.x, t.y + dist, t.z + 0.001); break;
    case 'bottom': out.set(t.x, t.y - dist, t.z + 0.001); break;
    case 'persp':
    default:       out.set(t.x + dist * 0.6, t.y + dist * 0.55, t.z + dist * 0.9); break;
  }
  return out;
}

/* Snap the camera onto an axis-aligned view (instant — used by hotkeys / API). */
function setCameraViewPreset(name) {
  if (!orbit || !camera) return;
  const dist = Math.max(4, camera.position.distanceTo(orbit.target));
  _cameraPositionForPreset(name, orbit.target, dist, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(orbit.target);
  orbit.update();
}

/** Animate from current pose into a preset (used by the corner view gizmo). */
function beginCameraViewPresetAnim(name) {
  if (!orbit || !camera || flyEnabled) return;
  const dist = Math.max(4, camera.position.distanceTo(orbit.target));
  _camAnimTarget.copy(orbit.target);
  _cameraPositionForPreset(name, _camAnimTarget, dist, _camAnimToPos);
  _camAnimFromPos.copy(camera.position);
  const dur = name === 'persp' ? 420 : 280;
  _camViewAnim = { t0: performance.now(), dur, orbitWasEnabled: orbit.enabled };
  orbit.enabled = false;
}

function _stepCameraViewAnim(nowMs) {
  if (!_camViewAnim || !camera || !orbit) return;
  const { t0, dur, orbitWasEnabled } = _camViewAnim;
  const u = Math.min(1, (nowMs - t0) / dur);
  const k = u * u * (3 - 2 * u);
  camera.position.lerpVectors(_camAnimFromPos, _camAnimToPos, k);
  camera.up.set(0, 1, 0);
  camera.lookAt(_camAnimTarget);
  orbit.target.copy(_camAnimTarget);
  orbit.update();
  if (u >= 1) {
    _camViewAnim = null;
    orbit.enabled = orbitWasEnabled !== false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Object color (toolbar swatch) — sets the material color of the currently
   selected mesh and round-trips it through the scene API so peers see it.
───────────────────────────────────────────────────────────────────────── */
function _updateObjectColorPicker() {
  const wrap = document.getElementById('t3d-object-color-wrap');
  const inp  = document.getElementById('t3d-object-color');
  if (!wrap || !inp) return;
  const api  = window.slateScene3d;
  const obj  = (selectedId && api) ? api.find(selectedId) : null;
  const show = !!(obj && obj.type !== 'folder' && editorMode === 'object');
  wrap.style.display = show ? 'inline-flex' : 'none';
  if (show) {
    // Strip any alpha suffix on the stored color and re-clip to 7 chars.
    const c = (obj.color || '#7c6aff').slice(0, 7);
    if (inp.value !== c) inp.value = c;
  }
}
function _onObjectColorInput(e) {
  if (!selectedId) return;
  const api = window.slateScene3d;
  if (!api) return;
  api.setColor(selectedId, e.target.value);
}

function toggleSnap() {
  snapEnabled = !snapEnabled;
  const btn = document.getElementById('t3d-snap-btn');
  if (btn) btn.classList.toggle('active', snapEnabled);
  if (!transform) return;
  if (snapEnabled) {
    transform.translationSnap = 0.25;
    transform.rotationSnap = THREE.MathUtils.degToRad(15);
    transform.scaleSnap = 0.05;
  } else {
    transform.translationSnap = null;
    transform.rotationSnap = null;
    transform.scaleSnap = null;
  }
}

function cycleTransformSpace() {
  if (!transform) return;
  transformSpace = transformSpace === 'world' ? 'local' : 'world';
  transform.setSpace(transformSpace);
  const btn = document.getElementById('t3d-space-btn');
  if (btn) btn.textContent = transformSpace === 'world' ? 'W' : 'L';
}

function mirrorOnAxis(axisIdx) {
  const api = window.slateScene3d;
  if (!api || !selectedId) return;
  const obj = api.find(selectedId);
  if (!obj || obj.type === 'folder') return;
  window.slateScene3dBeginAction?.();
  const s = [
    Number(obj.scale[0]) || 1,
    Number(obj.scale[1]) || 1,
    Number(obj.scale[2]) || 1,
  ];
  s[axisIdx] *= -1;
  api.setTransform(selectedId, { scale: s });
}

function resize() {
  if (!container || !renderer || !camera) return;
  // Round to whole CSS pixels so the renderer doesn't pick up sub-pixel sizes
  // that drift away from container.aspect — fixes the stretched-on-resize bug
  // when the dock-resize-handle shifts the viewport mid-frame.
  const w = Math.max(1, Math.round(container.clientWidth  || 1));
  const h = Math.max(1, Math.round(container.clientHeight || 1));
  renderer.setSize(w, h, false);
  const coarse = (typeof window !== 'undefined' && window.matchMedia && (
    window.matchMedia('(max-width: 768px)').matches ||
    window.matchMedia('(pointer: coarse)').matches
  ));
  const prCap = coarse ? 1.25 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap));
  const aspect = w / h;
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  // Some Three.js controls cache the renderer's DOM size — give them a chance
  // to read the new layout on the next frame.
  if (transform && typeof transform.update === 'function') {
    try { transform.update(); } catch (_) {}
  }
}

let _resizeObserver = null;
function _attachContainerResizeObserver(el) {
  if (_resizeObserver || !el || typeof ResizeObserver !== 'function') return;
  _resizeObserver = new ResizeObserver(() => resize());
  _resizeObserver.observe(el);
}
function _detachContainerResizeObserver() {
  if (_resizeObserver) {
    try { _resizeObserver.disconnect(); } catch (_) {}
    _resizeObserver = null;
  }
}

let _lastLoopTs = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  if (!renderer || !scene || !camera || !container?.isConnected) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - (_lastLoopTs || now)) / 1000);
  _lastLoopTs = now;
  if (flyEnabled) _stepFlyCamera(dt);
  else if (_camViewAnim) _stepCameraViewAnim(now);
  else if (orbit && !flyEnabled) orbit.update();
  _loopFrame++;
  if ((_loopFrame & 1) === 0) _updatePeerCamMarkers();
  _maybeBroadcastCamera(now);
  renderer.render(scene, camera);
  _renderViewGizmo();
}

function onVisualViewportChange() { resize(); }

function bindEvents() {
  if (bound || !container) return;
  bound = true;
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeyDown, true);
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointerup',   onPointerUp);
  container.addEventListener('pointermove', _onContainerPointerTrack);
  // Catch pointerup outside the canvas (e.g. when PointerLock has the cursor
  // captured) so releasing RMB always exits fly mode even if the up event
  // doesn't bubble to the container.
  window.addEventListener('pointerup', _onWindowPointerUp, true);
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
    container.removeEventListener('pointermove', _onContainerPointerTrack);
  }
  window.removeEventListener('pointerup', _onWindowPointerUp, true);
  if (window.visualViewport && vvResizeBound) {
    vvResizeBound = false;
    window.visualViewport.removeEventListener('resize', onVisualViewportChange);
    window.visualViewport.removeEventListener('scroll', onVisualViewportChange);
  }
}

/* Window-level RMB-up handler: ensures fly mode exits even if PointerLock
   captured the cursor and the canvas didn't see the pointerup. */
function _onWindowPointerUp(e) {
  if (e.button !== 2) return;
  if (!_rmbArmed && !flyEnabled) return;
  _rmbArmed = false;
  _cancelRmbFlyTimer();
  if (flyEnabled) {
    _rmbFlyTriggered = false;
    exitFlyCamera();
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
  document.getElementById('t3d-add-menu-btn')?.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    _openAddPrimitiveMenu(r.left, r.bottom + 4);
  });
  const modeToggle = tb.querySelector('#t3d-mode-toggle-btn');
  if (modeToggle) {
    modeToggle.addEventListener('click', () => {
      _animateModeToggle();
      if (editorMode === 'edit') leaveEditMode(); else enterEditMode();
    });
  }
  tb.querySelectorAll('.t3d-esel-btn').forEach(btn => {
    btn.addEventListener('click', () => setEditSubMode(btn.dataset.sel));
  });
  document.getElementById('t3d-delete-btn')?.addEventListener('click', () => {
    if (editorMode !== 'object') return;
    const api = window.slateScene3d;
    if (!api) return;
    const ids = [...selectedIds];
    if (!ids.length && selectedId) ids.push(selectedId);
    if (!ids.length) return;
    window.slateScene3dBeginAction?.();
    ids.forEach(id => api.remove(id));
    selectedIds.clear(); selectedId = null;
    transform?.detach();
  });
  document.getElementById('t3d-frame-btn')?.addEventListener('click', frameSelected);
  document.getElementById('t3d-duplicate-btn')?.addEventListener('click', duplicateSelected);
  document.getElementById('t3d-fly-btn')?.addEventListener('click', _onFlyCamBtnDown);
  _updateFlyButtonUI();
  document.getElementById('t3d-grid-btn')?.addEventListener('click', toggleGrid);
  document.getElementById('t3d-snap-btn')?.addEventListener('click', toggleSnap);
  document.getElementById('t3d-space-btn')?.addEventListener('click', cycleTransformSpace);
  document.getElementById('t3d-mirror-btn')?.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    _openMirrorMenu(r.left, r.bottom + 4);
  });
  document.getElementById('t3d-home-btn')?.addEventListener('click', () => {
    resetCameraHome();
    try { window.slateSfx?.play('view-snap'); } catch (_) {}
  });
  document.getElementById('t3d-wireframe-btn')?.addEventListener('click', toggleWireframeOverlay);
  document.getElementById('t3d-object-color')?.addEventListener('input', _onObjectColorInput);
  // Mesh-editing operators (only enabled while in edit mode).
  document.getElementById('t3d-extrude-btn')  ?.addEventListener('click', () => _runMeshOp('Extrude',   () => extrudeSelectedFaces()));
  document.getElementById('t3d-inset-btn')    ?.addEventListener('click', () => _runMeshOp('Inset',     () => insetSelectedFaces()));
  document.getElementById('t3d-bevel-btn')    ?.addEventListener('click', () => _runMeshOp('Bevel',     () => bevelSelectedVerts()));
  document.getElementById('t3d-loopcut-btn')  ?.addEventListener('click', () => _runMeshOp('Loop cut',  () => loopCutSelectedFaces()));
  document.getElementById('t3d-subdivide-btn')?.addEventListener('click', () => _runMeshOp('Subdivide', () => subdivideSelectedFaces()));
  document.getElementById('t3d-merge-btn')    ?.addEventListener('click', () => _runMeshOp('Merge',     () => mergeSelectedToCenter()));
  document.getElementById('t3d-delete-btn-edit')?.addEventListener('click', () => _runMeshOp('Delete',  () => deleteSelectedTopology()));
}

function _openMirrorMenu(clientX, clientY) {
  _closeViewportCtxMenu();
  const div = document.createElement('div');
  div.className = 't3d-viewport-ctx';
  div.innerHTML = `<div class="t3d-ctx-head">Mirror</div>
    <button type="button" data-axis="0">X axis</button>
    <button type="button" data-axis="1">Y axis</button>
    <button type="button" data-axis="2">Z axis</button>`;
  document.body.appendChild(div);
  _ctxMenuEl = div;
  div.querySelectorAll('button[data-axis]').forEach(btn => {
    btn.addEventListener('click', () => {
      mirrorOnAxis(Number(btn.dataset.axis));
      _closeViewportCtxMenu();
    });
  });
  const pad = 8;
  div.style.left = `${clientX}px`;
  div.style.top  = `${clientY}px`;
  requestAnimationFrame(() => {
    const w = div.offsetWidth, h = div.offsetHeight;
    let x = clientX, y = clientY;
    if (x + w + pad > window.innerWidth)  x = Math.max(pad, window.innerWidth  - w - pad);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    div.style.left = `${x}px`;
    div.style.top  = `${y}px`;
  });
  setTimeout(() => {
    window.addEventListener('pointerdown', _onDocCloseCtx, true);
    window.addEventListener('keydown', _onKeyCloseCtx, true);
  }, 0);
}

/**
 * Customize the TransformControls gizmo to match Blender's single-direction look:
 *   • Hide the negative-direction arrows for X / Y / Z (translate)
 *   • Hide the long thin axis-line shafts so each axis is one clean arrow
 *   • Hide the negative-direction arrows AND their pickers
 *   • Hide the planar handles (XY / YZ / XZ) — Blender doesn't show these
 *   • Keep the center XYZ omni handle for free-translation
 *
 * Runs once after the helper is added to the scene. The visible flags are
 * persisted on the internal gizmo children, so they survive mode switches.
 */
function _customizeTransformGizmo() {
  if (!transform) return;
  const gz = transform._gizmo;
  if (!gz) return;

  // The translate gizmo is the one with axis arrows. Customise both the
  // visible gizmo group AND the picker group (so hidden directions also
  // become non-grabbable).
  const groups = [gz.gizmo?.translate, gz.picker?.translate].filter(Boolean);

  for (const group of groups) {
    for (const child of group.children) {
      if (!child) continue;
      const name = child.name || '';
      const p    = child.position;
      const gp   = child.geometry?.parameters || {};

      // 1. Negative-direction arrows / pickers (named like "X_negate").
      if (/_negate$/.test(name)) { child.visible = false; continue; }

      // 2. Planar handles — Blender hides these. Name is a 2-axis combo.
      if (name === 'XY' || name === 'YZ' || name === 'XZ' ||
          name === 'YX' || name === 'ZY' || name === 'ZX') {
        child.visible = false; continue;
      }

      // 3. The thin shaft cylinder that runs along each axis. In r170 it's
      //    a CylinderGeometry with radiusTop/Bottom ≈ 0.0075 and height 0.5.
      //    Some patch versions use 0.005 — accept anything < 0.015.
      const isLineShaft = (
        (name === 'X' || name === 'Y' || name === 'Z') &&
        gp.radiusTop !== undefined && gp.radiusTop < 0.02 &&
        gp.height    !== undefined && gp.height < 1.2 &&
        Math.abs(p.x) < 1e-4 && Math.abs(p.y) < 1e-4 && Math.abs(p.z) < 1e-4
      );
      if (isLineShaft) { child.visible = false; continue; }

      // 4. Fallback: any child whose name is a single axis letter but whose
      //    position component is negative (older three.js variants used a
      //    naming convention without `_negate`).
      if ((name === 'X' && p.x < -1e-4) ||
          (name === 'Y' && p.y < -1e-4) ||
          (name === 'Z' && p.z < -1e-4)) {
        child.visible = false;
      }
    }
  }
}

function addPrimitive(kind) {
  if (!window.slateScene3d) return;
  window.slateScene3dBeginAction?.();
  const src = ADD_PRIMITIVE_PRESETS[kind] || ADD_PRIMITIVE_PRESETS.cube;
  const spec = {
    ...src,
    params: { ...src.params },
    position: [...src.position],
    ...(src.rotation ? { rotation: [...src.rotation] } : {}),
  };
  const obj = window.slateScene3d.add(spec);
  if (obj) selectById(obj.id);
  try { window.slateSfx?.play('add'); } catch (_) {}
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

/** Lightweight DOM patch for selection-only changes — leaves the row nodes
 *  intact so that an in-flight dblclick (which fires AFTER the first click's
 *  selection update) still lands on the same span and can begin a rename. */
function _refreshHierarchySelection() {
  if (!hierarchyEl) {
    hierarchyEl = document.getElementById('hierarchy-list');
    if (!hierarchyEl) return;
  }
  hierarchyEl.querySelectorAll('.outliner-row').forEach(row => {
    const oid = row.dataset.oid;
    const sel = oid === selectedId || oid === editTargetId || selectedIds.has(oid);
    row.classList.toggle('selected', !!sel);
  });
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
    hierarchyEl.innerHTML = `<div class="outliner-empty">No objects yet. Right-click the 3D viewport (or use +▾ in the toolbar) to add one.</div>`;
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
      e.preventDefault();
      const span = row.querySelector('.out-name');
      if (span && !span.tagName.match(/^INPUT$/i)) beginOutlinerRename(span);
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
  octahedron: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 1.5l5 5-5 5-5-5z"/></svg>`,
  tetrahedron: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 1.5L12.5 12H1.5z"/></svg>`,
  icosahedron: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5"/></svg>`,
  capsule:  `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4.5 3.5a2.5 2.5 0 0 1 5 0v7a2.5 2.5 0 0 1-5 0z"/></svg>`,
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
    if (!viewGizmoScene) _initViewGizmo();
    resize(); bindEvents();
    _attachContainerResizeObserver(container);
    cancelAnimationFrame(raf); loop();
    return;
  }
  disposeEditor3D();
  container = rootEl;
  container.style.touchAction = 'none';
  ensureScene();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const coarse = (typeof window !== 'undefined' && window.matchMedia && (
    window.matchMedia('(max-width: 768px)').matches ||
    window.matchMedia('(pointer: coarse)').matches
  ));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.25 : 2));
  renderer.shadowMap.enabled = false;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.addEventListener('contextmenu', _onViewportContextMenu);

  // Orbit first so its pointer listeners register before TransformControls'.
  // TransformControls stops propagation when the gizmo grabs the pointer,
  // so Orbit never sees pointer events on those clicks.
  orbit = new OrbitControls(camera, renderer.domElement);
  // RMB binding is gated on `flyArmed`:
  //   • fly disarmed → RMB-drag pans (orbit.mouseButtons.RIGHT = PAN).
  //   • fly armed    → RMB is consumed by our hold-to-fly gesture (null).
  // A quick RMB tap always opens the add-object context menu — see
  // onPointerDown / onPointerUp.
  _applyFlyArmedToOrbit();
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.06;
  orbit.target.set(0, 0.4, 0);
  orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  transform = new TransformControls(camera, renderer.domElement);
  transform.setMode(transformMode);
  transform.setSpace(transformSpace);
  transform.showX = transform.showY = transform.showZ = true;
  transform.setSize(1.05);
  transform.addEventListener('dragging-changed', ev => {
    orbit.enabled = !ev.value;
    if (ev.value) {
      transform.setSize(1.32);
      window.slateScene3dBeginAction?.();
    } else {
      transform.setSize(1.05);
    }
    if (ev.value && editorMode === 'edit' && editDragHelper) {
      editDragHelper.userData.lastPos   = editDragHelper.position.clone();
      editDragHelper.userData.lastQuat  = editDragHelper.quaternion.clone();
      editDragHelper.userData.lastScale = editDragHelper.scale.clone();
    }
    if (!ev.value && editorMode === 'edit' && editTargetId) {
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
  // three r170+: TransformControls extends Controls (not Object3D). The
  // visible/interactive gizmo lives on transform.getHelper() — add THAT to the
  // scene. Without this the axis arrows are invisible / non-clickable.
  transformHelper = typeof transform.getHelper === 'function'
    ? transform.getHelper()
    : transform;
  scene.add(transformHelper);
  _customizeTransformGizmo();
  _initViewGizmo();

  resize();
  bindEvents();
  bindToolbar();
  ensureHierarchyPanel();
  _attachContainerResizeObserver(container);

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
  _detachContainerResizeObserver();

  if (typeof unsubScene === 'function') { unsubScene(); unsubScene = null; }

  _closeViewportCtxMenu();
  if (renderer?.domElement) {
    renderer.domElement.removeEventListener('contextmenu', _onViewportContextMenu);
  }
  _cancelRmbFlyTimer();
  _rmbFlyTriggered = false;
  if (grabState) _grabCancel();
  if (bevelState) _bevelCancel();
  if (extrudeState) _extrudeCancel();
  if (insetState) _insetCancel();
  _disposeViewGizmo();

  _clearAllPeerCameras();
  selectedIds.clear();
  _selectableList.length = 0;
  if (flyEnabled) exitFlyCamera();
  snapEnabled = false;
  transformSpace = 'world';

  destroyEditHelpers();
  editTargetId = null;
  editorMode = 'object';
  selectedId = null;

  if (transform) {
    transform.detach();
    if (transformHelper && scene) scene.remove(transformHelper);
    transformHelper = null;
    if (typeof transform.dispose === 'function') transform.dispose();
    transform = null;
  }
  _camViewAnim = null;
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
