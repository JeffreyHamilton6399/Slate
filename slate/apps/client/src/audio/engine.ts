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
import { toast } from '../ui/Toast';
import { INSTRUMENT_PRESETS, loadCustomInstruments, startVoice, type InstrumentParams } from './instruments';
import { SoundfontInstrument } from './soundfont';
import { createPitchShifter, ensurePitchWorklet, releasePitchShifter, PITCH_SHIFT_LATENCY } from './pitchShift';

interface PlayingClip {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
  /** Pitch-shift worklet node, present when speed ≠ 1 or pitch ≠ 0 —
   *  released (tail ring-out, then processor self-terminates) on stop. */
  shifter?: AudioWorkletNode;
}

/** A scheduled MIDI note voice — has a `stop(when)` method (like the
 *  instrument's VoiceHandle) so the engine can release all live voices when
 *  playback stops. The clipId is kept so restart/stop can find voices by
 *  their owning clip. */
interface PlayingMidiVoice {
  clipId: string;
  stop: (when: number) => void;
}

/** The synthetic instrument ID that selects the SoundfontInstrument (freepats
 *  acoustic grand piano). Any other instrumentId falls through to the
 *  oscillator-based LiveInstrument preset lookup. */
export const SOUNDFONT_PIANO_ID = 'soundfont-piano';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private playing = false;
  private recording = false;
  private startTime = 0;
  /** Playhead offset (seconds) — where playback started from. */
  private startOffset = 0;
  private playingClips: PlayingClip[] = [];
  /** Scheduled MIDI voices — released on stop()/restartPlayback. Kept separate
   *  from playingClips (which hold BufferSourceNodes) so stop() can iterate
   *  both without type-narrowing. */
  private playingMidiVoices: PlayingMidiVoice[] = [];
  /** One SoundfontInstrument per AudioContext — created lazily on first use
   *  (the freepats samples are fetched on-demand). Disposed with the engine. */
  private soundfont: SoundfontInstrument | null = null;
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
  /** Per-clip attempt counts for the getBuffer retry loop. Read + bumped inside
   *  the loop; reset to 0 by `slate:audio-clip-changed` events (sample arrival)
   *  so a clip whose samples took longer than the initial budget still gets
   *  more attempts instead of being silently dropped. */
  private retryAttempts = new Map<string, number>();
  /** One-time gesture listener that resumes a suspended AudioContext on the
   *  first pointerdown/keydown/touchstart. Held as a field so dispose() can
   *  remove it if the engine is torn down before any gesture fires. */
  private gestureHandler: (() => void) | null = null;
  /** Listener for `slate:audio-clip-changed` — resets a clip's retry budget
   *  when its samples land (fired by sampleStore's tryImportEntry on remote
   *  sample arrival, and by AudioEditor on local clip edits). Held as a field
   *  so dispose() can remove it. */
  private clipChangedHandler: ((e: Event) => void) | null = null;
  /** Active track gain nodes (for live volume/pan changes). */
  private trackGains = new Map<string, GainNode>();
  private trackPanners = new Map<string, StereoPannerNode>();
  /** Per-track 3-band channel EQ (low shelf 200 Hz / peak 1 kHz / high shelf
   *  4 kHz), inserted between the track gain and panner. */
  private trackEqs = new Map<string, { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode }>();
  /** Per-track send gains into the shared reverb/delay FX bus (post-EQ). */
  private trackSends = new Map<string, { reverb: GainNode; delay: GainNode }>();
  /** Shared FX bus — ONE convolver + ONE feedback delay for the whole mix;
   *  per-track send gains control how much each track feeds them. */
  private fxReverb: ConvolverNode | null = null;
  private fxDelay: DelayNode | null = null;
  private fxDelayFeedback: GainNode | null = null;
  /** Master volume (0..1). */
  private masterVolume = 0.9;
  /** Loop region (null = no loop). */
  private loopRegion: { start: number; end: number } | null = null;
  /** Timer that restarts playback at the loop-region end so the AUDIO wraps
   *  with the playhead (getPosition only wraps the display). */
  private loopTimer: number | null = null;

  constructor() {
    // Reset any in-flight retry loop's attempt counter when samples for that
    // clip arrive (or when the clip is otherwise mutated). Without this, a
    // remote peer whose sample blob arrives JUST after the 20×500ms budget
    // expired would never hear the clip until the next play() — the cache
    // miss path would re-enter the retry loop, but only if the clip is
    // re-requested. Resetting mid-loop extends the budget on the signal
    // that the samples are now available, so the in-flight loop wins on
    // its next iteration instead of giving up.
    this.clipChangedHandler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && this.retryingClips.has(id)) {
        this.retryAttempts.set(id, 0);
      }
    };
    window.addEventListener('slate:audio-clip-changed', this.clipChangedHandler);
  }

  /** Ensure the AudioContext is created. Browsers' autoplay policies suspend
   *  AudioContexts created before a user gesture — `ctx.resume()` from within
   *  a non-gesture call stack is silently ignored, so the previous
   *  `void this.ctx.resume()` was a no-op for a remote peer who just joined
   *  and hadn't clicked anything. Instead of silently failing, we register a
   *  one-time gesture listener (pointerdown/keydown/touchstart) that resumes
   *  the context on the first interaction. Callers that KNOW they're in a
   *  gesture handler (e.g. a click on the play button) should also call
   *  `resumeOnGesture()` directly for immediate effect. */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
       
      console.warn('[slate-audio] AudioContext is suspended — will resume on the first user gesture (browser autoplay policy). Click anywhere to enable audio.');
      this.attachGestureListener();
    }
    return this.ctx;
  }

  /** Register a one-time pointerdown/keydown/touchstart listener that resumes
   *  the suspended AudioContext on the first user interaction. Idempotent —
   *  multiple calls while suspended coalesce into one listener. The listener
   *  removes itself from all three event targets when it fires. */
  private attachGestureListener(): void {
    if (this.gestureHandler) return;
    const handler = () => {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('touchstart', handler);
      this.gestureHandler = null;
    };
    this.gestureHandler = handler;
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    window.addEventListener('touchstart', handler);
  }

  /** Resume the AudioContext if it's suspended. Safe to call from any user
   *  gesture handler (click, pointerdown, keydown, touchstart) — browsers
   *  only allow `resume()` to take effect from within a gesture call stack.
   *  No-op if the context is already running or hasn't been created yet. */
  resumeOnGesture(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
      // Clean up the gesture listener if one is pending — the explicit call
      // supersedes it.
      if (this.gestureHandler) {
        window.removeEventListener('pointerdown', this.gestureHandler);
        window.removeEventListener('keydown', this.gestureHandler);
        window.removeEventListener('touchstart', this.gestureHandler);
        this.gestureHandler = null;
      }
    }
  }

  /** Get or create an AudioBuffer for a clip — loads samples from IndexedDB.
   *  If the samples haven't arrived yet (empty Float32Array, which happens when
   *  a remote peer's sample-blob is still in flight via the Yjs sync map),
   *  retries up to 20 times at 500ms intervals (10s total) before giving up
   *  and returning null. The clip is then skipped on this play() pass, but
   *  the AudioEditor's restart-on-sample-arrival will re-schedule it once the
   *  samples land and the cache is populated. The 20×500ms budget matches
   *  the WaveformImg retry budget — large multi-MB samples arriving as
   *  ~512KB Yjs chunks over a slow link can take several seconds, and the
   *  previous 10×300ms (3s) budget was too short. The `slate:audio-clip-changed`
   *  event (fired when samples arrive) resets `retryAttempts` to 0 for any
   *  clip currently in the loop, so the budget extends on the very signal
   *  that the samples are now available. */
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

    // Samples not yet arrived — retry for up to 10s (20 × 500ms). This
    // covers the gap between a remote clip's metadata landing in Yjs and
    // its sample blob landing in the sync map + being written to local
    // IndexedDB. The `retryAttempts` counter is read fresh on every
    // iteration so a `slate:audio-clip-changed` event (samples arrived)
    // can reset it to 0 mid-loop, extending the budget on the signal that
    // the wait is over.
    this.retryingClips.add(clip.id);
    this.retryAttempts.set(clip.id, 0);
    try {
      while ((this.retryAttempts.get(clip.id) ?? 0) < 20) {
        this.retryAttempts.set(clip.id, (this.retryAttempts.get(clip.id) ?? 0) + 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        buf = await buildBuffer();
        if (buf) {
          this.bufferCache.set(clip.id, buf);
          return buf;
        }
      }
    } finally {
      this.retryingClips.delete(clip.id);
      this.retryAttempts.delete(clip.id);
    }
    return null;
  }

  /** Pre-load (decode + cache) the AudioBuffer for a clip WITHOUT scheduling
   *  playback. Used to warm the cache when samples arrive for a clip while
   *  the user is paused — without this, the first play() goes through the
   *  full getBuffer retry loop, adding audible latency to the first
   *  playback after a remote sample lands. No-op if the clip doesn't exist
   *  or the AudioContext hasn't been created yet (no gesture → no decoding). */
  async preloadBuffer(slate: SlateDoc, clipId: string): Promise<void> {
    if (!this.ctx) return;
    const yo = slate.audioClips().get(clipId);
    if (!yo) return;
    const clip = readAudioClip(yo, clipId);
    if (!clip) return;
    await this.getBuffer(clip); // pre-warm the cache
  }

  /** Lazily build the shared FX bus (one reverb + one feedback echo the whole
   *  mix shares; per-track send gains feed them). */
  private ensureFxBus(): void {
    if (this.fxReverb || !this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    this.fxReverb = ctx.createConvolver();
    this.fxReverb.buffer = this.makeReverbIR(ctx, 2.2, 3);
    this.fxReverb.connect(this.masterGain);
    this.fxDelay = ctx.createDelay(1);
    this.fxDelay.delayTime.value = this.delayTimeForBpm();
    this.fxDelayFeedback = ctx.createGain();
    this.fxDelayFeedback.gain.value = 0.35;
    this.fxDelay.connect(this.fxDelayFeedback);
    this.fxDelayFeedback.connect(this.fxDelay);
    this.fxDelay.connect(this.masterGain);
  }

  /** Dotted-eighth echo synced to the project tempo (the classic slap). */
  private delayTimeForBpm(): number {
    return Math.min(1, 0.375 * (60 / this.bpm));
  }

  /** Build the per-track chain for the current set of tracks:
   *  gain → EQ low/mid/high → panner → master, with post-EQ sends into the
   *  shared reverb/delay bus. Values (volume, pan, EQ dB, send levels) are
   *  re-applied on every call, so this doubles as the "apply Yjs → graph"
   *  step for live edits from the settings panel. */
  private setupTrackNodes(tracks: AudioTrack[]): void {
    const ctx = this.ctx!;
    this.ensureFxBus();
    // Remove stale nodes.
    for (const [id] of this.trackGains) {
      if (!tracks.find((t) => t.id === id)) {
        this.trackGains.get(id)?.disconnect();
        this.trackPanners.get(id)?.disconnect();
        const eq = this.trackEqs.get(id);
        if (eq) { eq.low.disconnect(); eq.mid.disconnect(); eq.high.disconnect(); }
        const sends = this.trackSends.get(id);
        if (sends) { sends.reverb.disconnect(); sends.delay.disconnect(); }
        this.trackGains.delete(id);
        this.trackPanners.delete(id);
        this.trackEqs.delete(id);
        this.trackSends.delete(id);
      }
    }
    // Create missing nodes.
    for (const track of tracks) {
      if (!this.trackGains.has(track.id)) {
        const gain = ctx.createGain();
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 200;
        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = 1000;
        mid.Q.value = 0.9;
        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = 4000;
        const panner = ctx.createStereoPanner();
        gain.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(panner);
        panner.connect(this.masterGain!);
        const reverbSend = ctx.createGain();
        reverbSend.gain.value = 0;
        const delaySend = ctx.createGain();
        delaySend.gain.value = 0;
        high.connect(reverbSend);
        high.connect(delaySend);
        if (this.fxReverb) reverbSend.connect(this.fxReverb);
        if (this.fxDelay) delaySend.connect(this.fxDelay);
        this.trackGains.set(track.id, gain);
        this.trackPanners.set(track.id, panner);
        this.trackEqs.set(track.id, { low, mid, high });
        this.trackSends.set(track.id, { reverb: reverbSend, delay: delaySend });
      }
      // Update values.
      const gain = this.trackGains.get(track.id)!;
      const panner = this.trackPanners.get(track.id)!;
      const eq = this.trackEqs.get(track.id)!;
      const sends = this.trackSends.get(track.id)!;
      const anySolo = tracks.some((t) => t.solo);
      const audible = anySolo ? track.solo : !track.muted;
      gain.gain.value = audible ? track.volume : 0;
      panner.pan.value = track.pan;
      eq.low.gain.value = track.eqLow ?? 0;
      eq.mid.gain.value = track.eqMid ?? 0;
      eq.high.gain.value = track.eqHigh ?? 0;
      sends.reverb.gain.value = track.reverbSend ?? 0;
      sends.delay.gain.value = track.delaySend ?? 0;
    }
  }

  /** Play all clips that intersect the current playhead. */
  async play(slate: SlateDoc, offset: number): Promise<void> {
    const ctx = this.ensureContext();
    // Browser autoplay policy: if the AudioContext is still suspended (no
    // user gesture yet, or the gesture listener hasn't fired), scheduling
    // sources is a silent no-op — the user would see the playhead move but
    // hear nothing. Bail with an actionable toast instead. The gesture
    // listener registered in ensureContext() will resume on the first click,
    // and the user can press play again.
    if (ctx.state === 'suspended') {
      toast({
        title: 'Click anywhere to enable audio',
        description: 'Your browser blocked audio until you interact with the page.',
      });
      return;
    }
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
    //
    // MIDI clips have no IndexedDB sample blob (their notes are inline in
    // Yjs), so they're skipped in the audio-buffer preload pass — they get
    // their own preload pass below (warm the soundfont sample cache for
    // soundfont-piano clips so the first note doesn't drop).
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      clips.map(async (clip) => {
        if (clip.mute) return;
        if (clip.kind === 'midi') return; // no PCM samples
        const buffer = await this.getBuffer(clip);
        if (buffer) buffers.set(clip.id, buffer);
      }),
    );
    if (!this.playing) return; // stopped while buffers were loading

    // Register the pitch-shift worklet if any clip needs time-stretch or
    // pitch-shift (speed ≠ 1 or pitch ≠ 0). One addModule per context —
    // memoized, so this is a cheap await after the first play(). Resolves
    // false where AudioWorklet is unavailable; scheduling then falls back to
    // the old coupled detune behaviour.
    const needsShift = clips.some(
      (c) => !c.mute && c.kind !== 'midi' && ((c.pitch ?? 0) !== 0 || (c.speed != null && c.speed > 0 && c.speed !== 1)),
    );
    const shiftReady = needsShift ? await ensurePitchWorklet(ctx) : false;
    if (!this.playing) return; // stopped while the worklet was loading

    // Pre-warm the soundfont for MIDI clips that use it. Without this the
    // first note of each clip would silently fetch its sample and miss its
    // scheduled start time (noteOn returns null while loading). We collect
    // every distinct midi number across all soundfont-piano clips and ask
    // the SoundfontInstrument to preload them in parallel — by the time the
    // scheduling loop runs, every note is cached and noteOn fires instantly.
    const sfMidis = new Set<number>();
    for (const clip of clips) {
      if (clip.mute || clip.kind !== 'midi') continue;
      const instId = this.resolveInstrumentId(clip, tracks);
      if (instId === SOUNDFONT_PIANO_ID) {
        for (const n of clip.notes ?? []) sfMidis.add(n.midi);
      }
    }
    if (sfMidis.size > 0) {
      const sf = this.ensureSoundfont();
      if (sf) await sf.preloadNotes(Array.from(sfMidis));
    }
    if (!this.playing) return; // stopped during soundfont preload

    // Re-anchor NOW that everything is ready: all clips schedule against one
    // shared clock read, so their relative timing is sample-accurate.
    this.startTime = ctx.currentTime;

    // Schedule each clip that starts after the playhead or is currently playing.
    for (const clip of clips) {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (!track) continue;
      if (clip.mute) continue; // clip muted individually

      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= offset) continue; // clip already finished

      // ── MIDI branch ────────────────────────────────────────────────────
      // For MIDI clips, schedule each note as an instrument voice (soundfont
      // sample or oscillator synth preset) at startTime + (clip.start +
      // note.start - offset). Notes whose start has already passed (the
      // playhead is partway through the clip) are scheduled with a clamped
      // start time so they fire immediately rather than in the past (Web Audio
      // throws if source.start(when) is called with when < currentTime).
      if (clip.kind === 'midi') {
        const trackGain = this.trackGains.get(track.id) ?? this.masterGain!;
        this.scheduleMidiClip(ctx, clip, track, offset, trackGain);
        continue;
      }

      const buffer = buffers.get(clip.id);
      if (!buffer) continue;

      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const pitchCents = clip.pitch ?? 0;
      const clipOffset = clip.offset ?? 0; // trim from the source (buffer seconds)
      const clipVol = clip.gain ?? 1;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Speed and pitch, DECOUPLED like a real editor (Audition's Stretch &
      // Pitch / Premiere's "maintain pitch"):
      //   - playbackRate = speed sets the timeline duration (and would shift
      //     pitch by ×speed as a Web Audio side effect);
      //   - a granular pitch-shift worklet after the source scales frequency
      //     by 2^(cents/1200) / speed — cancelling the varispeed side effect
      //     and applying the user's pitch knob on top.
      // Net: Speed changes duration but keeps pitch; Pitch shifts semitones
      // but keeps duration. Unity ratio bypasses the shifter entirely (the
      // common path stays two nodes). If the worklet isn't available, fall
      // back to the old coupled detune.
      source.playbackRate.value = speed;
      const shiftRatio = Math.pow(2, pitchCents / 1200) / speed;
      let shifter: AudioWorkletNode | undefined;
      let clipHead: AudioNode = source;
      if (shiftReady && Math.abs(shiftRatio - 1) > 0.0005) {
        shifter = createPitchShifter(ctx, shiftRatio);
        source.connect(shifter);
        clipHead = shifter;
        // Let the shifter ring out its buffered tail and self-terminate when
        // the source ends (naturally or via stop()) — worklet nodes whose
        // process() keeps returning true are never GC'd.
        const s = shifter;
        source.onended = () => releasePitchShifter(s);
      } else if (!shiftReady && pitchCents !== 0) {
        source.detune.value = pitchCents; // legacy coupled fallback
      }

      // Per-clip gain (fades + clip volume) → per-clip panner → optional
      // HP/LP filters → track chain. Filters are only inserted when engaged
      // (cutoff moved off the ends of the audible range) so the default path
      // stays two nodes.
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
      const trackGain = this.trackGains.get(track.id);
      if (trackGain) clipTail.connect(trackGain);
      else clipTail.connect(this.masterGain!);

      // How far the playhead is already into the clip (real seconds), and where
      // that lands in the source buffer (buffer seconds → scaled by speed).
      const skipTo = Math.max(0, offset - clip.start);
      const whenToStart = this.startTime + Math.max(0, clip.start - offset);
      const playDuration = clip.duration - skipTo; // real seconds left on the timeline
      const bufStart = clipOffset + skipTo * speed;
      const bufDuration = playDuration * speed;

      // Latency compensation: the shifter's granular window delays audio by
      // ~45ms on average, so shifted clips would land late against unshifted
      // ones. Start the SOURCE early by that amount when there's headroom —
      // the audio emerges from the shifter on time. (Fades below stay
      // anchored to whenToStart: the gain node sits after the shifter, in
      // timeline time.)
      const srcStart = shifter ? Math.max(ctx.currentTime, whenToStart - PITCH_SHIFT_LATENCY) : whenToStart;
      source.start(srcStart, bufStart, bufDuration);

      // Fades (real-time). Base level is the clip gain.
      clipGain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : clipVol, whenToStart);
      if (clip.fadeIn > 0) {
        clipGain.gain.linearRampToValueAtTime(clipVol, whenToStart + clip.fadeIn);
      }
      if (clip.fadeOut > 0) {
        clipGain.gain.setValueAtTime(clipVol, whenToStart + playDuration - clip.fadeOut);
        clipGain.gain.linearRampToValueAtTime(0, whenToStart + playDuration);
      }

      this.playingClips.push({ source, gain: clipGain, clipId: clip.id, shifter });
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
    for (const { source, shifter } of this.playingClips) {
      try { source.stop(); } catch { /* already stopped */ }
      if (shifter) releasePitchShifter(shifter); // idempotent (onended also fires)
    }
    this.playingClips = [];
    // Release every live MIDI voice too — without this, oscillator-based
    // presets would ring past stop() until their natural decay finished, and
    // soundfont samples would play out their full release tail.
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const v of this.playingMidiVoices) {
        try { v.stop(now); } catch { /* already stopped */ }
      }
    }
    this.playingMidiVoices = [];
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
    for (const { source, shifter } of this.playingClips) {
      try { source.stop(); } catch { /* already stopped */ }
      if (shifter) releasePitchShifter(shifter); // idempotent (onended also fires)
    }
    this.playingClips = [];
    // Release live MIDI voices too (see stop()).
    {
      const now = this.ctx.currentTime;
      for (const v of this.playingMidiVoices) {
        try { v.stop(now); } catch { /* already stopped */ }
      }
    }
    this.playingMidiVoices = [];
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

  setBpm(bpm: number): void {
    this.bpm = bpm;
    // Keep the shared echo musically in time with the new tempo.
    if (this.fxDelay) this.fxDelay.delayTime.value = this.delayTimeForBpm();
  }

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

  /** Set one EQ band's gain (dB) directly on a track's filter node — O(1),
   *  used by the settings-panel knobs for live feedback during playback.
   *  No-op before the graph exists; the next play() reads the Yjs value. */
  setTrackEq(trackId: string, band: 'low' | 'mid' | 'high', dB: number): void {
    const eq = this.trackEqs.get(trackId);
    if (!eq) return;
    eq[band].gain.value = Math.max(-12, Math.min(12, dB));
  }

  /** Set a track's reverb/delay send level (0..1) directly — O(1) live write. */
  setTrackSend(trackId: string, which: 'reverb' | 'delay', level: number): void {
    const sends = this.trackSends.get(trackId);
    if (!sends) return;
    sends[which].gain.value = Math.max(0, Math.min(1, level));
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

  /** Lazily create the shared SoundfontInstrument (one per AudioContext).
   *  Routes its output through the master gain so it joins the same mix as
   *  audio clips — but per-track routing for MIDI clips is handled in
   *  scheduleMidiClip(), which passes the track's gain-chain tail as `dest`
   *  to a per-call noteOn (the SoundfontInstrument constructor only needs a
   *  fallback destination; the per-clip routing overrides it).
   *
   *  Returns null if the AudioContext doesn't exist yet (no gesture). The
   *  caller (play()) bails on suspended ctx anyway, so this is mostly a
   *  belt-and-braces guard. */
  private ensureSoundfont(): SoundfontInstrument | null {
    if (!this.ctx || !this.masterGain) return null;
    if (!this.soundfont) {
      // The dest here is a fallback only — scheduleMidiClip routes each note
      // through the track's gain chain. The SoundfontInstrument connects its
      // per-note gain nodes to whatever `dest` is at noteOn time, so the
      // constructor's dest is only used if noteOn is called without a dest
      // override (it isn't, in our usage).
      this.soundfont = new SoundfontInstrument(this.ctx, this.masterGain);
    }
    return this.soundfont;
  }

  /** Resolve which instrument a MIDI clip should play through. Clip-level
   *  `instrumentId` wins; otherwise the track's `instrumentId` is used; if
   *  neither is set, fall back to the grand-piano preset (a sensible default
   *  for any MIDI clip — it's what a user expects when they create a MIDI
   *  track and drop notes on it without picking an instrument). */
  private resolveInstrumentId(clip: AudioClip, tracks: AudioTrack[]): string {
    if (clip.instrumentId) return clip.instrumentId;
    const track = tracks.find((t) => t.id === clip.trackId);
    if (track?.instrumentId) return track.instrumentId;
    return INSTRUMENT_PRESETS[0]!.id; // 'inst-grand-piano'
  }

  /** Look up a synth preset by id (factory presets first, then custom
   *  instruments from localStorage). Falls back to the grand-piano preset
   *  if the id is unknown — better to play *something* than silently drop
   *  the clip because the user deleted a custom instrument mid-session. */
  private resolveSynthParams(id: string): InstrumentParams {
    const factory = INSTRUMENT_PRESETS.find((p) => p.id === id);
    if (factory) return factory;
    // loadCustomInstruments reads localStorage — cheap, but only worth doing
    // when the id isn't a factory preset. We don't memoize because the set of
    // custom instruments can change mid-session (user saves/deletes one).
    const custom = loadCustomInstruments().find((p) => p.id === id);
    if (custom) return custom;
    return INSTRUMENT_PRESETS[0]!;
  }

  /** Schedule every note in a MIDI clip. Each note fires at
   *  `startTime + (clip.start + note.start - offset)` and releases at the
   *  note's start + duration. Notes whose start time is already in the past
   *  (the playhead is partway through the clip) are clamped to fire
   *  immediately — Web Audio throws if source.start(when) is called with a
   *  `when` < ctx.currentTime.
   *
   *  The instrument is selected by `resolveInstrumentId`:
   *  - 'soundfont-piano' → SoundfontInstrument (sample-based, freepats)
   *  - any other id → oscillator-based LiveInstrument preset (startVoice)
   *
   *  The voice's output is routed through the track's gain chain (the same
   *  one audio clips use) so MIDI clips get the same volume/pan/EQ/sends/
   *  mute/solo treatment as audio clips. */
  private scheduleMidiClip(
    ctx: AudioContext,
    clip: AudioClip,
    _track: AudioTrack,
    offset: number,
    dest: AudioNode,
  ): void {
    const notes = clip.notes ?? [];
    if (notes.length === 0) return;
    const instId = this.resolveInstrumentId(clip, [_track]);
    const clipVol = clip.gain ?? 1;

    if (instId === SOUNDFONT_PIANO_ID) {
      const sf = this.ensureSoundfont();
      if (!sf) return;
      for (const n of notes) {
        const noteAbsStart = clip.start + n.start;
        if (noteAbsStart + n.duration <= offset) continue; // note already ended
        // Clamp to currentTime so a note whose scheduled start is in the past
        // (playhead partway through the clip) fires NOW instead of throwing.
        const when = Math.max(ctx.currentTime, this.startTime + Math.max(0, noteAbsStart - offset));
        const voice = sf.noteOn(n.midi, n.velocity * clipVol, when);
        if (!voice) continue; // sample not loaded (will be on next play)
        const stopWhen = Math.max(when + 0.01, this.startTime + Math.max(0, noteAbsStart + n.duration - offset));
        voice.stop(stopWhen);
        this.playingMidiVoices.push({ clipId: clip.id, stop: voice.stop });
      }
      return;
    }

    // Oscillator-based synth preset.
    const params = this.resolveSynthParams(instId);
    for (const n of notes) {
      const noteAbsStart = clip.start + n.start;
      if (noteAbsStart + n.duration <= offset) continue; // note already ended
      const when = Math.max(ctx.currentTime, this.startTime + Math.max(0, noteAbsStart - offset));
      const voice = startVoice(ctx, dest, params, n.midi, n.velocity * clipVol, when);
      const stopWhen = Math.max(when + 0.02, this.startTime + Math.max(0, noteAbsStart + n.duration - offset));
      voice.stop(stopWhen);
      this.playingMidiVoices.push({ clipId: clip.id, stop: voice.stop });
    }
  }

  dispose(): void {
    this.stop();
    if (this.gestureHandler) {
      window.removeEventListener('pointerdown', this.gestureHandler);
      window.removeEventListener('keydown', this.gestureHandler);
      window.removeEventListener('touchstart', this.gestureHandler);
      this.gestureHandler = null;
    }
    if (this.clipChangedHandler) {
      window.removeEventListener('slate:audio-clip-changed', this.clipChangedHandler);
      this.clipChangedHandler = null;
    }
    this.trackGains.forEach((g) => g.disconnect());
    this.trackPanners.forEach((p) => p.disconnect());
    this.trackEqs.forEach((eq) => { eq.low.disconnect(); eq.mid.disconnect(); eq.high.disconnect(); });
    this.trackSends.forEach((s) => { s.reverb.disconnect(); s.delay.disconnect(); });
    this.trackGains.clear();
    this.trackPanners.clear();
    this.trackEqs.clear();
    this.trackSends.clear();
    this.fxReverb?.disconnect();
    this.fxDelay?.disconnect();
    this.fxDelayFeedback?.disconnect();
    this.fxReverb = null;
    this.fxDelay = null;
    this.fxDelayFeedback = null;
    this.bufferCache.clear();
    this.retryingClips.clear();
    this.retryAttempts.clear();
    this.soundfont?.dispose();
    this.soundfont = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }
}
