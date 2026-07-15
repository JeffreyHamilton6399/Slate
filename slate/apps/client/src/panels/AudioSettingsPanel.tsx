/**
 * AudioSettingsPanel — shows properties of the selected audio clip or track.
 * When a clip is selected: clip name, gain, pan, fade in/out, speed/pitch,
 * normalize, reverse, delete.
 * When no clip is selected: shows selected track properties (volume, pan,
 * mute, solo, arm).
 * Also has an import button + audio asset library at the bottom.
 */

import { useEffect, useState } from 'react';
import { Trash2, Wand2, FlipHorizontal2, Scissors, Sliders, Volume2, VolumeX, Gauge } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import {
  deleteAudioClip, readAudioClip, readAudioTrack, updateAudioClip,
  updateAudioTrack, splitAudioClip, deleteAudioTrack,
} from '../audio/scene';
import { loadSamples, float32ToNumberArray, storeSamples } from '../audio/sampleStore';

export function AudioSettingsPanel() {
  const room = useRoom();
  const slate = room.slate;
  const [version, setVersion] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // Subscribe to Yjs changes.
  useEffect(() => {
    const tracks = slate.audioTracks();
    const clips = slate.audioClips();
    const bump = () => setVersion((v) => v + 1);
    tracks.observeDeep(bump);
    clips.observeDeep(bump);
    bump();
    return () => { tracks.unobserveDeep(bump); clips.unobserveDeep(bump); };
  }, [slate]);

  // Listen for clip selection events from the AudioEditor.
  useEffect(() => {
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setSelectedClipId(detail);
      // Find the track for this clip.
      const clip = slate.audioClips().get(detail);
      if (clip) setSelectedTrackId(clip.get('trackId') as string);
    };
    window.addEventListener('slate:audio-clip-select', onSelect as EventListener);
    return () => window.removeEventListener('slate:audio-clip-select', onSelect as EventListener);
  }, [slate]);

  // Read selected clip.
  const clip = selectedClipId ? (() => {
    const m = slate.audioClips().get(selectedClipId);
    return m ? readAudioClip(m, selectedClipId) : null;
  })() : null;

  // Read selected track (or the track of the selected clip).
  const track = (selectedTrackId ?? clip?.trackId) ? (() => {
    const id = selectedTrackId ?? clip?.trackId;
    if (!id) return null;
    const m = slate.audioTracks().get(id);
    return m ? readAudioTrack(m, id) : null;
  })() : null;

  // All tracks for the track selector.
  const allTracks: { id: string; name: string; color: string }[] = [];
  slate.audioTracks().forEach((m, id) => {
    const t = readAudioTrack(m, id);
    if (t) allTracks.push({ id, name: t.name, color: t.color });
  });

  const setClip = (patch: Parameters<typeof updateAudioClip>[2]) => {
    if (selectedClipId) updateAudioClip(slate, selectedClipId, patch);
  };
  const setTrack = (patch: Parameters<typeof updateAudioTrack>[2]) => {
    const id = selectedTrackId ?? clip?.trackId;
    if (id) updateAudioTrack(slate, id, patch);
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      {/* Clip properties */}
      {clip ? (
        <div className="flex flex-col gap-2">
          <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">Clip Settings</h5>
          <div>
            <label className="field-label">Name</label>
            <input type="text" value={clip.name} onChange={(e) => setClip({ name: e.target.value })} className="w-full rounded border border-border bg-bg-3 px-2 py-1 text-xs text-text outline-none focus:border-accent" />
          </div>
          <div>
            <label className="field-label">Color</label>
            <input type="color" value={clip.color} onChange={(e) => setClip({ color: e.target.value })} className="h-7 w-full rounded border border-border bg-transparent" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="field-label">Start (s)</label>
              <input type="number" step={0.1} value={clip.start.toFixed(2)} onChange={(e) => setClip({ start: Math.max(0, Number(e.target.value)) })} className="w-full rounded border border-border bg-bg-3 px-1 py-1 text-center text-xs text-text outline-none focus:border-accent" />
            </div>
            <div>
              <label className="field-label">Duration (s)</label>
              <input type="number" step={0.1} value={clip.duration.toFixed(2)} onChange={(e) => setClip({ duration: Math.max(0.1, Number(e.target.value)) })} className="w-full rounded border border-border bg-bg-3 px-1 py-1 text-center text-xs text-text outline-none focus:border-accent" />
            </div>
          </div>
          {/* Fades */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="field-label">Fade In (s)</label>
              <input type="range" min={0} max={clip.duration / 2} step={0.05} value={clip.fadeIn} onChange={(e) => setClip({ fadeIn: Number(e.target.value) })} className="w-full accent-accent" />
              <span className="text-[9px] font-mono text-text-dim">{clip.fadeIn.toFixed(2)}s</span>
            </div>
            <div>
              <label className="field-label">Fade Out (s)</label>
              <input type="range" min={0} max={clip.duration / 2} step={0.05} value={clip.fadeOut} onChange={(e) => setClip({ fadeOut: Number(e.target.value) })} className="w-full accent-accent" />
              <span className="text-[9px] font-mono text-text-dim">{clip.fadeOut.toFixed(2)}s</span>
            </div>
          </div>
          {/* Gain + pan */}
          <div>
            <label className="field-label">Gain</label>
            <div className="flex items-center gap-2">
              <Volume2 size={12} className="text-text-dim" />
              <input type="range" min={0} max={1.5} step={0.01} value={clip.gain ?? 1} onChange={(e) => setClip({ gain: Number(e.target.value) })} className="flex-1 accent-accent" />
              <span className="w-8 text-right font-mono text-[10px] text-text-dim">{Math.round((clip.gain ?? 1) * 100)}</span>
            </div>
          </div>
          <div>
            <label className="field-label">Pan</label>
            <div className="flex items-center gap-2">
              <Sliders size={12} className="text-text-dim" />
              <input type="range" min={-1} max={1} step={0.01} value={clip.pan ?? 0} onChange={(e) => setClip({ pan: Number(e.target.value) })} className="flex-1 accent-accent" />
              <span className="w-8 text-right font-mono text-[10px] text-text-dim">{(clip.pan ?? 0) > 0 ? `R${Math.round((clip.pan ?? 0) * 100)}` : (clip.pan ?? 0) < 0 ? `L${Math.round(-(clip.pan ?? 0) * 100)}` : 'C'}</span>
            </div>
          </div>
          {/* Speed */}
          <div>
            <label className="field-label">Speed / Pitch</label>
            <div className="flex items-center gap-2">
              <Gauge size={12} className="text-text-dim" />
              <input type="range" min={0.25} max={4} step={0.05} value={clip.speed ?? 1} onChange={(e) => setClip({ speed: Number(e.target.value) })} className="flex-1 accent-accent" />
              <span className="w-10 text-right font-mono text-[10px] text-text-dim">{(clip.speed ?? 1).toFixed(2)}×</span>
            </div>
          </div>
          {/* Mute + source info */}
          <div className="flex items-center justify-between">
            <button onClick={() => setClip({ mute: !clip.mute })} className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${clip.mute ? 'border-warn/50 bg-warn/15 text-warn' : 'border-border text-text-mid hover:bg-bg-3'}`}>{clip.mute ? <VolumeX size={11} /> : <Volume2 size={11} />}{clip.mute ? 'Muted' : 'Mute clip'}</button>
            <span className="font-mono text-[9px] text-text-dim">{clip.sampleRate} Hz · {clip.channels === 2 ? 'stereo' : 'mono'}</span>
          </div>
          {/* Quick actions */}
          <div className="flex gap-1">
            <button onClick={() => splitAudioClip(slate, clip.id, clip.start + clip.duration / 2)} className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><Scissors size={10} />Split</button>
            <button onClick={async () => {
              const samples = await loadSamples(clip.sampleKey);
              let max = 0;
              for (let i = 0; i < samples.length; i += clip.channels) for (let ch = 0; ch < clip.channels; ch++) max = Math.max(max, Math.abs(samples[i + ch] ?? 0));
              if (max < 1e-6) return;
              const g = 1 / max;
              const normed = new Float32Array(samples.length);
              for (let i = 0; i < samples.length; i++) normed[i] = samples[i]! * g;
              await storeSamples(clip.sampleKey, float32ToNumberArray(normed));
              window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: clip.id }));
              toast({ title: 'Normalized' });
            }} className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><Wand2 size={10} />Normalize</button>
            <button onClick={async () => {
              const samples = await loadSamples(clip.sampleKey);
              const ch = clip.channels;
              const frames = samples.length / ch;
              const out = new Float32Array(samples.length);
              for (let i = 0; i < frames; i++) { const s = (frames - 1 - i) * ch; const d = i * ch; for (let c = 0; c < ch; c++) out[d + c] = samples[s + c] ?? 0; }
              await storeSamples(clip.sampleKey, float32ToNumberArray(out));
              window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: clip.id }));
              toast({ title: 'Reversed' });
            }} className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><FlipHorizontal2 size={10} />Reverse</button>
            <button onClick={() => { deleteAudioClip(slate, clip.id); setSelectedClipId(null); }} className="flex items-center justify-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-danger"><Trash2 size={10} /></button>
          </div>
          {/* Move to track */}
          <div>
            <label className="field-label">Move to track</label>
            <select value={clip.trackId} onChange={(e) => setClip({ trackId: e.target.value })} className="w-full rounded border border-border bg-bg-3 px-1 py-1 text-xs text-text outline-none focus:border-accent">
              {allTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>
      ) : track ? (
        <div className="flex flex-col gap-2">
          <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">Track Settings</h5>
          <div>
            <label className="field-label">Name</label>
            <input type="text" value={track.name} onChange={(e) => setTrack({ name: e.target.value })} className="w-full rounded border border-border bg-bg-3 px-2 py-1 text-xs text-text outline-none focus:border-accent" />
          </div>
          <div>
            <label className="field-label">Color</label>
            <input type="color" value={track.color} onChange={(e) => setTrack({ color: e.target.value })} className="h-7 w-full rounded border border-border bg-transparent" />
          </div>
          <div>
            <label className="field-label">Volume</label>
            <div className="flex items-center gap-2">
              <Volume2 size={12} className="text-text-dim" />
              <input type="range" min={0} max={1} step={0.01} value={track.volume} onChange={(e) => setTrack({ volume: Number(e.target.value) })} className="flex-1 accent-accent" />
              <span className="w-8 text-right font-mono text-[10px] text-text-dim">{Math.round(track.volume * 100)}</span>
            </div>
          </div>
          <div>
            <label className="field-label">Pan</label>
            <div className="flex items-center gap-2">
              <Sliders size={12} className="text-text-dim" />
              <input type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(e) => setTrack({ pan: Number(e.target.value) })} className="flex-1 accent-accent" />
              <span className="w-8 text-right font-mono text-[10px] text-text-dim">{track.pan > 0 ? `R${Math.round(track.pan * 100)}` : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : 'C'}</span>
            </div>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setTrack({ muted: !track.muted })} className={`flex-1 rounded border py-1 text-[10px] ${track.muted ? 'border-warn/50 bg-warn/15 text-warn' : 'border-border text-text-mid hover:bg-bg-3'}`}>{track.muted ? 'Muted' : 'Mute'}</button>
            <button onClick={() => setTrack({ solo: !track.solo })} className={`flex-1 rounded border py-1 text-[10px] ${track.solo ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border text-text-mid hover:bg-bg-3'}`}>{track.solo ? 'Solo' : 'Solo'}</button>
            <button onClick={() => setTrack({ armed: !track.armed, input: !track.armed ? 'mic' : 'none' })} className={`flex-1 rounded border py-1 text-[10px] ${track.armed ? 'border-danger/50 bg-danger/15 text-danger' : 'border-border text-text-mid hover:bg-bg-3'}`}>{track.armed ? 'Armed' : 'Arm'}</button>
          </div>
          <button onClick={() => { deleteAudioTrack(slate, track.id); setSelectedTrackId(null); }} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-danger"><Trash2 size={10} />Delete Track</button>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-text-dim">
          Select a clip in the timeline to edit its settings.
        </div>
      )}
    </div>
  );
}
