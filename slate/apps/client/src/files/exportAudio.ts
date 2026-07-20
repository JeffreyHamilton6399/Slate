/**
 * Audio mode exports.
 *
 *   WAV  → offline mixdown (OfflineAudioContext renders every clip as it
 *          would play live, then the rendered AudioBuffer is encoded as
 *          16-bit PCM WAV). Fast — not realtime — and bit-exact.
 *   MP3  → same offline mixdown, then encoded with lamejs (pure-JS MP3
 *          encoder). 192 kbps stereo. Plays anywhere MP3 is supported
 *          (which is everywhere). Much smaller than WAV for sharing.
 *
 * The offline graph mirrors the live AudioEngine node-for-node so the file
 * sounds like playback: per-clip gain/fades/pan/HP-LP filters/speed/pitch
 * (speed is a pitch-preserving stretch, pitch a duration-preserving shift —
 * same worklet as live playback), and per-track volume/pan/3-band EQ +
 * reverb/delay sends into a shared FX bus, with mute/solo resolved up front.
 * MIDI clips are not rendered (they have no PCM samples) — audio clips only.
 */

import { Mp3Encoder } from 'lamejs';
import type { SlateDoc } from '../sync/doc';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import { readAudioClip, readAudioTrack } from '../audio/scene';
import { loadSamples } from '../audio/sampleStore';
import { createPitchShifter, ensurePitchWorklet, PITCH_SHIFT_LATENCY } from '../audio/pitchShift';

interface ClipToSchedule {
  clip: AudioClip;
  track: AudioTrack;
  samples: Float32Array;
}

/** Read every audible clip + its track off the Yjs doc and load the PCM
 *  samples for each (samples live in IndexedDB, not Yjs). */
async function collectClips(slate: SlateDoc): Promise<ClipToSchedule[]> {
  const tracks: AudioTrack[] = [];
  slate.audioTracks().forEach((m, id) => {
    const t = readAudioTrack(m, id);
    if (t) tracks.push(t);
  });

  const hasSolo = tracks.some((t) => t.solo);
  const out: ClipToSchedule[] = [];
  const pending: Array<Promise<void>> = [];

  slate.audioClips().forEach((m, id) => {
    const clip = readAudioClip(m, id);
    if (!clip || clip.mute) return;
    const track = tracks.find((t) => t.id === clip.trackId);
    if (!track || track.muted) return;
    // Solo logic: if any track is soloed, only soloed tracks pass through.
    if (hasSolo && !track.solo) return;
    pending.push(
      loadSamples(clip.sampleKey).then((samples) => {
        if (samples.length === 0) return; // samples still syncing — skip
        out.push({ clip, track, samples });
      }),
    );
  });
  await Promise.all(pending);
  return out;
}

/** White-noise impulse response for the export reverb — same recipe as the
 *  live engine's makeReverbIR (2.2s, decay 3) so the send sounds identical. */
function makeReverbIR(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return ir;
}

/** Schedule every clip onto the offline context, mirroring the live engine's
 *  graph: per-clip chain (source [→ pitch shifter] → gain w/ fades → panner
 *  [→ HP][→ LP]) into a per-track chain (gain → EQ low/mid/high → panner →
 *  destination, with post-EQ reverb/delay sends into a shared FX bus). */
