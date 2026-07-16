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
  /** Clip ids currently in a getBuffer retry loop. Prevents multiple concurrent
   *  retry loops for the same clip when several play()/restartPlayback() calls
   *  race (e.g. a remote clip arriving while the user is scrubbing). */
  private retryingClips = new Set<string>();
  /** Active track gain nodes (for live volume/pan changes). */
  private trackGains = new Map<string, GainNode>();
  private trackPanners = new Map<string, StereoPannerNode>();
  /** Per-track effect nodes (reverb/delay/EQ) — inserted between gain and panner. */
  private trackEffects = new Map<string, { reverb: ConvolverNode; delay: DelayNode; eq: BiquadFilterNode }>();
  /** Master volume (0..1). */
  private masterVolume = 0.9;
  /** Loop region (null = no loop). */
  private loopRegion: { start: number; end: number } | null = null;
  /** Timer that restarts playback at the loop-region end so the AUDIO wraps
   *  with the playhead (getPosition only wraps the display). */
  private loopTimer: number | null = null;

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

  /** Get or create an AudioBuffer for a clip — loads samples from IndexedDB.
   *  If the samples haven't arrived yet (empty Float32Array, which happens when
   *  a remote peer's sample-blob is still in flight via the Yjs sync map),
   *  retries up to 10 times at 300ms intervals (3s total) before giving up and
   *  returning null. The clip is then skipped on this play() pass, but the
   *  AudioEditor's restart-on-sample-arrival will re-schedule it once the
   *  samples land and the cache is populated. */
  private async getBuffer(clip: AudioClip): Promise<AudioBuffer | null> {
    const ctx = this.ctx!;
    const cached = this.bufferCache.get(clip.id);
    if (cached) return cached;

    // If a retry loop is already running for this clip, bail — another
    // play()/restartPlayback() call will pick up the cached buffer once it
    // lands (the AudioEditor restarts on `slate:audio-clip-changed`).
    if (this.retryingClips.has(clip.id)) return null;

    const buildBuffer = async (): Promise<AudioBuffer | null> => {
      const samples = await loadSamples(clip.sampleKey);
      const channels = clip.channels;
      const length = samples.length / channels;
      if (length === 0) return null;
      const buf = ctx.createBuffer(channels, length, clip.sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          data[i] = samples[i * channels + ch] ?? 0;
        }
      }
      return buf;
    };

    // Fast path — samples already present (the overwhelmingly common case).
    let buf = await buildBuffer();
    if (buf) {
      this.bufferCache.set(clip.id, buf);
      return buf;
    }

    // Samples not yet arrived — retry for up to 3s (10 × 300ms). This covers
    // the gap between a remote clip's metadata landing in Yjs and its sample
    // blob landing in the sync map + being written to local IndexedDB.
    this.retryingClips.add(clip.id);
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        buf = await buildBuffer();
        if (buf) {
          this.bufferCache.set(clip.id, buf);
          return buf;
        }
      }
    } finally {
      this.retryingClips.delete(clip.id);
    }
    return null;
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
    if (this.loopTimer !== null) { clearTimeout(this.loopTimer); this.loopTimer = null; }
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

    // Preload EVERY buffer before scheduling anything. Awaiting each buffer
    // inside the scheduling loop anchored each clip to a drifting
    // ctx.currentTime — a clip whose decode (or sample-arrival retry) took
    // 500ms started 500ms late relative to the playhead AND to clips scheduled
    // before it, so multi-track projects audibly fell out of sync.
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      clips.map(async (clip) => {
        if (clip.mute) return;
        const buffer = await this.getBuffer(clip);
        if (buffer) buffers.set(clip.id, buffer);
      }),
    );
    if (!this.playing) return; // stopped while buffers were loading

    // Re-anchor NOW that everything is ready: all clips schedule against one
    // shared clock read, so their relative timing is sample-accurate.
    this.startTime = ctx.currentTime;

    // Schedule each clip that starts after the playhead or is currently playing.
    for (const clip of clips) {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (!track) continue;
      if (clip.mute) continue; // clip muted individually
      const buffer = buffers.get(clip.id);
      if (!buffer) continue;

      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= offset) continue; // clip already finished

      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const pitchCents = clip.pitch ?? 0;
      const clipOffset = clip.offset ?? 0; // trim from the source (buffer seconds)
      const clipVol = clip.gain ?? 1;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;
      // Pitch shift (in cents) via the buffer source's `detune` AudioParam.
      // NOTE: Web Audio's AudioBufferSourceNode couples pitch and speed —
      // `detune` shifts pitch AND scales the effective playback rate
      // (effectiveRate = playbackRate * 2^(detune/1200)). True pitch-
      // independent-of-speed requires offline time-stretching, which is out
      // of scope here. The two knobs still give the user independent CONTROL:
      // to hold timeline speed constant while shifting pitch, set
      // speed = 1 / 2^(pitch/1200) to compensate.
      if (pitchCents !== 0) source.detune.value = pitchCents;

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
      const whenToStart = this.startTime + Math.max(0, clip.start - offset);
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

    // Loop region: getPosition() wraps the PLAYHEAD at the loop end, but the
    // scheduled sources would happily play straight through it — the display
    // looped while the audio didn't. Schedule a restart at the boundary so the
    // audio wraps with the playhead.
    if (this.loopRegion && this.loopRegion.end > this.loopRegion.start && offset < this.loopRegion.end) {
      const untilWrap = this.loopRegion.end - offset;
      this.loopTimer = window.setTimeout(() => {
        this.loopTimer = null;
        if (this.playing && this.loopRegion) this.restartPlayback(slate, this.loopRegion.start);
      }, untilWrap * 1000);
    }

    // Start metronome if enabled.
    if (this.metronomeOn) this.startMetronome();
  }

  /** Stop all playback. */
  stop(): void {
    this.playing = false;
    if (this.loopTimer !== null) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    for (const { source } of this.playingClips) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playingClips = [];
    this.stopMetronome();
  }

  /** Stop all current sources and immediately re-schedule all clips from
   *  `offset`, atomically — `playing` stays true throughout so getPosition()
   *  keeps tracking from the new startTime (no jump back to 0, no UI glitch).
   *  Used when the clip set changes mid-playback (a remote peer adds a clip,
   *  or a clip's samples arrive after play started) so the new clip is picked
   *  up without a full stop+play round-trip from the UI. There's a brief audio
   *  gap while buffers reload, but the playhead and `playing` state never
   *  flicker. If the AudioContext hasn't been created yet (no user gesture),
   *  falls back to a plain play() which creates it. */
  restartPlayback(slate: SlateDoc, offset: number): void {
    if (!this.ctx) {
      void this.play(slate, offset);
      return;
    }
    // Stop + forget current sources, but keep `playing` true so getPosition()
    // continues to track. play() will reset startTime/startOffset.
    for (const { source } of this.playingClips) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playingClips = [];
    this.stopMetronome();
    // Re-schedule. play() re-reads the doc (so new clips are included),
    // resets startTime/startOffset, and restarts the metronome if enabled.
    void this.play(slate, offset);
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

  /** Update live track settings (volume/pan/mute/solo) without restarting.
   *  Re-reads ALL tracks from Yjs and rebuilds the per-track gain/panner
   *  values via setupTrackNodes — use this when the track SET changed (add/
   *  delete) or mute/solo toggled (which rebalances every track's audibility).
   *  For a single track's volume/pan DRAG, prefer setTrackVolume / setTrackPan
   *  (O(1) direct node write, no Yjs read, no graph rebuild) to avoid lag. */
  updateTracks(slate: SlateDoc): void {
    if (!this.ctx) return;
    const tracks: AudioTrack[] = [];
    slate.audioTracks().forEach((m, id) => {
      const t = readAudioTrack(m, id);
      if (t) tracks.push(t);
    });
    this.setupTrackNodes(tracks);
  }

  /** Set a single track's volume DIRECTLY on its gain node — O(1), no Yjs
   *  read, no audio-graph rebuild. Used by the TrackHeader volume slider
   *  during a drag for immediate audio feedback; the Yjs commit happens on
   *  pointerup via updateAudioTrack. No-op if the AudioContext hasn't been
   *  created yet or the track's gain node doesn't exist (e.g. playback hasn't
   *  started — there's no audio to adjust anyway, and the next play() will
   *  read the committed Yjs value).
   *
   *  `audible` mirrors setupTrackNodes' mute/solo logic so dragging the
   *  volume slider on a muted (or non-soloed-while-another-track-is-soloed)
   *  track doesn't briefly un-mute it: if not audible, the gain is forced
   *  to 0 regardless of `volume`. The React side computes `audible` from
   *  the track's `muted`/`solo` props + the `hasSolo` flag. */
  setTrackVolume(trackId: string, volume: number, audible: boolean): void {
    if (!this.ctx) return;
    const gain = this.trackGains.get(trackId);
    if (!gain) return;
    gain.gain.value = audible ? volume : 0;
  }

  /** Set a single track's pan DIRECTLY on its StereoPannerNode — O(1), no
   *  Yjs read, no audio-graph rebuild. See setTrackVolume for the rationale.
   *  Pan is clamped to [-1, 1] (StereoPannerNode's legal range) — values
   *  outside that throw a NotSupportedError on assignment. */
  setTrackPan(trackId: string, pan: number): void {
    if (!this.ctx) return;
    const panner = this.trackPanners.get(trackId);
    if (!panner) return;
    panner.pan.value = Math.max(-1, Math.min(1, pan));
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
