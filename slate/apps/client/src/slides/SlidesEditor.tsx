/**
 * Slides editor — Google Slides / Keynote-style presentations. Slate's 7th
 * editor mode.
 *
 * Layout: a left rail of live slide thumbnails + the editing stage. The rail,
 * the stage, and present mode all render through the same <SlideView>
 * component from the same Yjs-backed element arrays, so thumbnails can never
 * drift out of sync with the slide — they ARE the slide, scaled down.
 *
 * Interaction model:
 *   - Click selects (Shift adds), drag moves, 8 handles resize; corner-resize
 *     of images keeps their aspect ratio.
 *   - Double-click a text box to edit it; double-click empty canvas to drop a
 *     new text box right there.
 *   - Insert images via toolbar, drag-drop, or paste; they land centered and
 *     are immediately draggable/resizable like any element.
 *   - Delete removes; arrows nudge (Shift = 10×); Ctrl+C/X/V/D clipboard;
 *     [ / ] restack; Ctrl+Z / Ctrl+Shift+Z undo / redo; PageUp/PageDown flip
 *     slides; F5 or the Present button starts the show.
 *
 * All slide/element data lives in Yjs (`slides:slides` / `slides:elements`),
 * so editing is live-collaborative and offline-persistent like every mode.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Type,
  ImagePlus,
  Square,
  Circle,
  Plus,
  Copy,
  Trash2,
  ChevronUp,
  ChevronDown,
  Undo2,
  Redo2,
  Play,
  ChevronDown as CaretDown,
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
  StickyNote,
  GripVertical,
  Minus,
  ArrowRight,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  LayoutGrid,
} from 'lucide-react';
import {
  SLIDE_W,
  SLIDE_H,
  type Slide,
  type SlideElement,
  type SlideElementKind,
} from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { useIsMobile } from '../workspace/useMediaQuery';
import { makeId } from '../utils/id';
import { cn } from '../utils/cn';
import { toast } from '../ui/Toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu';
import { fileToImageShape, isImageFile } from '../canvas2d/importImage';
import { uploadDataUrl } from '../supabase/storage';
import { SlideView } from './SlideView';
import { PresentOverlay } from './PresentOverlay';
import { useSlidesStore } from './store';
import { defaultTextColor, setSlideBackground } from './background';
import { readSlides, readElements, toYMap, orderBetween, topZ } from './model';
import { migrateLegacyDeck, needsMigration } from './migrate';

const MIN_SIZE = 24;
const PASTE_OFFSET = 24;
const DEFAULT_BG = '#14141b';
/** Snap distance in SCREEN pixels — converted to slide units per zoom level so
 *  the magnet feels the same however far you're zoomed in. */
const SNAP_PX = 6;
/** Rotation snap increment while Shift is held. */
const ROT_SNAP = Math.PI / 12; // 15°

/** Slide background palette (dark-friendly plus a light paper). */
const BG_SWATCHES = ['#14141b', '#0c0c0e', '#1d1d2b', '#232333', '#f6f5f0', '#ffffff'];
/** Element fill/text color palette. */
const EL_SWATCHES = ['#e0dff5', '#7c6aff', '#8fd4ff', '#8fe6b0', '#ffd68f', '#ff9db8', '#2a2a35'];

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Edge (or centre line) of the selection's bounding box to align against. */
type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';

/** The three fill presets a closed shape can use. */
type FillStyle = 'solid' | 'tint' | 'none';

/** Which preset a shape's current fill corresponds to. Tints are written as
 *  8-digit hex with an alpha suffix, so a short (or fully opaque) value is a
 *  solid colour and an absent one is outline-only. */
function fillStyleOf(el: SlideElement): FillStyle {
  if (!el.fill) return 'none';
  return /^#[0-9a-f]{8}$/i.test(el.fill) && !/ff$/i.test(el.fill) ? 'tint' : 'solid';
}
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Candidate alignment lines gathered once at drag start. */
interface SnapTargets {
  xs: number[];
  ys: number[];
}

/** An alignment line currently being snapped to, in slide coordinates. */
interface Guide {
  axis: 'x' | 'y';
  at: number;
}

type Drag =
  | {
      kind: 'move';
      start: { x: number; y: number };
      origin: Map<string, { x: number; y: number }>;
      /** Union box of the dragged selection at drag start. */
      box: { x: number; y: number; w: number; h: number };
      snap: SnapTargets;
      moved: boolean;
    }
  | { kind: 'resize'; id: string; handle: Handle; start: SlideElement; aspect: boolean }
  | { kind: 'rotate'; id: string; center: { x: number; y: number }; start: number; grab: number };

interface TextEdit {
  elementId: string;
  value: string;
  /** True when the box was just created — an empty commit deletes it. */
  fresh: boolean;
}

