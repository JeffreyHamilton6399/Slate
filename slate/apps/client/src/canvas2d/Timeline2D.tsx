/**
 * Timeline2D — 2D animation timeline (Adobe Animate style).
 * Two modes:
 *   - Keyframe mode (default): continuous keyframe timeline with diamonds,
 *     scrubber, play/pause. Interpolates between keyframes.
 *   - Frame mode (Adobe Animate style): frame strip with frame numbers,
 *     onion skinning (ghost previous/next frames), step frame-by-frame.
 * Toggled by the animMode setting in useCanvasStore.
 */

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Diamond, Plus, Trash2, ChevronDown, ChevronUp, Film, Layers, SkipBack, SkipForward } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { useCanvasStore } from './store';
import { sampleAnim2D } from './animation';
import { insertKeyframe2D, deleteKeyframe2D, moveKeyframe2D } from './keyframes';
import { audioEditorHovered } from '../audio/AudioEditor';
import type { Shape } from '@slate/sync-protocol';

interface TimelineProps {
  selection: Set<string>;
}

export function Timeline2D({ selection }: TimelineProps) {
  const room = useRoom();
  const slate = room.slate;
  const [version, setVersion] = useState(0);
  const animTime = useCanvasStore((s) => s.animTime);
  const animDuration = useCanvasStore((s) => s.animDuration);
  const animPlaying = useCanvasStore((s) => s.animPlaying);
  const setAnimTime = useCanvasStore((s) => s.setAnimTime);
  const setAnimDuration = useCanvasStore((s) => s.setAnimDuration);
  const setAnimPlaying = useCanvasStore((s) => s.setAnimPlaying);
  const setAnimPreview = useCanvasStore((s) => s.setAnimPreview);
  const animMode = useCanvasStore((s) => s.animMode);
  const animFps = useCanvasStore((s) => s.animFps);
  const animFrame = useCanvasStore((s) => s.animFrame);
  const setAnimFrame = useCanvasStore((s) => s.setAnimFrame);
  const setAnimFps = useCanvasStore((s) => s.setAnimFps);
  const onionSkin = useCanvasStore((s) => s.onionSkin);
  const setOnionSkin = useCanvasStore((s) => s.setOnionSkin);
  const [open, setOpen] = useState(true);
  const [userToggled, setUserToggled] = useState(false);
  const dragRef = useRef<{ shapeId: string; curT: number; startX: number } | null>(null);
  /** Frame-strip scroll container — keeps the active frame in view. */
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Keep the active frame visible while playing/scrubbing: without this the
  // playhead runs off the right edge of the strip and playback looks stuck.
  useEffect(() => {
    if (!animMode) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-frame="${animFrame}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [animMode, animFrame]);

  // Subscribe to Yjs shapes + strokes so both keyframe and cel-frame changes
  // refresh the timeline (frame content markers track strokes too).
  useEffect(() => {
    const shapes = slate.shapes();
    const strokes = slate.strokes();
    const bump = () => setVersion((v) => v + 1);
    shapes.observeDeep(bump);
    strokes.observeDeep(bump);
    return () => {
      shapes.unobserveDeep(bump);
      strokes.unobserveDeep(bump);
    };
  }, [slate]);

  // Read all shapes from Yjs (lightweight — no samples).
  const allShapes: Shape[] = [];
  slate.shapes().forEach((m) => {
    const candidate: Record<string, unknown> = {};
    m.forEach((v, k) => { candidate[k] = v; });
    if (candidate.id && candidate.kind) allShapes.push(candidate as unknown as Shape);
  });

  // Frames that hold cel content (any shape or stroke stamped onto that frame).
  // Drives the "this frame has a drawing" markers on the frame strip.
  const framesWithContent = new Set<number>();
  for (const s of allShapes) if (typeof s.frame === 'number') framesWithContent.add(s.frame);
  slate.strokes().forEach((m) => {
    const f = m.get('frame');
    if (typeof f === 'number') framesWithContent.add(f);
  });

  const anyAnimated = allShapes.some((s) => (s.anim?.length ?? 0) > 0);
  // Auto-expand when animation first appears (unless user toggled).
  useEffect(() => {
    if (anyAnimated && !userToggled) setOpen(true);
  }, [anyAnimated, userToggled]);

  // Animated shapes in the current selection.
  const animated = allShapes.filter(
    (s) => selection.has(s.id) && (s.anim?.length ?? 0) > 0,
  );

  // Playback loop. In frame (cel) mode this steps one frame at a time at the
  // configured FPS and loops; in keyframe mode it advances continuous time.
  const lastRef = useRef(0);
  useEffect(() => {
    if (!animPlaying) return;
    let raf = 0;
    lastRef.current = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const s = useCanvasStore.getState();
      if (s.animMode) {
        const fps = Math.max(1, s.animFps);
        const total = Math.max(1, Math.ceil(s.animDuration * fps));
        if (now - lastRef.current >= 1000 / fps) {
          lastRef.current = now;
          s.setAnimFrame((s.animFrame + 1) % total);
        }
      } else {
        const dt = Math.min((now - lastRef.current) / 1000, 0.1);
        lastRef.current = now;
        s.setAnimTime((s.animTime + dt) % s.animDuration);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animPlaying]);

  // Stop preview when playback ends.
  useEffect(() => {
    if (!animPlaying && animTime === 0) setAnimPreview(false);
  }, [animPlaying, animTime, setAnimPreview]);

  // Keyframe drag (global handlers).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const trackEl = document.getElementById('timeline2d-track');
      if (!trackEl) return;
      const r = trackEl.getBoundingClientRect();
      const newT = Math.max(0, Math.min(animDuration, ((e.clientX - r.left) / r.width) * animDuration));
      moveKeyframe2D(slate, d.shapeId, d.curT, newT);
      d.curT = newT;
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [slate, animDuration]);

  // Keyboard: I = insert keyframe, Space = play/pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'i' || e.key === 'I') {
        if (selection.size > 0) {
          e.preventDefault();
          insertKeyframe2D(slate, [...selection], animTime);
        }
      } else if (e.key === ' ') {
        // Space plays if there's keyframe animation OR we're in frame (cel)
        // mode — cel playback doesn't need keyframed shapes (mirrors the Play
        // button's enabled state). Yields to the audio transport while the
        // pointer is over the docked audio editor.
        if ((anyAnimated || animMode) && !audioEditorHovered.current) {
          e.preventDefault();
          setAnimPlaying(!animPlaying);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slate, selection, animTime, animPlaying, anyAnimated, animMode, setAnimPlaying]);

<<<<<<< HEAD
  // Always render at least the collapsed header bar so the timeline can never
  // disappear with no way to bring it back — collapsing just shrinks it to the
  // thin header (the chevron re-expands it).
=======
  if (!animMode && !anyAnimated && !open) return null;

>>>>>>> b642fba (Round 6: smooth audio drag (rAF throttle), live import update, eraser rAF throttle + dedup, fix track sliders (direct node writes), 2D animation mode toggle (frame-based Adobe Animate style with onion skin))
  const totalFrames = Math.ceil(animDuration * animFps);

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md border border-border bg-bg-2/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          onClick={() => { setUserToggled(true); setOpen(!open); }}
          className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-dim hover:text-text"
        >
          {open ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
          {animMode ? 'Animation' : 'Timeline'}
        </button>
        <div className="flex-1" />
        {/* Mode toggle: Keyframe vs Frame (Adobe Animate) */}
        <button
          onClick={() => { useCanvasStore.getState().setAnimMode(!animMode); }}
          className={`flex h-6 items-center gap-1 rounded px-1.5 text-[9px] font-mono uppercase ${animMode ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`}
          title={animMode ? 'Switch to keyframe mode' : 'Switch to frame animation mode (Adobe Animate)'}
        >
          <Film size={10} />
          {animMode ? 'Frame' : 'Key'}
        </button>
        {animMode && (
          <button
            onClick={() => setOnionSkin(!onionSkin)}
            className={`flex h-6 w-6 items-center justify-center rounded ${onionSkin ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`}
            title="Onion skin (ghost previous/next frames)"
          >
            <Layers size={11} />
          </button>
        )}
        {animMode && (
          <>
            <button
              onClick={() => setAnimFrame(Math.max(0, animFrame - 1))}
              disabled={animFrame <= 0}
              className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30"
              title="Previous frame"
            >
              <SkipBack size={10} />
            </button>
            <button
              onClick={() => setAnimFrame(Math.min(totalFrames - 1, animFrame + 1))}
              disabled={animFrame >= totalFrames - 1}
              className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30"
              title="Next frame"
            >
              <SkipForward size={10} />
            </button>
          </>
        )}
        <button
          onClick={() => setAnimPlaying(!animPlaying)}
          disabled={!anyAnimated && !animMode}
          className={`flex h-6 w-6 items-center justify-center rounded ${animPlaying ? 'bg-warn/20 text-warn' : 'text-text-mid hover:bg-bg-3'} disabled:opacity-30`}
          title="Play (Space)"
        >
          {animPlaying ? <Pause size={11} /> : <Play size={11} />}
        </button>
        <button
          onClick={() => { if (selection.size > 0) insertKeyframe2D(slate, [...selection], animMode ? animFrame / animFps : animTime); }}
          disabled={selection.size === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-accent disabled:opacity-30"
          title="Insert Keyframe (I)"
        >
          <Diamond size={11} />
        </button>
        <button
          onClick={() => { if (selection.size > 0) deleteKeyframe2D(slate, [...selection], animMode ? animFrame / animFps : animTime); }}
          disabled={selection.size === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger disabled:opacity-30"
          title="Delete Keyframe"
        >
          <Trash2 size={10} />
        </button>
        {animMode ? (
          <label className="flex items-center gap-1 text-[10px] text-text-dim">
            FPS
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={animFps}
              onChange={(e) => setAnimFps(Number(e.target.value))}
              className="w-10 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-[10px] text-text outline-none focus:border-accent"
            />
          </label>
        ) : (
          <label className="flex items-center gap-1 text-[10px] text-text-dim">
            End
            <input
              type="number"
              min={0.5}
              max={600}
              step={0.5}
              value={animDuration}
              onChange={(e) => setAnimDuration(Number(e.target.value))}
              className="w-12 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-[10px] text-text outline-none focus:border-accent"
            />
          </label>
        )}
      </div>

      {open && (
        <>
          {animMode ? (
            /* Frame mode: Adobe Animate-style frame strip */
            <div className="border-t border-border px-2 py-1">
<<<<<<< HEAD
              <div ref={stripRef} className="flex items-center gap-1 overflow-x-auto">
                {Array.from({ length: Math.min(totalFrames, 240) }, (_, i) => {
                  const isActive = i === animFrame;
                  const hasKey = framesWithContent.has(i);
                  return (
                    <button
                      key={i}
                      data-frame={i}
                      onPointerDown={(e) => {
                        // Scrub: press selects, and dragging across the strip
                        // (pointerenter with the button held) follows.
                        e.preventDefault();
                        setAnimFrame(i);
                      }}
                      onPointerEnter={(e) => {
                        if (e.buttons & 1) setAnimFrame(i);
                      }}
=======
              <div className="flex items-center gap-1 overflow-x-auto">
                {Array.from({ length: Math.min(totalFrames, 120) }, (_, i) => {
                  const isActive = i === animFrame;
                  const hasKey = animated.some((s) => s.anim?.some((k) => Math.round(k.t * animFps) === i));
                  return (
                    <button
                      key={i}
                      onClick={() => setAnimFrame(i)}
>>>>>>> b642fba (Round 6: smooth audio drag (rAF throttle), live import update, eraser rAF throttle + dedup, fix track sliders (direct node writes), 2D animation mode toggle (frame-based Adobe Animate style with onion skin))
                      className={`flex h-8 w-6 shrink-0 flex-col items-center justify-center rounded-sm border text-[7px] font-mono ${
                        isActive
                          ? 'border-warn bg-warn/20 text-warn'
                          : hasKey
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border text-text-dim hover:bg-bg-3'
                      }`}
                      title={`Frame ${i + 1} (${(i / animFps).toFixed(2)}s)`}
                    >
                      {hasKey && <div className="h-1 w-1 rotate-45 rounded-sm bg-accent" />}
                      <span>{i + 1}</span>
                    </button>
                  );
                })}
<<<<<<< HEAD
                {totalFrames > 240 && (
                  <span className="px-1 text-[8px] text-text-dim">…{totalFrames - 240} more</span>
=======
                {totalFrames > 120 && (
                  <span className="px-1 text-[8px] text-text-dim">…{totalFrames - 120} more</span>
>>>>>>> b642fba (Round 6: smooth audio drag (rAF throttle), live import update, eraser rAF throttle + dedup, fix track sliders (direct node writes), 2D animation mode toggle (frame-based Adobe Animate style with onion skin))
                )}
              </div>
              {/* Frame info */}
              <div className="mt-1 flex items-center justify-between text-[9px] font-mono text-text-dim">
                <span>Frame {animFrame + 1} / {totalFrames}</span>
                <span>{animTime.toFixed(2)}s</span>
                {onionSkin && <span className="text-accent">Onion skin on</span>}
              </div>
            </div>
          ) : (
            /* Keyframe mode: dope sheet + scrubber */
            <>
              {/* Dope sheet — one row per selected animated shape */}
              <div id="timeline2d-track" className="relative h-20 overflow-hidden border-t border-border px-2">
                {/* Time ruler */}
                <div className="relative h-4 border-b border-border/30">
                  {Array.from({ length: Math.ceil(animDuration) + 1 }, (_, i) => (
                    <span
                      key={i}
                      className="absolute top-0 text-[7px] font-mono text-text-dim"
                      style={{ left: `${(i / animDuration) * 100}%` }}
                    >
                      {i}s
                    </span>
                  ))}
                </div>
                {/* Keyframe rows */}
                <div className="relative h-16 overflow-y-auto">
                  {animated.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-[9px] text-text-dim">
                      {selection.size === 0 ? 'Select a shape' : 'Press I to keyframe the selected shape'}
                    </div>
                  ) : (
                    animated.map((s) => (
                      <div key={s.id} className="relative h-5 border-b border-border/10">
                        {/* Keyframe diamonds */}
                        {s.anim!.map((k, idx) => {
                          const isActive = Math.abs(k.t - animTime) < 0.05;
                          return (
                            <div
                              key={idx}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                dragRef.current = { shapeId: s.id, curT: k.t, startX: e.clientX };
                                setAnimTime(k.t);
                              }}
                              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing"
                              style={{ left: `${(k.t / animDuration) * 100}%` }}
                              title={`${k.t.toFixed(2)}s`}
                            >
                              <div
                                className={`rotate-45 ${isActive ? 'bg-warn' : 'bg-accent hover:bg-warn'}`}
                                style={{ width: isActive ? 10 : 8, height: isActive ? 10 : 8 }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
                {/* Playhead */}
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-warn/70"
                  style={{ left: `${Math.min(100, (animTime / animDuration) * 100)}%` }}
                >
                  <div className="absolute top-0 -left-1 h-2 w-2 rounded-full bg-warn" />
                </div>
              </div>

              {/* Scrubber */}
              <div className="px-2 py-1">
                <input
                  type="range"
                  min={0}
                  max={animDuration}
                  step={0.01}
                  value={animTime}
                  onChange={(e) => setAnimTime(Number(e.target.value))}
                  onPointerUp={() => { if (!animPlaying) setAnimPreview(false); }}
                  aria-label="Timeline playhead"
                  className="w-full accent-accent"
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
