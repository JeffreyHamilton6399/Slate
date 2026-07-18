/**
 * AvatarCropper — Google-style circular avatar cropper. Load an image, drag to
 * pan, slider/scroll to zoom, and the circular frame shows the crop. Confirm
 * renders the framed region to a small square JPEG data URL (kept tiny so it
 * fits in a profiles row and syncs to friends without Storage).
 */

import { useEffect, useRef, useState } from 'react';
import { RotateCw, ZoomIn } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

const FRAME = 260; // on-screen crop viewport (px)
const OUT = 160; // exported avatar size (px)

interface AvatarCropperProps {
  open: boolean;
  /** Object URL or data URL of the source image. */
  src: string | null;
  onCancel: () => void;
  onCrop: (dataUrl: string) => void;
}

export function AvatarCropper({ open, src, onCancel, onCrop }: AvatarCropperProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0); // 0/90/180/270 degrees
  const [pan, setPan] = useState({ x: 0, y: 0 }); // px offset of image center from frame center
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // (Re)load the source image and reset the transform.
  useEffect(() => {
    if (!open || !src) return;
    setZoom(1);
    setRot(0);
    setPan({ x: 0, y: 0 });
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = src;
  }, [open, src]);

  // Base scale: cover the frame with the (rotation-aware) image at zoom 1.
  const rotated = rot === 90 || rot === 270;
  const imgW = natural ? (rotated ? natural.h : natural.w) : 1;
  const imgH = natural ? (rotated ? natural.w : natural.h) : 1;
  const baseScale = natural ? Math.max(FRAME / imgW, FRAME / imgH) : 1;
  const scale = baseScale * zoom;
  const dispW = imgW * scale;
  const dispH = imgH * scale;

  // Clamp pan so the image always covers the frame (no empty gaps).
  const clampPan = (p: { x: number; y: number }) => {
    const mx = Math.max(0, (dispW - FRAME) / 2);
    const my = Math.max(0, (dispH - FRAME) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  };
  // Re-clamp the pan when the zoom/rotation/image changes so the frame stays
  // covered. clampPan reads the latest render's scale via closure; the deps we
  // list are the ones that actually change the bounds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPan((p) => clampPan(p)); }, [zoom, rot, natural]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan(clampPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const crop = () => {
    const img = imgRef.current;
    if (!img || !natural) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Circular mask.
    ctx.beginPath();
    ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    // Map the on-screen transform to the export canvas (FRAME → OUT).
    const k = OUT / FRAME;
    ctx.translate(OUT / 2 + pan.x * k, OUT / 2 + pan.y * k);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(scale * k, scale * k);
    ctx.drawImage(img, -natural.w / 2, -natural.h / 2);
    onCrop(canvas.toDataURL('image/jpeg', 0.85));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }} title="Crop your photo" className="max-w-sm">
      <div className="flex flex-col items-center gap-4">
        <div
          className="relative overflow-hidden rounded-md bg-black/40 touch-none"
          style={{ width: FRAME, height: FRAME }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={(e) => setZoom((z) => Math.max(1, Math.min(4, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))}
        >
          {natural && (
            <img
              src={src ?? ''}
              alt=""
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
              style={{
                width: (rotated ? imgH : imgW) * scale,
                height: (rotated ? imgW : imgH) * scale,
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg)`,
              }}
            />
          )}
          {/* Circular frame overlay */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ boxShadow: `0 0 0 ${FRAME}px rgba(0,0,0,0.55)`, borderRadius: '9999px', margin: 'auto', width: FRAME, height: FRAME, clipPath: `circle(${FRAME / 2}px)` }}
          />
          <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/70" />
        </div>

        <div className="flex w-full items-center gap-2">
          <ZoomIn size={14} className="shrink-0 text-text-dim" />
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label="Zoom"
          />
          <button
            type="button"
            onClick={() => setRot((r) => ((r + 90) % 360))}
            className="flex h-7 w-7 items-center justify-center rounded-sm border border-border text-text-mid hover:bg-bg-3"
            title="Rotate"
            aria-label="Rotate"
          >
            <RotateCw size={13} />
          </button>
        </div>

        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={crop} disabled={!natural}>Set photo</Button>
        </div>
      </div>
    </Dialog>
  );
}
