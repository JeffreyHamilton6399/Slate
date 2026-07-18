/**
 * First-person fly navigation for the 3D viewport.
 *
 * MMB hold — mouse-look + WASD (Q/E down/up, Shift = fast, wheel = speed),
 * like Unity's flythrough / Blender's walk mode. Releasing returns to orbit
 * navigation with the target re-anchored ahead of the camera.
 *
 * RMB pan is intentionally NOT handled here — it's left to OrbitControls
 * (mouseButtons.RIGHT = PAN). OrbitControls pans with the cursor VISIBLE and
 * uses pointer capture, which is the standard, non-surprising behavior; the
 * old pointer-locked RMB pan hid the cursor and jumped it back on release
 * (users read that as "right-click drag is weird / broken").
 *
 * Mounted inside <Canvas>. Sets `flying` in the scene store so the keyboard
 * shortcut hook stands down while WASD is navigation, not tools.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useScene3DStore } from './store';

const LOOK_SPEED = 0.0024;
const MIN_SPEED = 0.5;
const MAX_SPEED = 60;

interface FlyModeProps {
  /** The viewport wrapper — pointer-locked while flying. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True while a G/R/S modal drag owns the pointer; fly must not start. */
  isModalActive: () => boolean;
}

export function FlyMode({ containerRef, isModalActive }: FlyModeProps) {
  const { camera, controls, size } = useThree();
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const flying = useRef(false);
  const keys = useRef(new Set<string>());
  const shiftRef = useRef(false);
  const look = useRef({ yaw: 0, pitch: 0 });
  /** Smoothed velocity — keys set a target, motion eases toward it. */
  const velocity = useRef(new THREE.Vector3());
  /** Camera→orbit-target distance at entry, restored on exit. */
  const distRef = useRef(8);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const orbit = () =>
      controls as unknown as {
        enabled: boolean;
        target: THREE.Vector3;
        update: () => void;
      } | null;

    // Lock the cursor so the fly mouse-look can't wander onto browser chrome.
    // Rejection (post-Esc cooldown) is fine — movementX/Y works unlocked too.
    const lockCursor = () => {
      try {
        const p = el.requestPointerLock?.();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => {});
        }
      } catch {
        /* fall back to unlocked drag */
      }
    };

    const start = (e: PointerEvent) => {
      if (flying.current) return;
      if (isModalActive()) return;
      if ((e.target as HTMLElement).tagName !== 'CANVAS') return;

      if (e.button !== 1 || e.shiftKey) return; // MMB only; Shift+MMB = orbit pan
      e.preventDefault();
      const c = orbit();
      if (c) {
        // Disable before OrbitControls sees this pointerdown (we run in the
        // parent's capture phase) so it doesn't start an orbit drag.
        c.enabled = false;
        distRef.current = camera.position.distanceTo(c.target) || 8;
      }
      const eu = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      look.current = { yaw: eu.y, pitch: eu.x };
      keys.current.clear();
      shiftRef.current = false;
      flying.current = true;
      useScene3DStore.getState().setFlying(true);
      useScene3DStore.getState().setViewingCamera(null);
      lockCursor();
    };

    const end = () => {
      if (!flying.current) return;
      flying.current = false;
      keys.current.clear();
      useScene3DStore.getState().setFlying(false);
      const c = orbit();
      if (c) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        c.target.copy(camera.position).addScaledVector(dir, distRef.current);
        c.enabled = true;
        c.update();
      }
      if (document.pointerLockElement === el) document.exitPointerLock?.();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 1) end();
    };
    // Belt & braces: gesture/mouse software can swallow pointerup.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 1) end();
    };
    const onWindowBlur = () => {
      end();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!flying.current) return;
      look.current.yaw -= e.movementX * LOOK_SPEED;
      look.current.pitch = THREE.MathUtils.clamp(
        look.current.pitch - e.movementY * LOOK_SPEED,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
      camera.quaternion.setFromEuler(
        new THREE.Euler(look.current.pitch, look.current.yaw, 0, 'YXZ'),
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!flying.current) return;
      shiftRef.current = e.shiftKey;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        e.preventDefault();
        end();
        return;
      }
      if ('wasdqe'.includes(k) || k.startsWith('arrow')) {
        e.preventDefault();
        keys.current.add(k);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!flying.current) return;
      shiftRef.current = e.shiftKey;
      keys.current.delete(e.key.toLowerCase());
    };
    const onWheel = (e: WheelEvent) => {
      if (!flying.current) return;
      e.preventDefault();
      const store = useScene3DStore.getState();
      const next = THREE.MathUtils.clamp(
        store.flySpeed * (e.deltaY < 0 ? 1.25 : 0.8),
        MIN_SPEED,
        MAX_SPEED,
      );
      store.setFlySpeed(next);
    };
    const onLockChange = () => {
      if (document.pointerLockElement === el) {
        // requestPointerLock resolves async — on a quick press-release the
        // lock can engage AFTER the button went up. Never leave the cursor
        // locked with no drag running. The G/R/S modal owns the lock too —
        // exiting on its behalf would instantly cancel the modal (that was
        // the "every object hotkey is dead" bug).
        if (!flying.current && !isModalActive()) {
          document.exitPointerLock?.();
        }
        return;
      }
      if (document.pointerLockElement) return;
      // Browser dropped the lock (Esc, Alt-Tab): leave fly too, so the
      // camera never keeps chasing an unlocked cursor.
      if (flying.current) end();
    };

    el.addEventListener('pointerdown', start, { capture: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      el.removeEventListener('pointerdown', start, { capture: true });
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onLockChange);
      end();
    };
  }, [camera, controls, containerRef, isModalActive]);

  useFrame((_, delta) => {
    const vel = velocity.current;
    if (!flying.current) {
      if (vel.lengthSq() > 0) vel.set(0, 0, 0);
      return;
    }
    // Ease velocity toward the keyed direction — a short accelerate/brake
    // glide feels like a game camera instead of a stepper motor.
    const k = keys.current;
    const move = new THREE.Vector3();
    if (k.size > 0) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      if (k.has('w') || k.has('arrowup')) move.add(dir);
      if (k.has('s') || k.has('arrowdown')) move.sub(dir);
      if (k.has('d') || k.has('arrowright')) move.add(right);
      if (k.has('a') || k.has('arrowleft')) move.sub(right);
      if (k.has('e')) move.y += 1;
      if (k.has('q')) move.y -= 1;
    }
    const speed = useScene3DStore.getState().flySpeed * (shiftRef.current ? 3 : 1);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    vel.lerp(move, 1 - Math.exp(-delta * 10));
    if (vel.lengthSq() < 1e-6) {
      vel.set(0, 0, 0);
      return;
    }
    camera.position.addScaledVector(vel, delta);
  });

  return null;
}
