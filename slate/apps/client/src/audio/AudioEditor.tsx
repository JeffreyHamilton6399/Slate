/**
 * AudioEditor — CapCut/BandLab-style DAW.
 * Key optimization: waveforms are pre-computed as PNG data URLs cached per
 * clip id + sample count. The canvas only draws ONCE when a clip is first
 * seen or its samples change — not on every version bump.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, Pause, Play, Plus, Trash2, Volume2, VolumeX, Headphones,
  Music, Upload, Scissors, Repeat, ZoomIn, ZoomOut, Copy, SkipBack,
  ChevronLeft, ChevronRight, Maximize2,
} from 'lucide-react';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import {
  addAudioClip, addAudioTrack, decodeAudioFile, deleteAudioClip,
  deleteAudioTrack, duplicateAudioClip, readAudioClip, readAudioTrack,
  setAudioBpm, splitAudioClip, updateAudioClip, updateAudioTrack,
} from './scene';
import { AudioEngine } from './engine';
import { loadSamples, registerSampleSyncMap } from './sampleStore';

const TRACK_H = 60;
/** px-per-sec zoom limits. The min is intentionally tiny (2) so a long mix
 *  (e.g. a 3-minute song = 180s) still fits in a typical viewport at the
 *  widest zoom-out — 180s * 2px = 360px, well within a timeline pane. The
 *  Fit-to-window button uses this as the floor so the computed fit value is
 *  never silently clamped away. */
const MIN_PX_PER_SEC = 2;
const MAX_PX_PER_SEC = 800;
/** Width of the sticky track-header column (Tailwind w-44 = 11rem = 176px).
 *  Used by the Fit-to-window calculation to subtract the header from the
 *  scroll viewport so we fit clips into the visible TIMELINE area only. */
const TRACK_HEADER_W = 176;

// ── Waveform cache: pre-computed PNG data URLs ───────────────────────────────
// Key: `${clipId}:${sampleCount}:${width}` → data URL
const waveformPNGCache = new Map<string, string>();

// Draw only the window [startFrame, endFrame) of the sample across `width`
// pixels. Rendering the *window* (not the whole sample stretched) is what makes
// trimming look like cutting the audio away rather than squashing it.
function computeWaveformPNG(samples: Float32Array, channels: number, width: number, color: string, height: number, startFrame: number, endFrame: number): string {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.floor(width));
  canvas.width = w * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, height);
  const totalFrames = samples.length / channels;
  const s = Math.max(0, Math.min(totalFrames, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(totalFrames, Math.floor(endFrame)));
  const span = e - s;
  if (span <= 0) return canvas.toDataURL();
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const f0 = s + Math.floor((x / w) * span);
    const f1 = Math.min(e, s + Math.floor(((x + 1) / w) * span) + 1);
    let peak = 0;
    for (let i = f0; i < f1; i++) { const v = Math.abs(samples[i * channels] ?? 0); if (v > peak) peak = v; }
    const bh = Math.max(1, peak * mid * 0.85);
    ctx.fillRect(x, mid - bh, 1, bh * 2);
  }
  return canvas.toDataURL();
}

/** Waveform image for the buffer window the clip actually plays. With speed s,
 *  a clip of `duration` timeline seconds consumes `duration*s` buffer seconds.
 *
 *  Two robustness fixes:
 *  1. If `loadSamples` returns an EMPTY Float32Array (length 0) — which happens
 *     when a freshly-split/created clip's IndexedDB write hasn't landed yet —
 *     we DON'T cache the resulting blank PNG. Instead we show the `···`
 *     placeholder and retry a few times (500ms apart) so the real waveform
 *     appears once the samples are available.
 *  2. We listen for `slate:audio-clip-changed` (fired by Normalize/Reverse/split)
 *     and invalidate our cache entry for the current clipId, then force a
 *     recompute via a `bust` counter — otherwise the memoised component would
 *     keep showing the stale PNG even after the cache was cleared. */
