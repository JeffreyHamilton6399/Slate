/**
 * AudioEditor — CapCut/BandLab-style DAW. Canvas waveforms, throttled drags,
 * CapCut hotkeys, clean dark UI.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, Pause, Play, Plus, Trash2, Volume2, VolumeX, Headphones,
  Music, Upload, Scissors, Repeat, ZoomIn, ZoomOut, Sliders,
  Copy, Wand2, FlipHorizontal2, SkipBack, SkipForward,
} from 'lucide-react';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import {
  addAudioClip, addAudioTrack, decodeAudioFile, deleteAudioClip,
  deleteAudioTrack, readAudioClip, readAudioTrack, setAudioBpm,
  splitAudioClip, updateAudioClip, updateAudioTrack,
} from './scene';
import { AudioEngine } from './engine';

const TRACK_H = 64;

// ── Canvas waveform — draws directly to a <canvas>, no DOM bars ──────────────

function WaveformCanvas({ clip, pxPerSec, color }: { clip: AudioClip; pxPerSec: number; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = Math.max(2, clip.duration * pxPerSec);
  const height = TRACK_H - 8;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const ch = clip.channels;
    const total = clip.samples.length / ch;
    const step = Math.max(1, Math.floor(total / width));
    const mid = height / 2;
    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
      const startSample = Math.floor((x / width) * total);
      let peak = 0;
      for (let i = 0; i < step; i++) {
        const idx = (startSample + i) * ch;
        const v = Math.abs(clip.samples[idx] ?? 0);
        if (v > peak) peak = v;
      }
      const barH = Math.max(1, peak * mid * 0.9);
      ctx.fillRect(x, mid - barH, 1, barH * 2);
    }
  }, [clip.samples, clip.channels, width, height, color]);

  return <canvas ref={canvasRef} className="pointer-events-none" />;
}

const MemoWaveform = memo(WaveformCanvas);

// ── Clip operations ─────────────────────────────────────────────────────────

function normalizeClip(clip: AudioClip): number[] {
  let max = 0;
  for (let i = 0; i < clip.samples.length; i += clip.channels) {
    for (let ch = 0; ch < clip.channels; ch++) max = Math.max(max, Math.abs(clip.samples[i + ch] ?? 0));
  }
  if (max < 1e-6) return clip.samples;
  const gain = 1 / max;
  return clip.samples.map((s) => s * gain);
}

function reverseClip(clip: AudioClip): number[] {
  const ch = clip.channels;
  const frames = clip.samples.length / ch;
  const out: number[] = new Array(clip.samples.length);
  for (let i = 0; i < frames; i++) {
    const src = (frames - 1 - i) * ch;
    const dst = i * ch;
    for (let c = 0; c < ch; c++) out[dst + c] = clip.samples[src + c] ?? 0;
  }
  return out;
}

// ── Main component ──────────────────────────────────────────────────────────

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
  const [pxPerSec, setPxPerSec] = useState(100);
  const engineRef = useRef<AudioEngine | null>(null);
  const stopRecRef = useRef<(() => Promise<{ samples: number[]; sampleRate: number; channels: number; duration: number }>) | null>(null);
  const rafRef = useRef(0);
  const positionRef = useRef(0);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const posDisplayRef = useRef<HTMLSpanElement | null>(null);

  // Yjs subscription — throttled.
  useEffect(() => {
    const tracks = slate.audioTracks();
    const clips = slate.audioClips();
    const audioMap = slate.doc.getMap('audio');
    let pending = false;
    const bump = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; setVersion((v) => v + 1); });
    };
    tracks.observeDeep(bump);
    clips.observeDeep(bump);
    audioMap.observe(bump);
    bump();
    const lateRead = setTimeout(bump, 200);
    return () => { clearTimeout(lateRead); tracks.unobserveDeep(bump); clips.unobserveDeep(bump); audioMap.unobserve(bump); };
  }, [slate]);

  useEffect(() => {
    engineRef.current = new AudioEngine();
    engineRef.current.setMasterVolume(masterVol);
    return () => { engineRef.current?.dispose(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playhead — direct DOM, no React state.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const eng = engineRef.current;
      if (!eng) return;
      const pos = eng.getPosition();
      positionRef.current = pos;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxPerSec}px)`;
      if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
      if (!looping && pos > timelineDuration + 2) { eng.stop(); setPlaying(false); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, looping, pxPerSec]);

  // CapCut-style hotkeys: Space=play, C=split, Delete=delete, L=loop, M=metronome
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'c' && !e.ctrlKey) { e.preventDefault(); splitSelected(); }
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
      else if (k === 'd' && !e.ctrlKey) { e.preventDefault(); duplicateSelected(); }
      else if (k === 'l' && !e.ctrlKey) { e.preventDefault(); toggleLoop(); }
      else if (k === 'm' && !e.ctrlKey) { e.preventDefault(); toggleMetronome(); }
      else if (k === 'r' && !e.ctrlKey) { e.preventDefault(); void toggleRecord(); }
      else if (k === 'arrowleft') { e.preventDefault(); seek(positionRef.current - 1); }
      else if (k === 'arrowright') { e.preventDefault(); seek(positionRef.current + 1); }
      else if (k === 'home') { e.preventDefault(); seek(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, recording, metronome, looping, selectedClipId]);

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

  const timelineDuration = Math.max(30, ...clips.map((c) => c.start + c.duration), positionRef.current + 10);

  // ── Transport ─────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (playing) { eng.stop(); setPlaying(false); }
    else {
      if (looping) eng.setLoopRegion(loopStart, loopEnd); else eng.setLoopRegion(null, null);
      eng.play(slate, positionRef.current);
      setPlaying(true);
    }
  }, [playing, slate, looping, loopStart, loopEnd]);

  const doStop = useCallback(() => {
    engineRef.current?.stop();
    setPlaying(false);
    positionRef.current = 0;
    if (playheadRef.current) playheadRef.current.style.transform = 'translateX(0px)';
    if (posDisplayRef.current) posDisplayRef.current.textContent = '0.0s';
  }, []);

  const seek = useCallback((t: number) => {
    const pos = Math.max(0, t);
    positionRef.current = pos;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxPerSec}px)`;
    if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
  }, [pxPerSec]);

  const toggleRecord = useCallback(async () => {
    if (recording) {
      const stopFn = stopRecRef.current;
      if (stopFn) {
        const result = await stopFn();
        stopRecRef.current = null;
        setRecording(false);
        let tid = tracks.find((t) => t.armed)?.id;
        if (!tid) tid = addAudioTrack(slate, { name: 'Recording' });
        addAudioClip(slate, tid, { start: positionRef.current, samples: result.samples, sampleRate: result.sampleRate, channels: result.channels, duration: result.duration, name: `Rec ${new Date().toLocaleTimeString()}` });
        toast({ title: 'Recording added' });
      }
    } else {
      try {
        const stopFn = await engineRef.current?.startRecording();
        stopRecRef.current = stopFn ?? null;
        setRecording(true);
      } catch { toast({ title: 'Mic denied', variant: 'error' }); }
    }
  }, [recording, tracks, slate]);

  const toggleMetronome = useCallback(() => { const n = !metronome; setMetronome(n); engineRef.current?.setMetronome(n); }, [metronome]);
  const toggleLoop = useCallback(() => { const n = !looping; setLooping(n); if (n) engineRef.current?.setLoopRegion(loopStart, loopEnd); else engineRef.current?.setLoopRegion(null, null); }, [looping, loopStart, loopEnd]);

  const handleBpmChange = (v: number) => { setBpmState(v); setAudioBpm(slate, v); engineRef.current?.setBpm(v); };
  const handleMasterVol = (v: number) => { setMasterVol(v); engineRef.current?.setMasterVolume(v); };

  const handleFileImport = async (file: File) => {
    try {
      const decoded = await decodeAudioFile(file);
      const tid = addAudioTrack(slate, { name: file.name.replace(/\.[^.]+$/, '') });
      addAudioClip(slate, tid, { start: positionRef.current, samples: decoded.samples, sampleRate: decoded.sampleRate, channels: decoded.channels, duration: decoded.duration, name: file.name });
      toast({ title: 'Imported', description: file.name });
    } catch (err) { toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' }); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name));
    for (const f of files) void handleFileImport(f);
  };

  const zoom = (dir: 'in' | 'out') => setPxPerSec((c) => Math.max(20, Math.min(500, dir === 'in' ? c * 1.4 : c / 1.4)));

  // Clip ops.
  const splitSelected = () => {
    if (!selectedClipId) return;
    const yo = slate.audioClips().get(selectedClipId);
    if (!yo) return;
    const clip = readAudioClip(yo, selectedClipId);
    if (!clip) return;
    splitAudioClip(slate, selectedClipId, positionRef.current);
  };
  const deleteSelected = () => {
    if (!selectedClipId) return;
    deleteAudioClip(slate, selectedClipId);
    setSelectedClipId(null);
  };
  const duplicateSelected = () => {
    if (!selectedClipId) return;
    const yo = slate.audioClips().get(selectedClipId);
    if (!yo) return;
    const clip = readAudioClip(yo, selectedClipId);
    if (!clip) return;
    addAudioClip(slate, clip.trackId, { start: clip.start + clip.duration, samples: clip.samples, sampleRate: clip.sampleRate, channels: clip.channels, duration: clip.duration, name: `${clip.name} copy` });
  };

  // Throttled clip drag — writes to Yjs at most once per animation frame.
  const dragPending = useRef(false);
  const dragNewStart = useRef(0);
  const dragClipId = useRef<string | null>(null);
  const throttledDrag = (clipId: string, newStart: number) => {
    dragClipId.current = clipId;
    dragNewStart.current = Math.max(0, newStart);
    if (dragPending.current) return;
    dragPending.current = true;
    requestAnimationFrame(() => {
      dragPending.current = false;
      if (dragClipId.current) updateAudioClip(slate, dragClipId.current, { start: dragNewStart.current });
    });
  };

  return (
    <div className="flex h-full flex-col bg-bg overflow-hidden" onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }} onDrop={onDrop}>
      {/* Transport */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-bg-2 px-3 py-2">
        <button onClick={() => seek(0)} className="flex h-8 w-8 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Back to start"><SkipBack size={15} /></button>
        <button onClick={togglePlay} className={`flex h-10 w-10 items-center justify-center rounded-full text-white ${playing ? 'bg-warn' : 'bg-accent'} hover:opacity-80`} title="Play / Pause (Space)">
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button onClick={() => void toggleRecord()} className={`flex h-9 w-9 items-center justify-center rounded-full border ${recording ? 'border-danger bg-danger/20 text-danger animate-pulse' : 'border-border text-text-mid hover:bg-bg-3'}`} title="Record (R)"><Mic size={16} /></button>
        <div className="mx-2 h-6 w-px bg-border" />
        <span ref={posDisplayRef} className="min-w-[3rem] font-mono text-sm text-text">0.0s</span>
        <div className="mx-2 h-6 w-px bg-border" />
        {/* Clip ops */}
        <button onClick={splitSelected} disabled={!selectedClipId} className="flex h-8 w-8 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Split (C)"><Scissors size={15} /></button>
        <button onClick={duplicateSelected} disabled={!selectedClipId} className="flex h-8 w-8 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Duplicate (D)"><Copy size={15} /></button>
        <button onClick={deleteSelected} disabled={!selectedClipId} className="flex h-8 w-8 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger disabled:opacity-30" title="Delete (Del)"><Trash2 size={15} /></button>
        <div className="mx-2 h-6 w-px bg-border" />
        <label className="flex items-center gap-1 text-xs text-text-dim">BPM<input type="number" min={20} max={300} value={bpm} onChange={(e) => handleBpmChange(Number(e.target.value))} className="w-12 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-sm text-text outline-none focus:border-accent" /></label>
        <button onClick={toggleMetronome} className={`flex h-8 w-8 items-center justify-center rounded ${metronome ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Metronome (M)"><Music size={14} /></button>
        <button onClick={toggleLoop} className={`flex h-8 w-8 items-center justify-center rounded ${looping ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Loop (L)"><Repeat size={14} /></button>
        <div className="mx-2 h-6 w-px bg-border" />
        <div className="flex items-center gap-1"><Volume2 size={13} className="text-text-mid" /><input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e) => handleMasterVol(Number(e.target.value))} className="w-16 accent-accent" /></div>
        <button onClick={() => zoom('out')} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom out"><ZoomOut size={13} /></button>
        <button onClick={() => zoom('in')} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom in"><ZoomIn size={13} /></button>
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-text-mid hover:bg-bg-3"><Upload size={13} />Import<input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFileImport(f); e.target.value = ''; }} /></label>
        <button onClick={() => addAudioTrack(slate)} className="flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs text-accent hover:bg-accent/20"><Plus size={13} />Track</button>
      </div>

      {/* Track area */}
      <div className="flex flex-1 min-h-0 overflow-auto">
        {/* Headers */}
        <div className="sticky left-0 z-10 w-48 shrink-0 border-r border-border bg-bg-2">
          <div className="flex items-center border-b border-border px-2 text-[10px] font-mono uppercase text-text-dim" style={{ height: 28 }}>Tracks</div>
          {tracks.length === 0 && <div className="p-3 text-center text-xs text-text-dim">No tracks. Import audio or add a track.</div>}
          {tracks.map((t) => <TrackHeader key={t.id} track={t} hasSolo={tracks.some((x) => x.solo)}
            onMute={() => { updateAudioTrack(slate, t.id, { muted: !t.muted }); engineRef.current?.updateTracks(slate); }}
            onSolo={() => { updateAudioTrack(slate, t.id, { solo: !t.solo }); engineRef.current?.updateTracks(slate); }}
            onVol={(v) => { updateAudioTrack(slate, t.id, { volume: v }); engineRef.current?.updateTracks(slate); }}
            onPan={(p) => { updateAudioTrack(slate, t.id, { pan: p }); engineRef.current?.updateTracks(slate); }}
            onArm={() => updateAudioTrack(slate, t.id, { armed: !t.armed, input: !t.armed ? 'mic' : 'none' })}
            onRename={(n) => updateAudioTrack(slate, t.id, { name: n })}
            onDelete={() => deleteAudioTrack(slate, t.id)} />)}
        </div>

        {/* Timeline */}
        <div className="relative flex-1" style={{ minWidth: timelineDuration * pxPerSec }}>
          {/* Ruler */}
          <div className="sticky top-0 z-10 border-b border-border bg-bg-2/95" style={{ height: 28 }}>
            {Array.from({ length: Math.ceil(timelineDuration) + 1 }, (_, i) => (
              <div key={i} className="absolute top-0 flex h-full items-center pl-1 text-[9px] font-mono text-text-dim" style={{ left: i * pxPerSec }}>{i}s</div>
            ))}
          </div>
          {/* Grid */}
          <div className="absolute inset-0 top-7">
            {Array.from({ length: Math.ceil(timelineDuration) + 1 }, (_, i) => (
              <div key={i} className="absolute top-0 bottom-0 border-l border-border/15" style={{ left: i * pxPerSec }} />
            ))}
          </div>
          {looping && <div className="absolute top-7 bottom-0 bg-accent/8 border-x border-accent/30" style={{ left: loopStart * pxPerSec, width: (loopEnd - loopStart) * pxPerSec }} />}
          {/* Playhead */}
          <div ref={playheadRef} className="absolute top-0 bottom-0 z-20 w-0.5 bg-warn pointer-events-none" style={{ transform: 'translateX(0px)' }}>
            <div className="absolute top-0 -left-1 h-2.5 w-2.5 rounded-full bg-warn" />
          </div>
          {/* Lanes */}
          {tracks.map((t) => {
            const tc = clips.filter((c) => c.trackId === t.id);
            return (
              <div key={t.id} className="relative border-b border-border/20" style={{ height: TRACK_H }}>
                {tc.map((c) => (
                  <ClipBlock key={c.id} clip={c} pxPerSec={pxPerSec} selected={selectedClipId === c.id}
                    onSelect={() => setSelectedClipId(c.id)}
                    onDrag={(ns) => throttledDrag(c.id, ns)}
                    onTrim={(d, o) => updateAudioClip(slate, c.id, { duration: Math.max(0.1, d), offset: Math.max(0, o) })}
                    onSplit={() => splitAudioClip(slate, c.id, positionRef.current)}
                    onDelete={() => { deleteAudioClip(slate, c.id); setSelectedClipId(null); }}
                    onFadeIn={(v) => updateAudioClip(slate, c.id, { fadeIn: v })}
                    onFadeOut={(v) => updateAudioClip(slate, c.id, { fadeOut: v })}
                    onNormalize={() => { const yo = slate.audioClips().get(c.id); if (yo) { const cl = readAudioClip(yo, c.id); if (cl) updateAudioClip(slate, c.id, { samples: normalizeClip(cl) }); } }}
                    onReverse={() => { const yo = slate.audioClips().get(c.id); if (yo) { const cl = readAudioClip(yo, c.id); if (cl) updateAudioClip(slate, c.id, { samples: reverseClip(cl) }); } }}
                  />
                ))}
              </div>
            );
          })}
          {/* Seek */}
          <div className="absolute inset-0" onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / pxPerSec); }} />
        </div>
      </div>

      {/* Status */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1 text-[9px] font-mono uppercase text-text-dim">
        <span>{tracks.length} tracks · {clips.length} clips</span>
        {recording && <span className="text-danger">● Rec</span>}
        {playing && <span className="text-accent">▶ Play</span>}
        <span className="ml-auto">Space=Play C=Split D=Dup Del=Delete R=Rec L=Loop M=Met ←→=Seek</span>
      </div>
    </div>
  );
}

