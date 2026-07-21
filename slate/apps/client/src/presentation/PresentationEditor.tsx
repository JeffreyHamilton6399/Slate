/**
 * PresentationEditor — Google Slides / PowerPoint-style slide editor.
 *
 * Minimal first cut: a slide navigator (thumbnail list) on the left, a
 * main editing area showing the current slide, and a "Present" button that
 * goes fullscreen showing only the current slide.
 *
 * Each slide is stored as a Yjs Y.Map with `{ id, content (HTML string),
 * background (color) }`. Slides live in the top-level Y.Array keyed by
 * SLIDES_KEY (`slides`) so every client resolves the same shared container
 * (see sync/doc.ts container doctrine). The contenteditable binds directly
 * to the slide's `content` field — `onInput` writes back to Yjs on a
 * debounce so typing stays smooth.
 *
 * No TipTap / ProseMirror — keep this light. The contenteditable is plain
 * HTML; formatting buttons (bold/italic/underline/lists) use execCommand so
 * the markup round-trips through the slide's `content` HTML string.
 *
 * Keyboard navigation in present mode:
 *   - ArrowRight / PageDown / Space → next slide
 *   - ArrowLeft / PageUp → previous slide
 *   - Esc → exit present mode
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  Plus, Trash2, Copy as CopyIcon, ChevronLeft, ChevronRight,
  Play as PlayIcon, X,
} from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { makeId } from '../utils/id';
import { useIsMobile } from '../workspace/useMediaQuery';
import { toast } from '../ui/Toast';

/** Default background for a new slide. */
const DEFAULT_BG = '#0c0c0e';

/** Background swatches in the slide settings popover. The first one matches
 *  the default for a fresh slide; the rest cover the common light/dark
 *  presentation tones without dumping a full color picker on the user. */
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

interface Slide {
  id: string;
  content: string;
  background: string;
}

/** Read a slide Y.Map as a plain object (defensive — fields may be missing
 *  on a freshly-added slide before its first commit). */
function readSlide(m: Y.Map<unknown>, fallbackId: string): Slide {
  return {
    id: (m.get('id') as string | undefined) ?? fallbackId,
    content: (m.get('content') as string | undefined) ?? '',
    background: (m.get('background') as string | undefined) ?? DEFAULT_BG,
  };
}

