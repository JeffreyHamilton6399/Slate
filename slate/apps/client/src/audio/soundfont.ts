/**
 * Soundfont loader — fetches individual note samples from freepats.zenvoid.org
 * and caches them as AudioBuffers.
 *
 * The freepats piano provides individual WAV files per note, e.g.:
 *   https://freepats.zenvoid.org/Piano/acoustic-grand-piano/a-0.wav
 *
 * The freepats filenames use a flat-style naming:
 *   - lowercase letter for the pitch class
 *   - `-` separator before the octave
 *   - `-` IN PLACE of `#` for sharps (so C#3 = `c--1.wav`, not `c#-1.wav`)
 *
 * We fetch each note lazily on first `noteOn(midi, …)` for that pitch, then
 * cache the decoded AudioBuffer in a Map for instant playback thereafter.
 * Calls during the load window return null (the note is silently dropped the
 * first time) — subsequent presses of the same note fire instantly once the
 * WAV has landed.
 *
 * One SoundfontInstrument per AudioEngine (one shared AudioContext). The
 * engine routes the SoundfontInstrument's noteOn output through a per-track
 * gain/panner chain so MIDI clips get the same mixing, mute, solo, EQ, and
 * reverb/delay sends as audio clips.
 *
 * CORS: freepats.zenvoid.org serves its WAVs with permissive CORS headers
 * (`Access-Control-Allow-Origin: *`), so `fetch()` + `decodeAudioData()` work
 * cross-origin without a proxy. If the fetch fails (network blocked, 404 for
 * an out-of-range note, etc.) we treat that note as permanently missing —
 * `ensureNote` returns null and the buffer slot stays empty so we don't
 * re-fetch the same failing URL every time the note is pressed.
 */

const SOUNDFONT_BASE = 'https://freepats.zenvoid.org/Piano/acoustic-grand-piano';

/** Pitch-class index (0=C, 1=C#, … 11=B) → freepats filename letter component.
 *  Sharps use a `-` instead of `#`, so the array is just the natural-letter
 *  names with `-` appended for the sharps. */
const NOTE_NAMES = ['c', 'c-', 'd', 'd-', 'e', 'f', 'f-', 'g', 'g-', 'a', 'a-', 'b'];

/** Convert a MIDI note number to the freepats WAV filename (e.g. 21 → 'a-0.wav',
 *  60 → 'c-4.wav', 72 → 'c-5.wav'). The freepats octave numbering is one
 *  higher than the MIDI-standard octave (MIDI 60 = C4 in scientific pitch
 *  notation, but freepats stores it as c-4.wav with their offset). We mirror
 *  the freepats convention: octave = floor(midi / 12) - 1, so MIDI 21 (A0)
 *  maps to a-0.wav and MIDI 108 (C8) maps to c-8.wav. */
function midiToNoteFile(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const noteIdx = midi % 12;
  const name = NOTE_NAMES[noteIdx] ?? 'c';
  return `${name}-${octave}.wav`;
}

/** Map of notes that returned a non-OK HTTP status (404 for an out-of-range
 *  note, 5xx, etc.). We remember them so we don't re-fetch the same failing
 *  URL every time the user presses the note. Cleared on dispose(). */
const failedMidis = new Set<number>();

export interface SoundfontVoiceHandle {
  /** Begin the release phase at `when` (context time) and clean up after. */
  stop(when: number): void;
}