const WaveformImg = memo(function WaveformImg({ clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color }: {
  clipId: string; sampleKey: string; channels: number; sampleRate: number;
  offset: number; duration: number; speed: number; width: number; color: string;
}) {
  const height = TRACK_H - 6;
  const [imgUrl, setImgUrl] = useState<string>('');
  const [bust, setBust] = useState(0);
  const retryRef = useRef(0);

  // Invalidate cached PNGs for this clip when its samples change (normalize /
  // reverse / split). The parent AudioEditor also invalidates + bumps version,
  // but the memoised WaveformImg wouldn't otherwise recompute (its primitive
  // props are unchanged) — the `bust` counter forces the load effect to re-run.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      // Match by clipId (normalize/reverse/split events) OR by sampleKey
      // (multiplayer sample-arrival events from registerSampleSyncMap).
      if (detail !== clipId && detail !== sampleKey) return;
      for (const key of waveformPNGCache.keys()) {
        if (key.startsWith(`${clipId}:`)) waveformPNGCache.delete(key);
      }
      retryRef.current = 0;
      setBust((n) => n + 1);
    };
    window.addEventListener('slate:audio-clip-changed', onChanged as EventListener);
    return () => window.removeEventListener('slate:audio-clip-changed', onChanged as EventListener);
  }, [clipId, sampleKey]);

  useEffect(() => {
    const startFrame = Math.round(offset * sampleRate);
    const endFrame = Math.round((offset + duration * speed) * sampleRate);
    const cacheKey = `${clipId}:${sampleKey}:${startFrame}:${endFrame}:${Math.floor(width)}`;
    const cached = waveformPNGCache.get(cacheKey);
    if (cached) { setImgUrl(cached); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled) return;
      void loadSamples(sampleKey).then((samples) => {
        if (cancelled) return;
        // Empty samples = the IndexedDB write for this sampleKey hasn't landed
        // yet (e.g. brand-new clip from a split). DON'T cache a blank PNG —
        // retry a few times so the real waveform appears.
        if (samples.length === 0) {
          if (retryRef.current < 5) {
            retryRef.current += 1;
            retryTimer = setTimeout(attempt, 500);
          }
          return;
        }
        retryRef.current = 0;
        const url = computeWaveformPNG(samples, channels, width, color, height, startFrame, endFrame);
        waveformPNGCache.set(cacheKey, url);
        setImgUrl(url);
      });
    };
    attempt();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color, height, bust]);

  if (!imgUrl) return <div className="flex h-full items-center justify-center text-[7px] text-text-dim">···</div>;
  return <img src={imgUrl} alt="" className="pointer-events-none h-full w-full" style={{ objectFit: 'fill' }} />;
});

/** Drop cached waveform PNGs for a clip (call when its samples change). */
function invalidateWaveform(clipId: string): void {
  for (const key of waveformPNGCache.keys()) if (key.startsWith(`${clipId}:`)) waveformPNGCache.delete(key);
}

// ── Main ────────────────────────────────────────────────────────────────────

