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

import { ensureGmNote, getGmNote, preloadGmNotes } from './gmSamples';

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

/** Synthesis model. `subtractive` = the classic oscillator+filter synth;
 *  `string` = Karplus-Strong physical modelling (a plucked/struck string — the
 *  realistic guitar/harp/pizzicato path); `fm` = 2-operator FM (realistic
 *  electric piano / bells / clav); `piano` = additive damped-partial piano
 *  (inharmonic partials, per-partial decay, detuned string pairs, hammer
 *  thump); `sampled` = real recorded notes streamed from the FluidR3 General
 *  MIDI soundfont (see gmSamples.ts). All run on plain Web Audio nodes so
 *  they render offline for recorded takes just like the subtractive path. */
export type SynthEngine = 'subtractive' | 'string' | 'fm' | 'piano' | 'sampled';

export interface InstrumentParams {
  id: string;
  name: string;
  /** True for the factory presets (not deletable, saved-as instead of over). */
  builtIn?: boolean;
  /** Picker grouping ("Keys", "Guitar & Bass", …). Customs show under their
   *  own "My instruments" group regardless. */
  group?: string;
  /** Synthesis model (default 'subtractive'). */
  engine?: SynthEngine;
  /** ── String (Karplus-Strong) params ──────────────────────────────────── */
  /** Loop-filter brightness 0..1 — higher rings the high harmonics longer
   *  (steel string / bright), lower is darker (nylon / muted). */
  stringDamping?: number;
  /** Loop feedback 0.8..0.999 — how long the string sustains before it decays
   *  to silence. 0.99 ≈ an acoustic guitar; 0.999 ≈ a long-ringing harp. */
  stringDecay?: number;
  /** Where the string is plucked, as a fraction of its length (0.02..0.5).
   *  Near the bridge (small) = thin/twangy; near the middle = hollow/round.
   *  The classic guitar pick sits around 0.13. */
  stringPickPos?: number;
  /** 0..1 acoustic-body resonance amount (low-mid peaking EQ modelled on a
   *  guitar box). 0 = a bare string (solid-body electric). */
  stringBody?: number;
  /** 0..1 amp overdrive for the electric path (soft-clip + cab-ish lowpass). */
  stringDrive?: number;
  /** 0..1 room-reverb send (shared synthetic room, works live + offline). */
  reverb?: number;
  /** ── Sampled engine ───────────────────────────────────────────────────── */
  /** FluidR3 GM instrument folder (see GM_INSTRUMENTS in gmSamples.ts). */
  sampleId?: string;
  /** ── FM params ────────────────────────────────────────────────────────── */
  /** Modulator : carrier frequency ratio. Integer ratios (1, 2, 3) = harmonic
   *  (e-piano, brass); non-integers (1.4, 3.5) = inharmonic (bells, metallic). */
  fmRatio?: number;
  /** Modulation index (brightness / timbre richness). */
  fmIndex?: number;
  /** Seconds for the modulation index to decay toward ~0 — the classic FM
   *  "bright attack, mellow tail". 0 = constant brightness (organ-like). */
  fmDecay?: number;
  /** 1-3 oscillators summed into the filter (subtractive engine). */
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

/** Karplus-Strong loop-delay tuning offset (in samples): a plucked string's
 *  pitch is set by the TOTAL round-trip delay = the delay line PLUS the loop
 *  lowpass's group delay. Subtract the filter's ~1-sample delay from the delay
 *  line so the sounding pitch matches the note (verified by the pitch test in
 *  instruments.test.ts to land within a few cents across the range). */
const KS_DELAY_SAMPLES_OFFSET = 1.0;

/** Compute one plucked string (Karplus-Strong) as raw samples — pure DSP so
 *  the pitch tests exercise the exact shipping loop.
 *
 *  A Web Audio DelayNode feedback loop is the "obvious" way to do this, but in
 *  practice the loop DIVERGES (RMS blows up) — feedback DelayNodes are
 *  unreliable, especially offline. So we compute the sample loop directly in JS
 *  (one delay line + a one-pole lowpass in the feedback path). Deterministic,
 *  always stable, in tune, and identical on live and offline contexts. The
 *  buffer length is the string's natural decay time (to ~-60 dB) capped at 3 s.
 *
 *  Realism over the naive KS loop:
 *   - the excitation noise is lowpassed by VELOCITY (soft touch = dull pluck,
 *     hard pick = bright attack), and
 *   - comb-filtered at the PICK POSITION (subtracting a copy delayed by
 *     pickPos·period cancels the harmonics with a node at the pluck point —
 *     the difference between a "synth pluck" and a guitar's twang), and
 *   - a DC blocker keeps the comb from parking offset in the loop.
 */
export function renderStringSamples(
  sr: number,
  f: number,
  damping: number,
  decay: number,
  velocity = 1,
  pickPos = 0.13,
): Float32Array {
  const fb = clamp(decay, 0.8, 0.9995);
  const delaySamples = Math.max(2, sr / f - KS_DELAY_SAMPLES_OFFSET);
  // Time for the fb^(cycles) envelope to reach ~-60 dB, capped.
  const dur = clamp(Math.log(0.001) / (f * Math.log(fb)), 0.3, 3);
  const N = Math.ceil(dur * sr);
  const out = new Float32Array(N);
  const lineLen = Math.ceil(delaySamples) + 4;
  const line = new Float32Array(lineLen);
  let widx = 0;
  const cutoff = clamp(damping * 7000 + f * 3, 400, 16000);
  const a = Math.exp((-2 * Math.PI * cutoff) / sr); // one-pole lowpass coeff
  let lp = 0;
  // ── Excitation: velocity-lowpassed noise, comb-filtered at the pick point.
  const burst = Math.floor(0.006 * sr); // 6 ms noise pluck
  const pick = Math.max(1, Math.round(delaySamples * clamp(pickPos, 0.02, 0.5)));
  const excLen = burst + pick;
  const exc = new Float32Array(excLen);
  const vel = clamp(velocity, 0, 1);
  const excCut = clamp(1200 + 9000 * vel * vel, 800, sr * 0.45);
  const ea = Math.exp((-2 * Math.PI * excCut) / sr);
  let elp = 0;
  for (let n = 0; n < burst; n++) {
    elp = (1 - ea) * (Math.random() * 2 - 1) + ea * elp;
    exc[n]! += elp;
    exc[n + pick]! -= elp; // pick-position comb (node at the pluck point)
  }
  let peak = 0;
  let dcX = 0;
  let dcY = 0;
  for (let n = 0; n < N; n++) {
    const readPos = widx - delaySamples;
    const i0 = ((Math.floor(readPos) % lineLen) + lineLen) % lineLen;
    const i1 = (i0 + 1) % lineLen;
    const frac = readPos - Math.floor(readPos);
    const delayed = line[i0]! * (1 - frac) + line[i1]! * frac;
    lp = (1 - a) * delayed + a * lp;
    line[widx] = (n < excLen ? exc[n]! : 0) + fb * lp;
    // DC blocker: y[n] = x[n] - x[n-1] + 0.995 y[n-1].
    dcY = delayed - dcX + 0.995 * dcY;
    dcX = delayed;
    out[n] = dcY;
    const abs = Math.abs(dcY);
    if (abs > peak) peak = abs;
    widx = (widx + 1) % lineLen;
  }
  // Normalize so velocity/gain control loudness predictably.
  if (peak > 1e-6) {
    const g = 0.7 / peak;
    for (let i = 0; i < N; i++) out[i]! *= g;
  }
  return out;
}

/** Two slightly detuned strings (±1.2 cents) summed into an AudioBuffer — the
 *  unison shimmer of a real instrument where no two strings (or two plucks)
 *  are ever perfectly identical. */
function renderStringBuffer(
  ctx: BaseAudioContext,
  f: number,
  damping: number,
  decay: number,
  velocity: number,
  pickPos: number,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = 0.0007; // ±1.2 cents
  const s1 = renderStringSamples(sr, f * (1 - d), damping, decay, velocity, pickPos);
  const s2 = renderStringSamples(sr, f * (1 + d), damping, decay, velocity, pickPos);
  const N = Math.max(s1.length, s2.length);
  const buf = ctx.createBuffer(1, N, sr);
  const out = buf.getChannelData(0);
  for (let i = 0; i < N; i++) out[i] = 0.5 * ((s1[i] ?? 0) + (s2[i] ?? 0));
  return buf;
}

/** Additive damped-partial piano — pure DSP, exported for the pitch tests.
 *
 *  What makes it read as "piano" instead of "organ tone with an envelope":
 *   - INHARMONIC partials: fₙ = n·f·√(1+B·n²) — real strings are stiff, so
 *     upper partials run progressively sharp (B grows toward the treble),
 *   - per-partial decay: highs die fast, the fundamental sings on,
 *   - hammer-position comb: partial amplitudes follow sin(π·n·x) with the
 *     hammer at x ≈ 0.12 of the string,
 *   - velocity → spectrum: soft notes lose their upper partials (felt hammer),
 *   - detuned string PAIRS per note (real pianos have 2-3): the slow beating
 *     between them is the familiar "singing" warble of a held piano note,
 *   - a felt-hammer thump (lowpassed noise, ~20 ms) under the attack.
 *  Partials run on complex-rotation oscillators (no Math.sin in the loop) so a
 *  4-second note renders in a few milliseconds. */
export function renderPianoSamples(sr: number, f: number, velocity = 1): Float32Array {
  const vel = clamp(velocity, 0, 1);
  const dur = clamp(5 * Math.pow(220 / f, 0.6), 0.9, 4.5);
  const N = Math.ceil(dur * sr);
  const out = new Float32Array(N);
  const nyq = sr * 0.45;
  const maxP = Math.max(4, Math.min(22, Math.floor(nyq / f)));
  const B = 0.00008 + 0.00035 * (f / 1000); // stiffness inharmonicity
  const hammerX = 0.12;
  const baseTau = clamp(4.2 * Math.pow(220 / f, 0.7), 0.5, 6);
  interface Partial { c: number; s: number; dc: number; ds: number; amp: number; k: number }
  const parts: Partial[] = [];
  for (let p = 1; p <= maxP; p++) {
    const fn = p * f * Math.sqrt(1 + B * p * p);
    if (fn >= nyq) break;
    // Hammer comb + rolloff + velocity brightness.
    const amp =
      (Math.abs(Math.sin(Math.PI * p * hammerX)) / Math.pow(p, 1.1)) *
      Math.exp(-(p - 1) * (1 - vel) * 0.55);
    if (amp < 1e-4) continue;
    const tau = baseTau / (1 + 0.03 * p * p);
    const k = Math.exp(-1 / (tau * sr)); // per-sample decay
    // A detuned pair per partial (two strings): beat rate grows gently with p.
    for (const det of [1 - 0.00035, 1 + 0.00035]) {
      const w = (2 * Math.PI * fn * det) / sr;
      parts.push({ c: 1, s: 0, dc: Math.cos(w), ds: Math.sin(w), amp: amp * 0.5, k });
    }
  }
  // Per-partial rotation with per-partial exponential decay folded into amp.
  for (const pt of parts) {
    let { c, s, amp } = pt;
    const { dc, ds, k } = pt;
    for (let n = 0; n < N; n++) {
      out[n]! += s * amp;
      const nc = c * dc - s * ds;
      s = c * ds + s * dc;
      c = nc;
      amp *= k;
      if (amp < 1e-6) break;
    }
  }
  // Felt-hammer thump: 20 ms of 250 Hz-lowpassed noise under the attack.
  const thump = Math.floor(0.02 * sr);
  const ta = Math.exp((-2 * Math.PI * 250) / sr);
  let tlp = 0;
  for (let n = 0; n < thump && n < N; n++) {
    tlp = (1 - ta) * (Math.random() * 2 - 1) + ta * tlp;
    out[n]! += tlp * 0.9 * vel * (1 - n / thump);
  }
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(out[i]!);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = 0.7 / peak;
    for (let i = 0; i < N; i++) out[i]! *= g;
  }
  return out;
}

