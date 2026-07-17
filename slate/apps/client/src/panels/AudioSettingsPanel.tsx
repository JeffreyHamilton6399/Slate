/**
 * AudioSettingsPanel — real audio-editor settings for the selected clip or
 * track, DAW channel-strip style.
 *
 * Clip: gain (dB) / pan, fades, speed / pitch, high-pass & low-pass filters,
 * mute, split/duplicate/normalize/reverse, move-to-track.
 * Track: volume (dB) / pan, 3-band EQ (low shelf 200 Hz, mid peak 1 kHz,
 * high shelf 4 kHz), reverb & delay sends, mute/solo/arm.
 *
 * All numeric parameters use the RotaryKnob component below — a circular DAW
 * knob (Ableton/FL Studio style) with a coloured value arc + indicator line,
 * drag-to-adjust (vertical), mouse-wheel, and keyboard arrow support.
 * Track EQ/send edits are audible live: the AudioEditor re-applies track
 * values to the audio graph on every Yjs track change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Wand2, FlipHorizontal2, Scissors, Copy } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import {
  deleteAudioClip, duplicateAudioClip, readAudioClip, readAudioTrack, updateAudioClip,
  updateAudioTrack, splitAudioClip, deleteAudioTrack,
} from '../audio/scene';
import { loadSamples, storeSamples } from '../audio/sampleStore';
import { audioPlayheadPos, nearestFreeStart } from '../audio/AudioEditor';

/** Linear amplitude → decibels for display (0 → -∞). */
function fmtDb(v: number): string {
  if (v <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** EQ band gain formatting: flat reads "0.0", boosts get a +. */
function fmtBandDb(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

/** Filter cutoff formatting: Hz below 1k, kHz above. */
function fmtHz(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
}

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
          {/* Name + Color */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="field-label">Name</label>
              <input type="text" value={clip.name} onChange={(e) => setClip({ name: e.target.value })} className="w-full rounded border border-border bg-bg-3 px-2 py-1 text-xs text-text outline-none focus:border-accent" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="field-label">Color</label>
              <input type="color" value={clip.color} onChange={(e) => setClip({ color: e.target.value })} className="h-7 w-full rounded border border-border bg-transparent" />
            </div>
          </div>
          {/* Fades — rotary knobs */}
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="Fade In"
              value={clip.fadeIn}
              min={0}
              max={Math.max(0.1, clip.duration / 2)}
              step={0.05}
              onChange={(v) => setClip({ fadeIn: v })}
              format={(v) => `${v.toFixed(2)}s`}
            />
            <RotaryKnob
              label="Fade Out"
              value={clip.fadeOut}
              min={0}
              max={Math.max(0.1, clip.duration / 2)}
              step={0.05}
              onChange={(v) => setClip({ fadeOut: v })}
              format={(v) => `${v.toFixed(2)}s`}
            />
          </div>
          {/* Gain + Pan — rotary knobs. Gain is stored linear (0..1.5 ≈
              -∞..+3.5 dB) but displayed in dB like a real channel strip. */}
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="Gain"
              value={clip.gain ?? 1}
              min={0}
              max={1.5}
              step={0.01}
              onChange={(v) => setClip({ gain: v })}
              format={fmtDb}
            />
            <RotaryKnob
              label="Pan"
              value={clip.pan ?? 0}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => setClip({ pan: v })}
              format={(v) => (v > 0.005 ? `R${Math.round(v * 100)}` : v < -0.005 ? `L${Math.round(-v * 100)}` : 'C')}
            />
          </div>
          {/* Speed + Pitch — two separate rotary knobs.
              • Speed: 0.25×..4×, sets clip.speed (timeline rate; Web Audio
                playbackRate — naturally shifts pitch as a side effect).
              • Pitch: -12..+12 semitones, sets clip.pitch (stored in Yjs as
                cents = semitones × 100). Applied via the buffer source's
                `detune` AudioParam. */}
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="Speed"
              value={clip.speed ?? 1}
              min={0.25}
              max={4}
              step={0.05}
              onChange={(v) => setClip({ speed: v })}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <RotaryKnob
              label="Pitch"
              value={(clip.pitch ?? 0) / 100}
              min={-12}
              max={12}
              step={1}
              onChange={(v) => setClip({ pitch: v * 100 })}
              format={(v) => {
                const n = Math.round(v);
                return n > 0 ? `+${n} st` : `${n} st`;
              }}
            />
          </div>
          {/* Filters — high-pass cuts rumble/mud, low-pass tames hiss or
              makes the "muffled" telephone/underwater effect. At the extreme
              ends (20 Hz / 20 kHz) the filter is bypassed entirely. */}
          <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">Filters</p>
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="High-pass"
              value={clip.hpCutoff ?? 20}
              min={20}
              max={1000}
              step={5}
              onChange={(v) => setClip({ hpCutoff: v })}
              format={(v) => (v <= 22 ? 'Off' : fmtHz(v))}
            />
            <RotaryKnob
              label="Low-pass"
              value={clip.lpCutoff ?? 20000}
              min={500}
              max={20000}
              step={100}
              onChange={(v) => setClip({ lpCutoff: v })}
              format={(v) => (v >= 19500 ? 'Off' : fmtHz(v))}
            />
          </div>
          {/* Mute + source info */}
          <div className="flex items-center justify-between">
            <button onClick={() => setClip({ mute: !clip.mute })} className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${clip.mute ? 'border-warn/50 bg-warn/15 text-warn' : 'border-border text-text-mid hover:bg-bg-3'}`}>{clip.mute ? 'Muted' : 'Mute clip'}</button>
            <span className="font-mono text-[9px] text-text-dim">{clip.sampleRate} Hz · {clip.channels === 2 ? 'stereo' : 'mono'}</span>
          </div>
          {/* Quick actions — Split + Duplicate first (matching the D hotkey), then the sample-processing ops. */}
          <div className="grid grid-cols-2 gap-1">
            <button onClick={() => splitAudioClip(slate, clip.id, clip.start + clip.duration / 2)} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><Scissors size={10} />Split</button>
            <button onClick={() => {
              // Duplicate AT THE PLAYHEAD (matching the timeline's D key),
              // resolved to the nearest free gap on the clip's track.
              const blockers: { start: number; end: number }[] = [];
              slate.audioClips().forEach((m, cid) => {
                const c = readAudioClip(m, cid);
                if (c && c.trackId === clip.trackId) blockers.push({ start: c.start, end: c.start + c.duration });
              });
              const start = nearestFreeStart(audioPlayheadPos.current, clip.duration, blockers);
              void duplicateAudioClip(slate, clip.id, start).then(() => toast({ title: 'Duplicated at playhead' }));
            }} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent" title="Duplicate this clip at the playhead"><Copy size={10} />Duplicate</button>
            <button onClick={async () => {
              const samples = await loadSamples(clip.sampleKey);
              let max = 0;
              for (let i = 0; i < samples.length; i += clip.channels) for (let ch = 0; ch < clip.channels; ch++) max = Math.max(max, Math.abs(samples[i + ch] ?? 0));
              if (max < 1e-6) return;
              const g = 1 / max;
              const normed = new Float32Array(samples.length);
              for (let i = 0; i < samples.length; i++) normed[i] = samples[i]! * g;
              await storeSamples(clip.sampleKey, normed, { sampleRate: clip.sampleRate, channels: clip.channels });
              window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: clip.id }));
              toast({ title: 'Normalized' });
            }} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><Wand2 size={10} />Normalize</button>
            <button onClick={async () => {
              const samples = await loadSamples(clip.sampleKey);
              const ch = clip.channels;
              const frames = samples.length / ch;
              const out = new Float32Array(samples.length);
              for (let i = 0; i < frames; i++) { const s = (frames - 1 - i) * ch; const d = i * ch; for (let c = 0; c < ch; c++) out[d + c] = samples[s + c] ?? 0; }
              await storeSamples(clip.sampleKey, out, { sampleRate: clip.sampleRate, channels: clip.channels });
              window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: clip.id }));
              toast({ title: 'Reversed' });
            }} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-accent"><FlipHorizontal2 size={10} />Reverse</button>
          </div>
          <button onClick={() => { deleteAudioClip(slate, clip.id); setSelectedClipId(null); }} className="flex items-center justify-center gap-1 rounded border border-border py-1 text-[10px] text-text-mid hover:bg-bg-3 hover:text-danger"><Trash2 size={10} />Delete Clip</button>
          {/* Move to track */}
          <div className="flex flex-col gap-1">
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
          {/* Volume + Pan — rotary knobs. Volume stored linear, shown in dB. */}
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="Volume"
              value={track.volume}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setTrack({ volume: v })}
              format={fmtDb}
            />
            <RotaryKnob
              label="Pan"
              value={track.pan}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => setTrack({ pan: v })}
              format={(v) => (v > 0.005 ? `R${Math.round(v * 100)}` : v < -0.005 ? `L${Math.round(-v * 100)}` : 'C')}
            />
          </div>
          {/* 3-band channel EQ — low shelf 200 Hz, mid peak 1 kHz, high shelf
              4 kHz. ±12 dB like a console strip. Audible live during playback. */}
          <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">EQ</p>
          <div className="grid grid-cols-3 gap-1">
            <RotaryKnob
              label="Low"
              value={track.eqLow ?? 0}
              min={-12}
              max={12}
              step={0.5}
              onChange={(v) => setTrack({ eqLow: v })}
              format={fmtBandDb}
              size={42}
            />
            <RotaryKnob
              label="Mid"
              value={track.eqMid ?? 0}
              min={-12}
              max={12}
              step={0.5}
              onChange={(v) => setTrack({ eqMid: v })}
              format={fmtBandDb}
              size={42}
            />
            <RotaryKnob
              label="High"
              value={track.eqHigh ?? 0}
              min={-12}
              max={12}
              step={0.5}
              onChange={(v) => setTrack({ eqHigh: v })}
              format={fmtBandDb}
              size={42}
            />
          </div>
          {/* FX sends — shared room reverb + tempo-synced echo, per-track
              send level (0 = dry). */}
          <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">Sends</p>
          <div className="grid grid-cols-2 gap-2">
            <RotaryKnob
              label="Reverb"
              value={track.reverbSend ?? 0}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setTrack({ reverbSend: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <RotaryKnob
              label="Delay"
              value={track.delaySend ?? 0}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setTrack({ delaySend: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
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

// ── RotaryKnob ──────────────────────────────────────────────────────────────

/** Convert polar (angle in degrees, measured CLOCKWISE from 3 o'clock — i.e.
 *  SVG-friendly since y grows downward) to cartesian coordinates. */
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Arc path: clockwise from startAngle to endAngle (degrees, SVG convention). */
function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  // sweepFlag = 1 → clockwise (SVG visual, since y is down and angles increase
  // clockwise visually).
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/**
 * DAW-style rotary knob (Ableton / FL Studio inspired).
 *
 * Visual: a 270° value arc (gap at the bottom) with a coloured fill from min
 * to the current value, a circular knob body, and an indicator line pointing
 * to the current position. ~48px diameter.
 *
 * Interaction:
 *  - Drag up = increase, drag down = decrease (Shift = 3× finer).
 *  - Mouse wheel up = increase, down = decrease.
 *  - Arrow Up/Right = +step, Arrow Down/Left = -step (keyboard accessible).
 *
 * The `onChange` callback fires on every adjustment tick — same semantics as
 * the old `<input type="range">` it replaces, so the Yjs update logic is
 * unchanged.
 */
function RotaryKnob({ value, min, max, step, label, onChange, format, size = 48 }: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  size?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ startY: number; startVal: number; fine: boolean } | null>(null);

  // Latest value + onChange held in refs so the native (non-passive) wheel
  // listener — attached ONCE — can read the freshest value without re-binding
  // on every drag tick.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const range = max - min;
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);
  // Snap a free value to the step grid (with float-drift fix via toFixed).
  const snap = useCallback((v: number) => {
    if (step <= 0) return clamp(v);
    const steps = Math.round((v - min) / step);
    const snapped = min + steps * step;
    const decimals = step < 0.001 ? 5 : step < 0.01 ? 4 : step < 0.1 ? 3 : step < 1 ? 2 : 1;
    return clamp(parseFloat(snapped.toFixed(decimals)));
  }, [min, step, clamp]);

  // Geometry: 270° sweep starting at 135° (lower-left, ~7:30) going clockwise
  // to 45° (lower-right, ~4:30). Normalised 0..1 maps across that arc.
  const cx = size / 2;
  const cy = size / 2;
  const rRing = size / 2 - 3;       // outer arc radius
  const rBody = size / 2 - 9;       // knob body radius
  const rInd = rBody - 1;           // indicator line length

  const ARC_START = 135;
  const ARC_END = 135 + 270;        // 405 (= 45)
  const normalized = range > 0 ? (value - min) / range : 0;
  const valAngle = ARC_START + normalized * 270;
  const valRad = (valAngle * Math.PI) / 180;

  const bgPath = arcPath(cx, cy, rRing, ARC_START, ARC_END);
  // Skip the value arc when at min (zero-length path is invalid).
  const valPath = normalized > 0.001 ? arcPath(cx, cy, rRing, ARC_START, valAngle) : '';
  // Indicator line: from a small inner radius out to the body edge, pointing
  // at the current value angle.
  const indStart = { x: cx + 4 * Math.cos(valRad), y: cy + 4 * Math.sin(valRad) };
  const indEnd = { x: cx + rInd * Math.cos(valRad), y: cy + rInd * Math.sin(valRad) };

  // ── Pointer drag (vertical: up = increase) ──────────────────────────────
  // We attach pointermove/pointerup to WINDOW during a drag instead of
  // relying on `setPointerCapture` — pointer capture is flaky on some
  // browsers/setups (the capture can be silently lost mid-drag, leaving the
  // knob stuck following the cursor or not following at all). Window-level
  // listeners always receive the events regardless of where the pointer goes.
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startY: e.clientY, startVal: valueRef.current, fine: e.shiftKey };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      // 150px of drag = full range (400px with Shift for fine control).
      // Lower denominator = more sensitive (less movement needed).
      const sensitivity = d.fine ? 400 : 150;
      const delta = ((d.startY - ev.clientY) / sensitivity) * range;
      onChangeRef.current(clamp(d.startVal + delta));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ── Native non-passive wheel listener (so preventDefault works) ─────────
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      // Each notch = max(step, range/50) so a full sweep takes ~50 notches
      // even for fine-grained knobs (e.g. gain has 150 single-steps).
      const wheelStep = Math.max(step, range / 50);
      onChangeRef.current(snap(valueRef.current + dir * wheelStep));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [step, range, snap]);

  // ── Keyboard: arrows nudge by one step ──────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = value + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation(); // don't trigger the AudioEditor's seek hotkeys
      onChange(snap(next));
    }
  };

  const display = format ? format(value) : String(value);

  return (
    <div className="flex select-none flex-col items-center gap-0.5">
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="touch-none cursor-ns-resize"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        tabIndex={0}
      >
        {/* Background track — full 270° arc (dim) */}
        <path d={bgPath} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="text-text-dim/30" />
        {/* Value arc — min → current (accent) */}
        {valPath && (
          <path d={valPath} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="text-accent" />
        )}
        {/* Knob body */}
        <circle cx={cx} cy={cy} r={rBody} className="fill-bg-3 stroke-border" strokeWidth={1} />
        {/* Indicator line — points to the current value angle */}
        <line x1={indStart.x} y1={indStart.y} x2={indEnd.x} y2={indEnd.y} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" className="text-accent" />
      </svg>
      <span className="font-mono text-[9px] text-text-dim">{display}</span>
      <span className="field-label text-center leading-tight">{label}</span>
    </div>
  );
}