export default function SlidesEditor() {
  const room = useRoom();
  const slidesMap = useMemo(() => room.slate.slides(), [room]);
  const elementsMap = useMemo(() => room.slate.slideElements(), [room]);
  const iAmCreator = useAppStore((s) => s.currentBoard?.iAmCreator ?? false);
  // On a phone the slide rail becomes a horizontal filmstrip above the stage:
  // a 192px vertical rail is half a portrait viewport, which left the stage
  // too narrow to edit and pushed the toolbar off screen.
  const isMobile = useIsMobile();
  const thumbW = isMobile ? 104 : 152;

  // Re-read the Yjs maps into plain arrays on any deep change. This single
  // version counter is what keeps the STAGE and the THUMBNAILS in lockstep.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    slidesMap.observeDeep(bump);
    elementsMap.observeDeep(bump);
    return () => {
      slidesMap.unobserveDeep(bump);
      elementsMap.unobserveDeep(bump);
    };
  }, [slidesMap, elementsMap]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slides = useMemo(() => readSlides(slidesMap), [slidesMap, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const elements = useMemo(() => readElements(elementsMap), [elementsMap, version]);

  // ── Legacy deck migration ──────────────────────────────────────────────────
  // Decks authored before the editor swap live as HTML blobs in a separate
  // Y.Array. Convert them before the bootstrap below runs, or an existing deck
  // would look empty and get a blank "slide 1" stamped on top of it.
  const legacyArr = useMemo(() => room.slate.legacySlides(), [room]);
  useEffect(() => {
    const run = () => {
      const n = migrateLegacyDeck(
        room.slate.doc,
        legacyArr,
        slidesMap,
        elementsMap,
        room.identity.peerId,
      );
      if (n > 0) {
        toast({
          title: 'Presentation upgraded',
          description: `${n} slide${n === 1 ? '' : 's'} converted to the new editor. Your original is kept.`,
        });
      }
    };
    // The legacy array may arrive with the initial sync rather than at mount.
    run();
    legacyArr.observeDeep(run);
    return () => legacyArr.unobserveDeep(run);
  }, [legacyArr, slidesMap, elementsMap, room]);

  // ── Slide bootstrap + active slide ─────────────────────────────────────────
  useEffect(() => {
    if (slides.length > 0) return;
    // Never stamp a blank slide over a deck that is still waiting to migrate.
    if (needsMigration(legacyArr, slidesMap)) return;
    const bootstrap = () => {
      if (slidesMap.size > 0 || needsMigration(legacyArr, slidesMap)) return;
      slidesMap.doc?.transact(() => {
        const id = makeId('slide');
        slidesMap.set(
          id,
          toYMap({
            order: 1,
            background: DEFAULT_BG,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          }),
        );
      });
    };
    // Creator makes slide 1 immediately; joiners wait a beat for the initial
    // sync so we don't mint duplicate first slides (same as the 2D layer
    // bootstrap).
    if (iAmCreator) {
      bootstrap();
      return;
    }
    const t = setTimeout(bootstrap, 2500);
    return () => clearTimeout(t);
  }, [slides.length, slidesMap, room, iAmCreator, legacyArr]);

  const activeSlideId = useSlidesStore((s) => s.activeSlideId);
  const setActiveSlideId = useSlidesStore((s) => s.setActiveSlide);
  const activeSlide: Slide | null =
    slides.find((s) => s.id === activeSlideId) ?? slides[0] ?? null;
  // Clamp active to an existing slide (remote deletes).
  useEffect(() => {
    if (activeSlideId && !slides.some((s) => s.id === activeSlideId)) {
      setActiveSlideId(slides[0]?.id ?? null);
    }
  }, [slides, activeSlideId, setActiveSlideId]);

  const activeElements = useMemo(
    () => elements.filter((e) => e.slideId === activeSlide?.id),
    [elements, activeSlide?.id],
  );
  const elementsBySlide = useMemo(() => {
    const m = new Map<string, SlideElement[]>();
    for (const e of elements) {
      const arr = m.get(e.slideId);
      if (arr) arr.push(e);
      else m.set(e.slideId, [e]);
    }
    return m;
  }, [elements]);

  // ── Selection / editing state ──────────────────────────────────────────────
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  /** Rail drag-reorder: id being dragged, and the gap it would drop into. */
  const [railDrag, setRailDrag] = useState<{ id: string; over: number | null } | null>(null);
  /** Alignment lines currently being snapped to (drawn over the stage). */
  const [guides, setGuides] = useState<Guide[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const clipboardRef = useRef<SlideElement[]>([]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const textEditRef = useRef(textEdit);
  textEditRef.current = textEdit;

  // Selection follows existing elements only (remote deletes).
  useEffect(() => {
    setSelection((sel) => {
      const ids = new Set(activeElements.map((e) => e.id));
      const next = new Set([...sel].filter((id) => ids.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [activeElements]);
  // Switching slides clears selection + text edit.
  useEffect(() => {
    setSelection(new Set());
    setTextEdit(null);
  }, [activeSlide?.id]);
  // `activeSlide` falls back to slides[0] before anything is picked; write that
  // back so the Design panel and Export dialog agree on what's on the stage.
  useEffect(() => {
    if (activeSlide && activeSlide.id !== activeSlideId) setActiveSlideId(activeSlide.id);
  }, [activeSlide, activeSlideId, setActiveSlideId]);

  // ── Stage scale ────────────────────────────────────────────────────────────
  // Attached via a CALLBACK ref, not a mount effect: the component returns a
  // "setting up your first slide…" placeholder until the deck loads, so a
  // []-dep effect ran while the wrapper was still unmounted, bailed out, and
  // never re-ran — the stage stayed pinned at the initial 0.5 scale forever,
  // at every window size.
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const stageObserverRef = useRef<ResizeObserver | null>(null);
  const [scale, setScale] = useState(0.5);
  const measureStage = useCallback(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Insets leave room for the floating toolbar and the Present button.
    const k = Math.min((r.width - 32) / SLIDE_W, (r.height - 88) / SLIDE_H);
    setScale(Math.max(0.05, Math.min(2, k)));
  }, []);
  const attachStageWrap = useCallback(
    (el: HTMLDivElement | null) => {
      stageObserverRef.current?.disconnect();
      stageObserverRef.current = null;
      stageWrapRef.current = el;
      if (!el) return;
      const ro = new ResizeObserver(measureStage);
      ro.observe(el);
      stageObserverRef.current = ro;
      measureStage();
    },
    [measureStage],
  );
  useEffect(() => () => stageObserverRef.current?.disconnect(), []);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** Client → logical slide coordinates. */
  const toSlide = useCallback((clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    const k = scaleRef.current;
    return { x: (clientX - r.left) / k, y: (clientY - r.top) / k };
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const transact = useCallback(
    (fn: () => void) => room.slate.doc.transact(fn),
    [room],
  );

  const patchElement = useCallback(
    (id: string, patch: Partial<SlideElement>) => {
      const m = elementsMap.get(id);
      if (!m) return;
      transact(() => {
        for (const [k, v] of Object.entries(patch)) m.set(k, v as unknown);
      });
    },
    [elementsMap, transact],
  );

  const addElement = useCallback(
    (partial: Omit<SlideElement, 'id' | 'z' | 'createdAt' | 'authorId'>): string => {
      const id = makeId('sel');
      transact(() => {
        elementsMap.set(
          id,
          toYMap({
            ...partial,
            z: topZ(readElements(elementsMap), partial.slideId) + 1,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          }),
        );
      });
      return id;
    },
    [elementsMap, transact, room],
  );

  const deleteElements = useCallback(
    (ids: Iterable<string>) => {
      transact(() => {
        for (const id of ids) elementsMap.delete(id);
      });
      setSelection(new Set());
    },
    [elementsMap, transact],
  );

  // ── Slide operations ───────────────────────────────────────────────────────
  const addSlide = useCallback(
    (afterId?: string) => {
      const list = readSlides(slidesMap);
      const at = afterId ? list.findIndex((s) => s.id === afterId) : list.length - 1;
      const before = list[at]?.order;
      const after = list[at + 1]?.order;
      const id = makeId('slide');
      transact(() => {
        slidesMap.set(
          id,
          toYMap({
            order: orderBetween(before, after),
            background: list[at]?.background ?? DEFAULT_BG,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          }),
        );
      });
      setActiveSlideId(id);
    },
    [slidesMap, transact, room, setActiveSlideId],
  );

  const duplicateSlide = useCallback(
    (id: string) => {
      const list = readSlides(slidesMap);
      const at = list.findIndex((s) => s.id === id);
      const src = list[at];
      if (!src) return;
      const newId = makeId('slide');
      transact(() => {
        slidesMap.set(
          newId,
          toYMap({
            order: orderBetween(src.order, list[at + 1]?.order),
            background: src.background,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          }),
        );
        for (const el of readElements(elementsMap)) {
          if (el.slideId !== id) continue;
          const { id: _oldId, ...rest } = el;
          elementsMap.set(
            makeId('sel'),
            toYMap({ ...rest, slideId: newId, createdAt: Date.now() }),
          );
        }
      });
      setActiveSlideId(newId);
    },
    [slidesMap, elementsMap, transact, room, setActiveSlideId],
  );

  const deleteSlide = useCallback(
    (id: string) => {
      const list = readSlides(slidesMap);
      const at = list.findIndex((s) => s.id === id);
      transact(() => {
        slidesMap.delete(id);
        for (const el of readElements(elementsMap)) {
          if (el.slideId === id) elementsMap.delete(el.id);
        }
      });
      const next = list[at + 1] ?? list[at - 1];
      setActiveSlideId(next?.id ?? null);
      // The bootstrap effect recreates slide 1 if the deck is now empty.
    },
    [slidesMap, elementsMap, transact, setActiveSlideId],
  );

  const moveSlide = useCallback(
    (id: string, dir: -1 | 1) => {
      const list = readSlides(slidesMap);
      const at = list.findIndex((s) => s.id === id);
      const other = list[at + dir];
      if (at < 0 || !other) return;
      // Swap order values — two single-key writes.
      transact(() => {
        slidesMap.get(id)?.set('order', other.order);
        slidesMap.get(other.id)?.set('order', list[at]!.order);
      });
    },
    [slidesMap, transact],
  );

  /** Drop `id` into gap `to` (0 = before slide 0, list.length = at the end).
   *  One fractional-order write, so two peers reordering different slides
   *  never fight over a renumbering pass. */
  const reorderSlide = useCallback(
    (id: string, to: number) => {
      const list = readSlides(slidesMap);
      const from = list.findIndex((s) => s.id === id);
      if (from < 0 || to === from || to === from + 1) return;
      const rest = list.filter((s) => s.id !== id);
      const at = to > from ? to - 1 : to;
      transact(() => {
        slidesMap.get(id)?.set('order', orderBetween(rest[at - 1]?.order, rest[at]?.order));
      });
    },
    [slidesMap, transact],
  );

  const setNotes = useCallback(
    (id: string, notes: string) => {
      transact(() => slidesMap.get(id)?.set('notes', notes));
    },
    [slidesMap, transact],
  );

  // ── Insertions ─────────────────────────────────────────────────────────────
  const insertText = useCallback(
    (at?: { x: number; y: number }) => {
      if (!activeSlide) return;
      const w = 520;
      const h = 90;
      const id = addElement({
        slideId: activeSlide.id,
        kind: 'text',
        x: at ? at.x : (SLIDE_W - w) / 2,
        y: at ? at.y : (SLIDE_H - h) / 2,
        w,
        h,
        rotation: 0,
        text: '',
        fontSize: 40,
        color: defaultTextColor(activeSlide.background),
        align: 'left',
      });
      setSelection(new Set([id]));
      // Open the editor after the click settles (see the diagram editor's
      // pointerdown-blur gotcha).
      requestAnimationFrame(() => setTextEdit({ elementId: id, value: '', fresh: true }));
    },
    [activeSlide, addElement],
  );

  const insertShape = useCallback(
    (kind: SlideElementKind) => {
      if (!activeSlide) return;
      // Lines and arrows are drawn across the middle of their box, so they get
      // a wide, short one; closed shapes get a chunkier default.
      const linear = kind === 'line' || kind === 'arrow';
      const w = linear ? 420 : kind === 'ellipse' ? 260 : 300;
      const h = linear ? 48 : kind === 'ellipse' ? 260 : 200;
      const id = addElement({
        slideId: activeSlide.id,
        kind,
        x: (SLIDE_W - w) / 2,
        y: (SLIDE_H - h) / 2,
        w,
        h,
        rotation: 0,
        // A line has no interior — a fill would paint a rectangle behind the
        // stroke, so it stays explicitly empty.
        fill: linear ? null : '#7c6aff33',
        stroke: '#7c6aff',
        strokeWidth: linear ? 3 : 2,
      });
      setSelection(new Set([id]));
    },
    [activeSlide, addElement],
  );

  const insertImages = useCallback(
    async (files: File[] | Blob[], at?: { x: number; y: number }) => {
      const slide = activeSlide;
      if (!slide) return;
      let offset = 0;
      const newIds: string[] = [];
      for (const file of files) {
        try {
          const img = await fileToImageShape(file);
          const hosted = await uploadDataUrl(img.src, 'slide-images');
          // Fit within a sensible chunk of the slide, keeping aspect.
          const k = Math.min(1, 640 / img.w, 480 / img.h);
          const w = img.w * k;
          const h = img.h * k;
          const id = addElement({
            slideId: slide.id,
            kind: 'image',
            x: (at ? at.x - w / 2 : (SLIDE_W - w) / 2) + offset,
            y: (at ? at.y - h / 2 : (SLIDE_H - h) / 2) + offset,
            w,
            h,
            rotation: 0,
            src: hosted ?? img.src,
          });
          newIds.push(id);
          offset += PASTE_OFFSET;
        } catch (err) {
          toast({ title: 'Image import failed', description: (err as Error).message, variant: 'error' });
        }
      }
      if (newIds.length) setSelection(new Set(newIds));
    },
    [activeSlide, addElement],
  );

  // ── Arrange ────────────────────────────────────────────────────────────────
  /** Selected elements read fresh from the doc — these run from callbacks that
   *  outlive a render, so they read selectionRef rather than closing over it. */
  const readSelectedElements = useCallback(
    (): SlideElement[] =>
      readElements(elementsMap).filter((el) => selectionRef.current.has(el.id)),
    [elementsMap],
  );

  /** Align every selected element to the edge (or centre line) of the bounding
   *  box they share — the standard behaviour in every slide editor. */
  const alignSelection = useCallback(
    (edge: AlignEdge) => {
      const els = readSelectedElements();
      if (els.length < 2) return;
      const minX = Math.min(...els.map((e) => e.x));
      const maxX = Math.max(...els.map((e) => e.x + e.w));
      const minY = Math.min(...els.map((e) => e.y));
      const maxY = Math.max(...els.map((e) => e.y + e.h));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      room.slate.doc.transact(() => {
        for (const el of els) {
          const m = elementsMap.get(el.id);
          if (!m) continue;
          switch (edge) {
            case 'left': m.set('x', minX); break;
            case 'hcenter': m.set('x', cx - el.w / 2); break;
            case 'right': m.set('x', maxX - el.w); break;
            case 'top': m.set('y', minY); break;
            case 'vmiddle': m.set('y', cy - el.h / 2); break;
            case 'bottom': m.set('y', maxY - el.h); break;
          }
        }
      });
    },
    [elementsMap, room, readSelectedElements],
  );

  /** Even out the gaps between the selection's centres, holding the two
   *  outermost elements still. Needs three to have a middle to move. */
  const distributeSelection = useCallback(
    (axis: 'h' | 'v') => {
      const els = readSelectedElements();
      if (els.length < 3) return;
      const pos = axis === 'h' ? 'x' : 'y';
      const size = axis === 'h' ? 'w' : 'h';
      const centre = (e: SlideElement): number => e[pos] + e[size] / 2;
      const sorted = [...els].sort((a, b) => centre(a) - centre(b));
      const start = centre(sorted[0]!);
      const gap = (centre(sorted[sorted.length - 1]!) - start) / (sorted.length - 1);
      room.slate.doc.transact(() => {
        sorted.forEach((el, i) => {
          if (i === 0 || i === sorted.length - 1) return;
          elementsMap.get(el.id)?.set(pos, start + gap * i - el[size] / 2);
        });
      });
    },
    [elementsMap, room, readSelectedElements],
  );

  const imagePickerRef = useRef<HTMLInputElement | null>(null);

  // Paste images from the OS clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      if (!files.length) return;
      e.preventDefault();
      void insertImages(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [insertImages]);

  // ── Text editing ───────────────────────────────────────────────────────────
  const commitTextEdit = useCallback(() => {
    const te = textEditRef.current;
    if (!te) return;
    setTextEdit(null);
    const value = te.value.replace(/\s+$/, '');
    if (!value && te.fresh) {
      transact(() => elementsMap.delete(te.elementId));
      return;
    }
    patchElement(te.elementId, { text: value });
  }, [elementsMap, patchElement, transact]);

  // ── Pointer interactions (move / resize) ───────────────────────────────────
  const beginMove = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.stopPropagation();
      if (textEditRef.current) commitTextEdit();
      const sel = selectionRef.current;
      let next: Set<string>;
      if (e.shiftKey) {
        next = new Set(sel);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next = sel.has(id) ? sel : new Set([id]);
      }
      setSelection(next);
      if (!next.has(id)) return;
      const origin = new Map<string, { x: number; y: number }>();
      const picked: SlideElement[] = [];
      for (const el of activeElements) {
        if (next.has(el.id)) {
          origin.set(el.id, { x: el.x, y: el.y });
          picked.push(el);
        }
      }
      // Union box of the dragged set, so a multi-selection snaps as one shape.
      const box = {
        x: Math.min(...picked.map((p) => p.x)),
        y: Math.min(...picked.map((p) => p.y)),
        w: 0,
        h: 0,
      };
      box.w = Math.max(...picked.map((p) => p.x + p.w)) - box.x;
      box.h = Math.max(...picked.map((p) => p.y + p.h)) - box.y;
      dragRef.current = {
        kind: 'move',
        start: { x: e.clientX, y: e.clientY },
        origin,
        box,
        snap: snapTargets(activeElements, next),
        moved: false,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [activeElements, commitTextEdit],
  );

  const beginRotate = useCallback((e: React.PointerEvent, el: SlideElement) => {
    e.stopPropagation();
    const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    const p = toSlide(e.clientX, e.clientY);
    dragRef.current = {
      kind: 'rotate',
      id: el.id,
      center: c,
      start: el.rotation ?? 0,
      // Angle of the initial grab, so the element doesn't jump to the cursor.
      grab: Math.atan2(p.y - c.y, p.x - c.x),
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [toSlide]);

  const beginResize = useCallback(
    (e: React.PointerEvent, el: SlideElement, handle: Handle) => {
      e.stopPropagation();
      dragRef.current = {
        kind: 'resize',
        id: el.id,
        handle,
        start: el,
        // Images keep their aspect from corner handles (Shift toggles the
        // constraint for everything else).
        aspect: el.kind === 'image' ? !e.altKey : e.shiftKey,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const k = scaleRef.current;
      if (drag.kind === 'move') {
        let dx = (e.clientX - drag.start.x) / k;
        let dy = (e.clientY - drag.start.y) / k;
        if (!drag.moved && Math.hypot(dx, dy) * k < 3) return;
        drag.moved = true;
        // Snap the union box's edges/centers onto nearby alignment lines.
        // Alt suspends it for pixel-exact placement.
        let gx: number | null = null;
        let gy: number | null = null;
        if (!e.altKey) {
          const tol = SNAP_PX / k;
          const sx = snapAxis(drag.box.x, drag.box.w, dx, drag.snap.xs, tol);
          const sy = snapAxis(drag.box.y, drag.box.h, dy, drag.snap.ys, tol);
          dx = sx.offset;
          dy = sy.offset;
          gx = sx.guide;
          gy = sy.guide;
        }
        const next: Guide[] = [];
        if (gx !== null) next.push({ axis: 'x', at: gx });
        if (gy !== null) next.push({ axis: 'y', at: gy });
        setGuides((cur) =>
          cur.length === next.length && cur.every((g, i) => g.axis === next[i]!.axis && g.at === next[i]!.at)
            ? cur
            : next,
        );
        room.slate.doc.transact(() => {
          for (const [id, o] of drag.origin) {
            const m = elementsMap.get(id);
            if (!m) continue;
            m.set('x', Math.round(o.x + dx));
            m.set('y', Math.round(o.y + dy));
          }
        });
        return;
      }

      if (drag.kind === 'rotate') {
        const p = toSlide(e.clientX, e.clientY);
        const a = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
        let next = drag.start + (a - drag.grab);
        if (e.shiftKey) next = Math.round(next / ROT_SNAP) * ROT_SNAP;
        room.slate.doc.transact(() => elementsMap.get(drag.id)?.set('rotation', next));
        return;
      }

      // ── Resize ───────────────────────────────────────────────────────────
      // Done in the element's OWN frame so a rotated box resizes along its own
      // axes with the opposite corner pinned, instead of shearing away from
      // the cursor.
      const { start, handle } = drag;
      const rot = start.rotation ?? 0;
      const p = toSlide(e.clientX, e.clientY);
      const dirX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
      const dirY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
      const cx = start.x + start.w / 2;
      const cy = start.y + start.h / 2;
      // The fixed point: the corner/edge opposite the handle, in world space.
      const anchorLocal = { x: (-dirX * start.w) / 2, y: (-dirY * start.h) / 2 };
      const anchorRot = rotate(anchorLocal.x, anchorLocal.y, rot);
      const anchor = { x: cx + anchorRot.x, y: cy + anchorRot.y };
      // Pointer relative to the anchor, in the element's unrotated frame.
      const v = rotate(p.x - anchor.x, p.y - anchor.y, -rot);
      let w = dirX === 0 ? start.w : Math.max(MIN_SIZE, dirX * v.x);
      let h = dirY === 0 ? start.h : Math.max(MIN_SIZE, dirY * v.y);
      if (drag.aspect && dirX !== 0 && dirY !== 0 && start.w > 0 && start.h > 0) {
        const ratio = start.w / start.h;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
      }
      const offset = rotate((dirX * w) / 2, (dirY * h) / 2, rot);
      const x = anchor.x + offset.x - w / 2;
      const y = anchor.y + offset.y - h / 2;
      room.slate.doc.transact(() => {
        const m = elementsMap.get(drag.id);
        if (!m) return;
        m.set('x', Math.round(x));
        m.set('y', Math.round(y));
        m.set('w', Math.round(w));
        m.set('h', Math.round(h));
      });
    };
    const onUp = () => {
      dragRef.current = null;
      setGuides((cur) => (cur.length ? [] : cur));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [elementsMap, room, toSlide]);

  // ── Clipboard ──────────────────────────────────────────────────────────────
  const copySelection = useCallback((): boolean => {
    const sel = selectionRef.current;
    const copied = activeElements.filter((el) => sel.has(el.id));
    if (!copied.length) return false;
    clipboardRef.current = copied.map((el) => ({ ...el }));
    return true;
  }, [activeElements]);

  const pasteClipboard = useCallback(() => {
    const slide = activeSlide;
    const clip = clipboardRef.current;
    if (!slide || !clip.length) return;
    const newIds: string[] = [];
    transact(() => {
      let z = topZ(readElements(elementsMap), slide.id);
      for (const el of clip) {
        const id = makeId('sel');
        const { id: _o, ...rest } = el;
        elementsMap.set(
          id,
          toYMap({
            ...rest,
            slideId: slide.id,
            x: el.x + PASTE_OFFSET,
            y: el.y + PASTE_OFFSET,
            z: ++z,
            createdAt: Date.now(),
            authorId: room.identity.peerId,
          }),
        );
        newIds.push(id);
      }
    });
    setSelection(new Set(newIds));
  }, [activeSlide, elementsMap, transact, room]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (presenting !== null) return; // present overlay handles its own keys
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) room.undo.redo();
        else room.undo.undo();
        return;
      }
      if (k === 'f5') {
        // F5 picks up where you are; Shift+F5 runs the deck from the top —
        // the same split PowerPoint and Keynote use.
        e.preventDefault();
        setPresenting(
          e.shiftKey ? 0 : Math.max(0, slides.findIndex((s) => s.id === activeSlide?.id)),
        );
        return;
      }
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        const at = slides.findIndex((s) => s.id === activeSlide?.id);
        const next = slides[at + (e.key === 'PageDown' ? 1 : -1)];
        if (next) setActiveSlideId(next.id);
        return;
      }
      const sel = selectionRef.current;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
        e.preventDefault();
        deleteElements(sel);
        return;
      }
      if (e.key.startsWith('Arrow') && sel.size) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        room.slate.doc.transact(() => {
          for (const id of sel) {
            const m = elementsMap.get(id);
            if (!m) continue;
            m.set('x', ((m.get('x') as number) ?? 0) + dx);
            m.set('y', ((m.get('y') as number) ?? 0) + dy);
          }
        });
        return;
      }
      if ((e.key === ']' || e.key === '[') && sel.size && !ctrl) {
        e.preventDefault();
        const front = e.key === ']';
        const all = readElements(elementsMap).filter((el) => el.slideId === activeSlide?.id);
        const extreme = front
          ? Math.max(0, ...all.map((el) => el.z))
          : Math.min(0, ...all.map((el) => el.z));
        room.slate.doc.transact(() => {
          let off = 1;
          for (const id of sel) {
            elementsMap.get(id)?.set('z', front ? extreme + off++ : extreme - off++);
          }
        });
        return;
      }
      if (ctrl && k === 'c') {
        if (copySelection()) e.preventDefault();
        return;
      }
      if (ctrl && k === 'x') {
        if (copySelection()) {
          e.preventDefault();
          deleteElements(selectionRef.current);
        }
        return;
      }
      if (ctrl && k === 'v') {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (ctrl && k === 'd') {
        e.preventDefault();
        if (copySelection()) pasteClipboard();
        return;
      }
      if (ctrl && k === 'a') {
        e.preventDefault();
        setSelection(
          new Set(
            readElements(elementsMap)
              .filter((el) => el.slideId === activeSlide?.id)
              .map((el) => el.id),
          ),
        );
        return;
      }
      if (e.key === 'Escape') {
        setSelection(new Set());
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    slides,
    activeSlide?.id,
    presenting,
    room,
    setActiveSlideId,
    elementsMap,
    deleteElements,
    copySelection,
    pasteClipboard,
  ]);

  // ── Derived bits for render ────────────────────────────────────────────────
  const selectedElements = activeElements.filter((el) => selection.has(el.id));
  const selectedText = selectedElements.find((el) => el.kind === 'text');
  /** First closed shape in the selection — lines have no interior to fill. */
  const selectedShape = selectedElements.find(
    (el) => el.kind === 'rect' || el.kind === 'ellipse',
  );
  const editingEl = textEdit
    ? activeElements.find((el) => el.id === textEdit.elementId) ?? null
    : null;
  const slideIndex = Math.max(0, slides.findIndex((s) => s.id === activeSlide?.id));

  /** Switch every selected closed shape between solid / tinted / no fill,
   *  keeping the hue of its outline so it still matches the chosen swatch. */
  const setFillStyle = useCallback(
    (style: FillStyle) => {
      room.slate.doc.transact(() => {
        for (const el of selectedElements) {
          if (el.kind !== 'rect' && el.kind !== 'ellipse') continue;
          const m = elementsMap.get(el.id);
          if (!m) continue;
          const base = (el.stroke ?? el.fill ?? '#7c6aff').slice(0, 7);
          m.set('fill', style === 'none' ? null : style === 'tint' ? `${base}33` : base);
        }
      });
    },
    [elementsMap, room, selectedElements],
  );

  const applyToSelection = useCallback(
    (patch: Partial<SlideElement>, textPatch: Partial<SlideElement>) => {
      room.slate.doc.transact(() => {
        for (const el of selectedElements) {
          const m = elementsMap.get(el.id);
          if (!m) continue;
          const p = el.kind === 'text' ? textPatch : patch;
          for (const [key, v] of Object.entries(p)) m.set(key, v as unknown);
        }
      });
    },
    [selectedElements, elementsMap, room],
  );

  if (!activeSlide) {
    return (
      <div className="grid h-full place-items-center text-sm text-text-dim">
        Setting up your first slide…
      </div>
    );
  }

  return (
    <div className={cn('flex h-full w-full overflow-hidden bg-bg', isMobile && 'flex-col')}>
      {/* ── Slide rail (filmstrip on phones) ───────────────────────────────── */}
      <div
        className={cn(
          'flex flex-none bg-bg-2/60',
          isMobile
            ? 'w-full items-center gap-2 border-b border-border px-2 py-1.5'
            : 'w-48 flex-col border-r border-border',
        )}
      >
        {/* "New slide" sits at the TOP: the floating People widget anchors to
            the bottom-left of the workspace and would swallow clicks on a
            bottom-docked button. The rail also gets generous bottom padding so
            the last thumbnail can always be scrolled clear of that widget. */}
        <button
          title="New slide"
          className={cn(
            'flex items-center justify-center gap-1 rounded-md border border-border text-xs text-text-dim transition-colors hover:border-accent hover:text-text',
            isMobile ? 'h-[59px] w-9 flex-none' : 'm-2 py-1.5',
          )}
          onClick={() => addSlide(activeSlide.id)}
        >
          <Plus size={14} />
          {!isMobile && 'New slide'}
        </button>
        {/* Thumbnails. Drag one to reorder; the drop gap is shown as an accent
            rule so the target is never ambiguous. */}
        <div
          className={cn(
            'flex-1',
            isMobile
              ? 'flex min-w-0 gap-2 overflow-x-auto'
              : 'space-y-2 overflow-y-auto px-2 pb-28',
          )}
          onDragOver={(e) => {
            if (railDrag) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!railDrag) return;
            e.preventDefault();
            if (railDrag.over !== null) reorderSlide(railDrag.id, railDrag.over);
            setRailDrag(null);
          }}
        >
          {slides.map((s, i) => (
            <div
              key={s.id}
              data-slide-thumb={s.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload.
                e.dataTransfer.setData('text/plain', s.id);
                setRailDrag({ id: s.id, over: null });
              }}
              onDragEnd={() => setRailDrag(null)}
              onDragOver={(e) => {
                if (!railDrag) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const over = isMobile
                  ? e.clientX < r.left + r.width / 2
                    ? i
                    : i + 1
                  : e.clientY < r.top + r.height / 2
                    ? i
                    : i + 1;
                setRailDrag((d) => (d && d.over !== over ? { ...d, over } : d));
              }}
              className={cn(
                'group flex cursor-pointer items-start gap-1',
                isMobile && 'flex-none',
                railDrag?.id === s.id && 'opacity-40',
                railDrag && railDrag.over === i && (isMobile ? 'border-l-2 border-l-accent' : 'border-t-2 border-t-accent'),
                railDrag && railDrag.over === i + 1 && (isMobile ? 'border-r-2 border-r-accent' : 'border-b-2 border-b-accent'),
              )}
              onClick={() => setActiveSlideId(s.id)}
            >
              {/* Number in a gutter, not stamped on the slide: every layout
                  puts its title in exactly the top-left corner a badge would
                  cover. */}
              <span
                className={cn(
                  'w-3.5 pt-1 text-right font-mono text-[10px] leading-none',
                  s.id === activeSlide.id ? 'text-accent' : 'text-text-dim',
                )}
              >
                {i + 1}
              </span>
              <div
                className={cn(
                  'relative flex-1 rounded-md border p-1 transition-colors',
                  s.id === activeSlide.id
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-text-dim/40',
                )}
              >
              <SlideView
                background={s.background}
                elements={elementsBySlide.get(s.id) ?? []}
                scale={thumbW / SLIDE_W}
                className="rounded-sm"
              />
              {/* A slide with notes says so — otherwise it's invisible work. */}
              {s.notes?.trim() && (
                <span
                  title="Has speaker notes"
                  className="absolute bottom-1.5 left-1.5 rounded bg-bg/80 p-0.5 text-text-dim"
                >
                  <StickyNote size={10} />
                </span>
              )}
              <span className="absolute bottom-1.5 right-1.5 hidden text-text-dim group-hover:block">
                <GripVertical size={12} />
              </span>
              <div
                className="absolute right-1 top-1 hidden flex-col gap-0.5 group-hover:flex"
                onClick={(e) => e.stopPropagation()}
              >
                <RailButton title="Move up" disabled={i === 0} onClick={() => moveSlide(s.id, -1)}>
                  <ChevronUp size={12} />
                </RailButton>
                <RailButton
                  title="Move down"
                  disabled={i === slides.length - 1}
                  onClick={() => moveSlide(s.id, 1)}
                >
                  <ChevronDown size={12} />
                </RailButton>
                <RailButton title="Duplicate slide" onClick={() => duplicateSlide(s.id)}>
                  <Copy size={12} />
                </RailButton>
                <RailButton
                  title="Delete slide"
                  disabled={slides.length === 1}
                  onClick={() => deleteSlide(s.id)}
                >
                  <Trash2 size={12} />
                </RailButton>
              </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Stage column: the stage itself plus the speaker-notes strip ───── */}
      <div className="flex min-w-0 flex-1 flex-col">
      <div
        ref={attachStageWrap}
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        onDragOver={(e) => {
          if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...(e.dataTransfer?.files ?? [])].filter(isImageFile);
          if (!files.length) return;
          e.preventDefault();
          const at = stageRef.current ? toSlide(e.clientX, e.clientY) : undefined;
          void insertImages(files, at);
        }}
      >
        <div
          ref={stageRef}
          className="relative shadow-2xl ring-1 ring-border"
          style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}
          onPointerDown={() => {
            if (textEditRef.current) commitTextEdit();
            else setSelection(new Set());
          }}
          onDoubleClick={(e) => {
            if (textEdit) return;
            insertText(toSlide(e.clientX, e.clientY));
          }}
        >
          <SlideView background={activeSlide.background} elements={activeElements} scale={scale} />

          {/* Interaction layer: hit boxes + selection outlines + handles. */}
          {activeElements.map((el) => {
            const isSel = selection.has(el.id);
            return (
              <div
                key={el.id}
                data-slide-el={el.id}
                className={cn(
                  'absolute',
                  isSel ? 'cursor-move outline outline-2 outline-accent' : 'hover:outline hover:outline-1 hover:outline-accent/50',
                )}
                style={{
                  left: el.x * scale,
                  top: el.y * scale,
                  width: el.w * scale,
                  height: el.h * scale,
                  transform: el.rotation ? `rotate(${el.rotation}rad)` : undefined,
                }}
                onPointerDown={(e) => beginMove(e, el.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (el.kind === 'text') {
                    setSelection(new Set([el.id]));
                    setTextEdit({ elementId: el.id, value: el.text ?? '', fresh: false });
                  }
                }}
              >
                {isSel && selection.size === 1 && (
                  <>
                    {HANDLES.map((h) => (
                      <div
                        key={h}
                        data-handle={h}
                        className="absolute z-10 h-2.5 w-2.5 rounded-[2px] border border-accent bg-bg"
                        style={{ ...handlePos(h), cursor: handleCursor(h) }}
                        onPointerDown={(e) => beginResize(e, el, h)}
                      />
                    ))}
                    {/* Rotation handle. `rotation` was in the model and drawn
                        by the stage, the thumbnails and both exporters, but
                        nothing could ever set it. */}
                    <div
                      data-handle="rotate"
                      title="Drag to rotate (Shift snaps to 15°)"
                      className="absolute left-[calc(50%-6px)] top-[-22px] z-10 h-3 w-3 rounded-full border border-accent bg-bg"
                      style={{ cursor: 'grab' }}
                      onPointerDown={(e) => beginRotate(e, el)}
                    />
                    <div className="pointer-events-none absolute left-1/2 top-[-19px] h-[19px] w-px bg-accent" />
                  </>
                )}
              </div>
            );
          })}

          {/* Alignment guides. Purely visual — pointer-events-none so they
              never intercept the drag that produced them. */}
          {guides.map((g) => (
            <div
              key={`${g.axis}-${g.at}`}
              className="pointer-events-none absolute z-10"
              style={{
                background: 'var(--accent)',
                boxShadow: '0 0 0 0.5px var(--accent)',
                ...(g.axis === 'x'
                  ? { left: g.at * scale, top: 0, width: 1, height: SLIDE_H * scale }
                  : { top: g.at * scale, left: 0, height: 1, width: SLIDE_W * scale }),
              }}
            />
          ))}

          {/* Inline text editor. */}
          {textEdit && editingEl && (
            <textarea
              autoFocus
              data-slide-text
              value={textEdit.value}
              onChange={(e) => setTextEdit((s) => (s ? { ...s, value: e.target.value } : s))}
              onFocus={(e) => {
                if (!textEdit.fresh) e.target.select();
              }}
              onBlur={commitTextEdit}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitTextEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTextEdit(null);
                  if (textEdit.fresh) transact(() => elementsMap.delete(textEdit.elementId));
                }
              }}
              placeholder="Type…"
              spellCheck={false}
              className="absolute z-20 resize-none overflow-hidden rounded-sm bg-bg/85 outline outline-2 outline-accent backdrop-blur-[2px] placeholder:text-text-dim"
              style={{
                left: editingEl.x * scale,
                top: editingEl.y * scale,
                width: editingEl.w * scale,
                minHeight: editingEl.h * scale,
                padding: 8 * scale,
                color: editingEl.color ?? '#e0dff5',
                fontSize: (editingEl.fontSize ?? 32) * scale,
                fontWeight: editingEl.bold ? 700 : 400,
                textAlign: editingEl.align ?? 'left',
                lineHeight: 1.25,
                fontFamily: 'Inter, sans-serif',
              }}
            />
          )}
        </div>

        {/* ── Floating toolbar ─────────────────────────────────────────────── */}
        <div
          data-no-canvas
          className="absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-border bg-bg-2/95 px-2 py-1 shadow-lg backdrop-blur [&>*]:flex-none"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ToolButton title="Text box (double-click canvas)" onClick={() => insertText()}>
            <Type size={16} />
          </ToolButton>
          <ToolButton title="Insert image" onClick={() => imagePickerRef.current?.click()}>
            <ImagePlus size={16} />
          </ToolButton>
          <ToolButton title="Rectangle" onClick={() => insertShape('rect')}>
            <Square size={16} />
          </ToolButton>
          <ToolButton title="Ellipse" onClick={() => insertShape('ellipse')}>
            <Circle size={16} />
          </ToolButton>
          <ToolButton title="Line" onClick={() => insertShape('line')}>
            <Minus size={16} />
          </ToolButton>
          <ToolButton title="Arrow" onClick={() => insertShape('arrow')}>
            <ArrowRight size={16} />
          </ToolButton>
          <div className="mx-1 h-5 w-px bg-border" />
          {selection.size > 0 ? (
            <>
              {EL_SWATCHES.map((c) => (
                <button
                  key={c}
                  title={`Color ${c}`}
                  className="h-4 w-4 rounded-full border border-border transition-transform hover:scale-110"
                  style={{ background: c }}
                  onClick={() =>
                    applyToSelection(
                      { fill: `${c}33`, stroke: c },
                      { color: c },
                    )
                  }
                />
              ))}
              {selectedText && (
                <>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <ToolButton
                    title="Smaller text"
                    onClick={() =>
                      applyToSelection({}, { fontSize: Math.max(8, (selectedText.fontSize ?? 32) - 4) })
                    }
                  >
                    <span className="text-[11px] font-semibold">A−</span>
                  </ToolButton>
                  <ToolButton
                    title="Bigger text"
                    onClick={() =>
                      applyToSelection({}, { fontSize: Math.min(200, (selectedText.fontSize ?? 32) + 4) })
                    }
                  >
                    <span className="text-[13px] font-semibold">A+</span>
                  </ToolButton>
                  <ToolButton
                    title="Bold"
                    active={!!selectedText.bold}
                    onClick={() => applyToSelection({}, { bold: !selectedText.bold })}
                  >
                    <Bold size={14} />
                  </ToolButton>
                  <ToolButton title="Align left" active={(selectedText.align ?? 'left') === 'left'} onClick={() => applyToSelection({}, { align: 'left' })}>
                    <AlignLeft size={14} />
                  </ToolButton>
                  <ToolButton title="Align center" active={selectedText.align === 'center'} onClick={() => applyToSelection({}, { align: 'center' })}>
                    <AlignCenter size={14} />
                  </ToolButton>
                  <ToolButton title="Align right" active={selectedText.align === 'right'} onClick={() => applyToSelection({}, { align: 'right' })}>
                    <AlignRight size={14} />
                  </ToolButton>
                </>
              )}
              {selectedShape && (
                <>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <ToolButton
                    title="Solid fill"
                    active={fillStyleOf(selectedShape) === 'solid'}
                    onClick={() => setFillStyle('solid')}
                  >
                    <span className="h-3.5 w-3.5 rounded-[3px] bg-current" />
                  </ToolButton>
                  <ToolButton
                    title="Tinted fill"
                    active={fillStyleOf(selectedShape) === 'tint'}
                    onClick={() => setFillStyle('tint')}
                  >
                    <span className="h-3.5 w-3.5 rounded-[3px] border border-current bg-current opacity-40" />
                  </ToolButton>
                  <ToolButton
                    title="No fill (outline only)"
                    active={fillStyleOf(selectedShape) === 'none'}
                    onClick={() => setFillStyle('none')}
                  >
                    <span className="h-3.5 w-3.5 rounded-[3px] border border-current" />
                  </ToolButton>
                </>
              )}
              {selection.size >= 2 && (
                <>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        title="Align & distribute"
                        aria-label="Align and distribute"
                        className="grid h-7 w-7 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
                      >
                        <LayoutGrid size={16} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center">
                      <DropdownMenuItem onSelect={() => alignSelection('left')}>
                        <AlignStartVertical size={14} /> Align left
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => alignSelection('hcenter')}>
                        <AlignCenterVertical size={14} /> Align centre
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => alignSelection('right')}>
                        <AlignEndVertical size={14} /> Align right
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => alignSelection('top')}>
                        <AlignStartHorizontal size={14} /> Align top
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => alignSelection('vmiddle')}>
                        <AlignCenterHorizontal size={14} /> Align middle
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => alignSelection('bottom')}>
                        <AlignEndHorizontal size={14} /> Align bottom
                      </DropdownMenuItem>
                      {selection.size >= 3 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => distributeSelection('h')}>
                            <AlignHorizontalJustifyCenter size={14} /> Space evenly across
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => distributeSelection('v')}>
                            <AlignVerticalJustifyCenter size={14} /> Space evenly down
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              <div className="mx-1 h-5 w-px bg-border" />
              <ToolButton title="Delete selection (Del)" onClick={() => deleteElements(selection)}>
                <Trash2 size={16} />
              </ToolButton>
            </>
          ) : (
            <>
              <span className="px-1 text-[10px] uppercase tracking-wide text-text-dim">Background</span>
              {BG_SWATCHES.map((c) => (
                <button
                  key={c}
                  title={`Background ${c}`}
                  className={cn(
                    'h-4 w-4 rounded-full border transition-transform hover:scale-110',
                    activeSlide.background === c ? 'border-accent' : 'border-border',
                  )}
                  style={{ background: c }}
                  onClick={() =>
                    setSlideBackground(room.slate.doc, slidesMap, elementsMap, activeSlide.id, c)
                  }
                />
              ))}
            </>
          )}
          <div className="mx-1 h-5 w-px bg-border" />
          <ToolButton title="Undo (Ctrl+Z)" onClick={() => room.undo.undo()}>
            <Undo2 size={16} />
          </ToolButton>
          <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={() => room.undo.redo()}>
            <Redo2 size={16} />
          </ToolButton>
        </div>

        {/* Present button + slide counter. The split button matches PowerPoint:
            the big half runs from here, the caret offers "from the start". */}
        <div className="absolute right-3 top-3 z-30 flex items-center gap-2">
          <span className="text-xs font-mono text-text-dim">
            {slideIndex + 1} / {slides.length}
          </span>
          <div className="flex overflow-hidden rounded-md shadow">
            <button
              title="Present from this slide (F5)"
              className="flex items-center gap-1.5 bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-2"
              onClick={() => setPresenting(slideIndex)}
            >
              <Play size={13} /> Present
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Presentation options"
                  aria-label="Presentation options"
                  className="grid w-6 place-items-center border-l border-white/25 bg-accent text-white transition-colors hover:bg-accent-2"
                >
                  <CaretDown size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem shortcut="F5" onSelect={() => setPresenting(slideIndex)}>
                  From this slide
                </DropdownMenuItem>
                <DropdownMenuItem shortcut="⇧F5" onSelect={() => setPresenting(0)}>
                  From the beginning
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNotesOpen((v) => !v)}>
                  {notesOpen ? 'Hide speaker notes' : 'Show speaker notes'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Slide actions also live on the rail's hover controls, which
                    touch devices never get — this is their only route there. */}
                <DropdownMenuItem onSelect={() => addSlide(activeSlide.id)}>
                  New slide
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicateSlide(activeSlide.id)}>
                  Duplicate slide
                </DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  disabled={slides.length === 1}
                  onSelect={() => deleteSlide(activeSlide.id)}
                >
                  Delete slide
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <input
          ref={imagePickerRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void insertImages(files);
          }}
        />
      </div>

      {/* ── Speaker notes ──────────────────────────────────────────────────── */}
      {/* Notes are the half of a deck the audience never sees, and until now
          there was nowhere to write them even though present mode and the HTML
          export both read them. Collapsed by default so the stage keeps the
          room it had. */}
      <div className="flex-none border-t border-border bg-bg-2/40">
        <button
          className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-text-dim transition-colors hover:text-text"
          onClick={() => setNotesOpen((v) => !v)}
        >
          <StickyNote size={12} />
          Speaker notes
          {!notesOpen && activeSlide.notes?.trim() && (
            <span className="truncate text-text-dim/70">— {activeSlide.notes.trim()}</span>
          )}
          <CaretDown
            size={12}
            className={cn('ml-auto flex-none transition-transform', notesOpen && 'rotate-180')}
          />
        </button>
        {notesOpen && (
          <textarea
            key={activeSlide.id}
            defaultValue={activeSlide.notes ?? ''}
            // Committed on blur rather than per-keystroke: notes are prose, and
            // one Yjs write per character would flood every peer's undo stack.
            onBlur={(e) => {
              if (e.target.value !== (activeSlide.notes ?? '')) setNotes(activeSlide.id, e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') e.currentTarget.blur();
            }}
            placeholder={`Notes for slide ${slideIndex + 1} — shown to you in present mode (S), never on screen.`}
            spellCheck
            className="h-24 w-full resize-none bg-transparent px-3 pb-2 text-sm leading-relaxed text-text outline-none placeholder:text-text-dim/60"
          />
        )}
      </div>
      </div>

      {/* ── Present mode ───────────────────────────────────────────────────── */}
      {presenting !== null && (
        <PresentOverlay
          slides={slides}
          elementsBySlide={elementsBySlide}
          index={Math.min(presenting, slides.length - 1)}
          onNavigate={(i) => setPresenting(i)}
          onExit={() => setPresenting(null)}
        />
      )}
    </div>
  );
}