/** Piano buffers are cached per (sampleRate, note, velocity-bucket) — piano
 *  renders are ~10× costlier than the string loop and notes repeat constantly
 *  while playing. FIFO-capped so a long session can't hoard memory. */
const pianoCache = new Map<string, Float32Array>();
function renderPianoBuffer(ctx: BaseAudioContext, f: number, velocity: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const vb = Math.round(clamp(velocity, 0, 1) * 8);
  const key = `${sr}|${f.toFixed(2)}|${vb}`;
  let samples = pianoCache.get(key);
  if (!samples) {
    samples = renderPianoSamples(sr, f, vb / 8);
    pianoCache.set(key, samples);
    if (pianoCache.size > 96) {
      const first = pianoCache.keys().next().value;
      if (first !== undefined) pianoCache.delete(first);
    }
  }
  const buf = ctx.createBuffer(1, samples.length, sr);
  buf.getChannelData(0).set(samples);
  return buf;
}

// ── Room reverb (shared synthetic impulse response) ─────────────────────────

/** ~1.8 s decaying-noise stereo IR with progressive high-frequency damping —
 *  a believable small hall, generated per context (works offline too). */
const reverbIRCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function getReverbIR(ctx: BaseAudioContext): AudioBuffer {
  let buf = reverbIRCache.get(ctx);
  if (buf) return buf;
  const sr = ctx.sampleRate;
  const dur = 1.8;
  const N = Math.ceil(dur * sr);
  buf = ctx.createBuffer(2, N, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // One-pole lowpass whose cutoff falls as the tail decays (air absorption).
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const cut = 6000 * Math.pow(1 - t, 1.5) + 400;
      const a = Math.exp((-2 * Math.PI * cut) / sr);
      lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
      d[i] = lp * Math.pow(1 - t, 2.1);
    }
    // 12 ms pre-delay gap keeps the direct sound distinct.
    const gap = Math.floor(0.012 * sr);
    for (let i = 0; i < gap; i++) d[i] = 0;
  }
  reverbIRCache.set(ctx, buf);
  return buf;
}

