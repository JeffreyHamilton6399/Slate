/**
 * AudioEditor — CapCut/BandLab-style DAW.
 * Key optimization: waveforms are pre-computed as PNG data URLs cached per
 * clip id + sample count. The canvas only draws ONCE when a clip is first
 * seen or its samples change — not on every version bump.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, Pause, Play, Plus, Trash2, Volume2, VolumeX, Headphones,
  Music, Upload, Scissors, Repeat, ZoomIn, ZoomOut, Copy, SkipBack,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import {
  addAudioClip, addAudioTrack, decodeAudioFile, deleteAudioClip,
  deleteAudioTrack, readAudioClip, readAudioTrack,
  setAudioBpm, splitAudioClip, updateAudioClip, updateAudioTrack,
} from './scene';
import { AudioEngine } from './engine';
import { loadSamples, float32ToNumberArray } from './sampleStore';

const TRACK_H = 60;

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
 *  a clip of `duration` timeline seconds consumes `duration*s` buffer seconds. */
const WaveformImg = memo(function WaveformImg({ clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color }: {
  clipId: string; sampleKey: string; channels: number; sampleRate: number;
  offset: number; duration: number; speed: number; width: number; color: string;
}) {
  const height = TRACK_H - 6;
  const [imgUrl, setImgUrl] = useState<string>('');

  useEffect(() => {
    const startFrame = Math.round(offset * sampleRate);
    const endFrame = Math.round((offset + duration * speed) * sampleRate);
    const cacheKey = `${clipId}:${sampleKey}:${startFrame}:${endFrame}:${Math.floor(width)}`;
    const cached = waveformPNGCache.get(cacheKey);
    if (cached) { setImgUrl(cached); return; }
    let cancelled = false;
    void loadSamples(sampleKey).then((samples) => {
      if (cancelled) return;
      const url = computeWaveformPNG(samples, channels, width, color, height, startFrame, endFrame);
      waveformPNGCache.set(cacheKey, url);
      setImgUrl(url);
    });
    return () => { cancelled = true; };
  }, [clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color, height]);

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
  } | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedClipId;
  const clipsRef = useRef<AudioClip[]>([]);
  const pxRef = useRef(pxPerSec);
  pxRef.current = pxPerSec;

  // Yjs subscription.
  useEffect(() => {
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

  // Ctrl+scroll zoom.
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPxPerSec((c) => Math.max(10, Math.min(800, c * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Global pointermove/up — pure DOM, zero React state.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const pps = pxRef.current;
      const dt = (ev.clientX - d.sx) / pps;
      const oldEnd = d.os + d.od;
      if (d.mode === 'drag') {
        // Keep the whole clip inside the free gap between its neighbours.
        const maxStart = Math.max(d.leftLimit, d.rightLimit - d.od);
        const start = Math.min(maxStart, Math.max(d.leftLimit, d.os + dt));
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
    const yo = slate.audioClips().get(id); if (!yo) return;
    const c = readAudioClip(yo, id); if (!c) return;
    const samples = await loadSamples(c.sampleKey);
    await addAudioClip(slate, c.trackId, { start: c.start + c.duration, samples: float32ToNumberArray(samples), sampleRate: c.sampleRate, channels: c.channels, duration: c.duration, name: `${c.name} copy` });
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
  // overlapping any other clip on the same track.
  const neighbourBounds = useCallback((clip: AudioClip): { leftLimit: number; rightLimit: number } => {
    let leftLimit = 0;
    let rightLimit = Infinity;
    const clipEnd = clip.start + clip.duration;
    for (const o of clipsRef.current) {
      if (o.id === clip.id || o.trackId !== clip.trackId) continue;
      const oEnd = o.start + o.duration;
      if (oEnd <= clip.start + 1e-4) leftLimit = Math.max(leftLimit, oEnd);
      else if (o.start >= clipEnd - 1e-4) rightLimit = Math.min(rightLimit, o.start);
    }
    return { leftLimit, rightLimit };
  }, []);

  const startDrag = useCallback((clip: AudioClip, e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation(); setSelectedClipId(clip.id);
    const { leftLimit, rightLimit } = neighbourBounds(clip);
    dragRef.current = { clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset, speed: clip.speed ?? 1, sx: e.clientX, leftLimit, rightLimit, mode: 'drag' };
  }, [neighbourBounds]);

  const startTrim = useCallback((clip: AudioClip, side: 'left' | 'right', e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation(); setSelectedClipId(clip.id);
    const { leftLimit, rightLimit } = neighbourBounds(clip);
    dragRef.current = { clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset, speed: clip.speed ?? 1, sx: e.clientX, leftLimit, rightLimit, mode: side === 'left' ? 'trimL' : 'trimR' };
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
        <button onClick={() => setPxPerSec((c) => Math.max(10, c / 1.3))} className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom out"><ZoomOut size={12} /></button>
        <button onClick={() => setPxPerSec((c) => Math.min(800, c * 1.3))} className="flex h-6 w-6 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom in"><ZoomIn size={12} /></button>
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
            {Array.from({ length: Math.ceil(timelineDuration / 5) + 1 }, (_, i) => (
              <span key={i} className="absolute top-1 pl-1 text-[8px] font-mono text-text-dim" style={{ left: i * 5 * pxPerSec }}>{i * 5}s</span>
            ))}
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
  useEffect(() => { setVol(track.volume); }, [track.volume]);
  useEffect(() => { setPan(track.pan); }, [track.pan]);

  const update = (patch: Partial<AudioTrack>) => { updateAudioTrack(slate, track.id, patch); engineRef.current?.updateTracks(slate); };
  const onVol = (v: number) => { setVol(v); engineRef.current?.updateTracks(slate); };
  const onVolEnd = () => updateAudioTrack(slate, track.id, { volume: vol });
  const onPan = (p: number) => { setPan(p); engineRef.current?.updateTracks(slate); };
  const onPanEnd = () => updateAudioTrack(slate, track.id, { pan: pan });

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
        <input type="range" min={0} max={1} step={0.01} value={vol} onChange={(e) => onVol(Number(e.target.value))} onPointerUp={onVolEnd} className="h-0.5 flex-1 accent-accent" />
        <input type="range" min={-1} max={1} step={0.01} value={pan} onChange={(e) => onPan(Number(e.target.value))} onPointerUp={onPanEnd} className="h-0.5 w-8 accent-accent" />
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

  return (
    <div ref={elRef} onPointerDown={(e) => { if (elRef.current) { e.stopPropagation(); onSelect(clip.id); window.dispatchEvent(new CustomEvent('slate:audio-clip-select', { detail: clip.id })); onDragStart(clip, e, elRef.current, waveRef.current); } }}
      className={`group pointer-events-auto absolute top-0.5 bottom-0.5 cursor-grab overflow-hidden rounded border ${selected ? 'border-warn' : 'border-black/30'} active:cursor-grabbing`} style={{ left, width, backgroundColor: `${clip.color}20` }}>
      {/* Fixed-width waveform layer — clipped by the box so trimming cuts the
          audio rather than squashing the whole wave into a smaller space. */}
      <div ref={waveRef} className="pointer-events-none absolute top-0 bottom-0 left-0" style={{ width }}>
        {clip.sampleKey && <WaveformImg clipId={clip.id} sampleKey={clip.sampleKey} channels={clip.channels} sampleRate={clip.sampleRate} offset={clip.offset} duration={clip.duration} speed={clip.speed ?? 1} width={w} color={clip.color} />}
      </div>
      <span className="absolute left-1 top-0 truncate text-[7px] font-medium text-text-mid/70 pointer-events-none">{clip.name}{clip.mute ? ' (muted)' : ''}</span>
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'left', e, elRef.current, waveRef.current); }} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'right', e, elRef.current, waveRef.current); }} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
    </div>
  );
});
