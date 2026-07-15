/**
 * Timeline2D — minimalistic 2D animation timeline (Adobe Animate style).
 * Shows keyframe diamonds for selected animated shapes, a scrubber, play/pause,
 * and insert/delete keyframe buttons. Mounted as an overlay at the bottom of
 * the 2D canvas.
 */

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Diamond, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { useCanvasStore } from './store';
import { sampleAnim2D } from './animation';
import { insertKeyframe2D, deleteKeyframe2D, moveKeyframe2D } from './keyframes';
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
  const [open, setOpen] = useState(true);
  const [userToggled, setUserToggled] = useState(false);
  const dragRef = useRef<{ shapeId: string; curT: number; startX: number } | null>(null);

  // Subscribe to Yjs shapes for keyframe changes.
  useEffect(() => {
    const shapes = slate.shapes();
    const bump = () => setVersion((v) => v + 1);
    shapes.observeDeep(bump);
    return () => shapes.unobserveDeep(bump);
  }, [slate]);

  // Read all shapes from Yjs (lightweight — no samples).
  const allShapes: Shape[] = [];
  slate.shapes().forEach((m) => {
    const candidate: Record<string, unknown> = {};
    m.forEach((v, k) => { candidate[k] = v; });
    if (candidate.id && candidate.kind) allShapes.push(candidate as unknown as Shape);
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

  // Playback loop.
  const lastRef = useRef(0);
  useEffect(() => {
    if (!animPlaying) return;
    let raf = 0;
    lastRef.current = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - lastRef.current) / 1000, 0.1);
      lastRef.current = now;
      const s = useCanvasStore.getState();
      s.setAnimTime((s.animTime + dt) % s.animDuration);
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
        // Only handle space if there's animation.
        if (anyAnimated) {
          e.preventDefault();
          setAnimPlaying(!animPlaying);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slate, selection, animTime, animPlaying, anyAnimated, setAnimPlaying]);

  if (!anyAnimated && !open) return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md border border-border bg-bg-2/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          onClick={() => { setUserToggled(true); setOpen(!open); }}
          className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-dim hover:text-text"
        >
          {open ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
          Timeline
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setAnimPlaying(!animPlaying)}
          disabled={!anyAnimated}
          className={`flex h-6 w-6 items-center justify-center rounded ${animPlaying ? 'bg-warn/20 text-warn' : 'text-text-mid hover:bg-bg-3'} disabled:opacity-30`}
          title="Play (Space)"
        >
          {animPlaying ? <Pause size={11} /> : <Play size={11} />}
        </button>
        <button
          onClick={() => { if (selection.size > 0) insertKeyframe2D(slate, [...selection], animTime); }}
          disabled={selection.size === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-accent disabled:opacity-30"
          title="Insert Keyframe (I)"
        >
          <Diamond size={11} />
        </button>
        <button
          onClick={() => { if (selection.size > 0) deleteKeyframe2D(slate, [...selection], animTime); }}
          disabled={selection.size === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger disabled:opacity-30"
          title="Delete Keyframe"
        >
          <Trash2 size={10} />
        </button>
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
      </div>

      {open && (
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
    </div>
  );
}
