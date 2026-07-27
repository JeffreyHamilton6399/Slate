/**
 * Pure presentational renderer for one slide — used by the editing stage, the
 * thumbnail rail, AND present mode. Everything renders from the same logical
 * SLIDE_W×SLIDE_H coordinate space and is scaled by a single CSS transform,
 * so a thumbnail is BY CONSTRUCTION pixel-faithful to the stage: there is no
 * separate preview pipeline to fall out of date.
 */

import { memo } from 'react';
import { SLIDE_W, SLIDE_H, type SlideElement } from '@slate/sync-protocol';

export function elementStyle(el: SlideElement): React.CSSProperties {
  return {
    position: 'absolute',
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    transform: el.rotation ? `rotate(${el.rotation}rad)` : undefined,
  };
}

/** One element, display only (no handles / interactivity). */
function ElementView({ el }: { el: SlideElement }) {
  const base = elementStyle(el);
  switch (el.kind) {
    case 'text':
      return (
        <div
          style={{
            ...base,
            color: el.color ?? '#e0dff5',
            fontSize: el.fontSize ?? 32,
            fontWeight: el.bold ? 700 : 400,
            textAlign: el.align ?? 'left',
            lineHeight: 1.25,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            overflow: 'hidden',
            padding: 8,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          {el.text ?? ''}
        </div>
      );
    case 'image':
      return el.src ? (
        <img
          src={el.src}
          alt=""
          draggable={false}
          style={{ ...base, objectFit: 'fill', userSelect: 'none' }}
        />
      ) : (
        <div style={{ ...base, background: 'rgba(127,127,127,0.15)' }} />
      );
    case 'rect':
      return (
        <div
          style={{
            ...base,
            background: el.fill ?? undefined,
            border: `${el.strokeWidth ?? 2}px solid ${el.stroke ?? '#c9c7e8'}`,
            borderRadius: 6,
          }}
        />
      );
    case 'ellipse':
      return (
        <div
          style={{
            ...base,
            background: el.fill ?? undefined,
            border: `${el.strokeWidth ?? 2}px solid ${el.stroke ?? '#c9c7e8'}`,
            borderRadius: '50%',
          }}
        />
      );
    case 'line':
    case 'arrow': {
      // Drawn corner-to-corner of the element box in an SVG so it scales with
      // the box like everything else.
      const sw = el.strokeWidth ?? 3;
      const color = el.stroke ?? '#c9c7e8';
      return (
        <svg style={base} viewBox={`0 0 ${Math.max(1, el.w)} ${Math.max(1, el.h)}`}>
          <line
            x1={0}
            y1={el.h / 2}
            x2={el.w}
            y2={el.h / 2}
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
          />
          {el.kind === 'arrow' && (
            <path
              d={`M ${el.w - 14} ${el.h / 2 - 7} L ${el.w} ${el.h / 2} L ${el.w - 14} ${el.h / 2 + 7}`}
              stroke={color}
              strokeWidth={sw}
              fill="none"
              strokeLinecap="round"
            />
          )}
        </svg>
      );
    }
  }
}

interface SlideViewProps {
  background: string;
  /** Elements of THIS slide only, already sorted by z. */
  elements: SlideElement[];
  /** Rendered size = SLIDE_W×SLIDE_H × scale. */
  scale: number;
  className?: string;
}

/** A slide scaled to `scale`. Non-interactive; the editor overlays handles. */
export const SlideView = memo(function SlideView({
  background,
  elements,
  scale,
  className,
}: SlideViewProps) {
  return (
    <div
      className={className}
      style={{
        width: SLIDE_W * scale,
        height: SLIDE_H * scale,
        overflow: 'hidden',
        position: 'relative',
        flex: 'none',
      }}
    >
      <div
        style={{
          width: SLIDE_W,
          height: SLIDE_H,
          background,
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      >
        {elements.map((el) => (
          <ElementView key={el.id} el={el} />
        ))}
      </div>
    </div>
  );
});
