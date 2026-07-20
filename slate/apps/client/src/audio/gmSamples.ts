/**
 * Real-instrument samples — streams per-note mp3s from the FluidR3 General
 * MIDI soundfont (gleitz.github.io/midi-js-soundfonts, served with
 * `Access-Control-Allow-Origin: *`) and caches the decoded AudioBuffers in a
 * module-level map shared by:
 *   - live playing (the 'sampled' instrument engine),
 *   - offline take rendering (renderPerformance preloads a take's notes), and
 *   - the Audio Assets "Real Instruments" one-shots.
 *
 * Follows the same lazy/cache/permanent-failure pattern as soundfont.ts (the
 * MIDI-track piano): first press of a note kicks off the fetch, subsequent
 * presses play instantly, and a 404 (note outside the instrument's sampled
 * range) is remembered so we never re-fetch it. When the exact note isn't
 * cached yet but a neighbour is, we play the nearest cached sample
 * pitch-shifted via playbackRate so fast runs don't drop notes.
 */

const GM_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';

export interface GmInstrument {
  /** FluidR3 folder name (without the `-mp3` suffix). */
  id: string;
  name: string;
  /** Sampled MIDI range hint — preloads stay inside it. */
  low: number;
  high: number;
  /** True for bowed/blown/sung instruments whose notes should sustain while
   *  held. Their samples get a seamless loop baked in (see bakeSustainLoop);
   *  plucked/struck instruments decay naturally as one-shots. */
  sustained?: boolean;
}

/** The "real instruments" we surface in the UI (a curated GM subset). */
export const GM_INSTRUMENTS: GmInstrument[] = [
  { id: 'acoustic_grand_piano', name: 'Grand Piano', low: 21, high: 108 },
  { id: 'acoustic_guitar_steel', name: 'Steel Guitar', low: 40, high: 88 },
  { id: 'acoustic_guitar_nylon', name: 'Nylon Guitar', low: 40, high: 88 },
  { id: 'electric_guitar_clean', name: 'Electric Guitar', low: 40, high: 88 },
  { id: 'electric_bass_finger', name: 'Bass Guitar', low: 28, high: 67 },
  { id: 'violin', name: 'Violin', low: 55, high: 100, sustained: true },
  { id: 'cello', name: 'Cello', low: 36, high: 76, sustained: true },
  { id: 'trumpet', name: 'Trumpet', low: 52, high: 94, sustained: true },
  { id: 'alto_sax', name: 'Alto Sax', low: 49, high: 89, sustained: true },
  { id: 'flute', name: 'Flute', low: 60, high: 96, sustained: true },
  { id: 'string_ensemble_1', name: 'String Ensemble', low: 28, high: 96, sustained: true },
  { id: 'choir_aahs', name: 'Choir', low: 36, high: 96, sustained: true },
  { id: 'drawbar_organ', name: 'Organ', low: 36, high: 96, sustained: true },
];

export function gmInstrument(id: string | undefined): GmInstrument {
  return GM_INSTRUMENTS.find((g) => g.id === id) ?? GM_INSTRUMENTS[0]!;
}

