/**
 * Lightweight minimap — renders the global board bounds and the current
 * viewport rectangle. Click/drag to recenter the camera.
 */

import { useEffect, useRef } from 'react';
import type { Layer, Shape, Stroke } from '@slate/sync-protocol';
import type { ViewportTransform } from './types';
import { shapeBounds, strokeBounds } from './geometry';
import { renderScene } from './renderer';

interface MinimapProps {
  getSnapshot: () =>
    | {
        layers: Layer[];
        shapesByLayer: Map<string, Shape[]>;
        strokesByLayer: Map<string, Stroke[]>;
      }
    | null;
  viewport: ViewportTransform;
  size: { width: number; height: number };
  onPan: (boardCenter: { x: number; y: number }) => void;
  /** Board paper color so the minimap matches the canvas. */
  paper?: string;
}

const MM_W = 180;
const MM_H = 120;

export function Minimap({ getSnapshot, viewport, size, onPan, paper }: MinimapProps) {
  const cvs = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const c = cvs.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const snap = getSnapshot();
      c.width = MM_W * (window.devicePixelRatio || 1);
      c.height = MM_H * (window.devicePixelRatio || 1);
      c.style.width = `${MM_W}px`;
      c.style.height = `${MM_H}px`;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.fillStyle = paper || '#0c0c0e';
      ctx.fillRect(0, 0, MM_W, MM_H);
      if (!snap) return;
      // Compute world bounds.
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const layer of snap.layers) {
        for (const sh of snap.shapesByLayer.get(layer.id) ?? []) {
          const b = shapeBounds(sh);
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w;
          if (b.y + b.h > maxY) maxY = b.y + b.h;
        }
        for (const st of snap.strokesByLayer.get(layer.id) ?? []) {
          const b = strokeBounds(st);
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w;
          if (b.y + b.h > maxY) maxY = b.y + b.h;
        }
      }
      // Include viewport rect.
      const vw = size.width / viewport.zoom;
      const vh = size.height / viewport.zoom;
      const vx = -viewport.panX / viewport.zoom;
      const vy = -viewport.panY / viewport.zoom;
      if (!isFinite(minX)) {
        minX = vx;
        minY = vy;
        maxX = vx + vw;
        maxY = vy + vh;
      } else {
        minX = Math.min(minX, vx);
        minY = Math.min(minY, vy);
        maxX = Math.max(maxX, vx + vw);
        maxY = Math.max(maxY, vy + vh);
      }
      const pad = 50;
      minX -= pad;
      minY -= pad;
      maxX += pad;
      maxY += pad;
      const bw = maxX - minX || 1;
      const bh = maxY - minY || 1;
      const k = Math.min(MM_W / bw, MM_H / bh);
      const tx = (MM_W - bw * k) / 2 - minX * k;
      const ty = (MM_H - bh * k) / 2 - minY * k;

      // Render the ACTUAL drawing, miniaturized — not bounding boxes.
      renderScene(
        c,
        {
          layers: snap.layers,
          shapesByLayer: snap.shapesByLayer,
          strokesByLayer: snap.strokesByLayer,
          selection: new Set(),
          paper: paper || '#0c0c0e',
        },
        { zoom: k, panX: tx, panY: ty },
        { width: MM_W, height: MM_H, dpr: window.devicePixelRatio || 1 },
      );

      // Viewport overlay.
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.strokeStyle = '#7c6aff';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx * k + tx, vy * k + ty, vw * k, vh * k);

      // Stash for click-to-pan.
      (c as unknown as { __mm: unknown }).__mm = { k, tx, ty };
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [getSnapshot, viewport, size, paper]);

  return (
    <div
      data-no-canvas-pointer
      className="absolute right-2 bottom-2 z-10 hidden rounded-md border border-border bg-bg-2/95 backdrop-blur p-1 shadow-lg sm:block"
    >
      <canvas
        ref={cvs}
        onPointerDown={(e) => {
          const c = cvs.current;
          if (!c) return;
          const mm = (c as unknown as { __mm?: { k: number; tx: number; ty: number } }).__mm;
          if (!mm) return;
          const r = c.getBoundingClientRect();
          const bx = (e.clientX - r.left - mm.tx) / mm.k;
          const by = (e.clientY - r.top - mm.ty) / mm.k;
          onPan({ x: bx, y: by });
        }}
        className="block cursor-crosshair"
        aria-label="Minimap"
      />
    </div>
  );
}