export class SoundfontInstrument {
  private buffers = new Map<number, AudioBuffer>();
  private ctx: AudioContext;
  /** midi notes currently being fetched (prevents concurrent fetches of the
   *  same note). */
  private loading = new Set<number>();
  /** Master gain node the SoundfontInstrument connects through. The engine
   *  passes the track's existing gain-chain tail as `dest` in `noteOn` so
   *  each note feeds into the track's volume/pan/EQ/sends — the
   *  SoundfontInstrument does NOT own its own master output. */
  private dest: AudioNode;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.dest = dest;
  }

  /** Lazily fetch + decode the WAV for one note. Returns the cached
   *  AudioBuffer, or null if the fetch failed / is in-flight / was previously
   *  marked as permanently failed. Safe to call repeatedly — the second call
   *  for a successfully-loaded note returns instantly from the cache. */
  async ensureNote(midi: number): Promise<AudioBuffer | null> {
    if (this.buffers.has(midi)) return this.buffers.get(midi)!;
    if (failedMidis.has(midi)) return null;
    if (this.loading.has(midi)) return null;
    this.loading.add(midi);
    try {
      const file = midiToNoteFile(midi);
      const url = `${SOUNDFONT_BASE}/${file}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        // 404 for an out-of-range note (the piano soundfont doesn't cover all
        // 128 midi notes). Remember so we don't re-fetch.
        if (resp.status === 404 || resp.status >= 400) failedMidis.add(midi);
        return null;
      }
      const arrayBuffer = await resp.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(arrayBuffer);
      this.buffers.set(midi, buffer);
      return buffer;
    } catch {
      // Network error, CORS block, decode failure — mark as failed so we don't
      // retry every keypress (which would spam the network panel).
      failedMidis.add(midi);
      return null;
    } finally {
      this.loading.delete(midi);
    }
  }

  /** Schedule a note-on at `when` (context time). Returns a handle whose
   *  `stop(when)` schedules the release — for a sample-based instrument the
   *  release is a short gain fade-out + source.stop a hair later, so the
   *  sample's natural decay isn't cut off abruptly.
   *
   *  Returns null if the note's sample isn't loaded yet (the first press of a
   *  given note triggers `ensureNote` in the background; the next press fires
   *  instantly). The engine ignores null returns — the same way it ignores a
   *  null AudioBuffer for an audio clip whose samples haven't arrived. */
  noteOn(midi: number, velocity: number, when: number = this.ctx.currentTime): SoundfontVoiceHandle | null {
    const buffer = this.buffers.get(midi);
    if (!buffer) {
      // Lazy-load in the background — the user's NEXT press of this note will
      // fire instantly once the WAV is cached.
      void this.ensureNote(midi);
      return null;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // Acoustic piano samples are one-shot (not looped). Don't set source.loop.
    const gain = this.ctx.createGain();
    // Velocity scales the gain (sample is recorded at full velocity). Use a
    // 0.1 floor so a velocity-0 note is still barely audible (the user might
    // be expecting to hear *something* — velocity 0 in real MIDI is a note-off
    // analog, but in our instrument panel 0..1 maps linearly from inaudible).
    gain.gain.value = Math.max(0.0001, velocity);
    source.connect(gain);
    gain.connect(this.dest);
    try { source.start(when); } catch { /* already started? */ }

    let stopped = false;
    return {
      stop: (stopWhen?: number) => {
        if (stopped) return;
        stopped = true;
        const t = stopWhen ?? this.ctx.currentTime;
        // Short release ramp so the sample's natural decay isn't clicked off.
        gain.gain.setTargetAtTime(0, t, 0.05);
        try { source.stop(t + 0.15); } catch { /* already stopped */ }
      },
    };
  }

  /** Pre-load a range of notes (e.g. A0=21 .. C8=108). Useful for warming the
   *  cache before playback of a MIDI clip whose notes we know in advance —
   *  pass the clip's note list to `preloadNotes` and they'll all be cached by
   *  the time play() schedules them. Best-effort: failures are swallowed. */
  async preloadNotes(midis: number[]): Promise<void> {
    // Dedupe + filter to the range the freepats piano covers (A0=21 .. C8=108)
    // so we don't waste requests on notes that will 404.
    const unique = Array.from(new Set(midis.filter((m) => m >= 21 && m <= 108)));
    await Promise.all(unique.map((m) => this.ensureNote(m)));
  }

  /** True if a note's sample is already cached (no fetch needed on noteOn). */
  hasNote(midi: number): boolean {
    return this.buffers.has(midi);
  }

  dispose(): void {
    this.buffers.clear();
    // Don't clear `failedMidis` — it's a module-level set shared across
    // instances (a note that 404'd once won't suddenly exist on the server).
  }
}
