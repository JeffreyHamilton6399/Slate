/**
 * Voice capture worklet — batches mic samples into fixed-size frames and
 * posts them to the main thread. Served as a static file because the CSP
 * (script-src 'self') forbids blob: worklet modules.
 */
class SlateCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.total = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.chunks.push(new Float32Array(ch));
      this.total += ch.length;
      if (this.total >= 2048) {
        const out = new Float32Array(this.total);
        let o = 0;
        for (const c of this.chunks) {
          out.set(c, o);
          o += c.length;
        }
        this.chunks = [];
        this.total = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('slate-capture', SlateCapture);