// ── Track header ────────────────────────────────────────────────────────────

const TrackHeader = memo(function TrackHeader({ track, hasSolo, onMute, onSolo, onVol, onPan, onArm, onRename, onDelete }: {
  track: AudioTrack; hasSolo: boolean; onMute: () => void; onSolo: () => void;
  onVol: (v: number) => void; onPan: (p: number) => void; onArm: () => void; onRename: (n: string) => void; onDelete: () => void;
}) {
  return (
    <div className="border-b border-border/20 px-2 py-1.5" style={{ height: TRACK_H }}>
      <div className="flex items-center gap-1">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} />
        <input type="text" value={track.name} onChange={(e) => onRename(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs font-medium text-text outline-none" />
        <button onClick={onMute} className={`flex h-4 w-4 items-center justify-center rounded ${track.muted && !hasSolo ? 'bg-warn/30 text-warn' : 'text-text-mid hover:bg-bg-3'}`} title="Mute">{track.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}</button>
        <button onClick={onSolo} className={`flex h-4 w-4 items-center justify-center rounded ${track.solo ? 'bg-accent/30 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Solo"><Headphones size={10} /></button>
        <button onClick={onArm} className={`flex h-4 w-4 items-center justify-center rounded ${track.armed ? 'bg-danger/30 text-danger' : 'text-text-mid hover:bg-bg-3'}`} title="Arm"><div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: track.armed ? 'currentColor' : 'transparent', border: '1px solid currentColor' }} /></button>
        <button onClick={onDelete} className="flex h-4 w-4 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger" title="Delete"><Trash2 size={10} /></button>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Volume2 size={9} className="shrink-0 text-text-dim" />
        <input type="range" min={0} max={1} step={0.01} value={track.volume} onChange={(e) => onVol(Number(e.target.value))} className="h-1 flex-1 accent-accent" />
        <Sliders size={9} className="shrink-0 text-text-dim" />
        <input type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(e) => onPan(Number(e.target.value))} className="h-1 w-10 accent-accent" />
      </div>
    </div>
  );
});

// ── Clip block ──────────────────────────────────────────────────────────────

const ClipBlock = memo(function ClipBlock({ clip, pxPerSec, selected, onSelect, onDrag, onTrim, onSplit, onDelete, onFadeIn, onFadeOut, onNormalize, onReverse }: {
  clip: AudioClip; pxPerSec: number; selected: boolean; onSelect: () => void;
  onDrag: (ns: number) => void; onTrim: (d: number, o: number) => void; onSplit: () => void;
  onDelete: () => void; onFadeIn: (v: number) => void; onFadeOut: (v: number) => void;
  onNormalize: () => void; onReverse: () => void;
}) {
  const left = clip.start * pxPerSec;
  const width = Math.max(4, clip.duration * pxPerSec);
  const fiW = clip.fadeIn * pxPerSec;
  const foW = clip.fadeOut * pxPerSec;

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation(); onSelect();
    const sx = e.clientX; const os = clip.start;
    const mv = (ev: PointerEvent) => onDrag(os + (ev.clientX - sx) / pxPerSec);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const startTrimL = (e: React.PointerEvent) => {
    e.stopPropagation(); onSelect();
    const sx = e.clientX; const os = clip.start; const od = clip.duration; const oo = clip.offset;
    const mv = (ev: PointerEvent) => { const dt = (ev.clientX - sx) / pxPerSec; if (od - dt > 0.1 && oo + dt >= 0) { onDrag(os + dt); onTrim(od - dt, oo + dt); } };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const startTrimR = (e: React.PointerEvent) => {
    e.stopPropagation(); onSelect();
    const sx = e.clientX; const od = clip.duration;
    const mv = (ev: PointerEvent) => onTrim(Math.max(0.1, od + (ev.clientX - sx) / pxPerSec), clip.offset);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  return (
    <div onPointerDown={startDrag} className={`group absolute top-0.5 bottom-0.5 cursor-grab overflow-hidden rounded border ${selected ? 'border-warn' : 'border-black/30'} active:cursor-grabbing`} style={{ left, width, backgroundColor: `${clip.color}25` }}>
      <MemoWaveform clip={clip} pxPerSec={pxPerSec} color={clip.color} />
      {clip.fadeIn > 0 && <div className="absolute top-0 bottom-0 left-0" style={{ width: fiW, background: `linear-gradient(to right, ${clip.color}00, ${clip.color}30)`, clipPath: 'polygon(0 0, 100% 50%, 0 100%)' }} />}
      {clip.fadeOut > 0 && <div className="absolute top-0 bottom-0 right-0" style={{ width: foW, background: `linear-gradient(to left, ${clip.color}00, ${clip.color}30)`, clipPath: 'polygon(100% 0, 0 50%, 100% 100%)' }} />}
      <span className="absolute left-1 top-0 truncate text-[8px] font-medium text-text-mid/80">{clip.name}</span>
      <div onPointerDown={startTrimL} className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100" />
      <div onPointerDown={startTrimR} className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100" />
      {selected && (
        <div className="absolute bottom-0.5 left-1 right-1 flex items-center gap-1">
          <label className="flex items-center gap-0.5 text-[7px] text-text-dim">FI<input type="range" min={0} max={clip.duration / 2} step={0.05} value={clip.fadeIn} onChange={(e) => onFadeIn(Number(e.target.value))} onPointerDown={(e) => e.stopPropagation()} className="h-0.5 w-10 accent-accent" /></label>
          <label className="flex items-center gap-0.5 text-[7px] text-text-dim">FO<input type="range" min={0} max={clip.duration / 2} step={0.05} value={clip.fadeOut} onChange={(e) => onFadeOut(Number(e.target.value))} onPointerDown={(e) => e.stopPropagation()} className="h-0.5 w-10 accent-accent" /></label>
        </div>
      )}
    </div>
  );
});
