/**
 * InstrumentPanel — a playable instrument (piano keyboard) for audio boards.
 *
 * - Pick a built-in instrument (piano, e-piano, organ, leads, pads…) or edit
 *   any of its parameters and save the result as your own custom instrument.
 * - Play with the mouse (click position on the key = velocity) or the
 *   computer keyboard (Ableton-style A/W/S/E/D… layout, Z/X shifts octave).
 * - Record a take: notes are captured while you play (against the timeline
 *   playhead), then rendered offline through the exact same synth voice and
 *   placed on a track as a normal audio clip — so it gets waveforms, editing
 *   and multiplayer sync through the existing pipeline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Keyboard, Minus, Plus, Save, Search as SearchIcon, Square, Trash2, Usb } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import { addAudioClip, addAudioTrack, readAudioClip } from '../audio/scene';
import { audioPlayheadPos } from '../audio/AudioEditor';
import {
  INSTRUMENT_PRESETS, KEY_TO_SEMITONE, LiveInstrument, RENDER_SAMPLE_RATE,
  deleteCustomInstrument, instrumentKeyCapture, loadCustomInstruments,
  midiToName, renderPerformance, saveCustomInstrument,
  type InstrumentParams, type NoteEvent, type WaveType,
} from '../audio/instruments';
import { GM_INSTRUMENTS, preloadGmNotes } from '../audio/gmSamples';

const WAVES: WaveType[] = ['sine', 'triangle', 'sawtooth', 'square'];
const WAVE_LABEL: Record<WaveType, string> = { sine: 'Sin', triangle: 'Tri', sawtooth: 'Saw', square: 'Sqr' };

/** Quantize grid options. 'off' = no quantization (free timing); the others
 *  snap each note's start to the nearest 1/N beat division at the project's
 *  BPM (read from the AudioEditor transport state). '1/4' = quarter note,
 *  '1/8' = eighth, '1/16' = sixteenth, '1/32' = thirty-second. */
type QuantizeOption = 'off' | '1/4' | '1/8' | '1/16' | '1/32';
const QUANTIZE_OPTIONS: QuantizeOption[] = ['off', '1/4', '1/8', '1/16', '1/32'];

/** Semitone offsets of black keys within an octave, keyed by the white-key
 *  index they sit after (C#=after C, D#=after D, F#=after F, …). */
const BLACK_AFTER_WHITE: [number, number][] = [[0, 1], [1, 3], [3, 6], [4, 8], [5, 10]];
const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

/** Deep-copy params so slider edits never mutate a preset object. */
function cloneParams(p: InstrumentParams): InstrumentParams {
  return { ...p, oscs: p.oscs.map((o) => ({ ...o })) };
}

/** The default instrument: the sampled Grand Piano (real recording). */
const DEFAULT_PRESET =
  INSTRUMENT_PRESETS.find((p) => p.id === 'inst-real-piano') ?? INSTRUMENT_PRESETS[0]!;

/** Picker group order — presets carry a `group`; anything unexpected sinks
 *  to the end, and customs render under "My instruments". */
const GROUP_ORDER = ['Keys', 'Guitar & Bass', 'Strings', 'Winds & Brass', 'Voices', 'Synths', 'Bells & Perc'];

