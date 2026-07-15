/**
 * Audio playback engine — Web Audio API scheduler that plays clips on tracks
 * at the right time, with gain/pan/mute/solo per track and a metronome.
 *
 * The engine is a singleton per AudioEditor mount. It reads from the Yjs doc
 * (via the SlateRoom) so remote clip edits are reflected in playback.
 */

import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import type { SlateDoc } from '../sync/doc';
import { readAudioClip, readAudioTrack } from './scene';
import { loadSamples } from './sampleStore';

interface PlayingClip {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private playing = false;
  private recording = false;
  private startTime = 0;
  /** Playhead offset (seconds) — where playback started from. */
  private startOffset = 0;
  private playingClips: PlayingClip[] = [];
  private metronomeOn = false;
  private bpm = 120;
  private nextClickTime = 0;
  private clickTimer: number | null = null;
  /** Cached AudioBuffers per clip id (decoded from PCM samples). */
  private bufferCache = new Map<string, AudioBuffer>();
  /** Active track gain nodes (for live volume/pan changes). */
  private trackGains = new Map<string, GainNode>();
  private trackPanners = new Map<string, StereoPannerNode>();
  /** Per-track effect nodes (reverb/delay/EQ) — inserted between gain and panner. */
  private trackEffects = new Map<string, { reverb: ConvolverNode; delay: DelayNode; eq: BiquadFilterNode }>();
  /** Master volume (0..1). */
  private masterVolume = 0.9;
  /** Loop region (null = no loop). */
  private loopRegion: { start: number; end: number } | null = null;