export function PresentationEditor() {
  const room = useRoom();
  const slate = room.slate;
  const isMobile = useIsMobile();
  const slidesArr = useMemo(() => slate.slides(), [slate]);
  const [version, setVersion] = useState(0);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  /** Debounce timer for committing contenteditable HTML back to Yjs. Typing
   *  on every keystroke would thrash the Yjs doc (one update per char, every
   *  peer re-rendering) — 250ms after the last keystroke is responsive
   *  enough for live collab and keeps the wire quiet. */
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while the contenteditable is the source of the in-flight commit.
   *  Without this, the Yjs observer would call applyRemoteContent() every
   *  time we wrote our own edit back, clobbering the cursor position. */
  const selfCommitRef = useRef(false);
  /** The contenteditable element for the active slide — used by the
   *  formatting toolbar (execCommand needs `document.execCommand` which
   *  targets the current selection, so we just need focus). */
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** The present-mode fullscreen container — Esc exits, click navigates. */
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
      // Don't re-render the editor off our own commit — the contenteditable
      // already shows it. Other peers' edits fall through and refresh the
      // DOM via applyRemoteContent below.
      if (selfCommitRef.current) {
        selfCommitRef.current = false;
        return;
      }
      bump();
    };
    slidesArr.observeDeep(observer);
    // Late read in case the initial sync from the server lands after mount.
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
  // click into. First writer wins — concurrent peers all push the same
  // blank slide, but the id collision-free IDs keep Yjs merge clean (the
  // deck might briefly have 2-3 blanks which is fine — easy to delete).
  useEffect(() => {
    if (slidesArr.length === 0) {
      const id = makeId('slide');
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('content', '');
      m.set('background', DEFAULT_BG);
      slidesArr.push([m]);
    }
  }, [slidesArr]);

  // Clamp `current` if slides were deleted (e.g. by a peer) so we don't
  // point past the end of the array.
  useEffect(() => {
    if (current > slides.length - 1) {
      setCurrent(Math.max(0, slides.length - 1));
    }
  }, [slides.length, current]);

  // When the current slide changes (or its content arrives from a peer),
  // sync the contenteditable's innerHTML to the Yjs value — UNLESS the edit
  // originated from the contenteditable itself (avoids caret jumps).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const slide = slides[current];
    if (!slide) return;
    // Compare against the live DOM (not the React prop) so we don't rewrite
    // identical HTML and reset the caret mid-typing.
    if (el.innerHTML !== slide.content) {
      el.innerHTML = slide.content;
    }
  }, [slides, current]);

  // ── Mutations ─────────────────────────────────────────────────────────

  const addSlide = useCallback(() => {
    const id = makeId('slide');
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('content', '');
    m.set('background', DEFAULT_BG);
    slidesArr.push([m]);
    setCurrent(slidesArr.length - 1);
  }, [slidesArr]);

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
    slidesArr.insert(idx + 1, [m]);
    setCurrent(idx + 1);
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
      selfCommitRef.current = true; // suppress the Yjs observer's re-render
      slide.set('content', html);
    }, 250);
  }, [slidesArr, current]);

  /** Set the background color of the current slide. Immediate commit (no
   *  debounce) — the user picked a swatch, the change should land now. */
  const setBackground = useCallback((bg: string) => {
    const slide = slidesArr.get(current);
    if (!slide) return;
    selfCommitRef.current = true;
    slide.set('background', bg);
  }, [slidesArr, current]);

  // ── Formatting toolbar (execCommand — deprecated but still the simplest
  //  way to round-trip rich text through a contenteditable without pulling
  //  in ProseMirror). The toolbar buttons call these; the resulting markup
  //  is committed to Yjs via the contenteditable's onInput handler. */
  const exec = useCallback((cmd: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false);
    commitContent();
  }, [commitContent]);

  // ── Navigation ────────────────────────────────────────────────────────

  const goPrev = useCallback(() => setCurrent((c) => Math.max(0, c - 1)), []);
  const goNext = useCallback(() => setCurrent((c) => Math.min(slidesArr.length - 1, c + 1)), [slidesArr.length]);

  // ── Present (fullscreen) mode ─────────────────────────────────────────

  const startPresent = useCallback(async () => {
    setPresenting(true);
    // Wait a tick for the fullscreen container to mount, then request
    // fullscreen on it. Some browsers throw if the element isn't in the
    // document yet, hence the rAF.
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
  }, []);

  // Sync `presenting` with the browser's fullscreen state so Esc (which the
  // browser handles itself) closes our overlay too.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && presenting) setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [presenting]);

  // Keyboard navigation in present mode: ←/→ to move, Esc to exit.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        if (current < slidesArr.length - 1) setCurrent(current + 1);
        else stopPresent();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setCurrent((c) => Math.max(0, c - 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stopPresent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, current, slidesArr.length, stopPresent]);

  // ── Render ────────────────────────────────────────────────────────────

  const activeSlide = slides[current];
  const slideCount = slides.length;

  return (
    <div className="flex h-full w-full flex-col bg-bg text-text overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-bg-2 px-2 py-1.5 [&>*]:shrink-0">
        <button onClick={addSlide} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20" title="Add slide">
          <Plus size={12} /> Slide
        </button>
        <button onClick={() => duplicateSlide(current)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3" title="Duplicate slide">
          <CopyIcon size={12} /> Duplicate
        </button>
        <button onClick={() => deleteSlide(current)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3 hover:text-danger" title="Delete slide">
          <Trash2 size={12} /> Delete
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        {/* Formatting — execCommand. Hidden on mobile (the slide content is
            still editable by direct touch; these just add B/I/U + lists). */}
        {!isMobile && (
          <>
            <button onClick={() => exec('bold')} className="flex h-7 w-7 items-center justify-center rounded font-bold text-text-mid hover:bg-bg-3" title="Bold">B</button>
            <button onClick={() => exec('italic')} className="flex h-7 w-7 items-center justify-center rounded italic text-text-mid hover:bg-bg-3" title="Italic">I</button>
            <button onClick={() => exec('underline')} className="flex h-7 w-7 items-center justify-center rounded underline text-text-mid hover:bg-bg-3" title="Underline">U</button>
            <button onClick={() => exec('insertUnorderedList')} className="flex h-7 w-7 items-center justify-center rounded text-xs text-text-mid hover:bg-bg-3" title="Bullet list">•</button>
            <button onClick={() => exec('insertOrderedList')} className="flex h-7 w-7 items-center justify-center rounded text-xs text-text-mid hover:bg-bg-3" title="Numbered list">1.</button>
            <div className="mx-1 h-5 w-px bg-border" />
          </>
        )}
        {/* Background swatches */}
        <div className="flex items-center gap-0.5">
          {BG_SWATCHES.map((bg) => (
            <button
              key={bg}
              onClick={() => setBackground(bg)}
              className={`h-5 w-5 rounded-full border ${activeSlide?.background === bg ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
              style={{ backgroundColor: bg }}
              title={`Background: ${bg}`}
              aria-label={`Set background ${bg}`}
            />
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={goPrev} disabled={current === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Previous slide">
          <ChevronLeft size={14} />
        </button>
        <span className="min-w-[3rem] text-center font-mono text-[11px] text-text-mid">
          {current + 1} / {slideCount}
        </span>
        <button onClick={goNext} disabled={current >= slideCount - 1} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Next slide">
          <ChevronRight size={14} />
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={startPresent} className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-80" title="Present (fullscreen)">
          <PlayIcon size={12} /> Present
        </button>
      </div>

      {/* Body: navigator + main editing area */}
      <div className="flex min-h-0 flex-1">
        {/* Slide navigator — vertical thumbnail list. Hidden on mobile to
            give the editing surface the full width; the user navigates with
            Prev/Next + the slide counter in the toolbar. */}
        {!isMobile && (
          <aside className="flex w-44 shrink-0 flex-col border-r border-border bg-bg-2">
            <div className="border-b border-border px-2 py-1 text-[9px] font-mono uppercase text-text-dim">
              Slides
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {slides.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setCurrent(i)}
                    className={`group mb-1.5 flex w-full flex-col gap-1 rounded-sm border p-1 text-left transition-colors ${i === current ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40 hover:bg-bg-3'}`}
                  >
                    <span className="flex items-center gap-1 text-[9px] font-mono text-text-dim">
                      <span className="flex h-3 w-3 items-center justify-center rounded-sm text-[7px] font-bold text-text-mid" style={{ backgroundColor: s.background }}>{i + 1}</span>
                    </span>
                    {/* Thumbnail: a tiny preview of the slide's content + bg. */}
                    <span
                      className="block aspect-video w-full overflow-hidden rounded-sm border border-border/50"
                      style={{ backgroundColor: s.background }}
                    >
                      <span
                        className="block h-full w-full origin-top-left scale-[0.18] text-[7px] text-text opacity-80"
                        // Slide content as static HTML preview (read-only)
                        dangerouslySetInnerHTML={{ __html: s.content || '<span style="opacity:0.4">Blank slide</span>' }}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        {/* Main editing surface — the current slide, centered, with a 16:9
            aspect ratio. The contenteditable fills the slide; the user
            clicks anywhere to edit. */}
        <main className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-bg-3 p-4">
          <div
            className="relative flex aspect-video w-full max-w-4xl items-center justify-center overflow-hidden rounded-lg border border-border shadow-xl"
            style={{ backgroundColor: activeSlide?.background ?? DEFAULT_BG }}
          >
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={commitContent}
              onBlur={() => {
                // Flush any pending commit immediately on blur so the user's
                // last keystroke lands before they navigate away.
                if (commitTimerRef.current) {
                  clearTimeout(commitTimerRef.current);
                  commitTimerRef.current = null;
                  const slide = slidesArr.get(current);
                  if (slide && editorRef.current) {
                    selfCommitRef.current = true;
                    slide.set('content', editorRef.current.innerHTML);
                  }
                }
              }}
              className="h-full w-full overflow-auto p-[6%] text-text outline-none"
              style={{ caretColor: 'currentColor' }}
              data-placeholder="Click to add slide content…"
            />
          </div>
        </main>
      </div>

      {/* Status bar — slides count + present-mode hint. Slightly larger than
          the audio editor's so it's readable. */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-bg-2 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
        <span>{slideCount} slide{slideCount === 1 ? '' : 's'}</span>
        <span className="ml-auto hidden sm:inline">Click slide to edit · ←/→ navigate · Present = fullscreen · Esc exits</span>
      </div>

      {/* Present mode — fullscreen overlay showing only the current slide. */}
      {presenting && (
        <div
          ref={presentRef}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
        >
          <div
            className="flex aspect-video h-full max-h-screen w-full max-w-[177vh] items-center justify-center overflow-hidden"
            style={{ backgroundColor: activeSlide?.background ?? DEFAULT_BG }}
          >
            <div
              className="h-full w-full overflow-auto p-[6%] text-text"
              dangerouslySetInnerHTML={{ __html: activeSlide?.content ?? '' }}
            />
          </div>
          {/* Present-mode controls — bottom-right, hidden until hover. */}
          <div className="absolute bottom-4 right-4 flex items-center gap-2 opacity-60 transition-opacity hover:opacity-100">
            <button
              onClick={goPrev}
              disabled={current === 0}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              aria-label="Previous slide"
            >
              <ChevronLeft size={20} />
            </button>
            <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-white">
              {current + 1} / {slideCount}
            </span>
            <button
              onClick={goNext}
              disabled={current >= slideCount - 1}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              aria-label="Next slide"
            >
              <ChevronRight size={20} />
            </button>
            <button
              onClick={stopPresent}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              aria-label="Exit present mode"
              title="Exit (Esc)"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PresentationEditor;
