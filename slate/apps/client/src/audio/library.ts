/**
 * Built-in audio library — drum/percussion one-shots synthesized in code
 * (no bundled sample files, nothing to download). Each generator returns
 * mono PCM at 44.1kHz ready for addAudioClip; samples are produced on demand
 * and are deterministic in character (noise is random per generation, which
 * is fine — every real drum hit differs too).
 */

import { fetchGmPcm } from './gmSamples';

const SR = 44100;

export type LibraryCategory = 'Drums' | 'Cymbals & Perc' | 'Tonal & FX' | 'Real Instruments';

export interface LibrarySample {
  id: string;
  name: string;
  /** Panel grouping. */
  category: LibraryCategory;
  /** Length in seconds (shown in the panel without generating). */
  duration: number;
  /** Synthesized one-shots produce PCM synchronously… */
  generate?: () => Float32Array;
  /** …real-instrument one-shots fetch + decode a recorded sample instead.
   *  Exactly one of generate/load is set. */
  load?: () => Promise<Float32Array>;
}

/** PCM for a sample regardless of kind (sync synth or fetched recording). */
export async function librarySamplePcm(sample: LibrarySample): Promise<Float32Array> {
  return sample.load ? sample.load() : sample.generate!();
}

/** Normalize to a 0.9 peak so library clips land at a consistent level. */
function normalize(buf: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!));
  if (peak > 1e-6) {
    const g = 0.9 / peak;
    for (let i = 0; i < buf.length; i++) buf[i]! *= g;
  }
  return buf;
}

function seconds(dur: number): Float32Array {
  return new Float32Array(Math.floor(SR * dur));
}

/** Kick — exponential pitch sweep (120→45Hz) with a short attack click. */
function kick(): Float32Array {
  const out = seconds(0.35);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 45 + 75 * Math.exp(-t * 22); // 120Hz → 45Hz
    phase += (2 * Math.PI * f) / SR;
    let v = Math.sin(phase) * Math.exp(-t * 9);
    if (t < 0.004) v += (Math.random() * 2 - 1) * (1 - t / 0.004) * 0.4; // click
    out[i] = v;
  }
  return normalize(out);
}

/** 808-style long boomy kick — deeper sweep, slow decay, soft saturation. */
function kick808(): Float32Array {
  const out = seconds(0.8);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 38 + 60 * Math.exp(-t * 30);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.tanh(Math.sin(phase) * 2.2) * Math.exp(-t * 3.5);
  }
  return normalize(out);
}

/** Snare — noise burst plus a 185Hz body tone. */
function snare(): Float32Array {
  const out = seconds(0.25);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 18) * 0.8;
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 28) * 0.6;
    out[i] = noise + body;
  }
  return normalize(out);
}

/** Hi-hat — first-difference (high-passed) noise with a fast decay. */
function hat(open: boolean): Float32Array {
  const out = seconds(open ? 0.4 : 0.08);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    const hp = n - prev; // crude one-zero highpass keeps only the sizzle
    prev = n;
    out[i] = hp * Math.exp(-t * (open ? 9 : 65));
  }
  return normalize(out);
}

/** Clap — three staggered noise bursts with a shared tail. */
function clap(): Float32Array {
  const out = seconds(0.3);
  const bursts = [0, 0.012, 0.024];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (const b of bursts) {
      if (t >= b) v += (Math.random() * 2 - 1) * Math.exp(-(t - b) * 55) * 0.5;
    }
    v += (Math.random() * 2 - 1) * Math.exp(-t * 9) * 0.25; // room tail
    out[i] = v;
  }
  return normalize(out);
}

/** Tom — sine sweep with a body-dependent decay. */
function tom(fHigh: number, fLow: number, dur: number, decay: number): Float32Array {
  const out = seconds(dur);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = fLow + (fHigh - fLow) * Math.exp(-t * 14);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * decay);
  }
  return normalize(out);
}

