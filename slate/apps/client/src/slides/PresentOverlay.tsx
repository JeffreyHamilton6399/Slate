/**
 * Present mode — the full-screen show.
 *
 * Everything renders through the same <SlideView> the editor stage and the
 * thumbnail rail use, so what you present is by construction what you
 * authored; this file only adds the presenting *apparatus* around it:
 *
 *   - Auto-hiding controls + cursor. The chrome disappears after a couple of
 *     idle seconds so the audience sees only the slide, and comes straight
 *     back on the first mouse move.
 *   - A presenter sidebar (S) with speaker notes, the next slide, an elapsed
 *     timer, and the wall clock — the single-screen version of a second
 *     display, the way Reveal.js and Keynote's rehearsal view work.
 *   - An overview grid (O) to jump anywhere in the deck mid-talk.
 *   - Blackout / whiteout (B / W) for "look at me, not the screen" moments.
 *   - A laser pointer (L), swipe navigation, and per-slide entrance
 *     transitions.
 *
 * The overlay is portalled to <body>: it must sit above the header, the docks
 * and the floating People widget, none of which know it exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Grid2x2,
  StickyNote,
  Maximize,
  Minimize,
  X,
  Pause,
  Play,
  RotateCcw,
  Keyboard,
  Radius,
  Contrast,
} from 'lucide-react';
import { SLIDE_W, SLIDE_H, type Slide, type SlideElement } from '@slate/sync-protocol';
import { SlideView } from './SlideView';
import { muteToasts } from '../ui/Toast';
import { cn } from '../utils/cn';

/** Idle delay before the chrome and the cursor fade away. */
const IDLE_MS = 2600;
/** Slide-sorter tile width in the overview grid. */
const OVERVIEW_THUMB_W = 232;

type Blank = 'none' | 'black' | 'white';