export function InstrumentPanel() {
  const room = useRoom();
  const slate = room.slate;
  const [customs, setCustoms] = useState<InstrumentParams[]>(loadCustomInstruments);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_PRESET.id);
  const [params, setParams] = useState<InstrumentParams>(() => cloneParams(DEFAULT_PRESET));
  /** Instrument search — filters the picker to matching presets/customs. */
  const [instQuery, setInstQuery] = useState('');
  const [baseMidi, setBaseMidi] = useState(48); // C3
  const [keysOn, setKeysOn] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [recInfo, setRecInfo] = useState<{ seconds: number; notes: number } | null>(null);
  /** Quantize grid applied to recorded takes BEFORE rendering. 'off' preserves
   *  the player's exact timing; any other value snaps each note's `start` to
   *  the nearest 1/N beat division at the project's current BPM. */
  const [quantize, setQuantize] = useState<QuantizeOption>('off');
  const quantizeRef = useRef(quantize);
  quantizeRef.current = quantize;

  const synthRef = useRef<LiveInstrument | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const baseMidiRef = useRef(baseMidi);
  baseMidiRef.current = baseMidi;
  /** QWERTY key char → sounding midi note (so keyup releases the right note
   *  even if the octave shifted while held). */
  const heldKeysRef = useRef<Map<string, number>>(new Map());
  /** Midi note currently held by the pointer (for glissando drags). */
  const pointerNoteRef = useRef<number | null>(null);
  /** Active recording take, or null. */
  const recRef = useRef<{ startPerf: number; startPos: number; notes: NoteEvent[]; held: Map<number, { t: number; v: number }> } | null>(null);

  // Sampled instruments: warm the note cache around the visible keyboard the
  // moment the instrument (or octave) changes, so keys sound on first press
  // instead of only after their mp3 lands.
  useEffect(() => {
    if ((params.engine ?? 'subtractive') !== 'sampled') return;
    const notes = Array.from({ length: 30 }, (_, i) => baseMidi + i - 2);
    void preloadGmNotes(params.sampleId ?? 'acoustic_grand_piano', notes);
  }, [params.engine, params.sampleId, baseMidi]);

  useEffect(() => {
    synthRef.current = new LiveInstrument(paramsRef.current);
    return () => {
      synthRef.current?.allOff();
      synthRef.current = null;
      instrumentKeyCapture.current = false;
    };
  }, []);

  useEffect(() => { synthRef.current?.setParams(params); }, [params]);

  const selectInstrument = useCallback((id: string) => {
    const src = INSTRUMENT_PRESETS.find((p) => p.id === id) ?? loadCustomInstruments().find((p) => p.id === id);
    if (!src) return;
    setSelectedId(id);
    setParams(cloneParams(src));
    setSaveName('');
  }, []);

  // ── Note on/off (shared by mouse + QWERTY) ────────────────────────────────

  const noteOn = useCallback((midi: number, velocity: number) => {
    synthRef.current?.noteOn(midi, velocity);
    setActiveNotes((prev) => new Set(prev).add(midi));
    const rec = recRef.current;
    if (rec && !rec.held.has(midi)) {
      rec.held.set(midi, { t: (performance.now() - rec.startPerf) / 1000, v: velocity });
    }
  }, []);

  const noteOff = useCallback((midi: number) => {
    synthRef.current?.noteOff(midi);
    setActiveNotes((prev) => {
      if (!prev.has(midi)) return prev;
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
    const rec = recRef.current;
    if (rec) {
      const h = rec.held.get(midi);
      if (h) {
        rec.held.delete(midi);
        const end = (performance.now() - rec.startPerf) / 1000;
        rec.notes.push({ midi, velocity: h.v, start: h.t, duration: Math.max(0.03, end - h.t) });
      }
    }
  }, []);

  // ── QWERTY capture ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!keysOn) {
      instrumentKeyCapture.current = false;
      return;
    }
    instrumentKeyCapture.current = true;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); setBaseMidi((m) => Math.max(24, m - 12)); return; }
      if (k === 'x') { e.preventDefault(); setBaseMidi((m) => Math.min(84, m + 12)); return; }
      const semi = KEY_TO_SEMITONE[k];
      if (semi === undefined || heldKeysRef.current.has(k)) return;
      e.preventDefault();
      const midi = baseMidiRef.current + semi;
      heldKeysRef.current.set(k, midi);
      noteOn(midi, 0.85);
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const midi = heldKeysRef.current.get(k);
      if (midi !== undefined) {
        heldKeysRef.current.delete(k);
        noteOff(midi);
      }
    };
    const blur = () => {
      for (const midi of heldKeysRef.current.values()) noteOff(midi);
      heldKeysRef.current.clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      instrumentKeyCapture.current = false;
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      blur();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysOn]);

  // Global pointerup ends the pointer note (the pointer may leave the keys).
  useEffect(() => {
    const up = () => {
      if (pointerNoteRef.current !== null) {
        noteOff(pointerNoteRef.current);
        pointerNoteRef.current = null;
      }
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [noteOff]);

  // ── Web MIDI (hardware keyboards) ─────────────────────────────────────────

  const [midiOn, setMidiOn] = useState(false);
  const midiAccessRef = useRef<MIDIAccess | null>(null);

  const onMidiMessage = useCallback((e: MIDIMessageEvent) => {
    const d = e.data;
    if (!d || d.length < 3) return;
    const status = d[0]! & 0xf0;
    const note = d[1]!;
    const vel = d[2]!;
    if (status === 0x90 && vel > 0) noteOn(note, vel / 127);
    else if (status === 0x80 || (status === 0x90 && vel === 0)) noteOff(note);
  }, [noteOn, noteOff]);

  const toggleMidi = useCallback(async () => {
    if (midiAccessRef.current) {
      midiAccessRef.current.inputs.forEach((inp) => { inp.onmidimessage = null; });
      midiAccessRef.current.onstatechange = null;
      midiAccessRef.current = null;
      setMidiOn(false);
      return;
    }
    if (!('requestMIDIAccess' in navigator)) {
      toast({ title: 'MIDI not supported', description: 'This browser has no Web MIDI support (try Chrome/Edge).', variant: 'error' });
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      midiAccessRef.current = access;
      const attach = () => access.inputs.forEach((inp) => { inp.onmidimessage = onMidiMessage; });
      attach();
      access.onstatechange = attach; // hot-plugged keyboards attach too
      setMidiOn(true);
      const n = access.inputs.size;
      toast({ title: 'MIDI connected', description: n > 0 ? `${n} input device${n > 1 ? 's' : ''} listening` : 'Plug in a MIDI keyboard and play' });
    } catch {
      toast({ title: 'MIDI access denied', variant: 'error' });
    }
  }, [onMidiMessage]);

  // Detach MIDI handlers on unmount.
  useEffect(() => () => {
    if (midiAccessRef.current) {
      midiAccessRef.current.inputs.forEach((inp) => { inp.onmidimessage = null; });
      midiAccessRef.current.onstatechange = null;
      midiAccessRef.current = null;
    }
  }, []);

  // ── Recording ─────────────────────────────────────────────────────────────

  // Live "REC 3.2s · 5 notes" readout.
  useEffect(() => {
    if (!recInfo) return;
    const iv = setInterval(() => {
      const rec = recRef.current;
      if (!rec) return;
      setRecInfo({ seconds: (performance.now() - rec.startPerf) / 1000, notes: rec.notes.length + rec.held.size });
    }, 250);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recInfo !== null]);

  /** Place a rendered take: reuse a track named after the instrument if the
   *  region is free there, otherwise create a new track. `clipName` overrides
   *  the default "<instrument> take" (single notes use their note name). */
  const placeTake = useCallback(async (notes: NoteEvent[], startPos: number, clipName?: string) => {
    const p = paramsRef.current;

    // ── Quantize pass ──────────────────────────────────────────────────────
    // Snap each note's `start` to the nearest 1/N beat division at the
    // project's current BPM. The grid step is `(60/bpm) / (division/4)`
    // seconds — e.g. at 120 BPM, 1/16 = (60/120)/(16/4) = 0.5/4 = 0.125s
    // (a sixteenth note). We read the BPM from the doc's audio map so we
    // match the timeline the user actually sees, not a stale local value.
    //
    // Notes that quantize to the same start as another (a chord played
    // slightly off) collapse onto the same grid line — that's the desired
    // effect (chords become perfectly aligned). Duration is preserved
    // (we don't quantize note ends — a held note stays held).
    const q = quantizeRef.current;
    let qNotes = notes;
    if (q !== 'off') {
      const bpm = (slate.doc.getMap('audio').get('bpm') as number | undefined) ?? 120;
      const division = parseInt(q.split('/')[1]!, 10);
      const step = (60 / bpm) / (division / 4);
      qNotes = notes.map((n) => ({ ...n, start: Math.round(n.start / step) * step }));
    }

    const rendered = await renderPerformance(qNotes, p);
    if (!rendered) return;
    let trackId: string | null = null;
    slate.audioTracks().forEach((m, id) => {
      if (!trackId && (m.get('name') as string) === p.name) trackId = id;
    });
    if (trackId) {
      let clash = false;
      slate.audioClips().forEach((m, id) => {
        const c = readAudioClip(m, id);
        if (c && c.trackId === trackId && c.start < startPos + rendered.duration && c.start + c.duration > startPos) clash = true;
      });
      if (clash) trackId = null;
    }
    if (!trackId) trackId = addAudioTrack(slate, { name: p.name });
    await addAudioClip(slate, trackId, {
      start: startPos,
      samples: rendered.samples,
      sampleRate: RENDER_SAMPLE_RATE,
      channels: 1,
      duration: rendered.duration,
      name: clipName ?? `${p.name} take`,
    });
    toast({
      title: clipName ? 'Note added' : 'Take added',
      description: clipName ?? `${qNotes.length} notes → ${p.name}${q !== 'off' ? ` · quantized ${q}` : ''}`,
    });
  }, [slate]);

  /** Shift+click on a key: drop that single note as a clip at the playhead
   *  (one beat long at the project tempo) — quick way to build melodies
   *  note-by-note without recording. */
  const addSingleNote = useCallback((midi: number, velocity: number) => {
    const bpm = Math.max(20, Math.min(300, slate.audioBpm()));
    const note: NoteEvent = { midi, velocity, start: 0, duration: 60 / bpm };
    void placeTake([note], audioPlayheadPos.current, `${midiToName(midi)} · ${paramsRef.current.name}`);
  }, [slate, placeTake]);

  const toggleRecord = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      // Stop: finalize still-held notes, render, place.
      const end = (performance.now() - rec.startPerf) / 1000;
      for (const [midi, h] of rec.held) {
        rec.notes.push({ midi, velocity: h.v, start: h.t, duration: Math.max(0.03, end - h.t) });
      }
      rec.held.clear();
      recRef.current = null;
      setRecInfo(null);
      if (rec.notes.length === 0) {
        toast({ title: 'Nothing recorded', description: 'Play some notes while recording.' });
        return;
      }
      void placeTake(rec.notes, rec.startPos);
    } else {
      recRef.current = { startPerf: performance.now(), startPos: audioPlayheadPos.current, notes: [], held: new Map() };
      setRecInfo({ seconds: 0, notes: 0 });
      setKeysOn(true); // recording implies playing — grab the keyboard
    }
  }, [placeTake]);

  // ── Save / delete custom instruments ──────────────────────────────────────

  const saveAsCustom = useCallback(() => {
    const name = saveName.trim() || `My ${paramsRef.current.name}`;
    const src = customs.find((c) => c.id === selectedId);
    // Editing an existing custom under the same name = overwrite it in place;
    // anything else becomes a brand-new instrument.
    const id = src && src.name === name ? src.id : `inst-custom-${Date.now()}`;
    const p: InstrumentParams = { ...cloneParams(paramsRef.current), id, name, builtIn: false };
    const list = saveCustomInstrument(p);
    setCustoms(list);
    setSelectedId(id);
    setParams(cloneParams(p));
    setSaveName('');
    toast({ title: 'Instrument saved', description: name });
  }, [saveName, customs, selectedId]);

  const removeCustom = useCallback(() => {
    const src = customs.find((c) => c.id === selectedId);
    if (!src) return;
    const list = deleteCustomInstrument(src.id);
    setCustoms(list);
    selectInstrument(DEFAULT_PRESET.id);
    toast({ title: 'Instrument deleted', description: src.name });
  }, [customs, selectedId, selectInstrument]);

  // ── Param edit helpers ────────────────────────────────────────────────────

  const setP = useCallback(<K extends keyof InstrumentParams>(key: K, value: InstrumentParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setOsc = useCallback((idx: number, patch: Partial<InstrumentParams['oscs'][number]>) => {
    setParams((prev) => {
      const oscs = prev.oscs.map((o) => ({ ...o }));
      // Editing osc2 on a 1-osc instrument materializes it (level 0 = silent).
      while (oscs.length <= idx) oscs.push({ type: 'sine', octave: 0, detune: 0, level: 0 });
      oscs[idx] = { ...oscs[idx]!, ...patch };
      return { ...prev, oscs };
    });
  }, []);

  const isCustom = customs.some((c) => c.id === selectedId);

  // ── Keyboard geometry: 2 octaves + top C from baseMidi ────────────────────

  const octaves = 2;
  const whiteCount = octaves * 7 + 1;
  const whiteW = 100 / whiteCount;
  const whites: number[] = [];
  for (let o = 0; o < octaves; o++) for (const s of WHITE_SEMITONES) whites.push(baseMidi + o * 12 + s);
  whites.push(baseMidi + octaves * 12);
  const blacks: { midi: number; leftPct: number }[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const [wIdx, semi] of BLACK_AFTER_WHITE) {
      blacks.push({ midi: baseMidi + o * 12 + semi, leftPct: (o * 7 + wIdx + 1) * whiteW - whiteW * 0.3 });
    }
  }

  /** Which QWERTY char plays this midi note (hint labels while capture is on). */
  const keyHint = (midi: number): string | null => {
    if (!keysOn) return null;
    const semi = midi - baseMidi;
    for (const [k, s] of Object.entries(KEY_TO_SEMITONE)) if (s === semi) return k.toUpperCase();
    return null;
  };

  const velocityFromEvent = (e: React.PointerEvent): number => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return 0.5 + 0.5 * Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  };

  const keyDown = (midi: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const vel = velocityFromEvent(e);
    if (e.shiftKey) {
      // Shift+click = drop this note as a clip at the playhead (with a short
      // audible confirmation), instead of just playing it.
      synthRef.current?.noteOn(midi, vel);
      window.setTimeout(() => synthRef.current?.noteOff(midi), 250);
      addSingleNote(midi, vel);
      return;
    }
    pointerNoteRef.current = midi;
    noteOn(midi, vel);
  };
  const keyEnter = (midi: number) => (e: React.PointerEvent) => {
    if (e.buttons !== 1 || pointerNoteRef.current === midi) return;
    if (pointerNoteRef.current !== null) noteOff(pointerNoteRef.current);
    pointerNoteRef.current = midi;
    noteOn(midi, velocityFromEvent(e));
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      {/* Header row: instrument picker (grouped; searchable below) + record */}
      <div className="flex items-center gap-1">
        <select
          value={selectedId}
          onChange={(e) => selectInstrument(e.target.value)}
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg-3 px-1 py-1 text-[11px] text-text outline-none focus:border-accent"
          aria-label="Instrument"
        >
          {(() => {
            const q = instQuery.trim().toLowerCase();
            const match = (p: InstrumentParams) => q === '' || p.name.toLowerCase().includes(q);
            const presets = INSTRUMENT_PRESETS.filter(match);
            const myCustoms = customs.filter(match);
            // Keep the current selection listed even when it doesn't match the
            // search, so the select never shows a phantom value.
            const selectedShown = presets.some((p) => p.id === selectedId) || myCustoms.some((p) => p.id === selectedId);
            const groups = GROUP_ORDER.filter((g) => presets.some((p) => (p.group ?? 'Other') === g));
            const rest = presets.filter((p) => !GROUP_ORDER.includes(p.group ?? 'Other'));
            return (
              <>
                {!selectedShown && (() => {
                  const cur = INSTRUMENT_PRESETS.find((p) => p.id === selectedId) ?? customs.find((p) => p.id === selectedId);
                  return cur ? <option value={cur.id}>{cur.name}</option> : null;
                })()}
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {presets
                      .filter((p) => (p.group ?? 'Other') === g)
                      // Recorded instruments (plain names) before their
                      // "(synth)" counterparts.
                      .sort((a, b) => Number(a.name.includes('(synth)')) - Number(b.name.includes('(synth)')))
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                  </optgroup>
                ))}
                {rest.length > 0 && (
                  <optgroup label="Other">
                    {rest.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                )}
                {myCustoms.length > 0 && (
                  <optgroup label="My instruments">
                    {myCustoms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                )}
              </>
            );
          })()}
        </select>
        <button
          type="button"
          onClick={toggleRecord}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${recInfo ? 'border-danger bg-danger/20 text-danger animate-pulse' : 'border-border text-text-mid hover:bg-bg-3 hover:text-danger'}`}
          title={recInfo ? 'Stop & add take to timeline' : 'Record a take (placed at the playhead)'}
        >
          {recInfo ? <Square size={11} /> : <Circle size={11} />}
        </button>
        <button
          type="button"
          onClick={() => setKeysOn((v) => !v)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${keysOn ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`}
          title="Play with the computer keyboard (A W S E D… · Z/X = octave)"
        >
          <Keyboard size={13} />
        </button>
        <button
          type="button"
          onClick={() => void toggleMidi()}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${midiOn ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`}
          title="Connect a MIDI keyboard (Web MIDI — plays and records like the on-screen keys)"
        >
          <Usb size={13} />
        </button>
        {/* Quantize dropdown — applied to recorded takes before render. */}
        <select
          value={quantize}
          onChange={(e) => setQuantize(e.target.value as QuantizeOption)}
          className={`shrink-0 rounded-sm border px-1 py-1 text-[10px] outline-none ${quantize !== 'off' ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-3 text-text-mid hover:bg-bg-4'}`}
          title="Quantize recorded takes to this grid (applied before rendering)"
          aria-label="Quantize grid"
        >
          {QUANTIZE_OPTIONS.map((q) => <option key={q} value={q}>{q === 'off' ? 'Free' : q}</option>)}
        </select>
      </div>

      {/* Instrument search — narrows the grouped picker above. */}
      <div className="relative">
        <SearchIcon size={11} className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-text-dim" />
        <input
          type="search"
          value={instQuery}
          onChange={(e) => setInstQuery(e.target.value)}
          placeholder="Search instruments…"
          aria-label="Search instruments"
          className="w-full rounded-sm border border-border bg-bg-3 py-1 pl-6 pr-1.5 text-[10px] text-text outline-none placeholder:text-text-dim focus:border-accent"
        />
      </div>

      {recInfo && (
        <div className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] font-mono text-danger">
          ● REC {recInfo.seconds.toFixed(1)}s · {recInfo.notes} notes — stop to drop the take at the playhead
        </div>
      )}

      {/* Octave + keyboard */}
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setBaseMidi((m) => Math.max(24, m - 12))} className="flex h-5 w-5 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Octave down (Z)"><Minus size={11} /></button>
        <span className="font-mono text-[10px] text-text-dim">{midiToName(baseMidi)} – {midiToName(baseMidi + octaves * 12)}</span>
        <button type="button" onClick={() => setBaseMidi((m) => Math.min(84, m + 12))} className="flex h-5 w-5 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Octave up (X)"><Plus size={11} /></button>
      </div>

      <div className="relative h-24 w-full touch-none select-none" role="group" aria-label="Piano keyboard" title="Click to play — lower on the key = louder. Drag across keys for glissando. Shift+click drops the note as a clip at the playhead.">
        {/* White keys */}
        <div className="flex h-full w-full">
          {whites.map((midi) => (
            <div
              key={midi}
              onPointerDown={keyDown(midi)}
              onPointerEnter={keyEnter(midi)}
              className={`relative h-full border border-border/60 ${activeNotes.has(midi) ? 'bg-accent/60' : 'bg-white hover:bg-gray-100'} rounded-b-sm`}
              style={{ width: `${whiteW}%` }}
            >
              {midi % 12 === 0 && (
                <span className="pointer-events-none absolute bottom-0.5 left-1/2 -translate-x-1/2 font-mono text-[7px] text-gray-500">{midiToName(midi)}</span>
              )}
              {keyHint(midi) && (
                <span className="pointer-events-none absolute bottom-3.5 left-1/2 -translate-x-1/2 font-mono text-[7px] text-gray-400">{keyHint(midi)}</span>
              )}
            </div>
          ))}
        </div>
        {/* Black keys */}
        {blacks.map(({ midi, leftPct }) => (
          <div
            key={midi}
            onPointerDown={keyDown(midi)}
            onPointerEnter={keyEnter(midi)}
            className={`absolute top-0 z-10 h-[58%] rounded-b-sm border border-black ${activeNotes.has(midi) ? 'bg-accent' : 'bg-gray-900 hover:bg-gray-700'}`}
            style={{ left: `${leftPct}%`, width: `${whiteW * 0.6}%` }}
          >
            {keyHint(midi) && (
              <span className="pointer-events-none absolute bottom-0.5 left-1/2 -translate-x-1/2 font-mono text-[7px] text-gray-400">{keyHint(midi)}</span>
            )}
          </div>
        ))}
      </div>

      {/* Customize */}
      <button
        type="button"
        onClick={() => setShowEdit((v) => !v)}
        className="flex items-center gap-1 rounded-sm px-0.5 py-0.5 text-[10px] font-medium text-text-mid hover:bg-bg-3 hover:text-text"
        aria-expanded={showEdit}
      >
        {showEdit ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Customize
      </button>

      {showEdit && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-bg-3 p-2">
          {/* Engine selector — swaps the synthesis model (and which knobs show). */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-mono uppercase text-text-dim">Engine</span>
            {(['subtractive', 'string', 'fm', 'piano', 'sampled'] as const).map((eng) => (
              <button
                key={eng}
                type="button"
                onClick={() => setP('engine', eng)}
                title={eng === 'string' ? 'Plucked string (guitar/harp)' : eng === 'fm' ? 'FM (e-piano/bells)' : eng === 'piano' ? 'Modelled piano (inharmonic partials + hammer)' : eng === 'sampled' ? 'Real recorded notes (streamed samples)' : 'Subtractive synth'}
                className={`rounded-sm border px-1.5 py-0.5 text-[9px] capitalize ${(params.engine ?? 'subtractive') === eng ? 'border-accent bg-accent/20 text-accent' : 'border-border text-text-mid hover:bg-bg-4'}`}
              >
                {eng === 'subtractive' ? 'Synth' : eng === 'string' ? 'String' : eng === 'fm' ? 'FM' : eng === 'piano' ? 'Piano' : 'Real'}
              </button>
            ))}
          </div>

          {/* Oscillators — subtractive only. */}
          {(params.engine ?? 'subtractive') === 'subtractive' && [0, 1].map((idx) => {
            const o = params.oscs[idx];
            return (
              <div key={idx} className="flex flex-col gap-1">
                <span className="text-[9px] font-mono uppercase text-text-dim">Osc {idx + 1}</span>
                <div className="flex items-center gap-1">
                  {WAVES.map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setOsc(idx, { type: w })}
                      className={`rounded-sm border px-1.5 py-0.5 text-[9px] ${o?.type === w ? 'border-accent bg-accent/20 text-accent' : 'border-border text-text-mid hover:bg-bg-4'}`}
                    >
                      {WAVE_LABEL[w]}
                    </button>
                  ))}
                  <select
                    value={o?.octave ?? 0}
                    onChange={(e) => setOsc(idx, { octave: Number(e.target.value) })}
                    className="ml-auto rounded-sm border border-border bg-bg-4 px-1 py-0.5 text-[9px] text-text outline-none"
                    title="Octave"
                  >
                    {[-1, 0, 1, 2].map((v) => <option key={v} value={v}>{v >= 0 ? `+${v}` : v} oct</option>)}
                  </select>
                </div>
                <Param label="Level" value={o?.level ?? 0} min={0} max={1} step={0.01} onChange={(v) => setOsc(idx, { level: v })} />
                {idx === 1 && <Param label="Detune" value={o?.detune ?? 0} min={-50} max={50} step={1} fmt={(v) => `${v}¢`} onChange={(v) => setOsc(idx, { detune: v })} />}
              </div>
            );
          })}

          {/* String (Karplus-Strong) knobs. */}
          {(params.engine ?? 'subtractive') === 'string' && (
            <>
              <span className="mt-1 text-[9px] font-mono uppercase text-text-dim">String</span>
              <Param label="Brightness" value={params.stringDamping ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => setP('stringDamping', v)} />
              <Param label="Sustain" value={params.stringDecay ?? 0.985} min={0.9} max={0.999} step={0.001} fmt={(v) => v.toFixed(3)} onChange={(v) => setP('stringDecay', v)} />
              <Param label="Pick pos" value={params.stringPickPos ?? 0.13} min={0.02} max={0.5} step={0.01} onChange={(v) => setP('stringPickPos', v)} />
              <Param label="Body" value={params.stringBody ?? 0} min={0} max={1} step={0.01} onChange={(v) => setP('stringBody', v)} />
              <Param label="Drive" value={params.stringDrive ?? 0} min={0} max={1} step={0.01} onChange={(v) => setP('stringDrive', v)} />
            </>
          )}

          {/* Sampled (real recording) picker. */}
          {(params.engine ?? 'subtractive') === 'sampled' && (
            <>
              <span className="mt-1 text-[9px] font-mono uppercase text-text-dim">Sample</span>
              <select
                value={params.sampleId ?? 'acoustic_grand_piano'}
                onChange={(e) => setP('sampleId', e.target.value)}
                aria-label="Sampled instrument"
                className="rounded-sm border border-border bg-bg-4 px-1 py-1 text-[10px] text-text outline-none"
              >
                {GM_INSTRUMENTS.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <p className="text-[9px] leading-snug text-text-dim">
                Real recordings, streamed per note (~20 KB each) and cached.
              </p>
            </>
          )}

          {/* FM knobs. */}
          {(params.engine ?? 'subtractive') === 'fm' && (
            <>
              <span className="mt-1 text-[9px] font-mono uppercase text-text-dim">FM</span>
              <Param label="Ratio" value={params.fmRatio ?? 1} min={0.5} max={8} step={0.5} fmt={(v) => `${v}×`} onChange={(v) => setP('fmRatio', v)} />
              <Param label="Index" value={params.fmIndex ?? 2} min={0} max={8} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => setP('fmIndex', v)} />
              <Param label="Bright decay" value={params.fmDecay ?? 0} min={0} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} onChange={(v) => setP('fmDecay', v)} />
            </>
          )}

          <span className="mt-1 text-[9px] font-mono uppercase text-text-dim">Envelope</span>
          <Param label="Attack" value={params.attack} min={0.002} max={2} step={0.002} fmt={(v) => `${(v * 1000).toFixed(0)}ms`} onChange={(v) => setP('attack', v)} />
          <Param label="Decay" value={params.decay} min={0.02} max={3} step={0.01} fmt={(v) => `${v.toFixed(2)}s`} onChange={(v) => setP('decay', v)} />
          <Param label="Sustain" value={params.sustain} min={0} max={1} step={0.01} onChange={(v) => setP('sustain', v)} />
          <Param label="Release" value={params.release} min={0.02} max={3} step={0.01} fmt={(v) => `${v.toFixed(2)}s`} onChange={(v) => setP('release', v)} />

          {/* Tone (filter/noise/vibrato) — subtractive only. */}
          {(params.engine ?? 'subtractive') === 'subtractive' && (
            <>
              <span className="mt-1 text-[9px] font-mono uppercase text-text-dim">Tone</span>
              <Param label="Cutoff" value={params.filterCutoff} min={100} max={10000} step={10} fmt={(v) => `${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}Hz`} onChange={(v) => setP('filterCutoff', v)} />
              <Param label="Reso" value={params.filterQ} min={0.1} max={10} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => setP('filterQ', v)} />
              <Param label="Env amt" value={params.filterEnv} min={0} max={6000} step={50} fmt={(v) => `${v}Hz`} onChange={(v) => setP('filterEnv', v)} />
              <Param label="Noise" value={params.noise} min={0} max={0.5} step={0.01} onChange={(v) => setP('noise', v)} />
              <Param label="Vib rate" value={params.vibratoRate} min={0} max={10} step={0.1} fmt={(v) => `${v.toFixed(1)}Hz`} onChange={(v) => setP('vibratoRate', v)} />
              <Param label="Vib depth" value={params.vibratoDepth} min={0} max={50} step={1} fmt={(v) => `${v}¢`} onChange={(v) => setP('vibratoDepth', v)} />
            </>
          )}
          <Param label="Reverb" value={params.reverb ?? 0} min={0} max={1} step={0.01} onChange={(v) => setP('reverb', v)} />
          <Param label="Volume" value={params.gain} min={0.1} max={1.5} step={0.01} onChange={(v) => setP('gain', v)} />

          {/* Save as custom */}
          <div className="mt-1 flex items-center gap-1">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={isCustom ? params.name : `My ${params.name}`}
              className="min-w-0 flex-1 rounded-sm border border-border bg-bg-4 px-1.5 py-1 text-[10px] text-text outline-none focus:border-accent"
              aria-label="Instrument name"
            />
            <button
              type="button"
              onClick={saveAsCustom}
              className="flex items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-1 text-[10px] text-accent hover:bg-accent/20"
              title="Save these settings as your own instrument"
            >
              <Save size={10} />Save
            </button>
            {isCustom && (
              <button
                type="button"
                onClick={removeCustom}
                className="flex h-6 w-6 items-center justify-center rounded-sm text-text-mid hover:bg-bg-4 hover:text-danger"
                title="Delete this custom instrument"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

/** Compact labelled slider row. */
function Param({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  fmt?: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] text-text-mid">
      <span className="w-14 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 accent-accent"
      />
      <span className="w-11 shrink-0 text-right font-mono text-[9px] text-text-dim">{fmt ? fmt(value) : value.toFixed(2)}</span>
    </label>
  );
}
