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
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
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
import { makeId } from '../utils/id';
import { cn } from '../utils/cn';
import { toast } from '../ui/Toast';
import { fileToImageShape, isImageFile } from '../canvas2d/importImage';
import { uploadDataUrl } from '../supabase/storage';
import { SlideView } from './SlideView';
import { useSlidesStore } from './store';
import { defaultTextColor, setSlideBackground } from './background';
import { readSlides, readElements, toYMap, orderBetween, topZ } from './model';
import { migrateLegacyDeck, needsMigration } from './migrate';

const MIN_SIZE = 24;
const PASTE_OFFSET = 24;
const DEFAULT_BG = '#14141b';

/** Slide background palette (dark-friendly plus a light paper). */
const BG_SWATCHES = ['#14141b', '#0c0c0e', '#1d1d2b', '#232333', '#f6f5f0', '#ffffff'];
/** Element fill/text color palette. */
const EL_SWATCHES = ['#e0dff5', '#7c6aff', '#8fd4ff', '#8fe6b0', '#ffd68f', '#ff9db8', '#2a2a35'];

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; start: SlideElement; aspect: boolean };

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
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const k = Math.min((r.width - 48) / SLIDE_W, (r.height - 88) / SLIDE_H);
      setScale(Math.max(0.05, Math.min(2, k)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
      const w = kind === 'ellipse' ? 260 : 300;
      const h = kind === 'ellipse' ? 260 : 200;
      const id = addElement({
        slideId: activeSlide.id,
        kind,
        x: (SLIDE_W - w) / 2,
        y: (SLIDE_H - h) / 2,
        w,
        h,
        rotation: 0,
        fill: '#7c6aff33',
        stroke: '#7c6aff',
        strokeWidth: 2,
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
      for (const el of activeElements) {
        if (next.has(el.id)) origin.set(el.id, { x: el.x, y: el.y });
      }
      dragRef.current = { kind: 'move', start: { x: e.clientX, y: e.clientY }, origin, moved: false };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [activeElements, commitTextEdit],
  );

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
        const dx = (e.clientX - drag.start.x) / k;
        const dy = (e.clientY - drag.start.y) / k;
        if (!drag.moved && Math.hypot(dx, dy) * k < 3) return;
        drag.moved = true;
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
      // Resize.
      const { start, handle } = drag;
      const p = toSlide(e.clientX, e.clientY);
      let x = start.x;
      let y = start.y;
      let w = start.w;
      let h = start.h;
      if (handle.includes('e')) w = Math.max(MIN_SIZE, p.x - start.x);
      if (handle.includes('s')) h = Math.max(MIN_SIZE, p.y - start.y);
      if (handle.includes('w')) {
        w = Math.max(MIN_SIZE, start.x + start.w - p.x);
        x = start.x + start.w - w;
      }
      if (handle.includes('n')) {
        h = Math.max(MIN_SIZE, start.y + start.h - p.y);
        y = start.y + start.h - h;
      }
      const corner = handle.length === 2;
      if (drag.aspect && corner && start.w > 0 && start.h > 0) {
        const ratio = start.w / start.h;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        if (handle.includes('w')) x = start.x + start.w - w;
        if (handle.includes('n')) y = start.y + start.h - h;
      }
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
        e.preventDefault();
        setPresenting(Math.max(0, slides.findIndex((s) => s.id === activeSlide?.id)));
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
  const editingEl = textEdit
    ? activeElements.find((el) => el.id === textEdit.elementId) ?? null
    : null;
  const slideIndex = Math.max(0, slides.findIndex((s) => s.id === activeSlide?.id));

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
    <div className="flex h-full w-full overflow-hidden bg-bg">
      {/* ── Slide rail ─────────────────────────────────────────────────────── */}
      <div className="flex w-44 flex-none flex-col border-r border-border bg-bg-2/60">
        {/* "New slide" sits at the TOP: the floating People widget anchors to
            the bottom-left of the workspace and would swallow clicks on a
            bottom-docked button. The rail also gets generous bottom padding so
            the last thumbnail can always be scrolled clear of that widget. */}
        <button
          className="m-2 flex items-center justify-center gap-1 rounded-md border border-border py-1.5 text-xs text-text-dim transition-colors hover:border-accent hover:text-text"
          onClick={() => addSlide(activeSlide.id)}
        >
          <Plus size={14} /> New slide
        </button>
        <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-28">
          {slides.map((s, i) => (
            <div
              key={s.id}
              data-slide-thumb={s.id}
              className={cn(
                'group relative cursor-pointer rounded-md border p-1 transition-colors',
                s.id === activeSlide.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-text-dim/40',
              )}
              onClick={() => setActiveSlideId(s.id)}
            >
              <SlideView
                background={s.background}
                elements={elementsBySlide.get(s.id) ?? []}
                scale={152 / SLIDE_W}
                className="rounded-sm"
              />
              <span className="absolute left-1.5 top-1.5 rounded bg-bg/80 px-1 text-[10px] font-mono text-text-dim">
                {i + 1}
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
                <RailButton title="Delete slide" onClick={() => deleteSlide(s.id)}>
                  <Trash2 size={12} />
                </RailButton>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Stage ──────────────────────────────────────────────────────────── */}
      <div
        ref={stageWrapRef}
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
                {isSel && selection.size === 1 &&
                  HANDLES.map((h) => (
                    <div
                      key={h}
                      data-handle={h}
                      className="absolute z-10 h-2.5 w-2.5 rounded-[2px] border border-accent bg-bg"
                      style={{ ...handlePos(h), cursor: handleCursor(h) }}
                      onPointerDown={(e) => beginResize(e, el, h)}
                    />
                  ))}
              </div>
            );
          })}

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
          className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg-2/95 px-2 py-1 shadow-lg backdrop-blur"
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

        {/* Present button + slide counter. */}
        <div className="absolute right-3 top-3 z-30 flex items-center gap-2">
          <span className="text-xs font-mono text-text-dim">
            {slideIndex + 1} / {slides.length}
          </span>
          <button
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white shadow transition-transform hover:scale-105"
            onClick={() => setPresenting(slideIndex)}
          >
            <Play size={13} /> Present
          </button>
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

/** Fullscreen presentation overlay — arrows / space / click advance, Esc exits. */
function PresentOverlay({
  slides,
  elementsBySlide,
  index,
  onNavigate,
  onExit,
}: {
  slides: Slide[];
  elementsBySlide: Map<string, SlideElement[]>;
  index: number;
  onNavigate: (i: number) => void;
  onExit: () => void;
}) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', update);
    // Best-effort fullscreen; presentation still works if the browser refuses.
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener('resize', update);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
      } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        if (index < slides.length - 1) onNavigate(index + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        if (index > 0) onNavigate(index - 1);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [index, slides.length, onNavigate, onExit]);
  const slide = slides[index];
  if (!slide) return null;
  const k = Math.min(size.w / SLIDE_W, size.h / SLIDE_H);
  return (
    <div
      data-present-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={() => {
        if (index < slides.length - 1) onNavigate(index + 1);
        else onExit();
      }}
    >
      <SlideView background={slide.background} elements={elementsBySlide.get(slide.id) ?? []} scale={k} />
      <span className="absolute bottom-3 right-4 text-xs font-mono text-white/50">
        {index + 1} / {slides.length}
      </span>
    </div>
  );
}
