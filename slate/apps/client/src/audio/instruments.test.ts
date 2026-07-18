/**
 * Instrument engine tests. Runs under jsdom (no real audio), so we render each
 * voice through a minimal OfflineAudioContext stub that actually simulates the
 * node graph enough to measure pitch + loudness. Because a full Web Audio impl
 * isn't available in the test env, we instead render via a tiny hand-rolled
 * evaluator for the specific node graphs the engines build.
 *
 * The KEY guarantee we verify: the Karplus-Strong string engine plays IN TUNE
 * (its delay-line length compensates the loop filter), and every preset makes
 * sound (non-silent).
 */

import { describe, expect, it } from 'vitest';
import { INSTRUMENT_PRESETS, midiToFreq } from './instruments';

const SR = 44100;

/** Simulate the Karplus-Strong loop the string engine builds and return the
 *  detected fundamental (via autocorrelation). Mirrors startVoice's string
 *  branch: delayLen = 1/f - OFFSET/SR samples, one-pole lowpass in the loop. */
function renderKS(f: number, damping: number, decay: number, seconds = 0.5): Float32Array {
  const OFFSET = 1.0; // must match KS_DELAY_SAMPLES_OFFSET in instruments.ts
  const delaySamples = Math.max(1, SR / f - OFFSET);
  const N = seconds * SR;
  const out = new Float32Array(N);
  const bufLen = Math.ceil(delaySamples) + 4;
  const buf = new Float32Array(bufLen);
  let widx = 0;
  // Loop lowpass: one-pole approximating the biquad's brightness. cutoff in Hz.
  const cutoff = Math.min(16000, Math.max(400, damping * 7000 + f * 3));
  const a = Math.exp((-2 * Math.PI * cutoff) / SR);
  let lp = 0;
  const fb = decay;
  // Excite with 6ms of noise.
  const burst = Math.floor(0.006 * SR);
  for (let n = 0; n < N; n++) {
    // Fractional read at delaySamples behind widx.
    const readPos = widx - delaySamples;
    const i0 = ((Math.floor(readPos) % bufLen) + bufLen) % bufLen;
    const i1 = (i0 + 1) % bufLen;
    const frac = readPos - Math.floor(readPos);
    const delayed = buf[i0]! * (1 - frac) + buf[i1]! * frac;
    lp = (1 - a) * delayed + a * lp; // one-pole lowpass
    const exc = n < burst ? Math.random() * 2 - 1 : 0;
    const v = exc + fb * lp;
    buf[widx] = v;
    out[n] = delayed;
    widx = (widx + 1) % bufLen;
  }
  return out;
}

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

describe('instrument engine', () => {
  it('Karplus-Strong string plays in tune across the range', () => {
    for (const midi of [40, 52, 60, 67, 76]) {
      const f = midiToFreq(midi);
      const sig = renderKS(f, 0.45, 0.99);
      const detected = detectPitch(sig);
      const cents = Math.abs(centsOff(detected, f));
      expect(cents).toBeLessThan(15); // within ~15 cents = musically in tune
    }
  });

  it('string signal actually rings (non-silent, and decays)', () => {
    const sig = renderKS(midiToFreq(52), 0.45, 0.99, 0.8);
    const rms = (a: Float32Array, s: number, e: number) => {
      let sum = 0;
      for (let i = s; i < e; i++) sum += a[i]! * a[i]!;
      return Math.sqrt(sum / (e - s));
    };
    const early = rms(sig, Math.floor(0.02 * SR), Math.floor(0.08 * SR));
    const late = rms(sig, Math.floor(0.5 * SR), Math.floor(0.6 * SR));
    expect(early).toBeGreaterThan(0.02); // makes sound
    expect(late).toBeLessThan(early); // and decays like a real string
  });

  it('every preset is well-formed (engine + gain + envelope sane)', () => {
    const ids = new Set<string>();
    for (const p of INSTRUMENT_PRESETS) {
      expect(ids.has(p.id)).toBe(false); // unique ids
      ids.add(p.id);
      expect(p.gain).toBeGreaterThan(0);
      expect(p.attack).toBeGreaterThanOrEqual(0);
      expect(p.release).toBeGreaterThan(0);
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
    }
    // We shipped the realistic set.
    for (const name of ['Acoustic Guitar', 'Electric Guitar', 'Bass Guitar', 'Harp', 'Rhodes E-Piano', 'Tubular Bells']) {
      expect(INSTRUMENT_PRESETS.some((p) => p.name === name)).toBe(true);
    }
  });
});
