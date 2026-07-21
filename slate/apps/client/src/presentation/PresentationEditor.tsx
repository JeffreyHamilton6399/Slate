/**
 * PresentationEditor — Google Slides / PowerPoint-style slide editor.
 *
 * Major upgrade from the minimal first cut. Still uses a contenteditable +
 * execCommand (no TipTap) for slide content, but now ships:
 *
 *   - A complete tool palette (left dock's PresentationToolsPanel) that
 *     dispatches `slate:presentation-command` window events. This component
 *     is the single listener — it routes each command to either a slide
 *     mutation (add/duplicate/delete/move/template) or a `document.execCommand`
 *     formatting call on the focused contenteditable.
 *   - Five slide templates (blank / title / title+content / two-column /
 *     section divider) selectable from the Add Slide button.
 *   - Drag-to-reorder thumbnails in the slide navigator (pointer events,
 *     no dnd-kit). Right-click a thumbnail for a context menu
 *     (add / duplicate / delete / move left / move right).
 *   - Speaker notes per slide (toggle below the editor; stored in the
 *     Y.Map as `notes`).
 *   - Slide transition selector (none / fade / slide / zoom) stored in the
 *     Y.Map as `transition`; applied in present mode via CSS keyframes.
 *   - Export to a single standalone HTML file (one `<section>` per slide).
 *   - Keyboard shortcuts: ←/→ + PageUp/Down navigate, Ctrl+Shift+N new,
 *     Ctrl+Shift+D duplicate, Ctrl+Shift+P present, Delete (when not
 *     editing text) deletes the slide.
 *   - Polished present mode: transitions between slides, slide counter,
 *     progress bar, click-to-advance, Esc exits.
 *
 * Each slide is a Y.Map with `{ id, content (HTML), background (color or
 * gradient), notes (string), transition ('none'|'fade'|'slide'|'zoom') }`.
 * Slides live in the top-level Y.Array keyed by SLIDES_KEY (`slides`) so
 * every client resolves the same shared container (sync/doc.ts container
 * doctrine). The contenteditable binds directly to `content` — `onInput`
 * writes back to Yjs on a 250ms debounce so typing stays smooth.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  Plus, Trash2, Copy as CopyIcon, ChevronLeft, ChevronRight,
  Play as PlayIcon, X, StickyNote as NotesIcon, FileCode2,
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, Palette, Eraser,
  List as ListIcon, ListOrdered, AlignLeft, AlignCenter, AlignRight,
  Square, Circle as CircleIcon, ArrowRight, Minus,
  Image as ImageIcon, Eye,
  type LucideIcon,
} from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { makeId } from '../utils/id';
import { useIsMobile } from '../workspace/useMediaQuery';
import { toast } from '../ui/Toast';
import {
  PRESENTATION_COMMAND_EVENT,
  type PresentationCommandDetail,
} from './presentationBridge';

/** Default background for a new slide. */
const DEFAULT_BG = '#0c0c0e';

/** Toolbar swatches — keep a short list inline so the editor has its own
 *  quick picker (the full grid lives in PresentationToolsPanel). */
const BG_SWATCHES = [
  DEFAULT_BG,
  '#ffffff',
  '#1a1a1d',
  '#f6f5f0',
  '#1e293b',
  '#fef3c7',
  '#dbeafe',
  '#dcfce7',
];

const TRANSITIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'slide', label: 'Slide' },
  { id: 'zoom', label: 'Zoom' },
] as const;
type TransitionId = (typeof TRANSITIONS)[number]['id'];

/** Slide ANIMATIONS — distinct from transitions: a transition fires when
 *  navigating BETWEEN slides (the new slide's entrance animation), while an
 *  animation is the in-slide content reveal. They stack (a slide can have
 *  transition=fade AND animation=slide-up). */
const ANIMATIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade-in', label: 'Fade In' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'zoom-in', label: 'Zoom In' },
  { id: 'bounce', label: 'Bounce' },
] as const;
type AnimationId = (typeof ANIMATIONS)[number]['id'];

function isAnimationId(v: unknown): v is AnimationId {
  return v === 'none' || v === 'fade-in' || v === 'slide-up' || v === 'zoom-in' || v === 'bounce';
}

/** Quick theme presets — set the background AND the default text color in
 *  one tap. Themes apply to the active slide (not the whole deck) so the user
 *  can mix-and-match per section. The text color is applied to the slide's
 *  contenteditable via inline `color` style on the wrapper. */
const THEMES: { id: string; label: string; bg: string; color: string }[] = [
  { id: 'dark', label: 'Dark', bg: '#0c0c0e', color: '#f5f5f7' },
  { id: 'light', label: 'Light', bg: '#ffffff', color: '#1a1a1d' },
  { id: 'blue', label: 'Blue', bg: '#1e3a8a', color: '#ffffff' },
  { id: 'sunset', label: 'Sunset', bg: 'linear-gradient(135deg, #f97316 0%, #db2777 100%)', color: '#ffffff' },
  { id: 'forest', label: 'Forest', bg: 'linear-gradient(135deg, #065f46 0%, #064e3b 100%)', color: '#f0fdf4' },
  { id: 'slate', label: 'Slate', bg: '#1e293b', color: '#e2e8f0' },
];

interface Slide {
  id: string;
  content: string;
  background: string;
  /** Inline text color override (set when a theme is applied) — empty string
   *  means "no override, use the default". */
  textColor: string;
  notes: string;
  transition: TransitionId;
  animation: AnimationId;
}

/** Read a slide Y.Map as a plain object (defensive — fields may be missing
 *  on a freshly-added slide before its first commit). */
function readSlide(m: Y.Map<unknown>, fallbackId: string): Slide {
  const transition = (m.get('transition') as TransitionId | undefined) ?? 'none';
  const animation = m.get('animation');
  return {
    id: (m.get('id') as string | undefined) ?? fallbackId,
    content: (m.get('content') as string | undefined) ?? '',
    background: (m.get('background') as string | undefined) ?? DEFAULT_BG,
    textColor: (m.get('textColor') as string | undefined) ?? '',
    notes: (m.get('notes') as string | undefined) ?? '',
    transition: (transition === 'none' || transition === 'fade' || transition === 'slide' || transition === 'zoom')
      ? transition
      : 'none',
    animation: isAnimationId(animation) ? animation : 'none',
  };
}

/** HTML templates for the five slide layouts. Inserted verbatim into the
 *  contenteditable, then committed to Yjs like any other edit. Inline
 *  styles so the markup round-trips through the slide's `content` HTML
 *  string with no external CSS dependency. */