/** Shaker — smoothed noise band with an attack ramp. */
function shaker(): Float32Array {
  const out = seconds(0.15);
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * 0.55; // soften the top
    const band = lp - prev;
    prev = lp;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 26);
    out[i] = band * env * 2;
  }
  return normalize(out);
}

/** Rimshot — short click + narrow resonant ping. */
function rim(): Float32Array {
  const out = seconds(0.12);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const ping = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 60);
    const click = t < 0.003 ? (Math.random() * 2 - 1) * (1 - t / 0.003) : 0;
    out[i] = ping * 0.8 + click * 0.6;
  }
  return normalize(out);
}

/** Crash cymbal — bright layered noise with a long shimmering decay. */
function crash(): Float32Array {
  const out = seconds(1.6);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    const hp = n - prev * 0.7; // keep plenty of top end
    prev = n;
    // Two decay stages: fast initial splash, long shimmer tail.
    const env = Math.exp(-t * 12) * 0.6 + Math.exp(-t * 2.2) * 0.4;
    out[i] = hp * env;
  }
  return normalize(out);
}

/** Ride cymbal — metallic ping over a controlled sizzle bed. */
function ride(): Float32Array {
  const out = seconds(1.0);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    const hp = n - prev;
    prev = n;
    const ping =
      (Math.sin(2 * Math.PI * 1250 * t) + Math.sin(2 * Math.PI * 1870 * t) * 0.6) *
      Math.exp(-t * 6) * 0.5;
    out[i] = hp * Math.exp(-t * 4) * 0.35 + ping;
  }
  return normalize(out);
}

/** Cowbell — two detuned square-ish tones (classic 808 recipe: 540 + 800Hz). */
function cowbell(): Float32Array {
  const out = seconds(0.35);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const sq = (f: number) => Math.sign(Math.sin(2 * Math.PI * f * t));
    out[i] = (sq(540) + sq(800) * 0.8) * Math.exp(-t * 11) * 0.5;
  }
  return normalize(out);
}

/** Woodblock — short high resonant ping. */
function woodblock(): Float32Array {
  const out = seconds(0.1);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] =
      (Math.sin(2 * Math.PI * 1200 * t) + Math.sin(2 * Math.PI * 2400 * t) * 0.4) *
      Math.exp(-t * 45);
  }
  return normalize(out);
}

/** Finger snap — one tight noise burst with a small room tail. */
function snap(): Float32Array {
  const out = seconds(0.15);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const burst = (Math.random() * 2 - 1) * Math.exp(-t * 70);
    const tail = (Math.random() * 2 - 1) * Math.exp(-t * 14) * 0.2;
    out[i] = burst + tail;
  }
  return normalize(out);
}

/** Conga — pitched hand-drum tone. */
function conga(f: number): Float32Array {
  const out = seconds(0.3);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const freq = f * (1 + 0.25 * Math.exp(-t * 40)); // small attack bend
    phase += (2 * Math.PI * freq) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * 12) + (t < 0.002 ? (Math.random() * 2 - 1) * 0.3 : 0);
  }
  return normalize(out);
}

/** Bass pluck — a note with harmonics and gentle saturation (default A1). */
function bassPluck(f = 55): Float32Array {
  const out = seconds(0.6);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const v =
      Math.sin(2 * Math.PI * f * t) +
      Math.sin(2 * Math.PI * f * 2 * t) * 0.35 * Math.exp(-t * 10) +
      Math.sin(2 * Math.PI * f * 3 * t) * 0.15 * Math.exp(-t * 16);
    out[i] = Math.tanh(v * 1.6) * Math.exp(-t * 5);
  }
  return normalize(out);
}

/** Synth stab — detuned saw minor chord burst. */
function stab(): Float32Array {
  const out = seconds(0.4);
  const notes = [220, 261.63, 329.63]; // A minor
  const saw = (f: number, t: number) => 2 * ((f * t) % 1) - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of notes) v += saw(f, t) + saw(f * 1.006, t); // slight detune
    out[i] = (v / (notes.length * 2)) * Math.exp(-t * 8);
  }
  return normalize(out);
}

