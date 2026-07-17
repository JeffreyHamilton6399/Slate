/**
 * Audio mode exports.
 *
 *   WAV  → offline mixdown (OfflineAudioContext renders every clip as it
 *          would play live, then the rendered AudioBuffer is encoded as
 *          16-bit PCM WAV). Fast — not realtime — and bit-exact.
 *   MP4  → "video of the timeline playback". Browsers can't encode MP4 from
 *          a raw AudioBuffer directly, so we play the offline-rendered mix
 *          through a MediaStreamAudioDestinationNode and capture it with
 *          MediaRecorder. MP4/AAC is preferred (plays everywhere); browsers
 *          without MP4 encoding (Firefox) fall back to WebM/Opus.
 *
 * Both functions honour per-track volume/pan/mute/solo and per-clip
 * gain/pan/mute/speed. EQ, sends, fades, HP/LP filters and pitch shift are
 * omitted — a deliberate MVP for a "share my mix" export.
 */

import type { SlateDoc } from '../sync/doc';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import { readAudioClip, readAudioTrack } from '../audio/scene';
import { loadSamples } from '../audio/sampleStore';

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

/** Schedule every clip onto an AudioContext at its timeline position, with
 *  per-clip gain/pan/speed applied on top of the track volume/pan. */
function scheduleClips(ctx: BaseAudioContext, clips: ClipToSchedule[], destination: AudioNode): void {
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

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clip.speed ?? 1;

    const gain = ctx.createGain();
    gain.gain.value = (clip.gain ?? 1) * track.volume;

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, (clip.pan ?? 0) + (track.pan ?? 0)));

    source.connect(gain).connect(panner).connect(destination);
    // source.start(when, offset, duration): `when` is the timeline position,
    // `offset` is the left-trim into the source (seconds), `duration` is the
    // played-out length (seconds). playbackRate stretches the source
    // consumption but `duration` stays in playhead time.
    source.start(clip.start, clip.offset ?? 0, clip.duration);
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
  scheduleClips(ctx, clips, ctx.destination);
  opts.onProgress?.(0.15);
  const rendered = await ctx.startRendering();
  opts.onProgress?.(0.9);
  const wav = audioBufferToWav(rendered);
  downloadBlob(new Blob([wav], { type: 'audio/wav' }), 'slate-mix.wav');
  opts.onProgress?.(1);
}

/** Capture the mix as a media file (MP4/AAC if supported, else WebM/Opus) by
 *  playing the offline-rendered mix through a MediaStreamAudioDestinationNode
 *  and recording it with MediaRecorder. Realtime — captures exactly what
 *  would play through the speakers. */
export async function exportAudioMp4(opts: {
  slate: SlateDoc;
  duration: number;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser can’t record audio.');
  }
  const sampleRate = 44100;
  const length = Math.max(1, Math.ceil(opts.duration * sampleRate));
  const offline = new OfflineAudioContext(2, length, sampleRate);
  const clips = await collectClips(opts.slate);
  scheduleClips(offline, clips, offline.destination);
  opts.onProgress?.(0.2);
  const rendered = await offline.startRendering();
  opts.onProgress?.(0.4);

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate });
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = rendered;
  src.connect(dest);
  // Also send to the speakers so the user hears the playback while it
  // captures — feels like a normal "bounce" pass.
  src.connect(ctx.destination);

  const mime = [
    'video/mp4;codecs=mp4a.40.2',
    'video/mp4',
    'audio/mp4',
    'video/webm;codecs=opus',
    'audio/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('No supported audio MIME type for MediaRecorder.');
  const isMp4 = mime.startsWith('video/mp4') || mime.startsWith('audio/mp4');
  const ext = isMp4 ? 'mp4' : 'webm';

  const recorder = new MediaRecorder(dest.stream, {
    mimeType: mime,
    audioBitsPerSecond: 192_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: isMp4 ? 'audio/mp4' : 'audio/webm' });
      downloadBlob(blob, `slate-mix.${ext}`);
      resolve();
    };
  });

  await ctx.resume();
  recorder.start();
  src.start();
  const start = performance.now();
  const totalMs = opts.duration * 1000;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - start;
      opts.onProgress?.(0.4 + 0.6 * Math.min(1, elapsed / totalMs));
      if (elapsed >= totalMs) {
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
  recorder.stop();
  try {
    src.stop();
  } catch {
    // source may have already finished — ignore
  }
  await done;
  await ctx.close();
  opts.onProgress?.(1);
}