/** FluidR3 filenames use FLAT names: C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B. */
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function midiToGmFile(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${FLAT_NAMES[midi % 12]}${octave}.mp3`;
}

export interface GmNote {
  buffer: AudioBuffer;
  /** Loop points in seconds (sustained instruments only) — the region between
   *  them repeats seamlessly while the note is held. */
  loopStart?: number;
  loopEnd?: number;
}

const buffers = new Map<string, GmNote>(); // `${gmId}|${midi}`
const failed = new Set<string>();
const loading = new Set<string>();

/**
 * Bake a click-free sustain loop into raw sample data (pure DSP, exported for
 * tests). The FluidR3 renders hold each note ~2.5 s and then release — without
 * a loop a held violin note just dies mid-phrase, which is the single biggest
 * "doesn't sound real" artifact for bowed/blown instruments.
 *
 * The stable sustain region is roughly the middle of the recording. We pick
 * loopStart/loopEnd inside it and CROSSFADE the audio approaching loopEnd with
 * the audio approaching loopStart, so sample[loopEnd] ≈ sample[loopStart] and
 * the jump is seamless — no zero-crossing hunting needed.
 * Returns loop points in seconds.
 */
export function bakeSustainLoop(
  data: Float32Array,
  sr: number,
): { loopStart: number; loopEnd: number } {
  const dur = data.length / sr;
  const loopStart = Math.min(0.9, dur * 0.35);
  const loopEnd = Math.max(loopStart + 0.4, Math.min(2.1, dur * 0.8));
  const L = Math.round((loopEnd - loopStart) * sr);
  const endIdx = Math.round(loopEnd * sr);
  const fadeLen = Math.min(Math.round(0.3 * sr), L - 1);
  for (let i = 0; i < fadeLen; i++) {
    const idx = endIdx - fadeLen + i;
    if (idx < 0 || idx >= data.length || idx - L < 0) continue;
    // Equal-power crossfade into the loop-start material.
    const t = (i + 1) / fadeLen;
    const a = Math.sin((t * Math.PI) / 2);
    const b = Math.cos((t * Math.PI) / 2);
    data[idx] = data[idx]! * b + data[idx - L]! * a;
  }
  return { loopStart, loopEnd };
}

/** Shared decode context. Decoding doesn't need the autoplay gesture, and the
 *  resulting AudioBuffers are usable from any context (live or offline). */
let decodeCtx: AudioContext | null = null;
function getDecodeCtx(): AudioContext {
  if (!decodeCtx) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    decodeCtx = new AudioCtx();
  }
  return decodeCtx;
}

/** Lazily fetch + decode one note. Resolves to the cached note, or null if
 *  it failed (missing from the soundfont / network error). Sustained
 *  instruments get their seamless sustain loop baked in here, once. */
export async function ensureGmNote(gmId: string, midi: number): Promise<GmNote | null> {
  const key = `${gmId}|${midi}`;
  const hit = buffers.get(key);
  if (hit) return hit;
  if (failed.has(key) || loading.has(key)) return null;
  loading.add(key);
  try {
    const resp = await fetch(`${GM_BASE}/${gmId}-mp3/${midiToGmFile(midi)}`);
    if (!resp.ok) {
      failed.add(key);
      return null;
    }
    const buf = await getDecodeCtx().decodeAudioData(await resp.arrayBuffer());
    const note: GmNote = { buffer: buf };
    if (gmInstrument(gmId).sustained && buf.duration > 1.2) {
      let loop: { loopStart: number; loopEnd: number } | null = null;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        loop = bakeSustainLoop(buf.getChannelData(ch), buf.sampleRate);
      }
      if (loop) {
        note.loopStart = loop.loopStart;
        note.loopEnd = loop.loopEnd;
      }
    }
    buffers.set(key, note);
    return note;
  } catch {
    failed.add(key);
    return null;
  } finally {
    loading.delete(key);
  }
}

/** Best available note RIGHT NOW (no fetch): the exact note, or a nearby
 *  cached neighbour pitch-shifted via playbackRate. The fallback is capped at
 *  ±3 semitones — beyond that the shift sounds obviously wrong (chipmunk /
 *  slow-motion), and silence-until-loaded is the lesser evil. */
export function getGmNote(
  gmId: string,
  midi: number,
): (GmNote & { playbackRate: number }) | null {
  const exact = buffers.get(`${gmId}|${midi}`);
  if (exact) return { ...exact, playbackRate: 1 };
  for (let d = 1; d <= 3; d++) {
    for (const m of [midi - d, midi + d]) {
      const near = buffers.get(`${gmId}|${m}`);
      if (near) return { ...near, playbackRate: Math.pow(2, (midi - m) / 12) };
    }
  }
  return null;
}

/** Warm the cache for a set of notes (dedup, clamped to the sampled range).
 *  Used before offline take renders and when the panel selects a sampled
 *  instrument so the keyboard is responsive immediately. */
export async function preloadGmNotes(gmId: string, midis: number[]): Promise<void> {
  const g = gmInstrument(gmId);
  const unique = Array.from(new Set(midis.filter((m) => m >= g.low && m <= g.high)));
  await Promise.all(unique.map((m) => ensureGmNote(gmId, m)));
}

/** Fetch one note as mono 44.1 kHz PCM — the Audio Assets "real instrument"
 *  one-shots go through this into the normal addAudioClip pipeline. */
export async function fetchGmPcm(gmId: string, midi: number): Promise<Float32Array> {
  const note = await ensureGmNote(gmId, midi);
  if (!note) throw new Error('Sample unavailable — check your connection.');
  const buf = note.buffer;
  // Mix to mono.
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i]! += d[i]!;
  }
  const chGain = 1 / Math.max(1, buf.numberOfChannels);
  for (let i = 0; i < n; i++) mono[i]! *= chGain;
  if (buf.sampleRate === 44100) return mono;
  // Linear resample to the library's 44.1 kHz.
  const outLen = Math.round((n * 44100) / buf.sampleRate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * buf.sampleRate) / 44100;
    const i0 = Math.floor(pos);
    const i1 = Math.min(n - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (mono[i0] ?? 0) * (1 - frac) + (mono[i1] ?? 0) * frac;
  }
  return out;
}
