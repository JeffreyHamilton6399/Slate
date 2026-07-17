/** Minimal ambient declaration for the `lamejs` MP3 encoder (no bundled types).
 *  Only the symbols we use are declared. lamejs is a CommonJS module that
 *  exports `Mp3Encoder` (and a few other helpers we don't use). */

declare module 'lamejs' {
  /** MP3 encoder — call `encodeBuffer(left, right?)` per PCM frame chunk,
   *  then `flush()` at the end to drain the internal reservoir. */
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    /** Encode a chunk of int16 samples. Returns the MP3 bytes for this chunk
     *  (may be empty when the encoder is still priming its reservoir). */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    /** Drain the encoder — returns the final MP3 bytes. */
    flush(): Int8Array;
  }
}
