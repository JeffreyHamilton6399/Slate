/**
 * Timeline — Blender-style animation bar along the bottom of the 3D
 * viewport. Scrub the playhead, play/pause (loops), insert (I) / delete
 * keyframes for the selection, and see the selection's keys as diamonds on
 * the track. Collapsed to a small pill until expanded.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Diamond, DiamondPlus, Pause, Play, Trash2 } from 'lucide-react';
import type { SlateRoom } from '../sync/provider';
import { Tooltip } from '../ui/Tooltip';
import { toast } from '../ui/Toast';
import { deleteKeyframe, insertKeyframe, moveKeyframe, type SceneSnapshot } from './scene';
import { useScene3DStore } from './store';

export function Timeline({ room, snapshot }: { room: SlateRoom; snapshot: SceneSnapshot }) {
  const animTime = useScene3DStore((s) => s.animTime);
  const animDuration = useScene3DStore((s) => s.animDuration);
  const playing = useScene3DStore((s) => s.animPlaying);
  const setAnimTime = useScene3DStore((s) => s.setAnimTime);
  const setAnimDuration = useScene3DStore((s) => s.setAnimDuration);
  const setAnimPlaying = useScene3DStore((s) => s.setAnimPlaying);
  const selection = useScene3DStore((s) => s.selection);
  const [open, setOpen] = useState(false);

  // Playback loop — advances the playhead at display rate, looping.
  const lastRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    lastRef.current = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - lastRef.current) / 1000, 0.1);
      lastRef.current = now;
      const s = useScene3DStore.getState();
      s.setAnimTime((s.animTime + dt) % s.animDuration);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const anyAnimated = snapshot.objects.some((o) => (o.anim?.length ?? 0) > 0);
  // Dope sheet shows one row per SELECTED animated object. Selecting one
  // object shows just its keys; selecting two shows both rows (Blender's
  // multi-object timeline), etc.
  const animated = snapshot.objects.filter(
    (o) => selection.includes(o.id) && (o.anim?.length ?? 0) > 0,
  );

  // Auto-expand when animation appears (Blender's timeline is visible once
  // there's something to animate) — but respect a manual collapse/open.
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (!userToggled && anyAnimated) setOpen(true);
  }, [anyAnimated, userToggled]);

  const insert = () => {
    if (selection.length === 0) {
      toast({ title: 'Select an object to keyframe' });
      return;
    }
    insertKeyframe(room.slate, selection, animTime);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setUserToggled(true); setOpen(true); }}
        className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-bg-2/95 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-text-dim shadow-lg backdrop-blur hover:text-text"
      >
        <ChevronUp size={11} />
        Timeline
        {anyAnimated && <Diamond size={9} className="text-accent" />}
      </button>
    );
  }

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 flex flex-col gap-1 rounded-md border border-border bg-bg-2/95 px-2 py-1.5 shadow-lg backdrop-blur">
      {/* Dope sheet: only the selected object's keyframes (Blender-style).
          Uses the same two-column grid as the slider row below so keyframe
          diamonds line up exactly with the scrubber thumb. */}
      {animated.length > 0 && (
        <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto border-b border-border pb-1">
          {animated.map((o) => (
            <div key={o.id} className="grid grid-cols-[7rem_1fr] items-center gap-2">
              <button
                type="button"
                onClick={() => useScene3DStore.getState().setSelection([o.id])}
                className={
                  'truncate rounded-sm px-1.5 py-0.5 text-left text-[11px] ' +
                  (selection.includes(o.id)
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-mid hover:bg-bg-3 hover:text-text')
                }
              >
                {o.name}
              </button>
              <div className="relative h-4 min-w-0 flex-1 rounded-sm bg-bg-3">
                {/* Playhead */}
                <div
                  className="absolute top-0 h-full w-px bg-warn/70"
                  style={{ left: `${Math.min(100, (animTime / animDuration) * 100)}%` }}
                />
                {(o.anim ?? []).map((k) => {
                  // A keyframe is "selected" (yellow) when the playhead sits
                  // on it (within a small tolerance) — Blender highlights the
                  // active key. Others stay accent/grey.
                  const isSel = Math.abs(k.t - animTime) < 0.05;
                  return (
                  <div
                    key={k.t}
                    title={`${k.t.toFixed(2)}s — drag to retime, click to jump`}
                    onPointerDown={(e) => {
                      // Drag the keyframe to retime it (Blender-style); a click
                      // (no drag) jumps the playhead to the key. Track the key's
                      // CURRENT time each tick so it stays grabbable across the
                      // whole drag (not just the first move).
                      e.preventDefault();
                      e.stopPropagation();
                      const trackEl = e.currentTarget.parentElement!;
                      const trackRect = trackEl.getBoundingClientRect();
                      // Use the track's client rect directly — the keyframe div
                      // is absolutely positioned inside it, so left:0 = rect.left.
                      // No padding/border offset needed.
                      let curT = k.t;
                      const startX = e.clientX;
                      let moved = false;
                      const onMove = (ev: PointerEvent) => {
                        if (Math.abs(ev.clientX - startX) > 3) moved = true;
                        if (!moved) return;
                        const pct = Math.max(0, Math.min(1, (ev.clientX - trackRect.left) / trackRect.width));
                        const newT = pct * animDuration;
                        moveKeyframe(room.slate, o.id, curT, newT);
                        curT = newT;
                      };
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                        if (!moved) {
                          setAnimTime(k.t);
                          useScene3DStore.getState().setSelection([o.id]);
                        }
                      };
                      window.addEventListener('pointermove', onMove);
                      window.addEventListener('pointerup', onUp);
                    }}
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"
                    style={{ left: `${Math.min(100, (k.t / animDuration) * 100)}%` }}
                  >
                    <Diamond
                      size={isSel ? 10 : 8}
                      className={
                        isSel
                          ? 'fill-warn text-warn'
                          : 'fill-accent text-accent hover:fill-warn hover:text-warn'
                      }
                    />
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-2">
      <div className="flex items-center gap-1">
      <Tooltip content={playing ? 'Pause' : 'Play (loops)'}>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => setAnimPlaying(!playing)}
          className="flex h-7 w-7 items-center justify-center rounded-sm border border-accent/50 bg-accent/15 text-accent hover:bg-accent/25"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
      </Tooltip>
      <span className="w-12 text-right font-mono text-xs text-text">{animTime.toFixed(2)}s</span>
      </div>

      {/* Track: scrubber + keyframe diamonds for the primary selection. */}
      <div className="relative min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={animDuration}
          step={0.01}
          value={animTime}
          onChange={(e) => setAnimTime(Number(e.target.value))}
          aria-label="Timeline playhead"
          className="w-full accent-accent"
        />
        {/* Snap tick marks at regular intervals so you can see where the
            playhead will land (Blender's frame grid). Keyframe diamonds live
            only in the dope sheet above (one row per selected object) so there
            aren't two sets of diamonds competing. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
          {Array.from({ length: Math.floor(animDuration) + 1 }, (_, i) => i).map((i) => (
            <div
              key={i}
              className="absolute top-0 h-full w-px bg-border/40"
              style={{ left: `${(i / animDuration) * 100}%` }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1">
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim">
        End
        <input
          type="number"
          min={0.5}
          max={600}
          step={0.5}
          value={animDuration}
          onChange={(e) => setAnimDuration(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="w-14 rounded-sm border border-border bg-bg-4 px-1 py-0.5 text-right font-mono text-xs text-text outline-none focus:border-accent"
          aria-label="Timeline duration (seconds)"
        />
      </label>

      <div className="h-5 w-px bg-border" />
      <Tooltip content="Insert keyframe for the selection at the playhead (I)">
        <button
          type="button"
          aria-label="Insert keyframe"
          onClick={insert}
          className="flex h-7 w-7 items-center justify-center rounded-sm border border-transparent text-text-mid hover:bg-bg-3 hover:text-accent"
        >
          <DiamondPlus size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Delete the selection's keyframe nearest the playhead">
        <button
          type="button"
          aria-label="Delete keyframe"
          onClick={() => deleteKeyframe(room.slate, selection, animTime)}
          className="flex h-7 w-7 items-center justify-center rounded-sm border border-transparent text-text-mid hover:bg-bg-3 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label="Collapse timeline"
        onClick={() => {
          setUserToggled(true);
          setOpen(false);
          setAnimPlaying(false);
        }}
        className="text-text-dim hover:text-text"
      >
        <ChevronDown size={13} />
      </button>
      </div>
      </div>
    </div>
  );
}