/** Entrance animation class for the slide we are arriving at. */
function enterClass(slide: Slide, dir: 1 | -1): string {
  switch (slide.transition ?? 'fade') {
    case 'none':
      return '';
    case 'slide':
      return dir === 1 ? 'slide-enter-right' : 'slide-enter-left';
    case 'zoom':
      return 'slide-enter-zoom';
    default:
      return 'slide-enter-fade';
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

interface PresentOverlayProps {
  slides: Slide[];
  elementsBySlide: Map<string, SlideElement[]>;
  index: number;
  onNavigate: (i: number) => void;
  onExit: () => void;
}

export function PresentOverlay({
  slides,
  elementsBySlide,
  index,
  onNavigate,
  onExit,
}: PresentOverlayProps) {
  const count = slides.length;
  const clamped = Math.min(Math.max(0, index), Math.max(0, count - 1));
  const slide = slides[clamped] ?? null;

  // ── Panels / display state ────────────────────────────────────────────────
  const [notesOpen, setNotesOpen] = useState(false);
  const [overview, setOverview] = useState(false);
  const [help, setHelp] = useState(false);
  const [blank, setBlank] = useState<Blank>('none');
  const [laser, setLaser] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Direction of the last navigation, so 'slide' transitions travel the way
  // the deck is moving. A ref (not state) — it must be current when the new
  // slide renders, without costing an extra render of its own.
  const dirRef = useRef<1 | -1>(1);

  // ── Navigation ────────────────────────────────────────────────────────────
  const goTo = useCallback(
    (i: number) => {
      const next = Math.min(Math.max(0, i), count - 1);
      dirRef.current = next >= clamped ? 1 : -1;
      setAtEnd(false);
      setBlank('none');
      if (next !== clamped) onNavigate(next);
    },
    [clamped, count, onNavigate],
  );

  const next = useCallback(() => {
    if (blank !== 'none') {
      setBlank('none');
      return;
    }
    if (clamped < count - 1) goTo(clamped + 1);
    // Past the last slide, park on the end card. Leaving is always deliberate
    // (Esc or the card's Exit) — advancing off the end should never dump the
    // presenter back into the editor in front of a room.
    else setAtEnd(true);
  }, [blank, clamped, count, goTo]);

  const prev = useCallback(() => {
    if (blank !== 'none') {
      setBlank('none');
      return;
    }
    if (atEnd) {
      setAtEnd(false);
      return;
    }
    if (clamped > 0) goTo(clamped - 1);
  }, [atEnd, blank, clamped, goTo]);

  // ── Fullscreen ────────────────────────────────────────────────────────────
  // Only ever exit fullscreen we ourselves entered — presenting inside a
  // window the user had already put in fullscreen shouldn't yank them out.
  const weEnteredFs = useRef(false);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      weEnteredFs.current = true;
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    if (!document.fullscreenElement) {
      weEnteredFs.current = true;
      // Best effort: some browsers refuse without a fresh gesture. The show
      // works either way — the overlay already covers the viewport.
      void document.documentElement.requestFullscreen?.().catch(() => {
        weEnteredFs.current = false;
      });
    }
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (weEnteredFs.current && document.fullscreenElement) {
        void document.exitFullscreen?.().catch(() => {});
      }
    };
  }, []);

  // No "Connection lost" cards on the projector while you're mid-sentence.
  useEffect(() => {
    muteToasts(true);
    return () => muteToasts(false);
  }, []);

  // ── Elapsed timer ─────────────────────────────────────────────────────────
  const [running, setRunning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const baseRef = useRef({ at: Date.now(), acc: 0 });
  useEffect(() => {
    if (!running) return;
    baseRef.current.at = Date.now();
    const t = setInterval(
      () => setElapsed(baseRef.current.acc + (Date.now() - baseRef.current.at)),
      500,
    );
    return () => clearInterval(t);
  }, [running]);
  const toggleTimer = useCallback(() => {
    setRunning((r) => {
      if (r) baseRef.current.acc += Date.now() - baseRef.current.at;
      else baseRef.current.at = Date.now();
      return !r;
    });
  }, []);
  const resetTimer = useCallback(() => {
    baseRef.current = { at: Date.now(), acc: 0 };
    setElapsed(0);
  }, []);
  // Wall clock, minute resolution — presenters glance at it, not stare.
  const [wall, setWall] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setWall(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // ── Idle / cursor hiding ──────────────────────────────────────────────────
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [wake]);
  // Any panel being open means the presenter is driving the UI, not talking.
  const chromeHidden = idle && !overview && !help && !notesOpen;

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // A pending "type a number, press Enter" jump, Keynote/Reveal style.
  const jumpRef = useRef('');
  const [jump, setJump] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      wake();
      const k = e.key;
      // Everything this handler acts on is swallowed here. Without it the
      // app-level cheatsheet ('?') and the editor's own bindings fire too, and
      // a key press does two unrelated things at once.
      const own = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (/^[0-9]$/.test(k)) {
        own();
        jumpRef.current = (jumpRef.current + k).slice(0, 4);
        setJump(jumpRef.current);
        return;
      }
      if (k === 'Enter' && jumpRef.current) {
        own();
        goTo(parseInt(jumpRef.current, 10) - 1);
        jumpRef.current = '';
        setJump('');
        return;
      }
      if (jumpRef.current) {
        jumpRef.current = '';
        setJump('');
      }

      switch (k) {
        case 'Escape':
          own();
          // Peel off one layer at a time; only a bare Escape ends the show.
          if (help) setHelp(false);
          else if (overview) setOverview(false);
          else if (blank !== 'none') setBlank('none');
          else onExit();
          return;
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
        case 'PageDown':
          own();
          next();
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          own();
          prev();
          return;
        case 'Home':
          own();
          goTo(0);
          return;
        case 'End':
          own();
          goTo(count - 1);
          return;
      }

      switch (k.toLowerCase()) {
        case 'n':
          own();
          next();
          break;
        case 'p':
          own();
          prev();
          break;
        case 'f':
          own();
          toggleFullscreen();
          break;
        case 'b':
        case '.':
          own();
          setBlank((v) => (v === 'black' ? 'none' : 'black'));
          break;
        case 'w':
          own();
          setBlank((v) => (v === 'white' ? 'none' : 'white'));
          break;
        case 'o':
        case 'g':
          own();
          setOverview((v) => !v);
          break;
        case 's':
          own();
          setNotesOpen((v) => !v);
          break;
        case 'l':
          own();
          setLaser((v) => !v);
          break;
        case 't':
          own();
          toggleTimer();
          break;
        case 'r':
          own();
          resetTimer();
          break;
        case '?':
        case 'h':
          own();
          setHelp((v) => !v);
          break;
      }
    };
    // Capture: the editor's own shortcut handler is still mounted underneath.
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [
    blank,
    count,
    goTo,
    help,
    next,
    onExit,
    overview,
    prev,
    resetTimer,
    toggleFullscreen,
    toggleTimer,
    wake,
  ]);

  // ── Stage sizing ──────────────────────────────────────────────────────────
  // Measured from the stage container rather than the window, so opening the
  // presenter sidebar re-fits the slide instead of cropping it.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setBox({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);
  const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / SLIDE_W, box.h / SLIDE_H) : 0;

  // ── Swipe + wheel navigation ──────────────────────────────────────────────
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const wheelLock = useRef(0);

  // ── Laser pointer ─────────────────────────────────────────────────────────
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!laser) setDot(null);
  }, [laser]);

  const nextSlide = slides[clamped + 1] ?? null;
  const notes = slide?.notes?.trim() ?? '';

  const body = useMemo(() => (typeof document === 'undefined' ? null : document.body), []);
  if (!body || !slide) return null;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 flex select-none bg-black text-white',
        chromeHidden && 'cursor-none',
      )}
      style={{ zIndex: 400 }}
      onPointerMove={(e) => {
        wake();
        if (laser) setDot({ x: e.clientX, y: e.clientY });
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        touchRef.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchRef.current;
        const t = e.changedTouches[0];
        touchRef.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(t.clientY - start.y)) {
          if (dx < 0) next();
          else prev();
        }
      }}
      onWheel={(e) => {
        // Rate-limited so a trackpad flick advances one slide, not twelve.
        if (overview) return;
        const now = Date.now();
        if (now - wheelLock.current < 420) return;
        if (Math.abs(e.deltaY) < 12) return;
        wheelLock.current = now;
        if (e.deltaY > 0) next();
        else prev();
      }}
    >
      {/* ── Stage column ───────────────────────────────────────────────────── */}
      {/* The control bar lives in here rather than in the overlay so it stays
          centred under the slide when the presenter sidebar is open. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
      <div
        ref={stageRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        onClick={() => {
          if (overview || help) return;
          next();
        }}
      >
        {scale > 0 && (
          <div key={slide.id} className={enterClass(slide, dirRef.current)}>
            <SlideView
              background={slide.background}
              elements={elementsBySlide.get(slide.id) ?? []}
              scale={scale}
            />
          </div>
        )}

        {/* End-of-deck card. Advancing past the last slide lands here rather
            than dumping the presenter back into the editor mid-sentence. */}
        {atEnd && (
          <div className="absolute inset-0 grid place-items-center bg-black text-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-2xl font-medium">End of presentation</p>
              <p className="text-sm text-white/50">
                {count} slide{count === 1 ? '' : 's'} · {clock(elapsed)} elapsed
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  className="rounded-md border border-white/20 px-4 py-2 text-sm transition-colors hover:bg-white/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    goTo(0);
                  }}
                >
                  Start over
                </button>
                <button
                  className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-transform hover:scale-105"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExit();
                  }}
                >
                  Exit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Blackout / whiteout. */}
        {blank !== 'none' && (
          <div
            className="absolute inset-0"
            style={{ background: blank === 'black' ? '#000' : '#fff' }}
          />
        )}

        {/* Edge arrows — big, quiet hit targets that fade with the chrome. */}
        <EdgeArrow
          side="left"
          hidden={chromeHidden || clamped === 0}
          onClick={prev}
          label="Previous slide"
        />
        <EdgeArrow
          side="right"
          hidden={chromeHidden || (clamped === count - 1 && atEnd)}
          onClick={next}
          label="Next slide"
        />

        {/* Progress. Always visible: it's information for the audience too. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-white/10">
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${count ? ((clamped + 1) / count) * 100 : 0}%` }}
          />
        </div>

        {/* Pending "jump to slide N". */}
        {jump && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-6 py-3 font-mono text-4xl backdrop-blur">
            {jump}
          </div>
        )}
      </div>

      {/* ── Control bar ────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-black/70 px-2 py-1.5 backdrop-blur transition-opacity duration-300',
          chromeHidden ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <CtlButton title="Previous (←)" onClick={prev} disabled={clamped === 0 && !atEnd}>
          <ChevronLeft size={17} />
        </CtlButton>
        <span className="min-w-[4.5rem] text-center font-mono text-xs tabular-nums text-white/70">
          {clamped + 1} / {count}
        </span>
        <CtlButton title="Next (→)" onClick={next}>
          <ChevronRight size={17} />
        </CtlButton>
        <Divider />
        <CtlButton title="Slide overview (O)" active={overview} onClick={() => setOverview((v) => !v)}>
          <Grid2x2 size={16} />
        </CtlButton>
        <CtlButton
          title="Presenter view — notes, next slide, timer (S)"
          active={notesOpen}
          onClick={() => setNotesOpen((v) => !v)}
        >
          <StickyNote size={16} />
        </CtlButton>
        <CtlButton
          title="Blackout (B) · whiteout (W)"
          active={blank !== 'none'}
          onClick={() => setBlank((v) => (v === 'none' ? 'black' : 'none'))}
        >
          <Contrast size={16} />
        </CtlButton>
        <CtlButton title="Laser pointer (L)" active={laser} onClick={() => setLaser((v) => !v)}>
          <Radius size={16} />
        </CtlButton>
        <Divider />
        <span
          className="px-1 font-mono text-xs tabular-nums text-white/50"
          title="Elapsed (T pause · R reset)"
        >
          {clock(elapsed)}
        </span>
        <CtlButton
          title={fullscreen ? 'Leave fullscreen (F)' : 'Fullscreen (F)'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </CtlButton>
        <CtlButton title="Shortcuts (?)" active={help} onClick={() => setHelp((v) => !v)}>
          <Keyboard size={16} />
        </CtlButton>
        <CtlButton title="End presentation (Esc)" onClick={onExit}>
          <X size={17} />
        </CtlButton>
      </div>
      </div>

      {/* ── Presenter sidebar ──────────────────────────────────────────────── */}
      {notesOpen && (
        <aside className="flex w-[22rem] flex-none flex-col gap-3 border-l border-white/10 bg-[#0c0c0e] p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
              Presenter view
            </span>
            <button
              className="rounded p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
              title="Close presenter view (S)"
              onClick={() => setNotesOpen(false)}
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-3xl tabular-nums">{clock(elapsed)}</span>
            <button
              className="rounded p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              title={running ? 'Pause timer (T)' : 'Resume timer (T)'}
              onClick={toggleTimer}
            >
              {running ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              className="rounded p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              title="Reset timer (R)"
              onClick={resetTimer}
            >
              <RotateCcw size={14} />
            </button>
            <span className="ml-auto font-mono text-xs text-white/40">
              {wall.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
              {nextSlide ? `Next · slide ${clamped + 2}` : 'Last slide'}
            </div>
            {nextSlide ? (
              <SlideView
                background={nextSlide.background}
                elements={elementsBySlide.get(nextSlide.id) ?? []}
                scale={328 / SLIDE_W}
                className="rounded-md ring-1 ring-white/10"
              />
            ) : (
              <div
                className="grid place-items-center rounded-md text-xs text-white/30 ring-1 ring-white/10"
                style={{ height: (328 / SLIDE_W) * SLIDE_H }}
              >
                End of deck
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
              Speaker notes
            </div>
            <div className="h-full overflow-y-auto whitespace-pre-wrap pr-1 text-sm leading-relaxed text-white/80">
              {notes || <span className="text-white/25">No notes for this slide.</span>}
            </div>
          </div>
        </aside>
      )}

      {/* ── Overview grid ──────────────────────────────────────────────────── */}
      {overview && (
        <div
          className="absolute inset-0 z-20 overflow-y-auto bg-black/95 p-6"
          onClick={() => setOverview(false)}
        >
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm text-white/60">Jump to a slide</span>
            <button
              className="rounded p-1 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              title="Close (Esc)"
              onClick={() => setOverview(false)}
            >
              <X size={16} />
            </button>
          </div>
          {/* Fixed-size tiles, wrapped and centred. A fluid grid track would
              stretch the button past the thumbnail it contains (SlideView is
              sized in pixels), leaving a dead strip beside every slide. */}
          <div className="flex flex-wrap gap-3">
            {slides.map((s, i) => (
              <button
                key={s.id}
                title={`Slide ${i + 1}`}
                className="group flex flex-none flex-col items-center gap-1 transition-transform hover:scale-[1.03]"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(i);
                  setOverview(false);
                }}
              >
                <SlideView
                  background={s.background}
                  elements={elementsBySlide.get(s.id) ?? []}
                  scale={OVERVIEW_THUMB_W / SLIDE_W}
                  className={cn(
                    'overflow-hidden rounded-md ring-1',
                    i === clamped ? 'ring-2 ring-accent' : 'ring-white/10',
                  )}
                />
                <span
                  className={cn(
                    'font-mono text-[10px]',
                    i === clamped ? 'text-accent' : 'text-white/40',
                  )}
                >
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Shortcut help ──────────────────────────────────────────────────── */}
      {help && (
        <div
          className="absolute inset-0 z-40 grid place-items-center bg-black/85 backdrop-blur-sm"
          onClick={() => setHelp(false)}
        >
          <div
            className="max-h-[80vh] overflow-y-auto rounded-lg border border-white/10 bg-[#111114] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium">Presenting shortcuts</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-xs text-white/70">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={what} className="contents">
                  <dt className="font-mono text-white/90">{keys}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {/* Laser dot — pointer-events-none so it never eats a click. */}
      {laser && dot && (
        <div
          className="pointer-events-none fixed h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: dot.x,
            top: dot.y,
            background: 'radial-gradient(circle, rgba(255,64,64,0.95) 0%, rgba(255,32,32,0.35) 55%, transparent 72%)',
            boxShadow: '0 0 14px 4px rgba(255,48,48,0.55)',
          }}
        />
      )}
    </div>,
    body,
  );
}

const SHORTCUTS: [string, string][] = [
  ['→ ␣ N', 'Next slide'],
  ['← P', 'Previous slide'],
  ['Home / End', 'First / last slide'],
  ['1…9 then ⏎', 'Jump to slide number'],
  ['O', 'Slide overview'],
  ['S', 'Presenter view (notes, next, timer)'],
  ['B / W', 'Black / white screen'],
  ['L', 'Laser pointer'],
  ['T / R', 'Pause / reset timer'],
  ['F', 'Toggle fullscreen'],
  ['Esc', 'End presentation'],
];

function Divider() {
  return <div className="mx-1 h-5 w-px bg-white/15" />;
}

function CtlButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-lg transition-colors disabled:opacity-25',
        active ? 'bg-accent text-white' : 'text-white/70 hover:bg-white/15 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

function EdgeArrow({
  side,
  hidden,
  onClick,
  label,
}: {
  side: 'left' | 'right';
  hidden: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'absolute top-1/2 z-10 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white/70 backdrop-blur transition-opacity duration-300 hover:bg-black/70 hover:text-white',
        side === 'left' ? 'left-4' : 'right-4',
        hidden ? 'pointer-events-none opacity-0' : 'opacity-70',
      )}
    >
      {side === 'left' ? <ChevronLeft size={26} /> : <ChevronRight size={26} />}
    </button>
  );
}
