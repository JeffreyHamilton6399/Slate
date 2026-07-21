/**
 * Timeline2D — Adobe Animate-style frame-by-frame animation timeline.
 *
 * Collapsed to a small centered pill by default (like the 3D timeline).
 * The timeline IS the animation-mode switch: opening it enters frame (cel)
 * mode — new strokes/shapes stamp onto the current frame — and closing it
 * returns the board to plain whiteboard drawing. There is no separate
 * keyframe/frame toggle; motion keyframes recorded before this change still
 * play back (the renderer samples them inside cel mode).
 *
 * The bar above the frame strip holds the onion-skin controls: toggle plus a
 * depth slider for how many ghost frames to show on each side.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Diamond, ChevronDown, ChevronUp, Film, Layers, SkipBack, SkipForward, Clapperboard } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { useCanvasStore } from './store';
import { audioEditorHovered } from '../audio/AudioEditor';
import { export2dVideo } from '../files/export2dVideo';
import { toast } from '../ui/Toast';
import type { Shape } from '@slate/sync-protocol';

interface TimelineProps {
  selection: Set<string>;
}

export function Timeline2D({ selection: _selection }: TimelineProps) {
  const room = useRoom();
  const slate = room.slate;
  const [, setVersion] = useState(0);
  const animTime = useCanvasStore((s) => s.animTime);
  const animDuration = useCanvasStore((s) => s.animDuration);
  const animPlaying = useCanvasStore((s) => s.animPlaying);
  const setAnimDuration = useCanvasStore((s) => s.setAnimDuration);
  const setAnimPlaying = useCanvasStore((s) => s.setAnimPlaying);
  const setAnimPreview = useCanvasStore((s) => s.setAnimPreview);
  const animFps = useCanvasStore((s) => s.animFps);
  const animFrame = useCanvasStore((s) => s.animFrame);
  const setAnimFrame = useCanvasStore((s) => s.setAnimFrame);
  const setAnimFps = useCanvasStore((s) => s.setAnimFps);
  const onionSkin = useCanvasStore((s) => s.onionSkin);
  const setOnionSkin = useCanvasStore((s) => s.setOnionSkin);
  const onionSkinFrames = useCanvasStore((s) => s.onionSkinFrames);
  const setOnionSkinFrames = useCanvasStore((s) => s.setOnionSkinFrames);
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  /** Frame-strip scroll container — keeps the active frame in view. */
  const stripRef = useRef<HTMLDivElement | null>(null);

  // The timeline drives animation (cel) mode: open = frame stamping on, closed
  // = whiteboard. Closing also stops playback and rewinds to frame 0 so the
  // static view shows the full drawing, not a random mid-animation frame.
  useEffect(() => {
    const s = useCanvasStore.getState();
    s.setAnimMode(open);
    if (!open) {
      s.setAnimPlaying(false);
      s.setAnimFrame(0);
      s.setAnimPreview(false);
    }
  }, [open]);

  // Keep the active frame visible while playing/scrubbing: without this the
  // playhead runs off the right edge of the strip and playback looks stuck.
  useEffect(() => {
    if (!open) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-frame="${animFrame}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open, animFrame]);

  // Subscribe to Yjs shapes + strokes so frame-content markers stay fresh.
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
  const framesWithContent = new Set<number>();
  for (const s of allShapes) if (typeof s.frame === 'number') framesWithContent.add(s.frame);
  slate.strokes().forEach((m) => {
    const f = m.get('frame');
    if (typeof f === 'number') framesWithContent.add(f);
  });

  const anyAnimated = allShapes.some((s) => (s.anim?.length ?? 0) > 0);
  // "This board is animated" = cels on more than one frame, or motion
  // keyframes. A single stamped frame (someone opened the timeline once and
  // drew) doesn't force the timeline open on every visit.
  const hasAnimation = framesWithContent.size > 1 || anyAnimated;

  // Auto-expand when the board has animation (mirrors the 3D timeline) —
  // otherwise the cels would render stacked on top of each other in
  // whiteboard mode. Respects a manual collapse.
  useEffect(() => {
    if (hasAnimation && !userToggled) setOpen(true);
  }, [hasAnimation, userToggled]);

  // Playback loop — steps one frame at a time at the configured FPS, looping.
  const lastRef = useRef(0);
  useEffect(() => {
    if (!animPlaying) return;
    let raf = 0;
    lastRef.current = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const s = useCanvasStore.getState();
      const fps = Math.max(1, s.animFps);
      const total = Math.max(1, Math.ceil(s.animDuration * fps));
      if (now - lastRef.current >= 1000 / fps) {
        lastRef.current = now;
        s.setAnimFrame((s.animFrame + 1) % total);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animPlaying]);

  // Stop preview when playback ends at frame 0.
  useEffect(() => {
    if (!animPlaying && animTime === 0) setAnimPreview(false);
  }, [animPlaying, animTime, setAnimPreview]);

  // "Export MP4" — record the canvas while stepping every frame at the
  // configured FPS, then download the blob. Mirrors the 3D viewport's
  // Render Animation. Button label shows live progress while recording.
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const onExportVideo = useCallback(async () => {
    if (exporting) return;
    if (!hasAnimation) {
      toast({
        title: 'No animation to export',
        description: 'Stamp content on more than one frame, or add motion keyframes first.',
      });
      return;
    }
    // The 2D editor owns a single <canvas> (the minimap canvas has aria-label,
    // so this selector skips it). It's the first canvas in DOM order.
    const canvas = document.querySelector<HTMLCanvasElement>('canvas:not([aria-label])')
      ?? document.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      toast({
        title: 'Recording unsupported',
        description: 'This browser can’t record the canvas.',
        variant: 'error',
      });
      return;
    }
    setExporting(true);
    setExportPct(0);
    setAnimPlaying(false);
    try {
      await export2dVideo({
        canvas,
        fps: animFps,
        duration: animDuration,
        onProgress: (pct) => setExportPct(pct),
      });
      toast({
        title: 'Animation exported',
        description: 'Saved as a video file.',
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Export failed',
        description: (err as Error).message,
        variant: 'error',
      });
    } finally {
      setExporting(false);
      setExportPct(0);
    }
  }, [exporting, hasAnimation, animFps, animDuration, setAnimPlaying]);

  // Space = play/pause while the timeline is open. Yields to the audio
  // transport while the pointer is over a docked audio editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === ' ' && open && !audioEditorHovered.current) {
        e.preventDefault();
        setAnimPlaying(!animPlaying);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, animPlaying, setAnimPlaying]);

  const totalFrames = Math.max(1, Math.ceil(animDuration * animFps));

  // Collapsed: a small centered pill, like the 3D viewport's timeline.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setUserToggled(true); setOpen(true); }}
        className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-bg-2/95 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-text-dim shadow-lg backdrop-blur hover:text-text sm:bottom-2"
      >
        <ChevronUp size={11} />
        <Film size={11} />
        Animation
        {hasAnimation && <Diamond size={9} className="text-accent" />}
      </button>
    );
  }

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md border border-border bg-bg-2/95 shadow-lg backdrop-blur-sm">
      {/* Header: collapse, transport, FPS + length */}
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          onClick={() => { setUserToggled(true); setOpen(false); }}
          className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-dim hover:text-text"
          title="Close the timeline (back to whiteboard drawing)"
        >
          <ChevronDown size={10} />
          <Film size={10} />
          Animation
        </button>
        <div className="flex-1" />
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
        <button
          onClick={() => setAnimPlaying(!animPlaying)}
          className={`flex h-6 w-6 items-center justify-center rounded ${animPlaying ? 'bg-warn/20 text-warn' : 'text-text-mid hover:bg-bg-3'}`}
          title="Play (Space)"
        >
          {animPlaying ? <Pause size={11} /> : <Play size={11} />}
        </button>
        <label className="flex items-center gap-1 text-[10px] text-text-dim" title="Frames per second">
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
        <label className="flex items-center gap-1 text-[10px] text-text-dim" title="Total frames in the animation">
          Frames
          <input
            type="number"
            min={2}
            max={2000}
            step={1}
            value={totalFrames}
            onChange={(e) => setAnimDuration(Math.max(2, Number(e.target.value)) / animFps)}
            className="w-14 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-[10px] text-text outline-none focus:border-accent"
          />
        </label>
        <button
          onClick={onExportVideo}
          disabled={exporting || !hasAnimation}
          className={`flex h-6 items-center gap-1 rounded px-1.5 text-[9px] font-mono uppercase tracking-wider ${
            exporting
              ? 'bg-warn/20 text-warn'
              : hasAnimation
                ? 'text-text-mid hover:bg-bg-3 hover:text-text'
                : 'text-text-dim opacity-50'
          } disabled:cursor-not-allowed`}
          title={
            !hasAnimation
              ? 'No animation to export — add cel frames or motion keyframes first'
              : exporting
                ? `Recording… ${Math.round(exportPct * 100)}%`
                : 'Export the animation as an MP4 video (WebM fallback)'
          }
          aria-label="Export animation as MP4"
        >
          <Clapperboard size={11} />
          {exporting ? `${Math.round(exportPct * 100)}%` : 'MP4'}
        </button>
      </div>

      {/* Onion-skin bar — toggle + how many ghost frames each side. */}
      <div className="flex items-center gap-2 border-t border-border px-2 py-1">
        <button
          onClick={() => setOnionSkin(!onionSkin)}
          className={`flex h-6 items-center gap-1 rounded px-1.5 text-[9px] font-mono uppercase ${onionSkin ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`}
          title="Onion skin — ghost neighbouring frames (previous red, next green)"
        >
          <Layers size={10} />
          Onion skin
        </button>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={onionSkinFrames}
          disabled={!onionSkin}
          onChange={(e) => setOnionSkinFrames(Number(e.target.value))}
          className="w-24 accent-accent disabled:opacity-30"
          aria-label="Onion skin depth (frames each side)"
          title="How many frames to ghost on each side"
        />
        <span className={`font-mono text-[9px] ${onionSkin ? 'text-accent' : 'text-text-dim'}`}>±{onionSkinFrames}</span>
        <div className="flex-1" />
        <span className="font-mono text-[9px] text-text-dim">
          Frame {animFrame + 1} / {totalFrames} · {animTime.toFixed(2)}s
        </span>
      </div>

      {/* Frame strip */}
      <div className="border-t border-border px-2 py-1">
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
          {totalFrames > 240 && (
            <span className="px-1 text-[8px] text-text-dim">…{totalFrames - 240} more</span>
          )}
        </div>
      </div>
    </div>
  );
}
