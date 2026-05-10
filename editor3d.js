/**
 * editor3d.js — Three.js viewport (orbit / pan / zoom, transform tools, mesh selection).
 * ES module; requires import map for "three" in index.html.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

let container = null;
let renderer = null;
let scene = null;
let camera = null;
let orbit = null;
let transform = null;
let raycaster = null;
let pointer = new THREE.Vector2();
let selected = null;
let raf = 0;
let bound = false;
let vvResizeBound = false;

function pickObject(clientX, clientY) {
  if (!container || !camera) return null;
  const rect = container.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  scene.traverse(o => {
    if (o.isMesh && o.userData.selectable) meshes.push(o);
  });
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0].object : null;
}

function attachTransform(mesh) {
  if (!mesh || !transform) return;
  transform.attach(mesh);
  selected = mesh;
}

function onPointerDown(e) {
  if (e.button !== 0 || !orbit || transform?.dragging) return;
  const hit = pickObject(e.clientX, e.clientY);
  if (hit) {
    attachTransform(hit);
    orbit.enabled = false;
  } else {
    if (transform) transform.detach();
    selected = null;
    orbit.enabled = true;
  }
}

function onKeyDown(e) {
  if (!container || !container.isConnected) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!transform) return;
  if (e.key === 'g' || e.key === 'G') { transform.setMode('translate'); e.preventDefault(); }
  if (e.key === 'r' || e.key === 'R') { transform.setMode('rotate'); e.preventDefault(); }
  if (e.key === 's' || e.key === 'S') { transform.setMode('scale'); e.preventDefault(); }
  if (e.key === 'w' || e.key === 'W') {
    if (selected && selected.material) {
      selected.material.wireframe = !selected.material.wireframe;
    }
    e.preventDefault();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    transform.detach();
    scene.remove(selected);
    if (selected.geometry) selected.geometry.dispose();
    if (selected.material) selected.material.dispose();
    selected = null;
    orbit.enabled = true;
    e.preventDefault();
  }
}

function ensureScene() {
  if (scene) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121a);

  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
  camera.position.set(4, 3.5, 6);

  const amb = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(4, 10, 6);
  scene.add(dir);

  const grid = new THREE.GridHelper(40, 40, 0x3a3a4d, 0x252530);
  scene.add(grid);

  const boxGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x7c6aff, roughness: 0.45, metalness: 0.15 });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.set(0, 0.6, 0);
  box.userData.selectable = true;
  box.castShadow = true;
  box.receiveShadow = true;
  scene.add(box);

  const torusGeo = new THREE.TorusGeometry(0.55, 0.18, 16, 40);
  const torusMat = new THREE.MeshStandardMaterial({ color: 0x22d3a5, roughness: 0.35, metalness: 0.2 });
  const torus = new THREE.Mesh(torusGeo, torusMat);
  torus.position.set(-2.2, 0.55, 0.5);
  torus.rotation.y = 0.4;
  torus.userData.selectable = true;
  scene.add(torus);

  raycaster = new THREE.Raycaster();
}

function resize() {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth || 1;
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

function onVisualViewportChange() {
  resize();
}

function bindEvents() {
  if (bound || !container) return;
  bound = true;
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeyDown, true);
  container.addEventListener('pointerdown', onPointerDown);
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
  if (container) container.removeEventListener('pointerdown', onPointerDown);
  if (window.visualViewport && vvResizeBound) {
    vvResizeBound = false;
    window.visualViewport.removeEventListener('resize', onVisualViewportChange);
    window.visualViewport.removeEventListener('scroll', onVisualViewportChange);
  }
}

export function initEditor3D(rootEl) {
  if (!rootEl) return;
  if (container === rootEl && renderer) {
    resize();
    bindEvents();
    cancelAnimationFrame(raf);
    loop();
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

  transform = new TransformControls(camera, renderer.domElement);
  transform.addEventListener('dragging-changed', ev => {
    orbit.enabled = !ev.value;
  });
  scene.add(transform);

  resize();
  bindEvents();
  cancelAnimationFrame(raf);
  loop();
}

export function disposeEditor3D() {
  cancelAnimationFrame(raf);
  unbindEvents();
  if (transform) {
    transform.detach();
    if (scene) scene.remove(transform);
    if (typeof transform.dispose === 'function') transform.dispose();
    transform = null;
  }
  if (orbit) {
    orbit.dispose();
    orbit = null;
  }
  if (renderer && renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
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
  selected = null;
  container = null;
}

window.addEventListener('slate-3d-activate', () => {
  const el = document.getElementById('canvas-area-3d');
  if (el) initEditor3D(el);
});

window.addEventListener('slate-3d-deactivate', () => {
  disposeEditor3D();
});