  /** Ensure the AudioContext is created (must be after user gesture). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Get or create an AudioBuffer for a clip — loads samples from IndexedDB. */
  private async getBuffer(clip: AudioClip): Promise<AudioBuffer | null> {
    const ctx = this.ctx!;
    let buf = this.bufferCache.get(clip.id);
    if (buf) return buf;
    const samples = await loadSamples(clip.sampleKey);
    const channels = clip.channels;
    const length = samples.length / channels;
    if (length === 0) return null;
    buf = ctx.createBuffer(channels, length, clip.sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = samples[i * channels + ch] ?? 0;
      }
    }
    this.bufferCache.set(clip.id, buf);
    return buf;
  }

  /** Build per-track gain+panner chain for the current set of tracks. */
  private setupTrackNodes(tracks: AudioTrack[]): void {
    const ctx = this.ctx!;
    // Remove stale nodes.
    for (const [id] of this.trackGains) {
      if (!tracks.find((t) => t.id === id)) {
        this.trackGains.get(id)?.disconnect();
        this.trackPanners.get(id)?.disconnect();
        this.trackGains.delete(id);
        this.trackPanners.delete(id);
      }
    }
    // Create missing nodes.
    for (const track of tracks) {
      if (!this.trackGains.has(track.id)) {
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        gain.connect(panner);
        panner.connect(this.masterGain!);
        this.trackGains.set(track.id, gain);
        this.trackPanners.set(track.id, panner);
      }
      // Update values.
      const gain = this.trackGains.get(track.id)!;
      const panner = this.trackPanners.get(track.id)!;
      const anySolo = tracks.some((t) => t.solo);
      const audible = anySolo ? track.solo : !track.muted;
      gain.gain.value = audible ? track.volume : 0;
      panner.pan.value = track.pan;
    }
  }

  /** Play all clips that intersect the current playhead. */
  async play(slate: SlateDoc, offset: number): Promise<void> {
    const ctx = this.ensureContext();
    this.playing = true;
    this.startOffset = offset;
    this.startTime = ctx.currentTime;

    // Read tracks + clips from the doc.
    const tracks: AudioTrack[] = [];
    slate.audioTracks().forEach((m, id) => {
      const t = readAudioTrack(m, id);
      if (t) tracks.push(t);
    });
    this.setupTrackNodes(tracks);

    const clips: AudioClip[] = [];
    slate.audioClips().forEach((m, id) => {
      const c = readAudioClip(m, id);
      if (c) clips.push(c);
    });

    // Schedule each clip that starts after the playhead or is currently playing.
    for (const clip of clips) {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (!track) continue;
      if (clip.mute) continue; // clip muted individually
      const buffer = await this.getBuffer(clip);
      if (!buffer) continue;

      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= offset) continue; // clip already finished

      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const clipOffset = clip.offset ?? 0; // trim from the source (buffer seconds)
      const clipVol = clip.gain ?? 1;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;

      // Per-clip gain (fades + clip volume) → per-clip panner → track chain.
      const clipGain = ctx.createGain();
      const clipPan = ctx.createStereoPanner();
      clipPan.pan.value = Math.max(-1, Math.min(1, clip.pan ?? 0));
      source.connect(clipGain);
      clipGain.connect(clipPan);
      const trackGain = this.trackGains.get(track.id);
      if (trackGain) clipPan.connect(trackGain);
      else clipPan.connect(this.masterGain!);

      // How far the playhead is already into the clip (real seconds), and where
      // that lands in the source buffer (buffer seconds → scaled by speed).
      const skipTo = Math.max(0, offset - clip.start);
      const whenToStart = ctx.currentTime + Math.max(0, clip.start - offset);
      const playDuration = clip.duration - skipTo; // real seconds left on the timeline
      const bufStart = clipOffset + skipTo * speed;
      const bufDuration = playDuration * speed;

      source.start(whenToStart, bufStart, bufDuration);

      // Fades (real-time). Base level is the clip gain.
      clipGain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : clipVol, whenToStart);
      if (clip.fadeIn > 0) {
        clipGain.gain.linearRampToValueAtTime(clipVol, whenToStart + clip.fadeIn);
      }
      if (clip.fadeOut > 0) {
        clipGain.gain.setValueAtTime(clipVol, whenToStart + playDuration - clip.fadeOut);
        clipGain.gain.linearRampToValueAtTime(0, whenToStart + playDuration);
      }

      this.playingClips.push({ source, gain: clipGain, clipId: clip.id });
    }

    // Start metronome if enabled.
    if (this.metronomeOn) this.startMetronome();
  }

  /** Stop all playback. */
  stop(): void {
    this.playing = false;
    for (const { source } of this.playingClips) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playingClips = [];
    this.stopMetronome();
  }

  /** Get the current playhead position (seconds). Loops if a loop region is set. */
  getPosition(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    let pos = this.startOffset + (this.ctx.currentTime - this.startTime);
    if (this.loopRegion) {
      const loopLen = this.loopRegion.end - this.loopRegion.start;
      if (loopLen > 0 && pos >= this.loopRegion.end) {
        // Wrap around the loop region.
        pos = this.loopRegion.start + ((pos - this.loopRegion.start) % loopLen);
      }
    }
    return pos;
  }

  isPlaying(): boolean { return this.playing; }
  isRecording(): boolean { return this.recording; }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (on && this.playing) this.startMetronome();
    else this.stopMetronome();
  }

  setBpm(bpm: number): void { this.bpm = bpm; }

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    if (this.masterGain) this.masterGain.gain.value = v;
  }

  getMasterVolume(): number { return this.masterVolume; }

  setLoopRegion(start: number | null, end: number | null): void {
    if (start === null || end === null) {
      this.loopRegion = null;
    } else {
      this.loopRegion = { start, end };
    }
  }

  getLoopRegion(): { start: number; end: number } | null { return this.loopRegion; }

  /** Create a simple reverb impulse response for the ConvolverNode. */
  private makeReverbIR(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
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

  /** Update per-track effect settings. Each track can have reverb, delay, EQ. */
  updateTrackEffects(trackId: string, effects: { reverb?: number; delay?: number; eqFreq?: number }): void {
    if (!this.ctx) return;
    let nodes = this.trackEffects.get(trackId);
    if (!nodes) {
      const reverb = this.ctx.createConvolver();
      reverb.buffer = this.makeReverbIR(this.ctx, 2, 3);
      const delay = this.ctx.createDelay(1);
      delay.delayTime.value = 0.3;
      const eq = this.ctx.createBiquadFilter();
      eq.type = 'peaking';
      eq.frequency.value = 1000;
      eq.gain.value = 0;
      // Chain: gain → eq → reverb (parallel) → panner
      const gain = this.trackGains.get(trackId);
      const panner = this.trackPanners.get(trackId);
      if (gain && panner) {
        gain.disconnect();
        gain.connect(eq);
        eq.connect(panner);
        // Reverb as send/return
        const reverbGain = this.ctx.createGain();
        reverbGain.gain.value = 0;
        eq.connect(reverb);
        reverb.connect(reverbGain);
        reverbGain.connect(panner);
        // Delay as send/return
        const delayGain = this.ctx.createGain();
        delayGain.gain.value = 0;
        eq.connect(delay);
        delay.connect(delayGain);
        delayGain.connect(panner);
      }
      nodes = { reverb, delay, eq };
      this.trackEffects.set(trackId, nodes);
    }
    // Apply settings (reverb/delay are 0..1 wet, eq is frequency Hz)
    if (effects.reverb !== undefined) {
      // Adjust the reverb send gain (connected alongside the chain)
    }
    if (effects.delay !== undefined) {
      nodes.delay.delayTime.value = effects.delay * 0.5;
    }
    if (effects.eqFreq !== undefined) {
      nodes.eq.frequency.value = effects.eqFreq;
    }
  }

  private startMetronome(): void {
    if (!this.ctx) return;
    this.stopMetronome();
    const beatDur = 60 / this.bpm;
    this.nextClickTime = this.ctx.currentTime;
    const tick = () => {
      if (!this.ctx || !this.playing) return;
      if (this.nextClickTime < this.ctx.currentTime + 0.2) {
        this.click(this.nextClickTime);
        this.nextClickTime += beatDur;
      }
      this.clickTimer = window.setTimeout(tick, 25);
    };
    tick();
  }

  private stopMetronome(): void {
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
  }

  private click(time: number): void {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = 1000; // Click pitch
    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  /** Start recording from a microphone input. Returns a stop callback that
   *  resolves to the recorded PCM samples. */
  async startRecording(): Promise<() => Promise<{ samples: number[]; sampleRate: number; channels: number; duration: number }>> {
    const ctx = this.ensureContext();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: number[] = [];
    source.connect(processor);
    processor.connect(ctx.destination);
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) chunks.push(data[i]!);
    };
    this.recording = true;

    return async () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      this.recording = false;
      const duration = chunks.length / ctx.sampleRate;
      return { samples: chunks, sampleRate: ctx.sampleRate, channels: 1, duration };
    };
  }

  /** Update live track settings (volume/pan/mute/solo) without restarting. */
  updateTracks(slate: SlateDoc): void {
    if (!this.ctx) return;
    const tracks: AudioTrack[] = [];
    slate.audioTracks().forEach((m, id) => {
      const t = readAudioTrack(m, id);
      if (t) tracks.push(t);
    });
    this.setupTrackNodes(tracks);
  }

  /** Clear the buffer cache (e.g. when a clip's samples change). */
  clearCache(clipId?: string): void {
    if (clipId) this.bufferCache.delete(clipId);
    else this.bufferCache.clear();
  }

  dispose(): void {
    this.stop();
    this.trackGains.forEach((g) => g.disconnect());
    this.trackPanners.forEach((p) => p.disconnect());
    this.trackGains.clear();
    this.trackPanners.clear();
    this.bufferCache.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }
}
