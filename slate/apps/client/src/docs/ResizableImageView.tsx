/**
 * ResizableImageView — the editor rendering for DocImage. Draws the image with
 * its width / rotation / alignment, and when the node is selected shows a
 * bounding box with corner handles you can drag to resize (like selecting an
 * image on the 2D canvas). Width is written back to the node attribute, so it
 * syncs through Yjs and survives export.
 */

import { useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

type ImgAttrs = {
  src: string;
  alt?: string | null;
  title?: string | null;
  width?: string | null;
  rotation?: number;
  align?: string | null;
};

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

export function ResizableImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const { src, alt, title, width, rotation, align } = node.attrs as ImgAttrs;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragW, setDragW] = useState<number | null>(null);

  const startResize = (e: React.PointerEvent, east: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
    // Cap at the editor column width so an image can't overflow the page.
    const maxWidth = img.closest('.ProseMirror')?.getBoundingClientRect().width ?? 1600;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.max(40, Math.min(maxWidth, Math.round(startWidth + (east ? dx : -dx))));
      setDragW(w);
      updateAttributes({ width: `${w}px` });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragW(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const margin =
    align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : undefined;

  return (
    <NodeViewWrapper
      className="slate-doc-img"
      data-align={align ?? undefined}
      style={{ position: 'relative', display: 'block', width: 'fit-content', margin, lineHeight: 0 }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt ?? ''}
        title={title ?? undefined}
        draggable={false}
        style={{
          width: width ?? undefined,
          maxWidth: '100%',
          height: 'auto',
          display: 'block',
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transformOrigin: 'center center',
        }}
      />
      {selected && (
        <>
          <span className="slate-img-box" />
          {CORNERS.map((c) => (
            <span
              key={c}
              className={`slate-img-handle slate-img-${c}`}
              onPointerDown={(e) => startResize(e, c === 'ne' || c === 'se')}
            />
          ))}
          {dragW !== null && <span className="slate-img-size">{dragW}px</span>}
        </>
      )}
    </NodeViewWrapper>
  );
}

export default ResizableImageView;