function templateHtml(id: string): string {
  switch (id) {
    case 'title':
      return (
        '<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;text-align:center;">' +
        '<h1 style="font-size:3.2em;margin:0 0 0.4em;font-weight:700;">Slide Title</h1>' +
        '<p style="font-size:1.3em;opacity:0.7;margin:0;">Subtitle or presenter name</p>' +
        '</div>'
      );
    case 'title+content':
      return (
        '<h1 style="font-size:2.4em;margin:0 0 0.6em;font-weight:700;">Slide Title</h1>' +
        '<p style="font-size:1.2em;line-height:1.5;margin:0;">Start writing your content here…</p>' +
        '<ul style="font-size:1.1em;line-height:1.6;margin:0.6em 0 0 1.4em;">' +
        '<li>First point</li><li>Second point</li><li>Third point</li></ul>'
      );
    case 'two-column':
      return (
        '<h1 style="font-size:2.2em;margin:0 0 0.6em;font-weight:700;">Slide Title</h1>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2em;">' +
        '<div><h3 style="margin:0 0 0.3em;font-size:1.3em;">Left column</h3><p style="margin:0;line-height:1.5;">Content for the left side…</p></div>' +
        '<div><h3 style="margin:0 0 0.3em;font-size:1.3em;">Right column</h3><p style="margin:0;line-height:1.5;">Content for the right side…</p></div>' +
        '</div>'
      );
    case 'section':
      return (
        '<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;text-align:center;">' +
        '<h1 style="font-size:4em;margin:0;font-weight:800;letter-spacing:-0.02em;">Section</h1>' +
        '<p style="font-size:1.2em;opacity:0.6;margin-top:0.4em;">Divider</p>' +
        '</div>'
      );
    case 'blank':
    default:
      return '';
  }
}