export function AudioEditor() {
  const room = useRoom();
  const slate = room.slate;
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpmState] = useState(slate.audioBpm());
  const [metronome, setMetronome] = useState(false);
  const [recording, setRecording] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [masterVol, setMasterVol] = useState(0.85);
  const [looping, setLooping] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(8);
  const [pxPerSec, setPxPerSec] = useState(80);
  const engineRef = useRef<AudioEngine | null>(null);
  const stopRecRef = useRef<(() => Promise<{ samples: number[]; sampleRate: number; channels: number; duration: number }>) | null>(null);
  const rafRef = useRef(0);
  const positionRef = useRef(0);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const posDisplayRef = useRef<HTMLSpanElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    clipId: string; el: HTMLElement; waveEl: HTMLElement | null;
    os: number; od: number; oo: number; speed: number; sx: number;
    leftLimit: number; rightLimit: number; mode: 'drag' | 'trimL' | 'trimR';
    neighbours: { start: number; end: number }[];
  } | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedClipId;
  const clipsRef = useRef<AudioClip[]>([]);
  const pxRef = useRef(pxPerSec);
  pxRef.current = pxPerSec;
  /** Desired scrollLeft to apply after the next pxPerSec commit (used by
   *  zoomAtPlayhead so the playhead stays at the same screen position when
   *  zooming). Cleared in the layout effect below once applied. */
  const pendingScrollRef = useRef<number | null>(null);

  // Yjs subscription.
  useEffect(() => {
    // Register the multiplayer sample sync map so audio clips imported by
    // other peers are automatically received and stored locally.
    registerSampleSyncMap(room);
    const tracks = slate.audioTracks();
    const clips = slate.audioClips();
    const audioMap = slate.doc.getMap('audio');
    let pending = false;
    const bump = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; setVersion((v) => v + 1); }); };
    tracks.observeDeep(bump); clips.observeDeep(bump); audioMap.observe(bump); bump();
    const lateRead = setTimeout(bump, 200);
    return () => { clearTimeout(lateRead); tracks.unobserveDeep(bump); clips.unobserveDeep(bump); audioMap.unobserve(bump); };
  }, [slate]);

  useEffect(() => {
    engineRef.current = new AudioEngine();
    engineRef.current.setMasterVolume(masterVol);
    return () => { engineRef.current?.dispose(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playhead — direct DOM.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const eng = engineRef.current; if (!eng) return;
      const pos = eng.getPosition();
      positionRef.current = pos;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxRef.current}px)`;
      if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
      if (pos > timelineDuration + 2) { eng.stop(); setPlaying(false); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Ctrl+scroll zoom — centred on the playhead so the screen position under
  // the cursor/playhead stays put instead of zooming toward the left edge.
  /** Zoom while keeping the playhead at the same screen offset. Records the
   *  playhead's offset from the left edge of the visible viewport (relative to
   *  the timeline content), changes `pxPerSec`, then schedules a scroll
   *  correction so the playhead lands at the same offset in the new zoom.
   *  The actual `scrollLeft` write happens in the layout effect below (after
   *  React commits the new `minWidth` on the timeline div — setting it earlier
   *  would be clamped by the stale `scrollWidth`). */
  const zoomAtPlayhead = useCallback((newPxPerSec: number) => {
    const el = scrollRef.current;
    const oldPxPerSec = pxRef.current;
    if (!el || oldPxPerSec === newPxPerSec) {
      setPxPerSec(newPxPerSec);
      return;
    }
    const scrollLeft = el.scrollLeft;
    const playheadX = positionRef.current * oldPxPerSec;
    const playheadOffset = playheadX - scrollLeft;
    const newPlayheadX = positionRef.current * newPxPerSec;
    const newScrollLeft = newPlayheadX - playheadOffset;
    pendingScrollRef.current = newScrollLeft;
    setPxPerSec(newPxPerSec);
  }, []);

  // Apply any pending scroll correction after pxPerSec commits to the DOM.
  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [pxPerSec]);

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pxRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      zoomAtPlayhead(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAtPlayhead]);

  // Global pointermove/up — pure DOM, zero React state.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const pps = pxRef.current;
      const dt = (ev.clientX - d.sx) / pps;
      const oldEnd = d.os + d.od;
      if (d.mode === 'drag') {
        // Snap-to-neighbour drag: the clip follows the mouse, but if the new
        // position would overlap another clip on the same track, instead of
        // stopping dead at the neighbour's edge we JUMP to the free side of
        // that neighbour (right of it when dragging right, left of it when
        // dragging left). Iterates so a chain of back-to-back clips resolves
        // to the next free slot. A small overlap threshold avoids accidental
        // snaps when the cursor barely crosses the boundary.
        const duration = d.od;
        const rawStart = d.os + dt;
        let start = rawStart;
        const overlapThreshold = 0.05; // s — ignore near-boundary jitter
        for (let iter = 0; iter < d.neighbours.length + 1; iter++) {
          const blocker = d.neighbours.find((n) => {
            const ovStart = Math.max(start, n.start);
            const ovEnd = Math.min(start + duration, n.end);
            return ovEnd - ovStart > overlapThreshold;
          });
          if (!blocker) break;
          if (dt >= 0) start = blocker.end;          // snap to RIGHT of blocker
          else start = blocker.start - duration;     // snap to LEFT of blocker
        }
        // Fallback clamp: never let the clip start before t=0.
        start = Math.max(0, start);
        d.el.style.left = `${start * pps}px`;
      } else if (d.mode === 'trimL') {
        // Cut from the left: never past the left neighbour, the source start
        // (offset ≥ 0 → limited by the trimmed head in timeline seconds), or a
        // minimum width.
        const minStart = Math.max(d.leftLimit, d.os - d.oo / d.speed);
        const start = Math.min(oldEnd - 0.1, Math.max(minStart, d.os + dt));
        d.el.style.left = `${start * pps}px`;
        d.el.style.width = `${(oldEnd - start) * pps}px`;
        // Shift the (fixed-width) waveform the opposite way so the audio stays
        // anchored — the newly-trimmed head is clipped, not squashed.
        if (d.waveEl) d.waveEl.style.left = `${-(start - d.os) * pps}px`;
      } else if (d.mode === 'trimR') {
        // Cut from the right: never past the right neighbour or a min width.
        const end = Math.min(d.rightLimit, Math.max(d.os + 0.1, oldEnd + dt));
        d.el.style.width = `${(end - d.os) * pps}px`;
      }
    };
    const onUp = () => {
      const d = dragRef.current; if (!d) return;
      const pps = pxRef.current;
      const left = parseFloat(d.el.style.left) / pps;
      const width = parseFloat(d.el.style.width) / pps;
      if (d.mode === 'drag') updateAudioClip(slate, d.clipId, { start: Math.max(0, left) });
      else if (d.mode === 'trimL') updateAudioClip(slate, d.clipId, { start: left, duration: width, offset: Math.max(0, d.oo + (left - d.os) * d.speed) });
      else if (d.mode === 'trimR') updateAudioClip(slate, d.clipId, { duration: width });
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [slate]);

  // Hotkeys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'c' && !e.ctrlKey && selectedRef.current) { e.preventDefault(); void splitAudioClip(slate, selectedRef.current, positionRef.current); }
      else if ((k === 'delete' || k === 'backspace') && selectedRef.current) { e.preventDefault(); deleteAudioClip(slate, selectedRef.current); setSelectedClipId(null); }
      else if (k === 'd' && !e.ctrlKey && selectedRef.current) { e.preventDefault(); dupClip(selectedRef.current); }
      else if (k === 'l') { e.preventDefault(); setLooping((n) => !n); }
      else if (k === 'm') { e.preventDefault(); setMetronome((n) => { engineRef.current?.setMetronome(!n); return !n; }); }
      else if (k === 'r' && !e.ctrlKey) { e.preventDefault(); void toggleRecord(); }
      else if (k === 'arrowleft') { e.preventDefault(); seek(positionRef.current - 2); }
      else if (k === 'arrowright') { e.preventDefault(); seek(positionRef.current + 2); }
      else if (k === 'home') { e.preventDefault(); seek(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, recording]);

  // Read from Yjs — lightweight (no samples copied).
  const tracks: AudioTrack[] = useMemo(() => {
    const list: AudioTrack[] = [];
    slate.audioTracks().forEach((m, id) => { const t = readAudioTrack(m, id); if (t) list.push(t); });
    list.sort((a, b) => a.order - b.order);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate, version]);

  const clips: AudioClip[] = useMemo(() => {
    const list: AudioClip[] = [];
    slate.audioClips().forEach((m, id) => { const c = readAudioClip(m, id); if (c) list.push(c); });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate, version]);
  clipsRef.current = clips;

  // When a clip's samples change (normalize/reverse from the settings panel),
  // drop the cached waveform + decoded buffer so both refresh.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      invalidateWaveform(id);
      engineRef.current?.clearCache(id);
      setVersion((v) => v + 1);
    };
    window.addEventListener('slate:audio-clip-changed', onChanged as EventListener);
    return () => window.removeEventListener('slate:audio-clip-changed', onChanged as EventListener);
  }, []);

  const timelineDuration = Math.max(30, ...clips.map((c) => c.start + c.duration), positionRef.current + 10);

  /** Compute the px-per-sec that fits the ENTIRE timeline duration into the
   *  currently-visible timeline viewport (scroll container minus the sticky
   *  track-header column). Clamped to [MIN, MAX] so absurdly long or short
   *  sessions still produce a sane zoom. Goes through `zoomAtPlayhead` so the
   *  playhead stays on screen when the fit value would still overflow. */
  const fitToWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewportW = Math.max(50, el.clientWidth - TRACK_HEADER_W);
    const fit = viewportW / Math.max(1, timelineDuration);
    zoomAtPlayhead(Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, fit)));
  }, [timelineDuration, zoomAtPlayhead]);

  // ── Transport ─────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    const eng = engineRef.current; if (!eng) return;
    if (playing) { eng.stop(); setPlaying(false); }
    else { if (looping) eng.setLoopRegion(loopStart, loopEnd); else eng.setLoopRegion(null, null); void eng.play(slate, positionRef.current); setPlaying(true); }
  }, [playing, slate, looping, loopStart, loopEnd]);

  const seek = useCallback((t: number) => {
    const pos = Math.max(0, t);
    positionRef.current = pos;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxRef.current}px)`;
    if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
  }, []);

  const toggleRecord = useCallback(async () => {
    if (recording) {
      const stopFn = stopRecRef.current;
      if (stopFn) {
        const r = await stopFn(); stopRecRef.current = null; setRecording(false);
        let tid = tracks.find((t) => t.armed)?.id;
        if (!tid) tid = addAudioTrack(slate, { name: 'Recording' });
        addAudioClip(slate, tid, { start: positionRef.current, samples: r.samples, sampleRate: r.sampleRate, channels: r.channels, duration: r.duration, name: `Rec ${new Date().toLocaleTimeString()}` });
        toast({ title: 'Recording added' });
      }
    } else {
      try { const sf = await engineRef.current?.startRecording(); stopRecRef.current = sf ?? null; setRecording(true); }
      catch { toast({ title: 'Mic denied', variant: 'error' }); }
    }
  }, [recording, tracks, slate]);

  const dupClip = useCallback(async (id: string) => {
    await duplicateAudioClip(slate, id);
  }, [slate]);

  const handleFileImport = useCallback(async (file: File) => {
    try {
      const d = await decodeAudioFile(file);
      const tid = addAudioTrack(slate, { name: file.name.replace(/\.[^.]+$/, '') });
      addAudioClip(slate, tid, { start: positionRef.current, samples: d.samples, sampleRate: d.sampleRate, channels: d.channels, duration: d.duration, name: file.name });
      toast({ title: 'Imported', description: file.name });
    } catch (err) { toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' }); }
  }, [slate]);

  // ── Drag start ────────────────────────────────────────────────────────────

  // The free interval [leftLimit, rightLimit] the clip may occupy without
  // overlapping any other clip on the same track. `neighbours` is the full
  // list of same-track clip bounds (used by drag-snap to jump past a clip to
  // the free slot on its other side).
  const neighbourBounds = useCallback((clip: AudioClip): { leftLimit: number; rightLimit: number; neighbours: { start: number; end: number }[] } => {
    let leftLimit = 0;
    let rightLimit = Infinity;
    const neighbours: { start: number; end: number }[] = [];
    const clipEnd = clip.start + clip.duration;
    for (const o of clipsRef.current) {
      if (o.id === clip.id || o.trackId !== clip.trackId) continue;
      const oEnd = o.start + o.duration;
      if (oEnd <= clip.start + 1e-4) leftLimit = Math.max(leftLimit, oEnd);
      else if (o.start >= clipEnd - 1e-4) rightLimit = Math.min(rightLimit, o.start);
      neighbours.push({ start: o.start, end: oEnd });
    }
    return { leftLimit, rightLimit, neighbours };
  }, []);

  const startDrag = useCallback((clip: AudioClip, e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation(); setSelectedClipId(clip.id);
    const { leftLimit, rightLimit, neighbours } = neighbourBounds(clip);
    dragRef.current = { clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset, speed: clip.speed ?? 1, sx: e.clientX, leftLimit, rightLimit, neighbours, mode: 'drag' };
  }, [neighbourBounds]);

  const startTrim = useCallback((clip: AudioClip, side: 'left' | 'right', e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation(); setSelectedClipId(clip.id);
    const { leftLimit, rightLimit, neighbours } = neighbourBounds(clip);
    dragRef.current = { clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset, speed: clip.speed ?? 1, sx: e.clientX, leftLimit, rightLimit, neighbours, mode: side === 'left' ? 'trimL' : 'trimR' };
  }, [neighbourBounds]);

  // ── Loop region drag ──────────────────────────────────────────────────────

  const loopDragRef = useRef<{ mode: 'start' | 'end' | 'move'; sx: number; os: number; oe: number } | null>(null);
  const startLoopDrag = useCallback((mode: 'start' | 'end' | 'move', e: React.PointerEvent) => {
    e.stopPropagation();
    loopDragRef.current = { mode, sx: e.clientX, os: loopStart, oe: loopEnd };
    const onMove = (ev: PointerEvent) => {
      const d = loopDragRef.current; if (!d) return;
      const dt = (ev.clientX - d.sx) / pxRef.current;
      if (d.mode === 'start') { setLoopStart(Math.max(0, Math.min(d.oe - 0.5, d.os + dt))); }
      else if (d.mode === 'end') { setLoopEnd(Math.max(d.os + 0.5, d.oe + dt)); }
      else if (d.mode === 'move') { setLoopStart(Math.max(0, d.os + dt)); setLoopEnd(Math.max(0.5, d.oe + dt)); }
    };
    const onUp = () => { loopDragRef.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  }, [loopStart, loopEnd, pxPerSec]);

  // ── Render ────────────────────────────────────────────────────────────────

  const beatDur = 60 / bpm; // seconds per beat
  const gridStyle = {
    backgroundImage: `repeating-linear-gradient(to right, rgba(128,128,128,0.08) 0 1px, transparent 1px ${beatDur * pxPerSec}px), repeating-linear-gradient(to right, rgba(128,128,128,0.2) 0 1px, transparent 1px ${beatDur * 4 * pxPerSec}px)`,
  };

  // Adaptive ruler tick interval — picks a "nice" step (in seconds) whose
  // pixel spacing stays readable at the current zoom: tight when zoomed in
  // (so you get millisecond-level ticks), sparse when zoomed out (so a long
  // mix doesn't turn into a solid wall of labels).
  const { tickInterval, formatTick } = useMemo(() => {
    if (pxPerSec >= 400) return { tickInterval: 0.1, formatTick: (t: number) => `${t.toFixed(1)}s` };
    if (pxPerSec >= 100) return { tickInterval: 1, formatTick: (t: number) => `${t}s` };
    if (pxPerSec >= 40) return { tickInterval: 5, formatTick: (t: number) => `${t}s` };
    if (pxPerSec >= 10) return { tickInterval: 10, formatTick: (t: number) => `${t}s` };
    return {
      tickInterval: 60,
      formatTick: (t: number) => {
        const m = Math.floor(t / 60);
        const s = Math.round(t - m * 60);
        return s === 0 ? `${m}m` : `${m}m ${s}s`;
      },
    };
  }, [pxPerSec]);

  return (
    <div className="flex h-full flex-col bg-bg overflow-hidden" onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); for (const f of [...(e.dataTransfer?.files ?? [])].filter((f) => /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name))) void handleFileImport(f); }}>
      {/* Transport */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-2 px-2 py-1.5">
        <button onClick={() => seek(0)} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Start"><SkipBack size={14} /></button>
        <button onClick={togglePlay} className={`flex h-9 w-9 items-center justify-center rounded-full text-white ${playing ? 'bg-warn' : 'bg-accent'} hover:opacity-80`} title="Play (Space)">{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <button onClick={() => void toggleRecord()} className={`flex h-8 w-8 items-center justify-center rounded-full border ${recording ? 'border-danger bg-danger/20 text-danger animate-pulse' : 'border-border text-text-mid hover:bg-bg-3'}`} title="Record (R)"><Mic size={15} /></button>
        <span ref={posDisplayRef} className="ml-1 min-w-[2.5rem] font-mono text-xs text-text">0.0s</span>
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={() => selectedRef.current && splitAudioClip(slate, selectedRef.current, positionRef.current)} disabled={!selectedClipId} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Split (C)"><Scissors size={14} /></button>
        <button onClick={() => selectedRef.current && dupClip(selectedRef.current)} disabled={!selectedClipId} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Duplicate (D)"><Copy size={14} /></button>
        <button onClick={() => { if (selectedRef.current) { deleteAudioClip(slate, selectedRef.current); setSelectedClipId(null); } }} disabled={!selectedClipId} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger disabled:opacity-30" title="Delete (Del)"><Trash2 size={14} /></button>
        <div className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1 text-[11px] text-text-dim">BPM<input type="number" min={20} max={300} value={bpm} onChange={(e) => { setBpmState(Number(e.target.value)); setAudioBpm(slate, Number(e.target.value)); engineRef.current?.setBpm(Number(e.target.value)); }} className="w-14 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-xs text-text outline-none focus:border-accent" /></label>
        <button onClick={() => { const n = !metronome; setMetronome(n); engineRef.current?.setMetronome(n); }} className={`flex h-7 w-7 items-center justify-center rounded ${metronome ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Metronome (M)"><Music size={13} /></button>
        <button onClick={() => setLooping((n) => !n)} className={`flex h-7 w-7 items-center justify-center rounded ${looping ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Loop (L)"><Repeat size={13} /></button>
        <div className="mx-1 h-5 w-px bg-border" />
        <div className="flex items-center gap-1"><Volume2 size={12} className="text-text-mid" /><input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e) => { setMasterVol(Number(e.target.value)); engineRef.current?.setMasterVolume(Number(e.target.value)); }} className="w-14 accent-accent" /></div>
        <button onClick={() => zoomAtPlayhead(Math.max(MIN_PX_PER_SEC, pxRef.current / 1.3))} className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom out"><ZoomOut size={12} /></button>
        <button onClick={fitToWindow} className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-accent" title="Fit to window"><Maximize2 size={12} /></button>
        <button onClick={() => zoomAtPlayhead(Math.min(MAX_PX_PER_SEC, pxRef.current * 1.3))} className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom in"><ZoomIn size={12} /></button>
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3"><Upload size={12} />Import<input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFileImport(f); e.target.value = ''; }} /></label>
        <button onClick={() => addAudioTrack(slate)} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20"><Plus size={12} />Track</button>
      </div>

      {/* Track area */}
      <div ref={scrollRef} className="flex flex-1 min-h-0 overflow-auto">
        {/* Headers */}
        <div className="sticky left-0 z-10 w-44 shrink-0 border-r border-border bg-bg-2">
          <div className="flex items-center border-b border-border px-2 text-[9px] font-mono uppercase text-text-dim" style={{ height: 28 }}>Tracks</div>
          {tracks.length === 0 && <div className="p-3 text-center text-[11px] text-text-dim">No tracks. Import audio or add a track.</div>}
          {tracks.map((t) => <TrackHeader key={t.id} track={t} hasSolo={tracks.some((x) => x.solo)} slate={slate} engineRef={engineRef} />)}
        </div>

        {/* Timeline */}
        <div className="relative flex-1" style={{ minWidth: timelineDuration * pxPerSec }}>
          {/* Ruler + loop handles */}
          <div className="sticky top-0 z-10 border-b border-border bg-bg-2/95" style={{ height: 28 }}>
            {Array.from({ length: Math.ceil(timelineDuration / tickInterval) + 1 }, (_, i) => {
              const t = i * tickInterval;
              return (
                <span key={i} className="absolute top-1 pl-1 text-[8px] font-mono text-text-dim" style={{ left: t * pxPerSec }}>{formatTick(t)}</span>
              );
            })}
            {looping && (
              <>
                <div onPointerDown={(e) => startLoopDrag('start', e)} className="absolute top-0 z-20 flex h-7 cursor-ew-resize items-center justify-center bg-accent/40 hover:bg-accent/60" style={{ left: loopStart * pxPerSec - 8, width: 8 }} title="Drag loop start"><ChevronLeft size={10} className="text-white" /></div>
                <div onPointerDown={(e) => startLoopDrag('end', e)} className="absolute top-0 z-20 flex h-7 cursor-ew-resize items-center justify-center bg-accent/40 hover:bg-accent/60" style={{ left: loopEnd * pxPerSec, width: 8 }} title="Drag loop end"><ChevronRight size={10} className="text-white" /></div>
              </>
            )}
          </div>
          {/* Seek layer — background click catcher (behind clips) */}
          <div className="absolute inset-0 top-7" onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / pxRef.current); }} />
          {/* Grid background */}
          <div className="pointer-events-none absolute inset-0 top-7" style={gridStyle}>
            {looping && <div onPointerDown={(e) => startLoopDrag('move', e)} className="pointer-events-auto absolute top-0 bottom-0 cursor-grab bg-accent/8 border-x-2 border-accent/40" style={{ left: loopStart * pxPerSec, width: (loopEnd - loopStart) * pxPerSec }} />}
          </div>
          {/* Playhead */}
          <div ref={playheadRef} className="absolute top-0 bottom-0 z-20 w-0.5 bg-warn pointer-events-none" style={{ transform: 'translateX(0px)' }}>
            <div className="absolute top-0 -left-1 h-2 w-2 rounded-full bg-warn" />
          </div>
          {/* Clips */}
          {tracks.map((t) => (
            <div key={t.id} className="pointer-events-none relative border-b border-border/15" style={{ height: TRACK_H }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => (
                <ClipBlock key={c.id} clip={c} pxPerSec={pxPerSec} selected={selectedClipId === c.id}
                  onSelect={setSelectedClipId} onDragStart={startDrag} onTrimStart={startTrim} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Status */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-0.5 text-[8px] font-mono uppercase text-text-dim">
        <span>{tracks.length}T · {clips.length}C</span>
        {recording && <span className="text-danger">● Rec</span>}
        {playing && <span className="text-accent">▶ Play</span>}
        <span className="ml-auto">Space · C=Split · D=Dup · Del · R=Rec · L=Loop · M=Met · ←→=Seek · Ctrl+Scroll=Zoom</span>
      </div>
    </div>
  );
}

// ── Track header ────────────────────────────────────────────────────────────

const TrackHeader = memo(function TrackHeader({ track, hasSolo, slate, engineRef }: {
  track: AudioTrack; hasSolo: boolean;
  slate: ReturnType<typeof useRoom>['slate'];
  engineRef: React.RefObject<AudioEngine | null>;
}) {
  const [vol, setVol] = useState(track.volume);
  const [pan, setPan] = useState(track.pan);
  // While the user is dragging either slider, DON'T let the prop-sync effects
  // overwrite the local state — otherwise the Yjs observe fired by the engine's
  // live `updateTracks` would clobber `vol`/`pan` mid-drag, causing the slider
  // to fight the user (the "big slider does nothing" symptom).
  const isDraggingRef = useRef(false);
  useEffect(() => { if (!isDraggingRef.current) setVol(track.volume); }, [track.volume]);
  useEffect(() => { if (!isDraggingRef.current) setPan(track.pan); }, [track.pan]);

  const update = (patch: Partial<AudioTrack>) => { updateAudioTrack(slate, track.id, patch); engineRef.current?.updateTracks(slate); };
  const onVolDown = () => { isDraggingRef.current = true; };
  const onVol = (v: number) => { setVol(v); engineRef.current?.updateTracks(slate); };
  const onVolEnd = () => { isDraggingRef.current = false; updateAudioTrack(slate, track.id, { volume: vol }); };
  const onPanDown = () => { isDraggingRef.current = true; };
  const onPan = (p: number) => { setPan(p); engineRef.current?.updateTracks(slate); };
  const onPanEnd = () => { isDraggingRef.current = false; updateAudioTrack(slate, track.id, { pan: pan }); };

  return (
    <div className="border-b border-border/15 px-2 py-1" style={{ height: TRACK_H }}>
      <div className="flex items-center gap-0.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} />
        <input type="text" value={track.name} onChange={(e) => update({ name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-text outline-none" />
        <button onClick={() => update({ muted: !track.muted })} className={`flex h-4 w-4 items-center justify-center rounded ${track.muted && !hasSolo ? 'bg-warn/30 text-warn' : 'text-text-mid hover:bg-bg-3'}`} title="M">{track.muted ? <VolumeX size={9} /> : <Volume2 size={9} />}</button>
        <button onClick={() => update({ solo: !track.solo })} className={`flex h-4 w-4 items-center justify-center rounded ${track.solo ? 'bg-accent/30 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="S"><Headphones size={9} /></button>
        <button onClick={() => update({ armed: !track.armed, input: !track.armed ? 'mic' : 'none' })} className={`flex h-4 w-4 items-center justify-center rounded ${track.armed ? 'bg-danger/30 text-danger' : 'text-text-mid hover:bg-bg-3'}`} title="Arm"><div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: track.armed ? 'currentColor' : 'transparent', border: '1px solid currentColor' }} /></button>
        <button onClick={() => deleteAudioTrack(slate, track.id)} className="flex h-4 w-4 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger" title="Del"><Trash2 size={9} /></button>
      </div>
      <div className="mt-0.5 flex items-center gap-1">
        <Volume2 size={8} className="shrink-0 text-text-dim" />
        <input type="range" min={0} max={1} step={0.01} value={vol} onPointerDown={onVolDown} onChange={(e) => onVol(Number(e.target.value))} onPointerUp={onVolEnd} className="h-0.5 flex-1 accent-accent" />
        <input type="range" min={-1} max={1} step={0.01} value={pan} onPointerDown={onPanDown} onChange={(e) => onPan(Number(e.target.value))} onPointerUp={onPanEnd} className="h-0.5 w-8 accent-accent" />
      </div>
    </div>
  );
});

// ── Clip block ──────────────────────────────────────────────────────────────

const ClipBlock = memo(function ClipBlock({ clip, pxPerSec, selected, onSelect, onDragStart, onTrimStart }: {
  clip: AudioClip; pxPerSec: number; selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (clip: AudioClip, e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => void;
  onTrimStart: (clip: AudioClip, side: 'left' | 'right', e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => void;
}) {
  const left = clip.start * pxPerSec;
  const width = Math.max(4, clip.duration * pxPerSec);
  const elRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const w = Math.max(2, Math.floor(width));
  // Fade overlay widths (clamped to the clip box so a too-long fade doesn't
  // spill past the opposite edge).
  const fadeInW = clip.fadeIn > 0 ? Math.min(width, clip.fadeIn * pxPerSec) : 0;
  const fadeOutW = clip.fadeOut > 0 ? Math.min(width, clip.fadeOut * pxPerSec) : 0;

  return (
    <div ref={elRef} onPointerDown={(e) => { if (elRef.current) { e.stopPropagation(); onSelect(clip.id); window.dispatchEvent(new CustomEvent('slate:audio-clip-select', { detail: clip.id })); onDragStart(clip, e, elRef.current, waveRef.current); } }}
      className={`group pointer-events-auto absolute top-0.5 bottom-0.5 cursor-grab overflow-hidden rounded border ${selected ? 'border-warn' : 'border-black/30'} active:cursor-grabbing`} style={{ left, width, backgroundColor: `${clip.color}20` }}>
      {/* Fixed-width waveform layer — clipped by the box so trimming cuts the
          audio rather than squashing the whole wave into a smaller space. */}
      <div ref={waveRef} className="pointer-events-none absolute top-0 bottom-0 left-0" style={{ width }}>
        {clip.sampleKey && <WaveformImg clipId={clip.id} sampleKey={clip.sampleKey} channels={clip.channels} sampleRate={clip.sampleRate} offset={clip.offset} duration={clip.duration} speed={clip.speed ?? 1} width={w} color={clip.color} />}
      </div>
      {/* Fade-in overlay: triangle from full height at the outer (left) edge
          tapering to 0 at the inner edge — the dark wedge represents the
          portion of the clip still under the fade. */}
      {fadeInW > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 left-0 bg-black/30" style={{ width: fadeInW, clipPath: 'polygon(0% 0%, 0% 100%, 100% 50%)' }} />
      )}
      {/* Fade-out overlay: mirrored on the right side. */}
      {fadeOutW > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 right-0 bg-black/30" style={{ width: fadeOutW, clipPath: 'polygon(100% 0%, 100% 100%, 0% 50%)' }} />
      )}
      <span className="absolute left-1 top-0 truncate text-[7px] font-medium text-text-mid/70 pointer-events-none">{clip.name}{clip.mute ? ' (muted)' : ''}</span>
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'left', e, elRef.current, waveRef.current); }} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'right', e, elRef.current, waveRef.current); }} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
    </div>
  );
});