/**
 * Alignment lines a dragged element can snap to: every OTHER element's left /
 * center / right and top / middle / bottom, plus the slide's own edges and
 * center. Gathered once per drag — they don't move while you're dragging.
 */
function snapTargets(elements: SlideElement[], dragging: Set<string>): SnapTargets {
  const xs = [0, SLIDE_W / 2, SLIDE_W];
  const ys = [0, SLIDE_H / 2, SLIDE_H];
  for (const el of elements) {
    if (dragging.has(el.id)) continue;
    xs.push(el.x, el.x + el.w / 2, el.x + el.w);
    ys.push(el.y, el.y + el.h / 2, el.y + el.h);
  }
  return { xs, ys };
}

/**
 * Nudge `offset` so one of the box's three edges lands on a target line.
 * Returns the adjusted offset and the line we locked onto (for the guide).
 */
function snapAxis(
  origin: number,
  size: number,
  offset: number,
  targets: number[],
  tolerance: number,
): { offset: number; guide: number | null } {
  const edges = [origin + offset, origin + offset + size / 2, origin + offset + size];
  let best: { delta: number; at: number } | null = null;
  for (const edge of edges) {
    for (const t of targets) {
      const delta = t - edge;
      if (Math.abs(delta) > tolerance) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: t };
    }
  }
  return best ? { offset: offset + best.delta, guide: best.at } : { offset, guide: null };
}

/** Rotate (x, y) about the origin by `a` radians. */
function rotate(x: number, y: number, a: number): { x: number; y: number } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

function handlePos(h: Handle): React.CSSProperties {
  const c: React.CSSProperties = {};
  if (h.includes('n')) c.top = -5;
  else if (h.includes('s')) c.bottom = -5;
  else c.top = 'calc(50% - 5px)';
  if (h.includes('w')) c.left = -5;
  else if (h.includes('e')) c.right = -5;
  else c.left = 'calc(50% - 5px)';
  return c;
}

function handleCursor(h: Handle): string {
  switch (h) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    default:
      return 'ew-resize';
  }
}

function RailButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded bg-bg/85 p-0.5 text-text-dim transition-colors hover:text-text disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function ToolButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md transition-colors',
        active ? 'bg-accent/20 text-accent' : 'text-text-dim hover:bg-bg hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
