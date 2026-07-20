/**
 * Real-time pitch shifter — an AudioWorklet implementing the classic
 * dual-tap granular (delay-line) algorithm used by web DAWs: two read heads
 * scan a ring buffer at `ratio` × the write rate, each windowed by a raised
 * cosine and offset half a grain apart so one head is always at full gain
 * while the other wraps. Frequency is scaled by `ratio` while duration is
 * untouched — the missing half of Web Audio's coupled playbackRate/detune.
 *
 * Combined with an AudioBufferSourceNode's playbackRate this decouples the
 * two clip knobs like a real editor (Audition's Stretch & Pitch, Premiere's
 * "maintain pitch"):
 *
 *   playbackRate = speed                       // timeline duration
 *   shifter ratio = 2^(cents/1200) / speed     // final pitch
 *
 * → Speed changes duration but keeps pitch; Pitch shifts semitones but keeps
 * duration. ratio === 1 (speed 1, pitch 0) should bypass the shifter
 * entirely — callers only insert the node when it does real work.
 *
 * The module is registered from a Blob URL (no build-config changes, works
 * on both AudioContext and OfflineAudioContext, so live playback and WAV/MP3
 * export share the exact same DSP). Falls back gracefully: ensurePitchWorklet
 * resolves false where audioWorklet is unavailable and callers revert to the
 * old coupled `detune` behaviour.
 */

/** Average group delay of the shifter in seconds (half the 90ms grain).
 *  Callers start sources this much early when possible so shifted clips stay
 *  aligned with unshifted ones (poor-man's latency compensation). */
export const PITCH_SHIFT_LATENCY = 0.045;

/** AudioWorkletProcessor source, registered under this name. Kept as a
 *  string → Blob URL so no bundler/worklet plumbing is needed. */
const PROCESSOR_NAME = 'slate-pitch-shift';

const PROCESSOR_SRC = `
class SlatePitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.06, maxValue: 16, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    // ~90ms grain: good compromise between low-frequency fidelity (long
    // grains) and latency/echo artifacts (short grains).
    this.grain = Math.max(256, Math.round(sampleRate * 0.09));
    let len = 1;
    while (len < this.grain * 2 + 4) len <<= 1;
    this.len = len;
    this.mask = len - 1;
    this.rings = [];
    this.write = 0;
    this.phase = 0;
    // Lifecycle: an AudioWorkletNode whose process() returns true is never
    // garbage-collected. The engine posts any message when the owning source
    // ends; we ring out a short tail (the buffered grains) and then return
    // false so the node can die. -1 = running, >0 = tail countdown (samples).
    this.tail = -1;
    this.port.onmessage = () => {
      if (this.tail < 0) this.tail = Math.round(sampleRate * 0.25);
    };
  }
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return this.tail !== 0;
    const input = inputs[0] && inputs[0].length > 0 ? inputs[0] : null;
    const ratio = Math.max(0.06, parameters.ratio[0]);
    const frames = output[0].length;
    const ch = output.length;
    while (this.rings.length < ch) this.rings.push(new Float32Array(this.len));
    const grain = this.grain, mask = this.mask, TAU = 2 * Math.PI;
    // Read heads advance at ratio × write rate → delay drifts by (1 - ratio)
    // per sample; normalised phase wraps every grain.
    const inc = (1 - ratio) / grain;
    for (let i = 0; i < frames; i++) {
      const w = this.write;
      for (let c = 0; c < ch; c++) {
        const src = input ? (input[c] || input[0]) : null;
        this.rings[c][w] = src ? (src[i] || 0) : 0;
      }
      let p = this.phase + inc;
      p -= Math.floor(p); // wraps both directions (floor of negatives)
      this.phase = p;
      const p2 = (p + 0.5) % 1;
      const d1 = p * grain;
      const d2 = p2 * grain;
      // Raised-cosine windows: each tap is at zero gain exactly when its
      // delay wraps, so the discontinuity is inaudible.
      const w1 = 0.5 - 0.5 * Math.cos(TAU * p);
      const w2 = 0.5 - 0.5 * Math.cos(TAU * p2);
      for (let c = 0; c < ch; c++) {
        const ring = this.rings[c];
        let pos = w - d1;
        let i0 = Math.floor(pos);
        let fr = pos - i0;
        const a0 = ring[i0 & mask];
        const tap1 = a0 + (ring[(i0 + 1) & mask] - a0) * fr;
        pos = w - d2;
        i0 = Math.floor(pos);
        fr = pos - i0;
        const b0 = ring[i0 & mask];
        const tap2 = b0 + (ring[(i0 + 1) & mask] - b0) * fr;
        output[c][i] = w1 * tap1 + w2 * tap2;
      }
      this.write = (w + 1) & mask;
    }
    if (this.tail > 0) this.tail = Math.max(0, this.tail - frames);
    return this.tail !== 0;
  }
}
registerProcessor('${PROCESSOR_NAME}', SlatePitchShift);
`;

/** One addModule per context (worklet modules are per-context). WeakMap so a
 *  closed/collected context doesn't pin the promise. */
const moduleReady = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Register the pitch-shift processor on a context (live or offline).
 *  Resolves true when createPitchShifter may be called, false when
 *  AudioWorklet is unavailable or registration failed (caller should fall
 *  back to coupled detune). Memoized per context; safe to call repeatedly. */
export function ensurePitchWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let ready = moduleReady.get(ctx);
  if (!ready) {
    ready = (async () => {
      if (!('audioWorklet' in ctx) || !ctx.audioWorklet) return false;
      const url = URL.createObjectURL(new Blob([PROCESSOR_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[slate-audio] pitch-shift worklet unavailable, falling back to coupled detune', err);
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    moduleReady.set(ctx, ready);
  }
  return ready;
}

/** Create a shifter node with a fixed frequency ratio (1 = unity — but don't
 *  create one for unity; bypass instead). ensurePitchWorklet(ctx) must have
 *  resolved true for this context first. */
export function createPitchShifter(ctx: BaseAudioContext, ratio: number): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
  const param = node.parameters.get('ratio');
  if (param) param.value = Math.max(0.06, Math.min(16, ratio));
  return node;
}

/** Tell a shifter its source has ended: it rings out its buffered tail
 *  (~250ms) and then stops processing so the node can be GC'd. Idempotent. */
export function releasePitchShifter(node: AudioWorkletNode): void {
  try {
    node.port.postMessage('release');
  } catch {
    /* port already closed */
  }
}