/** Master graph: dry pass-through + convolver wet send. Returns the node
 *  voices connect to and a gain that sets the wet amount. */
export function buildInstrumentBus(
  ctx: BaseAudioContext,
  dest: AudioNode,
): { input: GainNode; wet: GainNode } {
  const input = ctx.createGain();
  input.connect(dest);
  const conv = ctx.createConvolver();
  conv.buffer = getReverbIR(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(conv);
  conv.connect(wet);
  wet.connect(dest);
  return { input, wet };
}

/** Soft-clip curves for the electric-guitar drive, cached per amount. */
const driveCurveCache = new Map<number, Float32Array<ArrayBuffer>>();
function getDriveCurve(drive: number): Float32Array<ArrayBuffer> {
  const key = Math.round(clamp(drive, 0, 1) * 20);
  let curve = driveCurveCache.get(key);
  if (!curve) {
    const k = 1 + (key / 20) * 14;
    curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    driveCurveCache.set(key, curve);
  }
  return curve;
}

/** Build and start one note's node graph. The SOURCE stage depends on the
 *  engine (subtractive oscs, Karplus-Strong string, or FM), feeding a common
 *  amp-ADSR → dest tail. Works on both AudioContext (live) and
 *  OfflineAudioContext (recorded-take render). */
export function startVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  p: InstrumentParams,
  midi: number,
  velocity: number,
  when: number,
): VoiceHandle {
  const f = midiToFreq(midi);
  const engine = p.engine ?? 'subtractive';
  const vel = clamp(velocity, 0, 1);

  const amp = ctx.createGain();
  amp.connect(dest);
  // Velocity curve — even a soft hit stays audible (0.25 floor).
  const peak = p.gain * (0.25 + 0.75 * vel);
  const atk = Math.max(0.002, p.attack);
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + atk);
  amp.gain.setTargetAtTime(peak * clamp(p.sustain, 0, 1), when + atk, Math.max(0.01, p.decay / 3));

  const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
  const nodes: AudioNode[] = [amp];

  // Optional vibrato LFO (drives osc/carrier detune in subtractive + FM).
  let lfoGain: GainNode | null = null;
  if (p.vibratoDepth > 0 && p.vibratoRate > 0 && engine !== 'string' && engine !== 'piano' && engine !== 'sampled') {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.vibratoRate;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = p.vibratoDepth;
    lfo.connect(lfoGain);
    lfo.start(when);
    sources.push(lfo);
    nodes.push(lfoGain);
  }

  if (engine === 'string') {
    // ── Karplus-Strong plucked/struck string (buffer-rendered) ─────────────
    const src = ctx.createBufferSource();
    src.buffer = renderStringBuffer(
      ctx,
      f,
      p.stringDamping ?? 0.5,
      p.stringDecay ?? 0.985,
      vel,
      p.stringPickPos ?? 0.13,
    );
    // src → [drive (soft-clip + cab lowpass)] → [body resonance EQ] → amp
    let head: AudioNode = src;
    const drive = clamp(p.stringDrive ?? 0, 0, 1);
    if (drive > 0.01) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = getDriveCurve(drive);
      shaper.oversample = '2x';
      const cab = ctx.createBiquadFilter();
      cab.type = 'lowpass';
      cab.frequency.value = 5200 - drive * 1800; // hotter drive = darker cab
      cab.Q.value = 0.7;
      head.connect(shaper);
      shaper.connect(cab);
      head = cab;
      nodes.push(shaper, cab);
    }
    const body = clamp(p.stringBody ?? 0, 0, 1);
    if (body > 0.01) {
      // Guitar-box low-mid resonances (main air + top-plate modes).
      const modes: [number, number, number][] = [
        [105, 1.6, 6 * body],
        [220, 2.2, 4 * body],
        [420, 2.5, 2.8 * body],
      ];
      for (const [freq, q, gainDb] of modes) {
        const peak = ctx.createBiquadFilter();
        peak.type = 'peaking';
        peak.frequency.value = freq;
        peak.Q.value = q;
        peak.gain.value = gainDb;
        head.connect(peak);
        head = peak;
        nodes.push(peak);
      }
    }
    head.connect(amp);
    src.start(when);
    sources.push(src);
  } else if (engine === 'piano') {
    // ── Additive damped-partial piano (buffer-rendered, cached) ────────────
    const src = ctx.createBufferSource();
    src.buffer = renderPianoBuffer(ctx, f, vel);
    src.connect(amp);
    src.start(when);
    sources.push(src);
  } else if (engine === 'sampled') {
    // ── Real recorded note (FluidR3 GM sample) ─────────────────────────────
    // Cache-only lookup: startVoice must stay synchronous. The nearest cached
    // neighbour (pitch-shifted) covers a note whose exact sample is still
    // downloading; a full miss kicks off the fetch so the NEXT press plays
    // (same first-press behavior as the MIDI-track soundfont piano).
    const gmId = p.sampleId ?? 'acoustic_grand_piano';
    const hit = getGmNote(gmId, midi);
    if (hit) {
      const src = ctx.createBufferSource();
      src.buffer = hit.buffer;
      src.playbackRate.value = hit.playbackRate;
      // Sustained instruments (bowed/blown/sung) loop their baked sustain
      // region while held — the release fade in stop() ends the note.
      if (hit.loopStart !== undefined && hit.loopEnd !== undefined) {
        src.loop = true;
        src.loopStart = hit.loopStart;
        src.loopEnd = hit.loopEnd;
      }
      src.connect(amp);
      src.start(when);
      sources.push(src);
    } else {
      void ensureGmNote(gmId, midi);
    }
  } else if (engine === 'fm') {
    // ── 2-operator FM ──────────────────────────────────────────────────────
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = f;
    if (lfoGain) lfoGain.connect(carrier.detune);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    const ratio = p.fmRatio ?? 1;
    mod.frequency.value = f * ratio;
    const modGain = ctx.createGain();
    // Index → peak deviation in Hz; harder hits are brighter.
    const idx = (p.fmIndex ?? 2) * (0.4 + 0.6 * vel);
    const depth = idx * f * ratio;
    modGain.gain.setValueAtTime(depth, when);
    const fmDecay = p.fmDecay ?? 0;
    if (fmDecay > 0) modGain.gain.setTargetAtTime(depth * 0.04, when, fmDecay);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(amp);
    mod.start(when);
    carrier.start(when);
    sources.push(mod, carrier);
    nodes.push(modGain);
  } else {
    // ── Subtractive (oscillators → lowpass filter) ─────────────────────────
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = clamp(p.filterQ, 0.0001, 20);
    const baseCut = clamp(p.filterCutoff + p.keyTrack * f * 2, 40, 18000);
    const peakCut = clamp(baseCut + p.filterEnv, 40, 18000);
    filter.frequency.setValueAtTime(peakCut, when);
    filter.frequency.setTargetAtTime(baseCut, when, Math.max(0.02, p.decay / 3));
    filter.connect(amp);
    nodes.push(filter);

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
      if (p.noiseDecay < 5) ng.gain.setTargetAtTime(0, when, Math.max(0.005, p.noiseDecay));
      src.connect(ng);
      ng.connect(filter);
      src.start(when);
      sources.push(src);
      nodes.push(ng);
    }
  }

  let stopped = false;
  return {
    stop(t: number) {
      if (stopped) return;
      stopped = true;
      // Never start the release before the attack ramp completes — a
      // setTarget(0) scheduled BEFORE the pending linearRamp would let the
      // ramp win and leave the note stuck at full level.
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
      if (last) last.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch { /* detached */ } } };
      // A silent sampled-engine miss has no sources — still detach the amp so
      // repeated first-presses don't accumulate orphaned gain nodes.
      else for (const n of nodes) { try { n.disconnect(); } catch { /* detached */ } }
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
  private bus: { input: GainNode; wet: GainNode } | null = null;
  private static readonly MAX_VOICES = 16;

  constructor(params: InstrumentParams) {
    this.params = params;
  }

  setParams(p: InstrumentParams): void {
    this.params = p;
    if (this.bus) this.bus.wet.gain.value = clamp(p.reverb ?? 0, 0, 1);
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
      // Voices feed the bus; the bus splits into the dry path + reverb send.
      this.bus = buildInstrumentBus(liveCtx, this.master);
      this.bus.wet.gain.value = clamp(this.params.reverb ?? 0, 0, 1);
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
    this.voices.set(midi, startVoice(ctx, this.bus!.input, this.params, midi, velocity, ctx.currentTime));
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
  // Sampled engine: fetch every note's mp3 up front — the offline graph can't
  // await downloads mid-render, and startVoice only reads the cache.
  if ((p.engine ?? 'subtractive') === 'sampled') {
    await preloadGmNotes(p.sampleId ?? 'acoustic_grand_piano', notes.map((n) => n.midi));
  }
  const lead = 0.03; // tiny pre-roll so attack transients aren't clipped at t=0
  const rel = Math.max(0.02, p.release);
  // Leave room for the reverb tail so a wet take isn't cut off mid-decay.
  const tail = (p.reverb ?? 0) > 0.01 ? 1.6 : 0;
  const end = Math.max(...notes.map((n) => n.start + n.duration)) + rel * 1.5 + 0.25 + tail;
  const length = Math.ceil((end + lead) * RENDER_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(1, length, RENDER_SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  // Same dry+reverb bus as live playing, so the take sounds like what the
  // player heard.
  const bus = buildInstrumentBus(ctx, master);
  bus.wet.gain.value = clamp(p.reverb ?? 0, 0, 1);
  for (const n of notes) {
    const v = startVoice(ctx, bus.input, p, n.midi, n.velocity, lead + n.start);
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
    id: 'inst-grand-piano', name: 'Grand Piano (synth)', builtIn: true, group: 'Keys',
    engine: 'piano', reverb: 0.14,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 1.5, sustain: 1, release: 0.35,
    filterCutoff: 750, filterQ: 0.6, filterEnv: 2800, keyTrack: 0.7,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-epiano', name: 'E-Piano', builtIn: true, group: 'Keys', reverb: 0.12,
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
    id: 'inst-organ', name: 'Organ (synth)', builtIn: true, group: 'Keys', reverb: 0.18,
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
    id: 'inst-lead', name: 'Synth Lead', builtIn: true, group: 'Synths', reverb: 0.1,
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
    id: 'inst-bass', name: 'Synth Bass', builtIn: true, group: 'Synths', reverb: 0.04,
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
    id: 'inst-pad', name: 'Warm Pad', builtIn: true, group: 'Synths', reverb: 0.35,
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
    id: 'inst-pluck', name: 'Pluck', builtIn: true, group: 'Synths', reverb: 0.15,
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
    id: 'inst-bells', name: 'Music Box', builtIn: true, group: 'Bells & Perc', reverb: 0.3,
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
    id: 'inst-strings', name: 'Strings (synth)', builtIn: true, group: 'Strings', reverb: 0.3,
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
    id: 'inst-brass', name: 'Brass', builtIn: true, group: 'Winds & Brass', reverb: 0.18,
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
    id: 'inst-marimba', name: 'Marimba', builtIn: true, group: 'Bells & Perc', reverb: 0.2,
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
    id: 'inst-kalimba', name: 'Kalimba', builtIn: true, group: 'Bells & Perc', reverb: 0.2,
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
    id: 'inst-choir', name: 'Choir (synth)', builtIn: true, group: 'Voices', reverb: 0.35,
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
    id: 'inst-acid', name: 'Acid Lead', builtIn: true, group: 'Synths', reverb: 0.08,
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
    id: 'inst-flute', name: 'Flute (synth)', builtIn: true, group: 'Winds & Brass', reverb: 0.2,
    oscs: [
      { type: 'sine', octave: 0, detune: 0, level: 1 },
      { type: 'triangle', octave: 0, detune: 0, level: 0.3 },
    ],
    noise: 0.06, noiseDecay: 10, // sustained breath
    attack: 0.08, decay: 0.2, sustain: 0.85, release: 0.25,
    filterCutoff: 2600, filterQ: 0.7, filterEnv: 400, keyTrack: 0.6,
    vibratoRate: 5.2, vibratoDepth: 10, gain: 0.75,
  },

  // ── Recorded instruments (FluidR3 GM samples, streamed + cached) ───────────
  // These play actual recordings per note and carry the PLAIN instrument
  // names — they're the default pick. The synthesized/modelled versions of
  // the same instruments keep working offline under a "(synth)" suffix.
  // First press of a note downloads it (~20 KB); after that it's instant.
  ...([
    ['inst-real-piano', 'Grand Piano', 'acoustic_grand_piano', 0.12, 'Keys'],
    ['inst-real-steel-guitar', 'Acoustic Guitar', 'acoustic_guitar_steel', 0.14, 'Guitar & Bass'],
    ['inst-real-nylon-guitar', 'Nylon Guitar', 'acoustic_guitar_nylon', 0.14, 'Guitar & Bass'],
    ['inst-real-electric-guitar', 'Electric Guitar', 'electric_guitar_clean', 0.12, 'Guitar & Bass'],
    ['inst-real-bass', 'Bass Guitar', 'electric_bass_finger', 0.05, 'Guitar & Bass'],
    ['inst-real-violin', 'Violin', 'violin', 0.22, 'Strings'],
    ['inst-real-cello', 'Cello', 'cello', 0.22, 'Strings'],
    ['inst-real-trumpet', 'Trumpet', 'trumpet', 0.16, 'Winds & Brass'],
    ['inst-real-sax', 'Alto Sax', 'alto_sax', 0.16, 'Winds & Brass'],
    ['inst-real-flute', 'Flute', 'flute', 0.2, 'Winds & Brass'],
    ['inst-real-strings', 'String Ensemble', 'string_ensemble_1', 0.3, 'Strings'],
    ['inst-real-choir', 'Choir', 'choir_aahs', 0.32, 'Voices'],
    ['inst-real-organ', 'Organ', 'drawbar_organ', 0.15, 'Keys'],
  ] as [string, string, string, number, string][]).map(([id, name, sampleId, reverb, group]) => ({
    id, name, builtIn: true, group,
    engine: 'sampled' as const, sampleId, reverb,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 0.3,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  })),

  // ── Physical-model strings (Karplus-Strong) ────────────────────────────────
  // These are the "real instrument" plucked/struck strings. `oscs`/filter
  // fields are ignored by the string engine but kept (defaulted) so the type
  // and the customize panel stay uniform.
  {
    id: 'inst-acoustic-guitar', name: 'Acoustic Guitar (synth)', builtIn: true, group: 'Guitar & Bass',
    engine: 'string', stringDamping: 0.42, stringDecay: 0.992,
    stringPickPos: 0.13, stringBody: 0.8, stringDrive: 0, reverb: 0.15,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 0.9,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1.1,
  },
  {
    id: 'inst-electric-guitar', name: 'Electric Guitar (synth)', builtIn: true, group: 'Guitar & Bass',
    engine: 'string', stringDamping: 0.62, stringDecay: 0.996,
    stringPickPos: 0.09, stringBody: 0, stringDrive: 0.45, reverb: 0.12,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 1.4,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1.05,
  },
  {
    id: 'inst-nylon-guitar', name: 'Nylon Guitar (synth)', builtIn: true, group: 'Guitar & Bass',
    engine: 'string', stringDamping: 0.3, stringDecay: 0.988,
    stringPickPos: 0.19, stringBody: 1, stringDrive: 0, reverb: 0.16,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 0.7,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1.1,
  },
  {
    id: 'inst-bass-guitar', name: 'Bass Guitar (synth)', builtIn: true, group: 'Guitar & Bass',
    engine: 'string', stringDamping: 0.28, stringDecay: 0.994,
    stringPickPos: 0.26, stringBody: 0.15, stringDrive: 0.12, reverb: 0.05,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 0.6,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1.2,
  },
  {
    id: 'inst-harp', name: 'Harp', builtIn: true, group: 'Strings',
    engine: 'string', stringDamping: 0.55, stringDecay: 0.997,
    stringPickPos: 0.4, stringBody: 0.5, stringDrive: 0, reverb: 0.3,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 2.2,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-banjo', name: 'Banjo', builtIn: true, group: 'Guitar & Bass',
    engine: 'string', stringDamping: 0.8, stringDecay: 0.982,
    stringPickPos: 0.07, stringBody: 0.9, stringDrive: 0, reverb: 0.1,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.001, decay: 0.3, sustain: 1, release: 0.5,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-pizzicato', name: 'Pizzicato', builtIn: true, group: 'Strings',
    engine: 'string', stringDamping: 0.45, stringDecay: 0.965,
    stringPickPos: 0.31, stringBody: 0.6, stringDrive: 0, reverb: 0.25,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.3, sustain: 1, release: 0.25,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1.1,
  },

  // ── FM operators (realistic e-piano / bells / clav) ────────────────────────
  {
    id: 'inst-rhodes', name: 'Rhodes E-Piano', builtIn: true, group: 'Keys', reverb: 0.15,
    engine: 'fm', fmRatio: 1, fmIndex: 1.4, fmDecay: 0.35,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.003, decay: 1.6, sustain: 0.35, release: 0.4,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-fm-piano', name: 'FM Piano', builtIn: true, group: 'Keys', reverb: 0.14,
    engine: 'fm', fmRatio: 2, fmIndex: 1.1, fmDecay: 0.5,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 2, sustain: 0, release: 0.3,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-tubular-bells', name: 'Tubular Bells', builtIn: true, group: 'Bells & Perc', reverb: 0.35,
    engine: 'fm', fmRatio: 4, fmIndex: 2, fmDecay: 2.2,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 3, sustain: 0, release: 1.8,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.9,
  },
  {
    id: 'inst-clav', name: 'Clavinet', builtIn: true, group: 'Keys', reverb: 0.08,
    engine: 'fm', fmRatio: 3, fmIndex: 2.2, fmDecay: 0.12,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.002, decay: 0.4, sustain: 0, release: 0.15,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 1,
  },
  {
    id: 'inst-steel-drum', name: 'Steel Drum', builtIn: true, group: 'Bells & Perc', reverb: 0.25,
    engine: 'fm', fmRatio: 1, fmIndex: 3, fmDecay: 0.5,
    oscs: [], noise: 0, noiseDecay: 0.05,
    attack: 0.003, decay: 0.8, sustain: 0, release: 0.4,
    filterCutoff: 6000, filterQ: 0.5, filterEnv: 0, keyTrack: 0,
    vibratoRate: 0, vibratoDepth: 0, gain: 0.95,
  },
];

// ── Custom instrument storage (localStorage) ────────────────────────────────

const LS_KEY = 'slate:custom-instruments';

/** Neutral defaults saved customs are merged over so params added in future
 *  versions get sane values instead of undefined. Deliberately NOT a factory
 *  preset: preset[0] is now the piano engine, and inheriting `engine` would
 *  silently re-voice every old custom synth. */
const CUSTOM_DEFAULTS: InstrumentParams = {
  id: '', name: '', engine: 'subtractive',
  oscs: [{ type: 'sawtooth', octave: 0, detune: 0, level: 1 }],
  noise: 0, noiseDecay: 0.05,
  attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.2,
  filterCutoff: 2000, filterQ: 0.7, filterEnv: 0, keyTrack: 0.5,
  vibratoRate: 0, vibratoDepth: 0, gain: 0.8, reverb: 0,
};

export function loadCustomInstruments(): InstrumentParams[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as InstrumentParams[];
    if (!Array.isArray(list)) return [];
    return list.map((p) => ({ ...CUSTOM_DEFAULTS, ...p, builtIn: false }));
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
