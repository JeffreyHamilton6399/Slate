/**
 * Instrument synth engine — playable, customizable instruments (piano,
 * e-piano, organ, leads, bass, pads, plucks, bells, strings) built entirely
 * from Web Audio oscillators, matching the sample-free approach of library.ts.
 *
 * One voice-builder (`startVoice`) runs against ANY BaseAudioContext, so the
 * exact same code path powers:
 *   - live playing (AudioContext) from the InstrumentPanel keyboard, and
 *   - offline rendering (OfflineAudioContext) of a recorded performance into
 *     mono PCM, which is then stored via the normal addAudioClip pipeline —
 *     so instrument takes get waveforms, editing, and multiplayer sample sync
 *     for free, with zero schema changes.
 *
 * Custom instruments are InstrumentParams objects persisted to localStorage.
 */

export type WaveType = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface OscSpec {
  type: WaveType;
  /** Octave offset from the played note (-1..2). */
  octave: number;
  /** Fine detune in cents (also used for fixed intervals, e.g. +702 = a fifth). */
  detune: number;
  /** Mix level 0..1. 0 disables the oscillator entirely. */
  level: number;
}

export interface InstrumentParams {
  id: string;
  name: string;
  /** True for the factory presets (not deletable, saved-as instead of over). */
  builtIn?: boolean;
  /** 1-3 oscillators summed into the filter. */
  oscs: OscSpec[];
  /** White-noise level 0..1 mixed pre-filter (hammer click / breath). */
  noise: number;
  /** Noise decay time-constant (seconds). >= 5 ≈ sustained with the note. */
  noiseDecay: number;
  /** Amp envelope (seconds / level). Piano-like = sustain 0, long decay. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Lowpass base cutoff (Hz). */
  filterCutoff: number;
  filterQ: number;
  /** Extra cutoff (Hz) at note-on that decays back to base with `decay`. */
  filterEnv: number;
  /** 0..1 — how much the cutoff follows the note's frequency. */
  keyTrack: number;
  vibratoRate: number;
  /** Vibrato depth in cents. */
  vibratoDepth: number;
  /** Instrument output gain 0..1.5. */
  gain: number;
}

export interface NoteEvent {
  midi: number;
  /** 0..1. */
  velocity: number;
  /** Seconds from the start of the take. */
  start: number;
  /** Held duration in seconds. */
  duration: number;
}

export interface VoiceHandle {
  /** Begin the release phase at `when` (context time) and clean up after. */
  stop(when: number): void;
}

export const RENDER_SAMPLE_RATE = 44100;

// ── Key capture handshake with the AudioEditor ──────────────────────────────

/** True while the InstrumentPanel owns the computer keyboard (playing notes).
 *  The AudioEditor's hotkey handler yields the note keys while this is set so
 *  pressing D/F/G to play doesn't duplicate/split/toggle things. Space and
 *  the arrow keys stay with the transport, like a real DAW. */
export const instrumentKeyCapture = { current: false };

/** QWERTY → semitone offset from the keyboard's base C (Ableton-style layout:
 *  A row = white keys, W row = black keys). */
export const KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9,
  u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
};

/** Keys the AudioEditor must ignore while capture is on (notes + Z/X octave). */
export const INSTRUMENT_CAPTURE_KEYS = new Set([...Object.keys(KEY_TO_SEMITONE), 'z', 'x']);

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Voice ───────────────────────────────────────────────────────────────────

/** Shared 1s white-noise buffer per context (looped by noise voices). */
const noiseBufCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBufCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBufCache.set(ctx, buf);
  }
  return buf;
}

/** Build and start one note's node graph:
 *  oscs (+noise) → lowpass filter (env + key tracking) → amp ADSR → dest.
 *  Works on both AudioContext (live) and OfflineAudioContext (render). */
