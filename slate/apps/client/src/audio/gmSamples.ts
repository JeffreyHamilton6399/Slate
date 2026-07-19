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
}

/** The "real instruments" we surface in the UI (a curated GM subset). */
export const GM_INSTRUMENTS: GmInstrument[] = [
  { id: 'acoustic_grand_piano', name: 'Grand Piano', low: 21, high: 108 },
  { id: 'acoustic_guitar_steel', name: 'Steel Guitar', low: 40, high: 88 },
  { id: 'acoustic_guitar_nylon', name: 'Nylon Guitar', low: 40, high: 88 },
  { id: 'electric_guitar_clean', name: 'Electric Guitar', low: 40, high: 88 },
  { id: 'electric_bass_finger', name: 'Bass Guitar', low: 28, high: 67 },
  { id: 'violin', name: 'Violin', low: 55, high: 100 },
  { id: 'cello', name: 'Cello', low: 36, high: 76 },
  { id: 'trumpet', name: 'Trumpet', low: 52, high: 94 },
  { id: 'alto_sax', name: 'Alto Sax', low: 49, high: 89 },
  { id: 'flute', name: 'Flute', low: 60, high: 96 },
  { id: 'string_ensemble_1', name: 'String Ensemble', low: 28, high: 96 },
  { id: 'choir_aahs', name: 'Choir', low: 36, high: 96 },
  { id: 'drawbar_organ', name: 'Organ', low: 36, high: 96 },
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

const buffers = new Map<string, AudioBuffer>(); // `${gmId}|${midi}`
const failed = new Set<string>();
const loading = new Set<string>();

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

/** Lazily fetch + decode one note. Resolves to the cached buffer, or null if
 *  the note failed (missing from the soundfont / network error). */
export async function ensureGmNote(gmId: string, midi: number): Promise<AudioBuffer | null> {
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
    buffers.set(key, buf);
    return buf;
  } catch {
    failed.add(key);
    return null;
  } finally {
    loading.delete(key);
  }
}

/** Best available buffer for a note RIGHT NOW (no fetch): the exact note, or
 *  the nearest cached neighbour within an octave pitch-shifted to the target
 *  via playbackRate. Null when nothing usable is cached yet. */
export function getGmNote(
  gmId: string,
  midi: number,
): { buffer: AudioBuffer; playbackRate: number } | null {
  const exact = buffers.get(`${gmId}|${midi}`);
  if (exact) return { buffer: exact, playbackRate: 1 };
  for (let d = 1; d <= 12; d++) {
    for (const m of [midi - d, midi + d]) {
      const near = buffers.get(`${gmId}|${m}`);
      if (near) return { buffer: near, playbackRate: Math.pow(2, (midi - m) / 12) };
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
  const buf = await ensureGmNote(gmId, midi);
  if (!buf) throw new Error('Sample unavailable — check your connection.');
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