export function PresentationEditor() {
  const room = useRoom();
  const slate = room.slate;
  const isMobile = useIsMobile();
  const slidesArr = useMemo(() => slate.slides(), [slate]);
  const [version, setVersion] = useState(0);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  /** Tracks the present-mode slide separately so transitions can fire on
   *  navigation (changing `presentKey` remounts the slide container and
   *  re-runs the CSS keyframe animation). */
  const [presentKey, setPresentKey] = useState(0);
  /** Presenter view overlay (small speaker-notes panel at the bottom of
   *  present mode) — toggleable from a button in the present chrome. */
  const [presenterNotes, setPresenterNotes] = useState(false);
  /** Elapsed-time counter for present mode — set when starting present,
   *  cleared when leaving. Updated once per second by an interval below. */
  const [presentElapsed, setPresentElapsed] = useState(0);
  const presentStartRef = useRef<number | null>(null);
  /** Image-file picker — hidden input; the Image button in the toolbar
   *  clicks it. On change, the file is read as a data URL and inserted as
   *  an <img> into the contenteditable. */
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** Context-menu state for the slide navigator (right-click). Null hides
   *  the menu; otherwise holds the target slide index + screen coords. */
  const [contextMenu, setContextMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  /** Debounce timer for committing contenteditable HTML back to Yjs. Typing
   *  on every keystroke would thrash the Yjs doc — 250ms after the last
   *  keystroke is responsive enough for live collab and keeps the wire quiet. */
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Notes debounce timer — same pattern, separate timer so editing notes
   *  doesn't reset the content debounce and vice versa. */
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while the contenteditable is the source of the in-flight commit.
   *  Without this, the Yjs observer would call applyRemoteContent() every
   *  time we wrote our own edit back, clobbering the cursor position. */
  const selfCommitRef = useRef(false);
  /** Same flag for notes — suppresses the observer's notes re-render while
   *  the textarea is the source of the in-flight notes commit. */
  const selfNotesCommitRef = useRef(false);
  /** The contenteditable element for the active slide. */
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** The speaker-notes textarea. */
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  /** The present-mode fullscreen container. */
  const presentRef = useRef<HTMLDivElement | null>(null);

  // ── Yjs subscription ──────────────────────────────────────────────────
  useEffect(() => {
    let pending = false;
    const bump = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setVersion((v) => v + 1);
      });
    };
    const observer = () => {
      if (selfCommitRef.current) {
        selfCommitRef.current = false;
        return;
      }
      bump();
    };
    slidesArr.observeDeep(observer);
    const late = setTimeout(bump, 200);
    return () => {
      clearTimeout(late);
      slidesArr.unobserveDeep(observer);
    };
  }, [slidesArr]);

  // Read slides fresh every render (driven by `version` bumps).
  const slides: Slide[] = useMemo(() => {
    void version;
    const list: Slide[] = [];
    for (let i = 0; i < slidesArr.length; i++) {
      list.push(readSlide(slidesArr.get(i), `slide-${i}`));
    }
    return list;
  }, [slidesArr, version]);

  // Seed an empty deck with one blank slide so the user has something to
  // click into. First writer wins across peers (id collision-free IDs keep
  // the Yjs merge clean).
  useEffect(() => {
    if (slidesArr.length === 0) {
      addSlideInternal('blank');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slidesArr]);

  // Clamp `current` if slides were deleted (e.g. by a peer).
  useEffect(() => {
    if (current > slides.length - 1) {
      setCurrent(Math.max(0, slides.length - 1));
    }
  }, [slides.length, current]);

  // Sync the contenteditable's innerHTML to the Yjs value when the current
  // slide changes — UNLESS the edit originated from the contenteditable
  // itself (avoids caret jumps).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const slide = slides[current];
    if (!slide) return;
    if (el.innerHTML !== slide.content) {
      el.innerHTML = slide.content;
    }
  }, [slides, current]);

  // Sync the notes textarea to the Yjs value when the current slide changes
  // (same caret-jump guard as the content editor).
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const slide = slides[current];
    if (!slide) return;
    if (el.value !== slide.notes) {
      el.value = slide.notes;
    }
  }, [slides, current, notesOpen]);

  // ── Mutations ─────────────────────────────────────────────────────────

  /** Core "add a slide" — used both by the toolbar's quick-add and the
   *  template picker. Inserts after `current`, switches to it. */
  const addSlideInternal = useCallback((templateId: string) => {
    const id = makeId('slide');
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('content', templateHtml(templateId));
    m.set('background', DEFAULT_BG);
    m.set('textColor', '');
    m.set('notes', '');
    m.set('transition', 'none');
    m.set('animation', 'none');
    const insertAt = Math.min(slidesArr.length, current + 1);
    slidesArr.insert(insertAt, [m]);
    setCurrent(insertAt);
  }, [slidesArr, current]);

  const addSlide = useCallback(() => addSlideInternal('blank'), [addSlideInternal]);

  const deleteSlide = useCallback((idx: number) => {
    if (slidesArr.length <= 1) {
      toast({ title: 'Cannot delete', description: 'A presentation needs at least one slide.', variant: 'error' });
      return;
    }
    slidesArr.delete(idx, 1);
    setCurrent((c) => Math.max(0, Math.min(c, slidesArr.length - 1)));
  }, [slidesArr]);

  const duplicateSlide = useCallback((idx: number) => {
    const src = slidesArr.get(idx);
    if (!src) return;
    const m = new Y.Map<unknown>();
    m.set('id', makeId('slide'));
    m.set('content', (src.get('content') as string | undefined) ?? '');
    m.set('background', (src.get('background') as string | undefined) ?? DEFAULT_BG);
    m.set('textColor', (src.get('textColor') as string | undefined) ?? '');
    m.set('notes', (src.get('notes') as string | undefined) ?? '');
    m.set('transition', (src.get('transition') as TransitionId | undefined) ?? 'none');
    m.set('animation', isAnimationId(src.get('animation')) ? src.get('animation') as AnimationId : 'none');
    slidesArr.insert(idx + 1, [m]);
    setCurrent(idx + 1);
  }, [slidesArr]);

  /** Move a slide by one slot in either direction. Implemented as a swap so
   *  the slide's Y.Map identity (and thus its observer wiring) is preserved. */
  const moveSlide = useCallback((idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= slidesArr.length) return;
    const a = slidesArr.get(idx);
    const b = slidesArr.get(target);
    if (!a || !b) return;
    // Delete the later one first so the earlier index stays valid.
    const [hi, lo] = idx < target ? [target, idx] : [idx, target];
    slidesArr.delete(hi, 1);
    slidesArr.delete(lo, 1);
    // Re-insert in swapped order at the lower index.
    slidesArr.insert(lo, [b, a]);
    setCurrent(target);
  }, [slidesArr]);

  /** Drag-to-reorder: move slide `from` to position `to` (final index after
   *  the move). Preserves the Y.Map identity by delete-then-reinsert. */
  const moveSlideTo = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= slidesArr.length || to >= slidesArr.length) return;
    const m = slidesArr.get(from);
    if (!m) return;
    slidesArr.delete(from, 1);
    slidesArr.insert(to, [m]);
    setCurrent(to);
  }, [slidesArr]);

  /** Commit the contenteditable's HTML back to the current slide's `content`
   *  field. Debounced 250ms after the last keystroke so typing stays smooth. */
  const commitContent = useCallback(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      const el = editorRef.current;
      const slide = slidesArr.get(current);
      if (!el || !slide) return;
      const html = el.innerHTML;
      selfCommitRef.current = true;
      slide.set('content', html);
    }, 250);
  }, [slidesArr, current]);

  /** Commit the notes textarea's value back to the current slide's `notes`
   *  field. Same debounced-commit pattern as content. */
  const commitNotes = useCallback(() => {
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      const el = notesRef.current;
      const slide = slidesArr.get(current);
      if (!el || !slide) return;
      selfNotesCommitRef.current = true;
      slide.set('notes', el.value);
    }, 250);
  }, [slidesArr, current]);

  /** Set the background color (or gradient) of the current slide. Immediate
   *  commit — the user picked a swatch, the change should land now. */
  const setBackground = useCallback((bg: string) => {
    const slide = slidesArr.get(current);
    if (!slide) return;
    selfCommitRef.current = true;
    slide.set('background', bg);
  }, [slidesArr, current]);

  /** Set the transition for the current slide. Immediate commit. */
  const setTransition = useCallback((t: TransitionId) => {
    const slide = slidesArr.get(current);
    if (!slide) return;
    selfCommitRef.current = true;
    slide.set('transition', t);
  }, [slidesArr, current]);

  /** Set the animation for the current slide. Immediate commit. */
  const setAnimation = useCallback((a: AnimationId) => {
    const slide = slidesArr.get(current);
    if (!slide) return;
    selfCommitRef.current = true;
    slide.set('animation', a);
  }, [slidesArr, current]);

  /** Apply a quick theme preset: sets both the slide background AND the
   *  default text color in one go. The text color is stored separately so a
   *  user can override it later by picking a different text color without
   *  losing the background. */
  const applyTheme = useCallback((themeId: string) => {
    const slide = slidesArr.get(current);
    if (!slide) return;
    const theme = THEMES.find((t) => t.id === themeId);
    if (!theme) return;
    selfCommitRef.current = true;
    slide.set('background', theme.bg);
    slide.set('textColor', theme.color);
  }, [slidesArr, current]);

  /** Insert a shape (rect / circle / arrow / line) at the cursor. Shapes are
   *  absolutely positioned <div>s with inline styles, so they live inside the
   *  same contenteditable HTML and round-trip through Yjs like any other
   *  content. The default position is `top:20%; left:10%` — the user drags
   *  them by editing the inline style (no separate shape layer needed). */
  const insertShape = useCallback((shape: 'rect' | 'circle' | 'arrow' | 'line') => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    let html = '';
    // Place the shape inside a positioned wrapper so the absolute coords are
    // relative to the slide (the contenteditable fills the slide).
    const wrap = (inner: string) =>
      `<div data-shape="${shape}" style="position:absolute;top:20%;left:10%;width:30%;height:30%;display:flex;align-items:center;justify-content:center;">${inner}</div>`;
    switch (shape) {
      case 'rect':
        html = wrap('<div style="width:100%;height:100%;background:#3b82f6;border:2px solid #1d4ed8;border-radius:4px;"></div>');
        break;
      case 'circle':
        html = wrap('<div style="width:100%;aspect-ratio:1/1;background:#10b981;border:2px solid #047857;border-radius:50%;"></div>');
        break;
      case 'arrow':
        // A right-pointing arrow built from a horizontal bar + a triangular
        // head via border-trick + transform. Inline styles only so it survives
        // the HTML string round-trip.
        html = wrap(
          '<div style="display:flex;align-items:center;width:100%;height:24px;">' +
          '<div style="flex:1;height:8px;background:#ef4444;"></div>' +
          '<div style="width:0;height:0;border-top:14px solid transparent;border-bottom:14px solid transparent;border-left:18px solid #ef4444;"></div>' +
          '</div>'
        );
        break;
      case 'line':
        html = wrap('<div style="width:100%;height:4px;background:#e5e7eb;border-radius:2px;"></div>');
        break;
    }
    // execCommand('insertHTML') inserts at the caret; placing the wrapper
    // before the caret keeps the cursor outside the shape so subsequent text
    // doesn't end up inside the shape div.
    document.execCommand('insertHTML', false, html);
    commitContent();
  }, [commitContent]);

  /** Insert an image: read the picked file as a data URL, then insert an
   *  <img> into the contenteditable. Images are bounded to 60% of the slide
   *  width so they don't overflow the 16:9 surface; the user can resize by
   *  dragging the corner (browser default for contenteditable <img> selection).
   *  We don't offload to Supabase here (slides sync as a small Yjs doc; a
   *  ~500KB data URL is fine and keeps the deck self-contained for export). */
  const insertImageFile = useCallback((file: File) => {
    const el = editorRef.current;
    if (!el) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Not an image', description: 'Pick a PNG, JPG, GIF, or WebP file.', variant: 'error' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!src) return;
      el.focus();
      // Place the image at the caret with a max-width so it fits the slide.
      // `position:relative` keeps it in the text flow (not absolutely
      // positioned like shapes) so the user can drag it around naturally.
      const html = `<img src="${src}" alt="${file.name.replace(/"/g, '&quot;')}" style="max-width:60%;height:auto;border-radius:6px;display:inline-block;" />`;
      document.execCommand('insertHTML', false, html);
      commitContent();
    };
    reader.onerror = () => {
      toast({ title: 'Image read failed', description: 'The file could not be read.', variant: 'error' });
    };
    reader.readAsDataURL(file);
  }, [commitContent]);

  // ── Formatting (execCommand — deprecated but still the simplest way to
  //  round-trip rich text through a contenteditable without ProseMirror). */
  const exec = useCallback((cmd: string, value?: string) => {
    editorRef.current?.focus();
    if (value !== undefined) {
      document.execCommand(cmd, false, value);
    } else {
      document.execCommand(cmd, false);
    }
    commitContent();
  }, [commitContent]);

  /** Wrap the current selection in a <span style="font-size:Npx">…</span>.
   *  execCommand('fontSize') only accepts 1–7 (the legacy font-size scale),
   *  which is too coarse — we want exact px values, so we manipulate the
   *  selection's HTML directly. */
  const setFontSize = useCallback((px: number) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return; // nothing to wrap — silently no-op
    const span = document.createElement('span');
    span.style.fontSize = `${px}px`;
    try {
      range.surroundContents(span);
    } catch {
      // surroundContents fails when the range crosses element boundaries.
      // Fall back to extract + insert (preserves the selection's contents,
      // even if they span multiple inline elements).
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    commitContent();
  }, [commitContent]);

  /** Clear the font size on the current selection: walk up from every text
   *  node inside the range and strip `font-size` from its parent's style. */
  const clearFontSize = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      if (node instanceof HTMLElement && range.intersectsNode(node)) {
        if (node.style.fontSize) node.style.fontSize = '';
      }
      node = walker.nextNode();
    }
    commitContent();
  }, [commitContent]);

  // ── Navigation ────────────────────────────────────────────────────────

  const goPrev = useCallback(() => setCurrent((c) => Math.max(0, c - 1)), []);
  const goNext = useCallback(() => setCurrent((c) => Math.min(slidesArr.length - 1, c + 1)), [slidesArr.length]);

  // ── Present (fullscreen) mode ─────────────────────────────────────────

  const startPresent = useCallback(async () => {
    setPresenting(true);
    setPresentKey((k) => k + 1);
    // Start the elapsed-time counter — setPresentElapsed(0) resets it so a
    // resumed present session starts fresh.
    presentStartRef.current = Date.now();
    setPresentElapsed(0);
    requestAnimationFrame(() => {
      const el = presentRef.current;
      if (!el) return;
      const req = el.requestFullscreen?.bind(el);
      if (req) {
        req().catch(() => { /* user denied or unsupported — stay in-app */ });
      }
    });
  }, []);

  const stopPresent = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => { /* ignore */ });
    }
    setPresenting(false);
    presentStartRef.current = null;
    setPresenterNotes(false);
  }, []);

  // Tick the elapsed-time counter once per second while presenting. Stops
  // when the user exits present mode (presentStartRef clears). Uses
  // Date.now() - presentStartRef.current so a tab-throttled interval still
  // shows the right elapsed time after the tab is brought back to focus.
  useEffect(() => {
    if (!presenting) return;
    const id = window.setInterval(() => {
      if (presentStartRef.current == null) return;
      setPresentElapsed(Math.floor((Date.now() - presentStartRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [presenting]);

  // Sync `presenting` with the browser's fullscreen state so Esc (which the
  // browser handles itself) closes our overlay too.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && presenting) setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [presenting]);

  // Present-mode keyboard navigation: ←/→/PageUp/PageDown/Space navigate,
  // Esc exits. Also re-fire the transition animation on each navigation by
  // bumping `presentKey`.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        if (current < slidesArr.length - 1) {
          setCurrent(current + 1);
          setPresentKey((k) => k + 1);
        } else {
          stopPresent();
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setCurrent((c) => Math.max(0, c - 1));
        setPresentKey((k) => k + 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stopPresent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, current, slidesArr.length, stopPresent]);

  // ── Editor-level keyboard shortcuts (only when NOT presenting) ────────
  useEffect(() => {
    if (presenting) return;
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+N — new slide
      if (e.ctrlKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        addSlide();
        return;
      }
      // Ctrl+Shift+D — duplicate slide
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        duplicateSlide(current);
        return;
      }
      // Ctrl+Shift+P — present
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        void startPresent();
        return;
      }
      // ArrowLeft / ArrowRight / PageUp / PageDown — navigate slides, but
      // only when the user ISN'T editing text (so arrow keys in the
      // contenteditable still move the caret).
      const target = e.target as HTMLElement | null;
      const editing = target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (editing) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSlide(current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, current, addSlide, duplicateSlide, startPresent, goNext, goPrev, deleteSlide]);

  // ── Export deck as a single standalone HTML file ──────────────────────
  // Defined before the command listener because the listener calls it for
  // the `exportHtml` action.
  const exportHtml = useCallback(() => {
    const boardName = room.room ?? 'presentation';
    const sections = slides.map((s, i) => {
      const esc = (v: string) => v.replace(/"/g, '&quot;');
      // Inline `color` carries the slide's textColor (set by a theme) so the
      // exported deck preserves the visual styling without external CSS.
      const colorStyle = s.textColor ? `color:${esc(s.textColor)};` : '';
      return (
        `<section class="slide" data-index="${i}" data-transition="${esc(s.transition)}" data-animation="${esc(s.animation)}" style="background:${esc(s.background)};${colorStyle}">` +
        `<div class="slide-inner">${s.content || '<p class="placeholder">Empty slide</p>'}</div>` +
        (s.notes ? `<aside class="notes"><strong>Notes:</strong> ${escapeHtml(s.notes)}</aside>` : '') +
        '</section>'
      );
    }).join('\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(boardName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #000; font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #fff; }
  .slide {
    width: 100vw; height: 100vh; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 6%; position: relative; page-break-after: always;
  }
  .slide-inner { width: 100%; max-width: 1280px; line-height: 1.5; font-size: 1.4rem; }
  .slide-inner h1 { font-size: 2.6em; margin: 0 0 0.5em; font-weight: 700; }
  .slide-inner h2 { font-size: 2em; margin: 0 0 0.5em; font-weight: 700; }
  .slide-inner h3 { font-size: 1.5em; margin: 0 0 0.4em; font-weight: 700; }
  .slide-inner ul, .slide-inner ol { padding-left: 1.4em; }
  .slide-inner .placeholder { opacity: 0.4; font-style: italic; }
  .notes { position: absolute; bottom: 1rem; left: 1rem; right: 1rem; font-size: 0.85rem; color: rgba(255,255,255,0.5); background: rgba(0,0,0,0.4); padding: 0.5rem 0.75rem; border-radius: 4px; }
  @media print {
    body { background: #fff; }
    .notes { display: none; }
  }
</style>
</head>
<body>
${sections}
</body>
</html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${boardName}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
    toast({ title: 'Exported', description: `${slides.length} slide${slides.length === 1 ? '' : 's'} → ${boardName}.html` });
  }, [slides, room]);

  // ── Command listener (PresentationToolsPanel bridge) ──────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PresentationCommandDetail>).detail;
      const cmd = detail?.command;
      if (!cmd) return;
      switch (cmd) {
        // Slide ops
        case 'addSlideTemplate': {
          const tpl = detail.value ?? 'blank';
          addSlideInternal(tpl);
          break;
        }
        case 'duplicateSlide': duplicateSlide(current); break;
        case 'deleteSlide': deleteSlide(current); break;
        case 'moveSlideLeft': moveSlide(current, -1); break;
        case 'moveSlideRight': moveSlide(current, 1); break;
        // Text formatting (execCommand — focuses the contenteditable first)
        case 'bold': exec('bold'); break;
        case 'italic': exec('italic'); break;
        case 'underline': exec('underline'); break;
        case 'strike': exec('strikeThrough'); break;
        case 'h1': exec('formatBlock', 'h1'); break;
        case 'h2': exec('formatBlock', 'h2'); break;
        case 'h3': exec('formatBlock', 'h3'); break;
        case 'textColor': {
          const color = detail.value;
          if (color) exec('foreColor', color);
          break;
        }
        case 'clearColor': {
          // Reset the selection's inline color to the inherited value. We
          // can't pass `inherit`/`unset` through execCommand('foreColor')
          // (browsers clamp it to a hex), so we walk the selected elements
          // and strip `color` from their inline style — same trick the
          // `clearFontSize` command uses. Forward-compatible: the panel
          // doesn't ship a clearColor button today, but a future "clear
          // color" affordance can dispatch this without needing another
          // listener edit.
          const el = editorRef.current;
          if (el) {
            el.focus();
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
              let node: Node | null = walker.currentNode;
              while (node) {
                if (node instanceof HTMLElement && range.intersectsNode(node)) {
                  if (node.style.color) node.style.color = '';
                }
                node = walker.nextNode();
              }
            }
            commitContent();
          }
          break;
        }
        case 'clearFormat':
          exec('removeFormat');
          exec('formatBlock', 'div');
          break;
        case 'bulletList': exec('insertUnorderedList'); break;
        case 'orderedList': exec('insertOrderedList'); break;
        case 'alignLeft': exec('justifyLeft'); break;
        case 'alignCenter': exec('justifyCenter'); break;
        case 'alignRight': exec('justifyRight'); break;
        case 'fontSize': {
          const px = Number(detail.value);
          if (px > 0) setFontSize(px);
          break;
        }
        case 'clearFontSize': clearFontSize(); break;
        // Design
        case 'setBackground': {
          const bg = detail.value;
          if (bg) setBackground(bg);
          break;
        }
        case 'setTransition': {
          const t = detail.value as TransitionId;
          if (t === 'none' || t === 'fade' || t === 'slide' || t === 'zoom') setTransition(t);
          break;
        }
        case 'setAnimation': {
          const a = detail.value;
          if (isAnimationId(a)) setAnimation(a);
          break;
        }
        case 'applyTheme': {
          const themeId = detail.value;
          if (themeId) applyTheme(themeId);
          break;
        }
        case 'insertShape': {
          const shape = detail.value;
          if (shape === 'rect' || shape === 'circle' || shape === 'arrow' || shape === 'line') insertShape(shape);
          break;
        }
        case 'insertImage': {
          imageInputRef.current?.click();
          break;
        }
        // Actions
        case 'present': void startPresent(); break;
        case 'exportHtml': exportHtml(); break;
        default: break;
      }
    };
    window.addEventListener(PRESENTATION_COMMAND_EVENT, handler as EventListener);
    return () => window.removeEventListener(PRESENTATION_COMMAND_EVENT, handler as EventListener);
  }, [current, addSlideInternal, duplicateSlide, deleteSlide, moveSlide, exec, setFontSize, clearFontSize, setBackground, setTransition, setAnimation, applyTheme, insertShape, startPresent, exportHtml, commitContent]);

  // ── Drag-to-reorder in the slide navigator ────────────────────────────
  /** Refs read inside document-level pointer handlers (which don't re-bind
   *  on every render). Holds the index being dragged + the index currently
   *  under the pointer + whether the pointer has moved past the drag
   *  threshold (so we can suppress the click that follows a drag). */
  const dragStateRef = useRef<{ from: number; over: number; moved: boolean; startX: number; startY: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Tag each thumbnail `<li>` with `data-slide-idx` so the document-level
   *  pointermove handler can find which slide is under the pointer via
   *  `elementFromPoint` (we don't use pointer capture — it would swallow
   *  the enter events on sibling thumbnails). */
  const startDrag = useCallback((idx: number, e: React.PointerEvent) => {
    if (e.button !== 0) return; // only primary button
    dragStateRef.current = { from: idx, over: idx, moved: false, startX: e.clientX, startY: e.clientY };
    const onMove = (ev: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      // Mark as moved once the pointer crosses a small threshold so a
      // pure click (no drag) still selects the slide via the button's
      // onClick — but a real drag suppresses that click.
      if (!st.moved && Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) > 4) {
        st.moved = true;
      }
      if (!st.moved) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const li = target?.closest('[data-slide-idx]') as HTMLElement | null;
      const overIdx = li ? Number(li.dataset.slideIdx) : -1;
      if (overIdx >= 0 && overIdx !== st.over) {
        st.over = overIdx;
        setDragOver(overIdx);
      }
    };
    const onUp = () => {
      const st = dragStateRef.current;
      if (st && st.moved && st.over !== st.from) {
        moveSlideTo(st.from, st.over);
      }
      // Keep `moved` around for one tick so the click handler that fires
      // right after pointerup can read it and decide to suppress itself.
      setTimeout(() => {
        dragStateRef.current = null;
        setDragOver(null);
      }, 0);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [moveSlideTo]);

  // ── Render ────────────────────────────────────────────────────────────

  const activeSlide = slides[current];
  const slideCount = slides.length;
  const activeBg = activeSlide?.background ?? DEFAULT_BG;
  // CSS background: solid colors and gradients both work via the `background`
  // shorthand (we use `background` rather than `backgroundColor` so gradient
  // strings land on `backgroundImage`).
  const activeBgStyle = activeBg.startsWith('linear-gradient') || activeBg.startsWith('radial-gradient')
    ? { backgroundImage: activeBg }
    : { backgroundColor: activeBg };

  return (
    <div className="flex h-full w-full flex-col bg-bg text-text overflow-hidden">
      {/* Toolbar — slide ops + inline formatting + background + navigation + present.
          Mobile-tightened: keeps the essentials (Add / Duplicate / Delete /
          Notes / Prev-Next / Export / Present) in the horizontally-scrolling
          strip; the inline-formatting + background + transition + animation +
          shapes + image + theme controls are desktop-only (the dock panel has
          the full set). */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-bg-2 px-2 py-1.5 [&>*]:shrink-0">
        <button onClick={addSlide} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20" title="Add slide (Ctrl+Shift+N)">
          <Plus size={12} /> Slide
        </button>
        <button onClick={() => duplicateSlide(current)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3" title="Duplicate slide (Ctrl+Shift+D)">
          <CopyIcon size={12} /> Duplicate
        </button>
        <button onClick={() => deleteSlide(current)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3 hover:text-danger" title="Delete slide">
          <Trash2 size={12} /> Delete
        </button>
        <button onClick={() => setNotesOpen((v) => !v)} className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${notesOpen ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border text-text-mid hover:bg-bg-3'}`} title="Toggle speaker notes">
          <NotesIcon size={12} /> Notes
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        {/* Inline formatting + Insert (shapes/image) + design (bg/transition/
            animation/theme) — desktop only. Mobile users reach these from
            the dock's PresentationToolsPanel (or the FAB on portrait phones). */}
        {!isMobile && (
          <>
            <ToolbarButton onClick={() => exec('formatBlock', 'h1')} title="Heading 1" Icon={Heading1} />
            <ToolbarButton onClick={() => exec('formatBlock', 'h2')} title="Heading 2" Icon={Heading2} />
            <ToolbarButton onClick={() => exec('formatBlock', 'h3')} title="Heading 3" Icon={Heading3} />
            <ToolbarButton onClick={() => exec('bold')} title="Bold" Icon={Bold} />
            <ToolbarButton onClick={() => exec('italic')} title="Italic" Icon={Italic} />
            <ToolbarButton onClick={() => exec('underline')} title="Underline" Icon={UnderlineIcon} />
            <ToolbarButton onClick={() => exec('strikeThrough')} title="Strikethrough" Icon={Strikethrough} />
            <ToolbarButton onClick={() => exec('insertUnorderedList')} title="Bullet list" Icon={ListIcon} />
            <ToolbarButton onClick={() => exec('insertOrderedList')} title="Numbered list" Icon={ListOrdered} />
            <ToolbarButton onClick={() => exec('justifyLeft')} title="Align left" Icon={AlignLeft} />
            <ToolbarButton onClick={() => exec('justifyCenter')} title="Align center" Icon={AlignCenter} />
            <ToolbarButton onClick={() => exec('justifyRight')} title="Align right" Icon={AlignRight} />
            <ToolbarButton onClick={() => exec('removeFormat')} title="Clear formatting" Icon={Eraser} />
            {/* Text color: native color input behind a label (same pattern as
                DocToolsPanel / PresentationToolsPanel — kept inline so the
                user has a quick color picker without opening the dock). */}
            <label title="Text color" aria-label="Text color" className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded text-text-mid hover:bg-bg-3">
              <Palette size={14} />
              <input
                type="color"
                aria-label="Text color"
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(e) => exec('foreColor', e.target.value)}
                defaultValue="#ffffff"
              />
            </label>
            <div className="mx-1 h-5 w-px bg-border" />
            {/* Insert — shapes + image. Shapes are absolutely positioned divs
                inside the contenteditable; images are <img> with a max-width. */}
            <ToolbarButton onClick={() => insertShape('rect')} title="Insert rectangle" Icon={Square} />
            <ToolbarButton onClick={() => insertShape('circle')} title="Insert circle" Icon={CircleIcon} />
            <ToolbarButton onClick={() => insertShape('arrow')} title="Insert arrow" Icon={ArrowRight} />
            <ToolbarButton onClick={() => insertShape('line')} title="Insert line" Icon={Minus} />
            <ToolbarButton onClick={() => imageInputRef.current?.click()} title="Insert image" Icon={ImageIcon} />
            <div className="mx-1 h-5 w-px bg-border" />
          </>
        )}
        {/* Background swatches — desktop only (mobile uses the dock panel). */}
        {!isMobile && (
          <div className="flex items-center gap-0.5">
            {BG_SWATCHES.map((bg) => (
              <button
                key={bg}
                onClick={() => setBackground(bg)}
                className={`h-5 w-5 rounded-full border ${activeBg === bg ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
                style={{ backgroundColor: bg }}
                title={`Background: ${bg}`}
                aria-label={`Set background ${bg}`}
              />
            ))}
          </div>
        )}
        {/* Transition + Animation selectors + Theme quick-picker — desktop
            only. Mobile uses the dock panel. */}
        {!isMobile && (
          <>
            <div className="mx-1 h-5 w-px bg-border" />
            <label className="flex items-center gap-1 text-[10px] text-text-dim">
              Transition
              <select
                value={activeSlide?.transition ?? 'none'}
                onChange={(e) => setTransition(e.target.value as TransitionId)}
                className="rounded border border-border bg-bg-3 px-1 py-0.5 text-[10px] text-text"
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[10px] text-text-dim">
              Animation
              <select
                value={activeSlide?.animation ?? 'none'}
                onChange={(e) => setAnimation(e.target.value as AnimationId)}
                className="rounded border border-border bg-bg-3 px-1 py-0.5 text-[10px] text-text"
              >
                {ANIMATIONS.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[10px] text-text-dim">
              Theme
              <select
                value=""
                onChange={(e) => { if (e.target.value) applyTheme(e.target.value); e.target.value = ''; }}
                className="rounded border border-border bg-bg-3 px-1 py-0.5 text-[10px] text-text"
                title="Apply a quick theme preset"
              >
                <option value="">Apply…</option>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={goPrev} disabled={current === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Previous slide (←)">
          <ChevronLeft size={14} />
        </button>
        <span className="min-w-[3rem] text-center font-mono text-[11px] text-text-mid">
          {current + 1} / {slideCount}
        </span>
        <button onClick={goNext} disabled={current >= slideCount - 1} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Next slide (→)">
          <ChevronRight size={14} />
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={exportHtml} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3" title="Export HTML">
          <FileCode2 size={12} /> Export
        </button>
        <button onClick={startPresent} className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-80" title="Present (Ctrl+Shift+P)">
          <PlayIcon size={12} /> Present
        </button>
      </div>

      {/* Body: navigator + main editing area */}
      <div className="flex min-h-0 flex-1">
        {/* Slide navigator — vertical thumbnail list. Hidden on mobile. */}
        {!isMobile && (
          <aside className="flex w-44 shrink-0 flex-col border-r border-border bg-bg-2">
            <div className="border-b border-border px-2 py-1 text-[9px] font-mono uppercase text-text-dim">
              Slides · drag to reorder
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {slides.map((s, i) => (
                <SlideThumbnail
                  key={s.id}
                  index={i}
                  id={s.id}
                  content={s.content}
                  background={s.background}
                  transition={s.transition}
                  animation={s.animation}
                  isActive={i === current}
                  isDragOver={dragOver === i && dragStateRef.current?.from !== i}
                  dragMoved={!!dragStateRef.current?.moved}
                  onActivate={setCurrent}
                  onDragStart={startDrag}
                  onContextMenu={(idx, e) => setContextMenu({ idx, x: e.clientX, y: e.clientY })}
                />
              ))}
            </ul>
          </aside>
        )}

        {/* Main editing surface — the current slide, centered, with a 16:9
            aspect ratio. The contenteditable fills the slide; the user
            clicks anywhere to edit. */}
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-auto bg-bg-3 p-2 sm:p-4">
          <div
            className="relative flex aspect-video w-full max-w-4xl items-center justify-center overflow-hidden rounded-lg border border-border shadow-xl"
            style={activeBgStyle}
          >
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={commitContent}
              onBlur={() => {
                if (commitTimerRef.current) {
                  clearTimeout(commitTimerRef.current);
                  commitTimerRef.current = null;
                  const slide = slidesArr.get(current);
                  if (slide && editorRef.current) {
                    selfCommitRef.current = true;
                    slide.set('content', editorRef.current.innerHTML);
                  }
                }
                if (notesTimerRef.current) {
                  clearTimeout(notesTimerRef.current);
                  notesTimerRef.current = null;
                  const slide = slidesArr.get(current);
                  if (slide && notesRef.current) {
                    selfNotesCommitRef.current = true;
                    slide.set('notes', notesRef.current.value);
                  }
                }
              }}
              // The active slide's textColor (set by a theme) overrides the
              // default text color via inline style. Empty string falls back
              // to the inherited .text-text color.
              className="h-full w-full overflow-auto p-[6%] outline-none"
              style={{ caretColor: 'currentColor', color: activeSlide?.textColor || 'currentColor' }}
              data-placeholder="Click to add slide content…"
            />
          </div>

          {/* Speaker notes — collapsible textarea below the slide. Smaller
              default height on mobile so it doesn't crowd the editor surface. */}
          {notesOpen && (
            <div className="mt-2 w-full max-w-4xl rounded-md border border-border bg-bg-2 p-2">
              <div className="mb-1 flex items-center gap-2">
                <NotesIcon size={12} className="text-text-dim" />
                <span className="text-[10px] font-mono uppercase tracking-wider text-text-dim">Speaker notes · slide {current + 1}</span>
                <button
                  onClick={() => setNotesOpen(false)}
                  className="ml-auto text-text-dim hover:text-text"
                  aria-label="Hide notes"
                >
                  <X size={12} />
                </button>
              </div>
              <textarea
                ref={notesRef}
                onInput={commitNotes}
                placeholder="Notes for this slide (presenter view only — not shown in the export)…"
                className="h-16 w-full resize-y rounded border border-border bg-bg p-2 text-[12px] text-text outline-none focus:border-accent/40 sm:h-20"
              />
            </div>
          )}
        </main>
      </div>

      {/* Hidden image file input — the Image button (toolbar or dock panel)
          clicks it. On change, the file is read as a data URL and inserted
          as an <img> into the contenteditable. */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) insertImageFile(f);
        }}
      />

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-bg-2 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
        <span>{slideCount} slide{slideCount === 1 ? '' : 's'}</span>
        {activeSlide?.transition && activeSlide.transition !== 'none' && (
          <span>transition: {activeSlide.transition}</span>
        )}
        {activeSlide?.animation && activeSlide.animation !== 'none' && (
          <span>animation: {activeSlide.animation}</span>
        )}
        <span className="ml-auto hidden sm:inline">Click slide to edit · ←/→ navigate · Ctrl+Shift+N new · Ctrl+Shift+P present · Del deletes · Esc exits present</span>
      </div>

      {/* Slide-navigator context menu (right-click). Closes on any click
          outside or on Escape. */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          idx={contextMenu.idx}
          canMoveLeft={contextMenu.idx > 0}
          canMoveRight={contextMenu.idx < slides.length - 1}
          canDelete={slides.length > 1}
          onAdd={() => { addSlideInternal('blank'); setContextMenu(null); }}
          onDuplicate={() => { duplicateSlide(contextMenu.idx); setContextMenu(null); }}
          onDelete={() => { deleteSlide(contextMenu.idx); setContextMenu(null); }}
          onMoveLeft={() => { moveSlide(contextMenu.idx, -1); setContextMenu(null); }}
          onMoveRight={() => { moveSlide(contextMenu.idx, 1); setContextMenu(null); }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Present mode — fullscreen overlay showing only the current slide. */}
      {presenting && (
        <div
          ref={presentRef}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
          // Click-to-advance: any click on the backdrop (not on a control)
          // moves to the next slide, mirroring Keynote / PowerPoint.
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              if (current < slidesArr.length - 1) {
                setCurrent(current + 1);
                setPresentKey((k) => k + 1);
              } else {
                stopPresent();
              }
            }
          }}
        >
          <div
            key={presentKey}
            // Transition + animation stack: the transition fires on the
            // container (entrance), the animation fires on the inner content
            // (reveal). Both re-trigger on navigation because presentKey
            // remounts the wrapper.
            className={`flex aspect-video h-full max-h-screen w-full max-w-[177vh] items-center justify-center overflow-hidden present-transition-${activeSlide?.transition ?? 'none'} present-animation-${activeSlide?.animation ?? 'none'}`}
            style={activeBgStyle}
          >
            <div
              className="h-full w-full overflow-auto p-[6%]"
              style={{ color: activeSlide?.textColor || '#fff' }}
              dangerouslySetInnerHTML={{ __html: activeSlide?.content ?? '' }}
            />
          </div>
          {/* Slide counter + elapsed timer (top-left). The timer runs from
              the moment `startPresent` set presentStartRef and ticks once
              per second via the interval effect above. mm:ss format keeps
              it compact in the corner. */}
          <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-white sm:left-6 sm:top-6">
            <span>{current + 1} / {slideCount}</span>
            <span className="opacity-60">·</span>
            <span title="Elapsed time">{formatElapsed(presentElapsed)}</span>
          </div>
          {/* Progress bar (bottom) — visual sense of how far through the deck. */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-1 bg-white/10">
            <div
              className="h-full bg-white transition-[width] duration-300"
              style={{ width: `${slideCount > 0 ? ((current + 1) / slideCount) * 100 : 0}%` }}
            />
          </div>
          {/* Presenter view overlay — speaker notes for the current slide in
              a small panel at the bottom-left. Toggleable so it doesn't get
              in the way of slides that don't use notes. */}
          {presenterNotes && activeSlide?.notes && (
            <div className="pointer-events-none absolute bottom-6 left-4 right-4 max-h-32 overflow-y-auto rounded-md bg-black/70 px-4 py-2 text-sm text-white/90 sm:left-6 sm:max-w-md">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/50">Notes · slide {current + 1}</div>
              <div className="whitespace-pre-wrap">{activeSlide.notes}</div>
            </div>
          )}
          {/* Present-mode controls — bottom-right. Always visible on mobile
              (no hover state on touch); desktop shows them at 60% opacity
              and brightens on hover. */}
          <div className={`absolute bottom-4 right-4 flex items-center gap-2 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-60 hover:opacity-100'}`}>
            {/* Presenter-view toggle — shows/hides the speaker-notes overlay. */}
            <button
              onClick={(e) => { e.stopPropagation(); setPresenterNotes((v) => !v); }}
              className={`flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 ${presenterNotes ? 'bg-accent/80' : 'bg-white/10'}`}
              aria-label="Toggle presenter notes"
              aria-pressed={presenterNotes}
              title="Toggle presenter notes"
            >
              <Eye size={18} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); goPrev(); setPresentKey((k) => k + 1); }}
              disabled={current === 0}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              aria-label="Previous slide"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); if (current < slidesArr.length - 1) { setCurrent(current + 1); setPresentKey((k) => k + 1); } else { stopPresent(); } }}
              disabled={current >= slideCount - 1}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              aria-label="Next slide"
            >
              <ChevronRight size={20} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); stopPresent(); }}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              aria-label="Exit present mode"
              title="Exit (Esc)"
            >
              <X size={20} />
            </button>
          </div>
          {/* Inline transition + animation keyframes. Rendered once per
              present session; the `key={presentKey}` on the slide container
              re-triggers both on each navigation. */}
          <style>{`
            .present-transition-fade { animation: pFade 0.4s ease-out; }
            .present-transition-slide { animation: pSlide 0.4s ease-out; }
            .present-transition-zoom { animation: pZoom 0.4s ease-out; }
            .present-animation-fade-in > div { animation: paFade 0.6s ease-out; }
            .present-animation-slide-up > div { animation: paSlideUp 0.6s ease-out; }
            .present-animation-zoom-in > div { animation: paZoom 0.6s ease-out; }
            .present-animation-bounce > div { animation: paBounce 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); }
            @keyframes pFade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes pSlide { from { transform: translateX(8%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes pZoom { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            @keyframes paFade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes paSlideUp { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            @keyframes paZoom { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            @keyframes paBounce { 0% { transform: translateY(-60px); opacity: 0; } 60% { transform: translateY(8px); opacity: 1; } 80% { transform: translateY(-4px); } 100% { transform: translateY(0); } }
          `}</style>
        </div>
      )}

      {/* Inline CSS for the contenteditable placeholder (empty slide hint). */}
      <style>{`
        [data-placeholder]:empty::before {
          content: attr(data-placeholder);
          opacity: 0.4;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

/** Small icon-only toolbar button — keeps the toolbar compact. */
function ToolbarButton({ onClick, title, Icon }: { onClick: () => void; title: string; Icon: LucideIcon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
    >
      <Icon size={14} />
    </button>
  );
}

/** Slide-navigator thumbnail. Memoized so a deck-wide re-render (e.g.
 *  bumping `current` to navigate, or a remote peer editing slide 3) doesn't
 *  re-render EVERY thumbnail — only the slide whose content/background/
 *  transition/animation changed, plus the old + new "active" rows.
 *
 *  Props are deliberately primitive (string/boolean/number + stable
 *  callbacks) so the default shallow comparison catches every real change
 *  and skips the rest. The `<li>` wrapper lives here so its
 *  `data-slide-idx` + drag/context handlers ship with the memoized subtree. */
const SlideThumbnail = memo(function SlideThumbnail({
  index, id, content, background, transition, animation,
  isActive, isDragOver, dragMoved,
  onActivate, onDragStart, onContextMenu,
}: {
  index: number;
  id: string;
  content: string;
  background: string;
  transition: TransitionId;
  animation: AnimationId;
  isActive: boolean;
  isDragOver: boolean;
  /** Read from `dragStateRef.current?.moved` at render time so the click
   *  handler can suppress the post-drag click without forcing a re-render
   *  mid-drag (the ref mutates freely during the drag). */
  dragMoved: boolean;
  onActivate: (index: number) => void;
  onDragStart: (index: number, e: React.PointerEvent) => void;
  onContextMenu: (index: number, e: React.MouseEvent) => void;
}) {
  void id;
  const bgStyle = background.startsWith('linear-gradient')
    ? { backgroundImage: background }
    : { backgroundColor: background };
  return (
    <li
      data-slide-idx={index}
      onPointerDown={(e) => onDragStart(index, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(index, e);
      }}
    >
      <button
        type="button"
        onClick={() => {
          // Suppress the click that follows a drag — otherwise releasing a
          // drag would also switch the active slide to the drop target.
          if (dragMoved) return;
          onActivate(index);
        }}
        className={`group mb-1.5 flex w-full flex-col gap-1 rounded-sm border p-1 text-left transition-colors ${
          isActive ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40 hover:bg-bg-3'
        } ${isDragOver ? 'ring-2 ring-accent/60' : ''}`}
      >
        <span className="flex items-center gap-1 text-[9px] font-mono text-text-dim">
          <span
            className="flex h-3 w-3 items-center justify-center rounded-sm text-[7px] font-bold text-text-mid"
            style={bgStyle}
          >
            {index + 1}
          </span>
          {transition !== 'none' && (
            <span className="opacity-60" title={`Transition: ${transition}`}>↻</span>
          )}
          {animation !== 'none' && (
            <span className="opacity-60" title={`Animation: ${animation}`}>✨</span>
          )}
        </span>
        <span
          className="block aspect-video w-full overflow-hidden rounded-sm border border-border/50"
          style={bgStyle}
        >
          <span
            className="block h-full w-full origin-top-left scale-[0.18] text-[7px] text-text opacity-80"
            dangerouslySetInnerHTML={{ __html: content || '<span style="opacity:0.4">Blank slide</span>' }}
          />
        </span>
      </button>
    </li>
  );
});

/** Right-click context menu for a slide thumbnail. Renders as a fixed-position
 *  popover at the click coords; closes on outside click / Escape. */
function ContextMenu({
  x, y, idx, canMoveLeft, canMoveRight, canDelete,
  onAdd, onDuplicate, onDelete, onMoveLeft, onMoveRight, onClose,
}: {
  x: number; y: number; idx: number;
  canMoveLeft: boolean; canMoveRight: boolean; canDelete: boolean;
  onAdd: () => void; onDuplicate: () => void; onDelete: () => void;
  onMoveLeft: () => void; onMoveRight: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // Don't close if the click is inside the menu (let the menu item's own
      // onClick handle it).
      const el = document.getElementById('slate-slide-ctx-menu');
      if (el && el.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp the menu to the viewport so it doesn't get cut off near the edges.
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 200);

  const item = (label: string, action: () => void, opts?: { disabled?: boolean; danger?: boolean }) => (
    <button
      type="button"
      disabled={opts?.disabled}
      onClick={action}
      className={`flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[12px] ${
        opts?.danger ? 'text-danger' : 'text-text'
      } hover:bg-bg-3 disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      {label}
    </button>
  );

  return (
    <div
      id="slate-slide-ctx-menu"
      role="menu"
      className="fixed z-[300] min-w-[180px] rounded-md border border-border bg-bg-2 p-1 shadow-xl"
      style={{ left, top }}
    >
      <div className="px-2 pb-1 pt-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
        Slide {idx + 1}
      </div>
      {item('Add slide after', onAdd)}
      {item('Duplicate', onDuplicate)}
      {item('Move left', onMoveLeft, { disabled: !canMoveLeft })}
      {item('Move right', onMoveRight, { disabled: !canMoveRight })}
      {item('Delete', onDelete, { disabled: !canDelete, danger: true })}
    </div>
  );
}

/** HTML-escape a plain string for safe interpolation into the exported file. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a seconds count as `m:ss` (or `h:mm:ss` past the hour) for the
 *  present-mode elapsed-time readout. Keeps the corner compact while still
 *  scaling for long presentations. */
function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default PresentationEditor;