export function startVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  p: InstrumentParams,
  midi: number,
  velocity: number,
  when: number,
): VoiceHandle {
  const f = midiToFreq(midi);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = clamp(p.filterQ, 0.0001, 20);
  const baseCut = clamp(p.filterCutoff + p.keyTrack * f * 2, 40, 18000);
  const peakCut = clamp(baseCut + p.filterEnv, 40, 18000);
  filter.frequency.setValueAtTime(peakCut, when);
  filter.frequency.setTargetAtTime(baseCut, when, Math.max(0.02, p.decay / 3));

  const amp = ctx.createGain();
  filter.connect(amp);
  amp.connect(dest);

  // Velocity curve — even a soft hit stays audible (0.25 floor).
  const peak = p.gain * (0.25 + 0.75 * clamp(velocity, 0, 1));
  const atk = Math.max(0.002, p.attack);
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + atk);
  amp.gain.setTargetAtTime(peak * clamp(p.sustain, 0, 1), when + atk, Math.max(0.01, p.decay / 3));

  const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];

  let lfoGain: GainNode | null = null;
  if (p.vibratoDepth > 0 && p.vibratoRate > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.vibratoRate;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = p.vibratoDepth;
    lfo.connect(lfoGain);
    lfo.start(when);
    sources.push(lfo);
  }

  for (const o of p.oscs) {
    if (o.level <= 0) continue;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.value = f * Math.pow(2, o.octave);
    osc.detune.value = o.detune;
    if (lfoGain) lfoGain.connect(osc.detune);
    const g = ctx.createGain();
    g.gain.value = o.level;
    osc.connect(g);
    g.connect(filter);
    osc.start(when);
    sources.push(osc);
  }

  if (p.noise > 0) {
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    src.loop = true;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(p.noise, when);
    // Short decay = hammer/pluck click; >= 5s ≈ sustained (breath) — the amp
    // ADSR still shapes it either way.
    if (p.noiseDecay < 5) ng.gain.setTargetAtTime(0, when, Math.max(0.005, p.noiseDecay));
    src.connect(ng);
    ng.connect(filter);
    src.start(when);
    sources.push(src);
  }

  let stopped = false;
  return {
    stop(t: number) {
      if (stopped) return;
      stopped = true;
      // Never start the release before the attack ramp completes — a
      // setTarget(0) scheduled BEFORE a pending linearRamp would leave the
      // ramp to win and the note stuck at full level.
      const rt = Math.max(t, when + atk + 0.01);
      const rel = Math.max(0.02, p.release);
      amp.gain.setTargetAtTime(0, rt, rel / 4);
      const end = rt + rel * 1.5 + 0.1;
      for (const s of sources) {
        try { s.stop(end); } catch { /* already stopped */ }
      }
      // Tear the sub-graph down once the last source ends (live contexts only
      // — for offline renders the context is discarded wholesale).
      const last = sources[sources.length - 1];
      if (last) last.onended = () => { try { amp.disconnect(); filter.disconnect(); } catch { /* detached */ } };
    },
  };
}

// ── Live playing ────────────────────────────────────────────────────────────

let liveCtx: AudioContext | null = null;

/** Polyphonic live synth for the panel keyboard. One instance per panel;
 *  shares a module-level AudioContext (created lazily on the first note —
 *  which is always a user gesture, so autoplay policy is satisfied). */
export class LiveInstrument {
  private params: InstrumentParams;
  private voices = new Map<number, VoiceHandle>();
  private order: number[] = [];
  private master: GainNode | null = null;
  private static readonly MAX_VOICES = 16;

  constructor(params: InstrumentParams) {
    this.params = params;
  }

  setParams(p: InstrumentParams): void {
    this.params = p;
  }

  private ensure(): AudioContext {
    if (!liveCtx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      liveCtx = new AudioCtx();
    }
    if (liveCtx.state === 'suspended') void liveCtx.resume();
    if (!this.master) {
      this.master = liveCtx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(liveCtx.destination);
    }
    return liveCtx;
  }

  noteOn(midi: number, velocity: number): void {
    const ctx = this.ensure();
    // Retrigger: release any voice already sounding on this note.
    this.voices.get(midi)?.stop(ctx.currentTime);
    // Voice cap: steal the oldest.
    while (this.order.length >= LiveInstrument.MAX_VOICES) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.voices.get(oldest)?.stop(ctx.currentTime);
        this.voices.delete(oldest);
      }
    }
    this.voices.set(midi, startVoice(ctx, this.master!, this.params, midi, velocity, ctx.currentTime));
    this.order = this.order.filter((m) => m !== midi);
    this.order.push(midi);
  }

  noteOff(midi: number): void {
    const v = this.voices.get(midi);
    if (v && liveCtx) {
      v.stop(liveCtx.currentTime);
      this.voices.delete(midi);
      this.order = this.order.filter((m) => m !== midi);
    }
  }

  allOff(): void {
    if (!liveCtx) return;
    for (const v of this.voices.values()) v.stop(liveCtx.currentTime);
    this.voices.clear();
    this.order = [];
  }
}

// ── Offline render (performance → PCM clip) ─────────────────────────────────

/** Render a recorded performance to mono PCM at 44.1kHz using the exact same
 *  voice code as live playing. Returns null for an empty take. Peaks are only
 *  attenuated (never boosted) so the clip matches what the player heard. */