async function scheduleClips(ctx: BaseAudioContext, clips: ClipToSchedule[], destination: AudioNode, bpm: number): Promise<void> {
  // Shared FX bus — one convolver + one tempo-synced feedback echo, matching
  // AudioEngine.ensureFxBus (dotted-eighth delay, 0.35 feedback).
  const fxReverb = ctx.createConvolver();
  fxReverb.buffer = makeReverbIR(ctx, 2.2, 3);
  fxReverb.connect(destination);
  const fxDelay = ctx.createDelay(1);
  fxDelay.delayTime.value = Math.min(1, 0.375 * (60 / Math.max(20, bpm)));
  const fxFeedback = ctx.createGain();
  fxFeedback.gain.value = 0.35;
  fxDelay.connect(fxFeedback);
  fxFeedback.connect(fxDelay);
  fxDelay.connect(destination);

  // Pitch/stretch worklet — only registered when some clip needs it. Same
  // module as live playback (OfflineAudioContext supports audioWorklet); if
  // unavailable, fall back to the coupled detune like the engine does.
  const needsShift = clips.some(({ clip }) => (clip.pitch ?? 0) !== 0 || (clip.speed != null && clip.speed > 0 && clip.speed !== 1));
  const shiftReady = needsShift ? await ensurePitchWorklet(ctx) : false;

  // One channel strip per distinct track.
  const trackInputs = new Map<string, AudioNode>();
  for (const { track } of clips) {
    if (trackInputs.has(track.id)) continue;
    const gain = ctx.createGain();
    gain.gain.value = track.volume;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;
    low.gain.value = track.eqLow ?? 0;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.9;
    mid.gain.value = track.eqMid ?? 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;
    high.gain.value = track.eqHigh ?? 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));
    gain.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(panner);
    panner.connect(destination);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = track.reverbSend ?? 0;
    high.connect(reverbSend);
    reverbSend.connect(fxReverb);
    const delaySend = ctx.createGain();
    delaySend.gain.value = track.delaySend ?? 0;
    high.connect(delaySend);
    delaySend.connect(fxDelay);
    trackInputs.set(track.id, gain);
  }

  for (const { clip, track, samples } of clips) {
    const ch = Math.max(1, clip.channels);
    const frames = Math.floor(samples.length / ch);
    if (frames <= 0) continue;

    const buffer = ctx.createBuffer(ch, frames, clip.sampleRate);
    for (let c = 0; c < ch; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        data[i] = samples[i * ch + c] ?? 0;
      }
    }

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const pitchCents = clip.pitch ?? 0;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    // Decoupled speed/pitch — see AudioEngine.play for the rationale.
    const shiftRatio = Math.pow(2, pitchCents / 1200) / speed;
    let clipHead: AudioNode = source;
    let shifted = false;
    if (shiftReady && Math.abs(shiftRatio - 1) > 0.0005) {
      const shifter = createPitchShifter(ctx, shiftRatio);
      source.connect(shifter);
      clipHead = shifter;
      shifted = true;
    } else if (!shiftReady && pitchCents !== 0) {
      source.detune.value = pitchCents;
    }

    const clipVol = clip.gain ?? 1;
    const clipGain = ctx.createGain();
    const clipPan = ctx.createStereoPanner();
    clipPan.pan.value = Math.max(-1, Math.min(1, clip.pan ?? 0));
    clipHead.connect(clipGain);
    clipGain.connect(clipPan);
    let clipTail: AudioNode = clipPan;
    const hp = clip.hpCutoff ?? 20;
    if (hp > 22) {
      const hpf = ctx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = hp;
      clipTail.connect(hpf);
      clipTail = hpf;
    }
    const lp = clip.lpCutoff ?? 20000;
    if (lp < 19500) {
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = lp;
      clipTail.connect(lpf);
      clipTail = lpf;
    }
    clipTail.connect(trackInputs.get(track.id)!);

    // Fades in timeline time, base level = clip gain (matches the engine).
    clipGain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : clipVol, clip.start);
    if (clip.fadeIn > 0) {
      clipGain.gain.linearRampToValueAtTime(clipVol, clip.start + clip.fadeIn);
    }
    if (clip.fadeOut > 0) {
      clipGain.gain.setValueAtTime(clipVol, clip.start + clip.duration - clip.fadeOut);
      clipGain.gain.linearRampToValueAtTime(0, clip.start + clip.duration);
    }

    // source.start(when, offset, duration): `offset`/`duration` are in BUFFER
    // seconds — playbackRate=speed consumes duration×speed buffer-seconds to
    // fill clip.duration timeline-seconds. Shifted sources start early by the
    // worklet's ~45ms group delay so they land on the grid (same latency
    // compensation as live playback).
    const when = shifted ? Math.max(0, clip.start - PITCH_SHIFT_LATENCY) : clip.start;
    source.start(when, clip.offset ?? 0, clip.duration * speed);
  }
}

/** Encode an AudioBuffer as a 16-bit PCM WAV ArrayBuffer (44-byte header +
 *  interleaved samples). Standard format — opens in Audacity / Premiere /
 *  anything. */
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * numChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels + clamp to int16.
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return arrayBuffer;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/** Render the mix offline and download as a WAV file. Fast (not realtime). */
export async function exportAudioWav(opts: {
  slate: SlateDoc;
  duration: number;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const sampleRate = 44100;
  const length = Math.max(1, Math.ceil(opts.duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const clips = await collectClips(opts.slate);
  await scheduleClips(ctx, clips, ctx.destination, opts.slate.audioBpm());
  opts.onProgress?.(0.15);
  const rendered = await ctx.startRendering();
  opts.onProgress?.(0.9);
  const wav = audioBufferToWav(rendered);
  downloadBlob(new Blob([wav], { type: 'audio/wav' }), 'slate-mix.wav');
  opts.onProgress?.(1);
}

/** Encode an AudioBuffer as an MP3 ArrayBuffer using lamejs (pure-JS MP3
 *  encoder). 192 kbps stereo (or mono if the source is mono). lamejs
 *  consumes 1152-sample blocks; we feed it consecutive subarrays per channel
 *  and accumulate the resulting MP3 bytes. */
function encodeMp3(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const kbps = 192;
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);

  // Convert Float32 [-1, 1] per channel to Int16 PCM.
  const channels: Int16Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    const f32 = buffer.getChannelData(c);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i] ?? 0));
      i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    channels.push(i16);
  }

  // lamejs internally processes 1152-sample granules — feed it consecutive
  // blocks of that size. subarray() is a no-copy view, so this is cheap.
  const blockSize = 1152;
  const mp3Chunks: Uint8Array[] = [];
  const length = channels[0]!.length;
  for (let i = 0; i < length; i += blockSize) {
    const end = Math.min(i + blockSize, length);
    const left = channels[0]!.subarray(i, end);
    const chunk = numChannels === 2
      ? encoder.encodeBuffer(left, channels[1]!.subarray(i, end))
      : encoder.encodeBuffer(left);
    if (chunk.length > 0) mp3Chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Chunks.push(new Uint8Array(flushed.buffer, flushed.byteOffset, flushed.length));

  // Concatenate all MP3 chunks into one buffer.
  const total = mp3Chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of mp3Chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

/** Render the mix offline and download as an MP3 file (192 kbps). Fast (not
 *  realtime) — the encoder runs on the rendered AudioBuffer directly, no
 *  MediaRecorder capture pass needed. */
export async function exportAudioMp3(opts: {
  slate: SlateDoc;
  duration: number;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const sampleRate = 44100;
  const length = Math.max(1, Math.ceil(opts.duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const clips = await collectClips(opts.slate);
  await scheduleClips(ctx, clips, ctx.destination, opts.slate.audioBpm());
  opts.onProgress?.(0.15);
  const rendered = await ctx.startRendering();
  opts.onProgress?.(0.6);
  const mp3 = encodeMp3(rendered);
  opts.onProgress?.(0.95);
  downloadBlob(new Blob([mp3], { type: 'audio/mpeg' }), 'slate-mix.mp3');
  opts.onProgress?.(1);
}