/** Riser — noise sweeping up in brightness and level (build-up FX). */
function riser(): Float32Array {
  const out = seconds(1.2);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const k = t / 1.2; // 0 → 1 over the sweep
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * (0.05 + 0.75 * k); // filter opens as it rises
    out[i] = lp * (0.2 + 0.8 * k * k);
  }
  return normalize(out);
}

/** Sub drop — sine falling from 90Hz to 25Hz (transition FX). */
function subDrop(): Float32Array {
  const out = seconds(1.0);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const k = t / 1.0;
    const f = 90 - 65 * k;
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.tanh(Math.sin(phase) * 1.8) * Math.min(1, (1 - k) * 4);
  }
  return normalize(out);
}

/** Laser zap — fast exponential downward sweep. */
function laser(): Float32Array {
  const out = seconds(0.25);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 2200 * Math.exp(-t * 18) + 80;
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * 9);
  }
  return normalize(out);
}

/** Bell — inharmonic FM-style partials with a long decay. */
function bell(): Float32Array {
  const out = seconds(1.4);
  const partials: [number, number][] = [[520, 1], [832, 0.6], [1378, 0.4], [2080, 0.25]];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (const [f, a] of partials) v += Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t * (2 + f / 700));
    out[i] = v;
  }
  return normalize(out);
}

