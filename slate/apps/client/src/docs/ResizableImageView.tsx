/**
 * ResizableImageView — editor rendering for DocImage. When selected it shows,
 * like an image on a design canvas:
 *   - a small floating toolbar (move handle, text-wrap none/left/right, rotate 90°)
 *   - a free rotation handle above the image (drag to any angle)
 *   - corner handles to drag-resize
 * Drag the move handle to reposition the image in the document (ProseMirror
 * node drag). `wrap` floats the image so text flows around it. Every change is
 * written to the node attributes, so it syncs through Yjs and exports.
 */

import { useRef, useState, type CSSProperties } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Move, RotateCw, Square, PanelLeft, PanelRight } from 'lucide-react';

type ImgAttrs = {
  src: string;
  alt?: string | null;
  title?: string | null;
  width?: string | null;
  rotation?: number;
  wrap?: 'none' | 'left' | 'right';
};

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
const prevent = (e: React.MouseEvent) => e.preventDefault();

export function ResizableImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const attrs = node.attrs as ImgAttrs;
  const { src, alt, title, width } = attrs;
  const rotation = attrs.rotation ?? 0;
  const wrap = attrs.wrap ?? 'none';
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragW, setDragW] = useState<number | null>(null);

  const startResize = (e: React.PointerEvent, east: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
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

  const startRotate = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const onMove = (ev: PointerEvent) => {
      const deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      updateAttributes({ rotation: Math.round(((deg % 360) + 360) % 360) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const floatStyle: CSSProperties =
    wrap === 'left'
      ? { float: 'left', margin: '0.2em 1.2em 0.6em 0' }
      : wrap === 'right'
        ? { float: 'right', margin: '0.2em 0 0.6em 1.2em' }
        : {};

  const wrapBtn = (active: boolean) =>
    `slate-img-btn${active ? ' is-active' : ''}`;

  return (
    <NodeViewWrapper
      className="slate-doc-img"
      data-wrap={wrap}
      style={{
        position: 'relative',
        display: wrap === 'none' ? 'block' : 'inline-block',
        width: 'fit-content',
        lineHeight: 0,
        ...floatStyle,
      }}
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
          <div className="slate-img-bar" contentEditable={false}>
            <button type="button" data-drag-handle draggable title="Drag to move" className="slate-img-btn slate-img-move">
              <Move size={12} />
            </button>
            <span className="slate-img-sep" />
            <button type="button" title="No wrap (block)" className={wrapBtn(wrap === 'none')} onMouseDown={prevent} onClick={() => updateAttributes({ wrap: 'none' })}>
              <Square size={12} />
            </button>
            <button type="button" title="Wrap text left" className={wrapBtn(wrap === 'left')} onMouseDown={prevent} onClick={() => updateAttributes({ wrap: 'left' })}>
              <PanelLeft size={12} />
            </button>
            <button type="button" title="Wrap text right" className={wrapBtn(wrap === 'right')} onMouseDown={prevent} onClick={() => updateAttributes({ wrap: 'right' })}>
              <PanelRight size={12} />
            </button>
            <span className="slate-img-sep" />
            <button type="button" title="Rotate 90°" className="slate-img-btn" onMouseDown={prevent} onClick={() => updateAttributes({ rotation: (((rotation + 90) % 360) + 360) % 360 })}>
              <RotateCw size={12} />
            </button>
          </div>
          <span className="slate-img-rotate" onPointerDown={startRotate} title="Drag to rotate" />
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
