/**
 * Instrument engine tests. The string and piano engines are pure-DSP sample
 * renderers (no Web Audio nodes), so the tests call the exact shipping code
 * and measure pitch/loudness directly.
 *
 * KEY guarantees: the Karplus-Strong string and the additive piano both play
 * IN TUNE across the range, decay like real instruments, and every preset is
 * well-formed.
 */

import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_PRESETS,
  midiToFreq,
  renderPianoSamples,
  renderStringSamples,
} from './instruments';

const SR = 44100;

/** Autocorrelation pitch detector — returns Hz. */
function detectPitch(x: Float32Array, minF = 40, maxF = 2000): number {
  // Analyse a stable window past the attack.
  const start = Math.floor(0.05 * SR);
  const win = x.subarray(start, start + Math.floor(0.2 * SR));
  const minLag = Math.floor(SR / maxF);
  const maxLag = Math.floor(SR / minF);
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < win.length; i++) s += win[i]! * win[i + lag]!;
    if (s > best) { best = s; bestLag = lag; }
  }
  return SR / bestLag;
}

function centsOff(measured: number, target: number): number {
  return 1200 * Math.log2(measured / target);
}

function rms(a: Float32Array, s: number, e: number): number {
  let sum = 0;
  for (let i = s; i < e; i++) sum += a[i]! * a[i]!;
  return Math.sqrt(sum / (e - s));
}

describe('instrument engine', () => {
  it('Karplus-Strong string plays in tune across the range', () => {
    for (const midi of [40, 52, 60, 67, 76]) {
      const f = midiToFreq(midi);
      const sig = renderStringSamples(SR, f, 0.45, 0.99);
      const detected = detectPitch(sig);
      const cents = Math.abs(centsOff(detected, f));
      expect(cents).toBeLessThan(15); // within ~15 cents = musically in tune
    }
  });

  it('string signal actually rings (non-silent, and decays)', () => {
    const sig = renderStringSamples(SR, midiToFreq(52), 0.45, 0.99);
    const early = rms(sig, Math.floor(0.02 * SR), Math.floor(0.08 * SR));
    const late = rms(sig, Math.floor(0.5 * SR), Math.floor(0.6 * SR));
    expect(early).toBeGreaterThan(0.02); // makes sound
    expect(late).toBeLessThan(early); // and decays like a real string
  });

  it('soft plucks are darker than hard picks (velocity → spectrum)', () => {
    const f = midiToFreq(52);
    // High-frequency energy proxy: RMS of the first difference (∝ HF content).
    const hf = (sig: Float32Array) => {
      const n = Math.floor(0.15 * SR);
      let sum = 0;
      for (let i = Math.floor(0.01 * SR); i < n; i++) {
        const d = sig[i]! - sig[i - 1]!;
        sum += d * d;
      }
      return Math.sqrt(sum / n);
    };
    const soft = hf(renderStringSamples(SR, f, 0.45, 0.99, 0.15));
    const hard = hf(renderStringSamples(SR, f, 0.45, 0.99, 1));
    expect(hard).toBeGreaterThan(soft * 1.15);
  });

  it('piano engine plays in tune across the range', () => {
    for (const midi of [36, 48, 60, 72, 84]) {
      const f = midiToFreq(midi);
      const sig = renderPianoSamples(SR, f, 0.9);
      const detected = detectPitch(sig, 40, 2200);
      // Inharmonicity pushes partials sharp, but the FUNDAMENTAL must land on
      // the note.
      const cents = Math.abs(centsOff(detected, f));
      expect(cents).toBeLessThan(15);
    }
  });

  it('piano note decays like a struck string (no organ-style sustain)', () => {
    const sig = renderPianoSamples(SR, midiToFreq(60), 0.9);
    const early = rms(sig, Math.floor(0.03 * SR), Math.floor(0.15 * SR));
    const late = rms(sig, Math.floor(1.6 * SR), Math.min(sig.length, Math.floor(1.8 * SR)));
    expect(early).toBeGreaterThan(0.02);
    expect(late).toBeLessThan(early * 0.6);
  });

  it('every preset is well-formed (engine + gain + envelope sane)', () => {
    const ids = new Set<string>();
    for (const p of INSTRUMENT_PRESETS) {
      expect(ids.has(p.id)).toBe(false); // unique ids
      ids.add(p.id);
      expect(p.gain).toBeGreaterThan(0);
      expect(p.attack).toBeGreaterThanOrEqual(0);
      expect(p.release).toBeGreaterThan(0);
      const reverb = p.reverb ?? 0;
      expect(reverb).toBeGreaterThanOrEqual(0);
      expect(reverb).toBeLessThanOrEqual(1);
      const engine = p.engine ?? 'subtractive';
      if (engine === 'string') {
        expect(p.stringDecay!).toBeGreaterThan(0.8);
        expect(p.stringDecay!).toBeLessThan(1);
      }
      if (engine === 'fm') {
        expect(p.fmRatio!).toBeGreaterThan(0);
        expect(p.fmIndex!).toBeGreaterThan(0);
      }
      if (engine === 'subtractive') {
        expect(p.oscs.some((o) => o.level > 0)).toBe(true);
      }
      if (engine === 'sampled') {
        expect(typeof p.sampleId).toBe('string');
        expect(p.sampleId!.length).toBeGreaterThan(0);
      }
    }
    // We shipped the realistic set (and the modelled piano).
    for (const name of ['Acoustic Guitar', 'Electric Guitar', 'Bass Guitar', 'Harp', 'Rhodes E-Piano', 'Tubular Bells']) {
      expect(INSTRUMENT_PRESETS.some((p) => p.name === name)).toBe(true);
    }
    expect(INSTRUMENT_PRESETS.find((p) => p.name === 'Grand Piano')?.engine).toBe('piano');
  });
});