export const AUDIO_LIBRARY: LibrarySample[] = [
  { id: 'lib-kick', name: 'Kick', category: 'Drums', duration: 0.35, generate: kick },
  { id: 'lib-808', name: '808 Kick', category: 'Drums', duration: 0.8, generate: kick808 },
  { id: 'lib-snare', name: 'Snare', category: 'Drums', duration: 0.25, generate: snare },
  { id: 'lib-hat', name: 'Hi-hat (closed)', category: 'Drums', duration: 0.08, generate: () => hat(false) },
  { id: 'lib-hat-open', name: 'Hi-hat (open)', category: 'Drums', duration: 0.4, generate: () => hat(true) },
  { id: 'lib-clap', name: 'Clap', category: 'Drums', duration: 0.3, generate: clap },
  { id: 'lib-snap', name: 'Snap', category: 'Drums', duration: 0.15, generate: snap },
  { id: 'lib-rim', name: 'Rimshot', category: 'Drums', duration: 0.12, generate: rim },
  { id: 'lib-tom-lo', name: 'Tom (low)', category: 'Drums', duration: 0.4, generate: () => tom(110, 70, 0.4, 7) },
  { id: 'lib-tom-hi', name: 'Tom (high)', category: 'Drums', duration: 0.3, generate: () => tom(190, 125, 0.3, 9) },
  { id: 'lib-crash', name: 'Crash', category: 'Cymbals & Perc', duration: 1.6, generate: crash },
  { id: 'lib-ride', name: 'Ride', category: 'Cymbals & Perc', duration: 1.0, generate: ride },
  { id: 'lib-shaker', name: 'Shaker', category: 'Cymbals & Perc', duration: 0.15, generate: shaker },
  { id: 'lib-cowbell', name: 'Cowbell', category: 'Cymbals & Perc', duration: 0.35, generate: cowbell },
  { id: 'lib-wood', name: 'Woodblock', category: 'Cymbals & Perc', duration: 0.1, generate: woodblock },
  { id: 'lib-conga-lo', name: 'Conga (low)', category: 'Cymbals & Perc', duration: 0.3, generate: () => conga(190) },
  { id: 'lib-conga-hi', name: 'Conga (high)', category: 'Cymbals & Perc', duration: 0.3, generate: () => conga(250) },
  { id: 'lib-bass', name: 'Bass pluck', category: 'Tonal & FX', duration: 0.6, generate: () => bassPluck(55) },
  { id: 'lib-stab', name: 'Synth stab', category: 'Tonal & FX', duration: 0.4, generate: stab },
  { id: 'lib-bell', name: 'Bell', category: 'Tonal & FX', duration: 1.4, generate: bell },
  { id: 'lib-riser', name: 'Riser', category: 'Tonal & FX', duration: 1.2, generate: riser },
  { id: 'lib-subdrop', name: 'Sub drop', category: 'Tonal & FX', duration: 1.0, generate: subDrop },
  { id: 'lib-laser', name: 'Laser', category: 'Tonal & FX', duration: 0.25, generate: laser },

  // Real recorded one-shots (FluidR3 GM), streamed on first use then cached.
  // Durations are the samples' natural ring-out lengths (approximate).
  { id: 'lib-real-piano-c4', name: 'Piano C4', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('acoustic_grand_piano', 60) },
  { id: 'lib-real-piano-c2', name: 'Piano C2', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('acoustic_grand_piano', 36) },
  { id: 'lib-real-guitar-e2', name: 'Guitar E2 (steel)', category: 'Real Instruments', duration: 2.0, load: () => fetchGmPcm('acoustic_guitar_steel', 40) },
  { id: 'lib-real-guitar-a3', name: 'Guitar A3 (steel)', category: 'Real Instruments', duration: 2.0, load: () => fetchGmPcm('acoustic_guitar_steel', 57) },
  { id: 'lib-real-nylon-c4', name: 'Guitar C4 (nylon)', category: 'Real Instruments', duration: 1.8, load: () => fetchGmPcm('acoustic_guitar_nylon', 60) },
  { id: 'lib-real-eguitar-e3', name: 'E-guitar E3', category: 'Real Instruments', duration: 2.2, load: () => fetchGmPcm('electric_guitar_clean', 52) },
  { id: 'lib-real-bass-g1', name: 'Bass G1', category: 'Real Instruments', duration: 1.8, load: () => fetchGmPcm('electric_bass_finger', 31) },
  { id: 'lib-real-violin-a4', name: 'Violin A4', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('violin', 69) },
  { id: 'lib-real-cello-c3', name: 'Cello C3', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('cello', 48) },
  { id: 'lib-real-trumpet-c4', name: 'Trumpet C4', category: 'Real Instruments', duration: 2.8, load: () => fetchGmPcm('trumpet', 60) },
  { id: 'lib-real-sax-c4', name: 'Sax C4', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('alto_sax', 60) },
  { id: 'lib-real-flute-a5', name: 'Flute A5', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('flute', 81) },
  { id: 'lib-real-strings-c4', name: 'Strings C4', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('string_ensemble_1', 60) },
  { id: 'lib-real-choir-c4', name: 'Choir C4', category: 'Real Instruments', duration: 2.9, load: () => fetchGmPcm('choir_aahs', 60) },
];

export const LIBRARY_CATEGORIES: LibraryCategory[] = ['Drums', 'Cymbals & Perc', 'Tonal & FX', 'Real Instruments'];

export const LIBRARY_SAMPLE_RATE = SR;

// ── Preview ──────────────────────────────────────────────────────────────────

let previewCtx: AudioContext | null = null;

/** Play a library sample immediately (panel click preview). Real-instrument
 *  samples resolve asynchronously — the first preview arrives when the fetch
 *  lands (cached and instant thereafter). */
export function previewLibrarySample(sample: LibrarySample): void {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!previewCtx) previewCtx = new AudioCtx();
  if (previewCtx.state === 'suspended') void previewCtx.resume();
  void librarySamplePcm(sample).then((pcm) => {
    const buf = previewCtx!.createBuffer(1, pcm.length, SR);
    buf.getChannelData(0).set(pcm);
    const src = previewCtx!.createBufferSource();
    src.buffer = buf;
    src.connect(previewCtx!.destination);
    src.start();
  }).catch(() => { /* offline / sample unavailable — preview silently skips */ });
}
