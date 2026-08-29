/**
 * Slides left-dock panel: layout presets + slide background.
 *
 * Layout presets replace the current slide's text boxes with a standard
 * arrangement (title, title + body, two columns, section header) the way
 * Google Slides' layout picker does — images and shapes are left alone, so
 * applying a layout to a slide that already has a picture only re-flows the
 * text around it.
 */

import { useEffect, useMemo, useState } from 'react';
import { SLIDE_W, SLIDE_H, type SlideElement, type SlideTransition } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { makeId } from '../utils/id';
import { cn } from '../utils/cn';
import { readSlides, readElements, toYMap, topZ } from '../slides/model';
import { useSlidesStore } from '../slides/store';
import { defaultTextColor, setSlideBackground } from '../slides/background';

/** A text box in a layout preset, in logical slide coordinates. */
interface Placeholder {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

interface Layout {
  id: string;
  name: string;
  boxes: Placeholder[];
  /** Miniature preview bars: [x, y, w, h] as fractions of the slide. */
  preview: [number, number, number, number][];
}

const M = 80; // slide margin

const LAYOUTS: Layout[] = [
  {
    id: 'title',
    name: 'Title',
    boxes: [
      { x: M, y: 250, w: SLIDE_W - M * 2, h: 120, text: 'Title', fontSize: 72, bold: true, align: 'center' },
      { x: M, y: 386, w: SLIDE_W - M * 2, h: 70, text: 'Subtitle', fontSize: 32, align: 'center' },
    ],
    preview: [
      [0.12, 0.36, 0.76, 0.16],
      [0.24, 0.57, 0.52, 0.08],
    ],
  },
  {
    id: 'title-body',
    name: 'Title + body',
    boxes: [
      { x: M, y: 70, w: SLIDE_W - M * 2, h: 100, text: 'Title', fontSize: 56, bold: true },
      { x: M, y: 200, w: SLIDE_W - M * 2, h: 400, text: 'Body text', fontSize: 32 },
    ],
    preview: [
      [0.06, 0.1, 0.62, 0.13],
      [0.06, 0.3, 0.88, 0.5],
    ],
  },
  {
    id: 'two-col',
    name: 'Two columns',
    boxes: [
      { x: M, y: 70, w: SLIDE_W - M * 2, h: 100, text: 'Title', fontSize: 56, bold: true },
      { x: M, y: 200, w: (SLIDE_W - M * 2 - 40) / 2, h: 400, text: 'Left column', fontSize: 28 },
      { x: M + (SLIDE_W - M * 2 - 40) / 2 + 40, y: 200, w: (SLIDE_W - M * 2 - 40) / 2, h: 400, text: 'Right column', fontSize: 28 },
    ],
    preview: [
      [0.06, 0.1, 0.62, 0.13],
      [0.06, 0.3, 0.41, 0.5],
      [0.53, 0.3, 0.41, 0.5],
    ],
  },
  {
    id: 'section',
    name: 'Section',
    boxes: [
      { x: M, y: (SLIDE_H - 110) / 2, w: SLIDE_W - M * 2, h: 110, text: 'Section', fontSize: 64, bold: true, align: 'left' },
    ],
    preview: [[0.06, 0.42, 0.66, 0.16]],
  },
  { id: 'blank', name: 'Blank', boxes: [], preview: [] },
];

const BG_SWATCHES = ['#14141b', '#0c0c0e', '#1d1d2b', '#232333', '#2b2036', '#f6f5f0', '#ffffff'];

/** Entrance animations offered per slide, in present mode. */
const TRANSITIONS: { id: SlideTransition; name: string }[] = [
  { id: 'none', name: 'Cut' },
  { id: 'fade', name: 'Fade' },
  { id: 'slide', name: 'Slide' },
  { id: 'zoom', name: 'Zoom' },
];

export function SlideLayoutPanel() {
  const room = useRoom();
  const mode = useAppStore((s) => s.currentBoard?.mode);
  const slidesMap = useMemo(() => room.slate.slides(), [room]);
  const elementsMap = useMemo(() => room.slate.slideElements(), [room]);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    slidesMap.observeDeep(bump);
    return () => slidesMap.unobserveDeep(bump);
  }, [slidesMap]);

  // The editor publishes which slide is active; fall back to the first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slides = useMemo(() => readSlides(slidesMap), [slidesMap, version]);
  const activeId = useSlidesStore((s) => s.activeSlideId);
  const active = slides.find((s) => s.id === activeId) ?? slides[0] ?? null;

  if (mode !== 'presentation') {
    return <div className="p-3 text-xs text-text-dim">Slide layouts are only available on slides boards.</div>;
  }
  if (!active) {
    return <div className="p-3 text-xs text-text-dim">No slide yet.</div>;
  }

  const applyLayout = (layout: Layout) => {
    const color = defaultTextColor(active.background);
    room.slate.doc.transact(() => {
      // Replace text boxes only — pictures and shapes stay put.
      for (const el of readElements(elementsMap)) {
        if (el.slideId === active.id && el.kind === 'text') elementsMap.delete(el.id);
      }
      let z = topZ(readElements(elementsMap), active.id);
      for (const b of layout.boxes) {
        elementsMap.set(
          makeId('sel'),
          toYMap({
            slideId: active.id,
            kind: 'text',
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            rotation: 0,
            z: ++z,
            text: b.text,
            fontSize: b.fontSize,
            color,
            align: b.align ?? 'left',
            bold: b.bold ?? false,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          } satisfies Partial<SlideElement> as Record<string, unknown>),
        );
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 p-2">
      <div>
        <div className="mb-1.5 px-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          Layout
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              title={`Apply the ${l.name} layout`}
              onClick={() => applyLayout(l)}
              className="group flex flex-col gap-1 rounded-md border border-border p-1 transition-colors hover:border-accent"
            >
              <span
                className="relative block w-full rounded-sm border border-border/60"
                style={{ background: active.background, aspectRatio: '16 / 9' }}
              >
                {l.preview.map(([x, y, w, h], i) => (
                  <span
                    key={i}
                    className="absolute rounded-[1px] bg-text-dim/60 group-hover:bg-accent/70"
                    style={{
                      left: `${x * 100}%`,
                      top: `${y * 100}%`,
                      width: `${w * 100}%`,
                      height: `${h * 100}%`,
                    }}
                  />
                ))}
              </span>
              <span className="truncate text-[10px] text-text-dim group-hover:text-text">{l.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 px-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          Background
        </div>
        <div className="flex flex-wrap gap-1 px-0.5">
          {BG_SWATCHES.map((c) => (
            <button
              key={c}
              title={c}
              onClick={() =>
                setSlideBackground(room.slate.doc, slidesMap, elementsMap, active.id, c)
              }
              className={cn(
                'h-[22px] w-[22px] rounded-md border transition-transform hover:scale-110',
                active.background === c ? 'border-accent' : 'border-border',
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <button
          className="mt-1.5 w-full rounded-md border border-border py-1 text-[10px] text-text-dim transition-colors hover:border-accent hover:text-text"
          title="Give every slide in the deck this background"
          onClick={() => {
            room.slate.doc.transact(() => {
              for (const s of slides) {
                setSlideBackground(room.slate.doc, slidesMap, elementsMap, s.id, active.background);
              }
            });
          }}
        >
          Apply background to all slides
        </button>
      </div>

      <div>
        <div className="mb-1.5 px-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          Transition
        </div>
        <div className="grid grid-cols-4 gap-1">
          {TRANSITIONS.map((t) => (
            <button
              key={t.id}
              title={`Play this slide with a ${t.name.toLowerCase()} entrance`}
              onClick={() => room.slate.doc.transact(() => slidesMap.get(active.id)?.set('transition', t.id))}
              className={cn(
                'rounded-md border py-1 text-[10px] transition-colors',
                (active.transition ?? 'fade') === t.id
                  ? 'border-accent bg-accent/15 text-text'
                  : 'border-border text-text-dim hover:text-text',
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
        <button
          className="mt-1.5 w-full rounded-md border border-border py-1 text-[10px] text-text-dim transition-colors hover:border-accent hover:text-text"
          title="Give every slide in the deck this transition"
          onClick={() => {
            const t = active.transition ?? 'fade';
            room.slate.doc.transact(() => {
              for (const s of slides) slidesMap.get(s.id)?.set('transition', t);
            });
          }}
        >
          Apply transition to all slides
        </button>
      </div>

      <p className="px-0.5 text-[10px] leading-relaxed text-text-dim">
        Double-click the slide to add text · drag/paste an image to place it · drag the top handle
        to rotate · elements snap to alignment guides (hold Alt to override) · F5 presents ·
        ⇧F5 presents from the start.
      </p>
    </div>
  );
}