export async function renderPerformance(
  notes: NoteEvent[],
  p: InstrumentParams,
): Promise<{ samples: Float32Array; duration: number } | null> {
  if (notes.length === 0) return null;
  const lead = 0.03; // tiny pre-roll so attack transients aren't clipped at t=0
  const rel = Math.max(0.02, p.release);
  const end = Math.max(...notes.map((n) => n.start + n.duration)) + rel * 1.5 + 0.25;
  const length = Math.ceil((end + lead) * RENDER_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(1, length, RENDER_SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  for (const n of notes) {
    const v = startVoice(ctx, master, p, n.midi, n.velocity, lead + n.start);
    v.stop(lead + n.start + Math.max(0.02, n.duration));
  }
  const buf = await ctx.startRendering();
  const out = new Float32Array(buf.getChannelData(0));
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!);
    if (a > peak) peak = a;
  }
  if (peak > 0.95) {
    const g = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i]! *= g;
  }
  return { samples: out, duration: buf.duration };
}

// ── Factory presets ─────────────────────────────────────────────────────────

export const INSTRUMENT_PRESETS: InstrumentParams[] = [
  {
    id: 'inst-grand-piano', name: 'Grand Piano', builtIn: true,
    oscs: [
      { type: 'triangle', octave: 0, detune: 0, level: 1 },
      { type: 'sawtooth', octave: 0, detune: 4, level: 0.3 },
      { type: 'triangle', octave: 1, detune: -3, level: 0.22 },
    ],
    noise: 0.14, noiseDecay: 0.05,
    attack: 0.003, decay: 1.5, sustain: 0, release: 0.25,
    filterCutoff: 750, filterQ: 0.6, filterEnv: 2800, keyTrack: 0.7,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.9,
  },
  {
    id: 'inst-epiano', name: 'E-Piano', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'sine', octave: 2, detune: 2, level: 0.18 },
      { type: 'triangle', octave: 1, detune: 0, level: 0.12 },
    ],
    noise: 0.04, noiseDecay: 0.03,
    attack: 0.002, decay: 1.2, sustain: 0.08, release: 0.3,
    filterCutoff: 1300, filterQ: 0.8, filterEnv: 1400, keyTrack: 0.5,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.95,
  },
  {
    id: 'inst-organ', name: 'Organ', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'sine', octave: 1, detune: 0, level: 0.55 },
      { type: 'sine', octave: 1, detune: 702, level: 0.35 }, // +fifth drawbar
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.01, decay: 0.1, sustain: 1, release: 0.08,
    filterCutoff: 5000, filterQ: 0.4, filterEnv: 0, keyTrack: 0.3,
    vibratoRate: 5.6, vibratoDepth: 5, gain: 0.7,
  },
  {
    id: 'inst-lead', name: 'Synth Lead', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -7, level: 0.8 },
      { type: 'square', octave: 0, detune: 7, level: 0.6 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.01, decay: 0.18, sustain: 0.7, release: 0.18,
    filterCutoff: 2400, filterQ: 1.2, filterEnv: 2200, keyTrack: 0.4,
    vibratoRate: 5, vibratoDepth: 9, gain: 0.75,
  },
  {
    id: 'inst-bass', name: 'Synth Bass', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, level: 0.75 },
      { type: 'sine', octave: -1, detune: 0, level: 1 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.004, decay: 0.3, sustain: 0.55, release: 0.12,
    filterCutoff: 420, filterQ: 2, filterEnv: 1300, keyTrack: 0.35,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-pad', name: 'Warm Pad', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -10, level: 0.6 },
      { type: 'sawtooth', octave: 0, detune: 10, level: 0.6 },
      { type: 'triangle', octave: 1, detune: 0, level: 0.25 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.55, decay: 0.6, sustain: 0.85, release: 1.2,
    filterCutoff: 1100, filterQ: 0.6, filterEnv: 350, keyTrack: 0.3,
    vibratoRate: 4.5, vibratoDepth: 5, gain: 0.6,
  },
  {
    id: 'inst-pluck', name: 'Pluck', builtIn: true,
    oscs: [
      { type: 'triangle', octave: 0, detune: 0, level: 1 },
      { type: 'sawtooth', octave: 0, detune: 3, level: 0.35 },
    ],
    noise: 0.08, noiseDecay: 0.015,
    attack: 0.002, decay: 0.38, sustain: 0, release: 0.18,
    filterCutoff: 650, filterQ: 1, filterEnv: 4200, keyTrack: 0.7,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.9,
  },
  {
    id: 'inst-bells', name: 'Music Box', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'sine', octave: 1, detune: 560, level: 0.35 }, // inharmonic partial
      { type: 'sine', octave: 2, detune: -30, level: 0.18 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 2.2, sustain: 0, release: 1.4,
    filterCutoff: 8000, filterQ: 0.4, filterEnv: 0, keyTrack: 0.5,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.85,
  },
  {
    id: 'inst-strings', name: 'Strings', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -6, level: 0.7 },
      { type: 'sawtooth', octave: 0, detune: 6, level: 0.7 },
      { type: 'sawtooth', octave: 1, detune: 0, level: 0.2 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.32, decay: 0.4, sustain: 0.9, release: 0.7,
    filterCutoff: 3200, filterQ: 0.5, filterEnv: 300, keyTrack: 0.4,
    vibratoRate: 5.5, vibratoDepth: 7, gain: 0.6,
  },
  {
    id: 'inst-brass', name: 'Brass', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -5, level: 0.8 },
      { type: 'sawtooth', octave: 0, detune: 5, level: 0.8 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.07, decay: 0.25, sustain: 0.8, release: 0.2,
    filterCutoff: 1500, filterQ: 1, filterEnv: 1600, keyTrack: 0.5,
    vibratoRate: 5, vibratoDepth: 6, gain: 0.7,
  },
  {
    id: 'inst-marimba', name: 'Marimba', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'sine', octave: 2, detune: 0, level: 0.25 }, // 4x bar partial
    ],
    noise: 0.06, noiseDecay: 0.01,
    attack: 0.002, decay: 0.5, sustain: 0, release: 0.25,
    filterCutoff: 2600, filterQ: 0.5, filterEnv: 900, keyTrack: 0.7,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.95,
  },
  {
    id: 'inst-kalimba', name: 'Kalimba', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'sine', octave: 2, detune: 30, level: 0.2 },
    ],
    noise: 0.12, noiseDecay: 0.008,
    attack: 0.002, decay: 0.9, sustain: 0, release: 0.4,
    filterCutoff: 4200, filterQ: 0.4, filterEnv: 500, keyTrack: 0.6,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.9,
  },
  {
    id: 'inst-choir', name: 'Choir', builtIn: true,
    oscs: [
      { type: 'triangle', octave: 0, detune: -8, level: 0.8 },
      { type: 'sine', octave: 0, detune: 8, level: 0.8 },
      { type: 'sine', octave: 1, detune: 0, level: 0.3 },
    ],
    noise: 0.02, noiseDecay: 10, // sustained breathiness
    attack: 0.4, decay: 0.5, sustain: 0.9, release: 1,
    filterCutoff: 1400, filterQ: 0.8, filterEnv: 250, keyTrack: 0.4,
    vibratoRate: 4.8, vibratoDepth: 8, gain: 0.6,
  },
  {
    id: 'inst-acid', name: 'Acid Lead', builtIn: true,
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, level: 1 },
      { type: 'square', octave: 0, detune: 4, level: 0.4 },
    ],
    noise: 0, noiseDecay: 0.05,
    attack: 0.005, decay: 0.22, sustain: 0.4, release: 0.15,
    filterCutoff: 320, filterQ: 8, filterEnv: 3400, keyTrack: 0.4,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.7,
  },
  {
    id: 'inst-flute', name: 'Flute', builtIn: true,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'triangle', octave: 0, detune: 0, level: 0.3 },
    ],
    noise: 0.06, noiseDecay: 10, // sustained breath
    attack: 0.08, decay: 0.2, sustain: 0.85, release: 0.25,
    filterCutoff: 2600, filterQ: 0.7, filterEnv: 400, keyTrack: 0.6,
    vibratoRate: 5.2, vibratoDepth: 10, gain: 0.75,
  },
];

// ── Custom instrument storage (localStorage) ────────────────────────────────

const LS_KEY = 'slate:custom-instruments';

export function loadCustomInstruments(): InstrumentParams[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as InstrumentParams[];
    if (!Array.isArray(list)) return [];
    // Merge over a factory preset so params added in future versions get
    // sane defaults instead of undefined.
    return list.map((p) => ({ ...INSTRUMENT_PRESETS[0]!, ...p, builtIn: false }));
  } catch {
    return [];
  }
}

export function saveCustomInstrument(p: InstrumentParams): InstrumentParams[] {
  const list = loadCustomInstruments().filter((x) => x.id !== p.id);
  list.push({ ...p, builtIn: false });
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
  return list;
}

export function deleteCustomInstrument(id: string): InstrumentParams[] {
  const list = loadCustomInstruments().filter((x) => x.id !== id);
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
  return list;
}
