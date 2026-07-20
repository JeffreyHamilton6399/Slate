/**
 * Sustain-loop baking tests — pure DSP, no Web Audio needed. The guarantee:
 * after bakeSustainLoop, jumping playback from loopEnd back to loopStart is
 * click-free (the boundary discontinuity is no bigger than the signal's own
 * per-sample motion).
 */

import { describe, expect, it } from 'vitest';
import { bakeSustainLoop } from './gmSamples';

const SR = 44100;

describe('bakeSustainLoop', () => {
  it('returns loop points inside the sample with a usable region', () => {
    const data = new Float32Array(3 * SR);
    const { loopStart, loopEnd } = bakeSustainLoop(data, SR);
    expect(loopStart).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(loopStart + 0.3);
    expect(loopEnd).toBeLessThan(3);
  });

  it('makes the loop boundary click-free on a non-loop-aligned tone', () => {
    // 220.7 Hz deliberately does NOT complete an integer number of cycles over
    // the loop length, so an unbaked loop would jump hard at the boundary.
    const n = 3 * SR;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * 220.7 * i) / SR);

    // Unbaked discontinuity (reference): |s[end-1] -> s[start]| step.
    const probe = bakeSustainLoop(data.slice(), SR); // on a copy, to get points
    const endIdx = Math.round(probe.loopEnd * SR);
    const startIdx = Math.round(probe.loopStart * SR);
    const naturalStep = (2 * Math.PI * 220.7) / SR; // max per-sample slope
    const rawJump = Math.abs(data[startIdx]! - data[endIdx - 1]!);

    bakeSustainLoop(data, SR);
    const bakedJump = Math.abs(data[startIdx]! - data[endIdx - 1]!);
    expect(bakedJump).toBeLessThan(naturalStep * 2); // as smooth as the tone itself
    // And the bake genuinely improved the boundary for this tone.
    expect(bakedJump).toBeLessThan(rawJump);
  });
});
