/**
 * Procedural textures for 3D materials.
 *
 * Textures sync as tiny parameter blobs (kind + scale + color) and are
 * rasterized client-side into cached CanvasTextures. Patterns are drawn in
 * white + the secondary color: three.js multiplies the map with the material
 * color, so white areas show the base PBR color untouched.
 *
 * Meshes carry no UVs, so `applyBoxUVs` box-projects them from each vertex's
 * dominant normal axis — the same trick as Blender's Box mapping.
 */

import * as THREE from 'three';
import type { MaterialTexture, TextureKind } from '@slate/sync-protocol';

const SIZE = 128;
const cache = new Map<string, THREE.CanvasTexture>();
/** Pending image-texture loads (data URL → THREE.Texture) — resolved async. */
const imageCache = new Map<string, THREE.Texture>();

export function proceduralTexture(tex: MaterialTexture): THREE.CanvasTexture | null {
  if (tex.kind === 'none') return null;
  // Image textures are loaded async (see loadImageTexture); return cached or null.
  if (tex.kind === 'image') {
    if (!tex.src) return null;
    return (imageCache.get(tex.src) as THREE.CanvasTexture | undefined) ?? null;
  }
  const key = `${tex.kind}|${tex.color2}|${tex.scale}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = tex.color2;
  ctx.strokeStyle = tex.color2;
  drawPattern(ctx, tex.kind);

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(tex.scale, tex.scale);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

function drawPattern(ctx: CanvasRenderingContext2D, kind: Exclude<TextureKind, 'none'>): void {
  const s = SIZE;
  switch (kind) {
    case 'checker':
      ctx.fillRect(0, 0, s / 2, s / 2);
      ctx.fillRect(s / 2, s / 2, s / 2, s / 2);
      break;
    case 'grid':
      ctx.lineWidth = s * 0.04;
      ctx.strokeRect(0, 0, s, s);
      break;
    case 'dots': {
      const r = s * 0.14;
      for (const [cx, cy] of [
        [s * 0.25, s * 0.25],
        [s * 0.75, s * 0.75],
      ]) {
        ctx.beginPath();
        ctx.arc(cx!, cy!, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'stripes':
      ctx.save();
      ctx.translate(s / 2, s / 2);
      ctx.rotate(Math.PI / 4);
      for (let i = -2; i <= 2; i++) ctx.fillRect(-s, i * s * 0.5 - s * 0.12, 2 * s, s * 0.24);
      ctx.restore();
      break;
    case 'bricks': {
      // Two courses per tile, offset half a brick — mortar in color2.
      const mortar = s * 0.045;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = '#ffffff';
      const rowH = s / 2;
      for (let row = 0; row < 2; row++) {
        const offset = row % 2 === 0 ? 0 : -s / 2;
        for (let col = -1; col < 2; col++) {
          ctx.fillRect(
            col * s + offset + mortar / 2,
            row * rowH + mortar / 2,
            s - mortar,
            rowH - mortar,
          );
        }
      }
      break;
    }
    case 'waves': {
      ctx.lineWidth = s * 0.06;
      for (let row = 0; row < 4; row++) {
        ctx.beginPath();
        const y0 = (row + 0.5) * (s / 4);
        for (let x = -s * 0.25; x <= s * 1.25; x += 2) {
          const y = y0 + Math.sin(((x / s) * 2 + row * 0.5) * Math.PI * 2) * s * 0.06;
          if (x <= -s * 0.25 + 2) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'noise': {
      // Deterministic hash noise so every client draws the same texture.
      let seed = 1337;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      const cell = 4;
      for (let y = 0; y < s; y += cell) {
        for (let x = 0; x < s; x += cell) {
          ctx.globalAlpha = rand() * 0.85;
          ctx.fillRect(x, y, cell, cell);
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
  }
}

/**
 * Box-project UVs from vertex positions: each vertex is mapped on the plane
 * perpendicular to its dominant normal axis. Requires a normal attribute
 * (call after computeVertexNormals). One repeat per world unit.
 */
export function applyBoxUVs(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!pos || !nrm) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    if (nx >= ny && nx >= nz) {
      uv[i * 2] = pos.getZ(i);
      uv[i * 2 + 1] = pos.getY(i);
    } else if (ny >= nx && ny >= nz) {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getZ(i);
    } else {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getY(i);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Load an image data URL into a THREE.Texture and cache it. Returns a
 *  callback to call when the texture is needed (the load is async). The
 *  SceneObjects component calls `proceduralTexture` which returns the cached
 *  texture once loaded, or null while loading. */
export function loadImageTexture(src: string, onReady: () => void): void {
  if (imageCache.has(src)) return;
  const img = new Image();
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    imageCache.set(src, tex);
    onReady();
  };
  img.onerror = () => {/* ignore — texture stays null */};
  img.src = src;
}

/** Clear the image texture cache (e.g. when the texture src changes). */
export function clearImageTexture(src: string): void {
  imageCache.delete(src);
}
