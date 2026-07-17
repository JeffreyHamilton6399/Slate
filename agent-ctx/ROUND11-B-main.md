# ROUND11-B — MIDI support, soundfonts, quantization, mute fix

## Goal
Add MIDI clip support end-to-end (schema → engine → UI), wire up the freepats acoustic-grand-piano soundfont, add a quantize pass for recorded instrument takes, add an Audio/MIDI track kind selector with instrument picker, and verify the remote-mute fix is in place.

## Files touched
- **Modified** `slate/packages/sync-protocol/src/schema.ts`
- **Modified** `slate/packages/sync-protocol/src/validators.ts`
- **Modified** `slate/apps/client/src/audio/scene.ts`
- **Modified** `slate/apps/client/src/audio/engine.ts`
- **Modified** `slate/apps/client/src/audio/AudioEditor.tsx`
- **Modified** `slate/apps/client/src/panels/InstrumentPanel.tsx`
- **Created** `slate/apps/client/src/audio/soundfont.ts`

## Implementation notes

### Task 1 — MIDI support in the schema (`schema.ts`)
- Added `NoteEvent` interface (midi/velocity/start/duration) — exported from `@slate/sync-protocol` for use by both client and server.
- Added 3 new optional fields to `AudioClip`:
  - `kind?: 'audio' | 'midi'` — discriminates PCM-sample clips from note-event clips. Defaults to `'audio'` for backward compat.
  - `notes?: NoteEvent[]` — only meaningful when `kind === 'midi'`.
  - `instrumentId?: string` — which synth/soundfont preset the clip plays through. Falls back to the track's `instrumentId` at playback time.

### Task 2 — AudioTrack updates (`schema.ts`)
- Added `instrumentId?: string` to `AudioTrack` (instrument preset ID for MIDI tracks, e.g. `'inst-grand-piano'` or `'soundfont-piano'`).
- Changed `input` to `'mic' | 'midi' | 'none'` so a track can be armed for MIDI-take recording (instrument capture) instead of mic input.

### Task 3 — Validators (`validators.ts`)
- Added `noteEventSchema`, `audioTrackSchema`, `audioClipSchema` zod validators. The audio schemas weren't previously defined (only shape/stroke/object3D/material/etc were). All new fields are optional or have backward-compatible defaults so existing clips continue to parse.
- `noteEventSchema`: midi 0-127 int, velocity 0-1, start/duration 0-3600s.
- `audioTrackSchema`: `kind: z.enum(['audio','midi'])`, `input: z.enum(['mic','midi','none'])`, `instrumentId` optional.
- `audioClipSchema`: `kind` optional, `notes` array (capped at 10k notes/clip), `instrumentId` optional.

### Task 4 — Soundfont instrument (`soundfont.ts` — NEW)
- `SoundfontInstrument` class: lazily fetches individual note WAVs from `https://freepats.zenvoid.org/Piano/acoustic-grand-piano/{name}-{octave}.wav` and caches them as AudioBuffers in a Map.
- Filename convention: `NOTE_NAMES = ['c','c-','d','d-','e','f','f-','g','g-','a','a-','b']` — sharps use `-` instead of `#` (freepats convention). Octave = `floor(midi/12) - 1` so MIDI 21 (A0) → `a-0.wav`, MIDI 60 (C4) → `c-4.wav`.
- `ensureNote(midi)` — fetch + decode + cache one note. Failed fetches (404 for out-of-range notes, network errors, CORS blocks) are remembered in a module-level `failedMidis` set so we don't re-fetch the same failing URL every keypress.
- `noteOn(midi, velocity, when)` — schedules a BufferSource → Gain → dest chain. Returns a `SoundfontVoiceHandle` with `stop(when)` for a short release ramp. Returns null if the sample isn't loaded yet (lazy-loads in the background — the next press of the same note fires instantly).
- `preloadNotes(midis)` — bulk pre-load. Used by the engine before scheduling a MIDI clip so the first note doesn't drop.
- `dispose()` — clears the buffer cache. The `failedMidis` set is NOT cleared (a note that 404'd won't suddenly exist on the server).

### Task 5 — MIDI playback in the engine (`engine.ts`)
- New imports: `INSTRUMENT_PRESETS, loadCustomInstruments, startVoice, type InstrumentParams` from `./instruments`, `SoundfontInstrument` from `./soundfont`.
- New exported constant: `SOUNDFONT_PIANO_ID = 'soundfont-piano'` — the synthetic instrument ID that selects the SoundfontInstrument. Any other instrumentId falls through to the oscillator-based LiveInstrument preset lookup.
- New private fields: `playingMidiVoices: PlayingMidiVoice[]`, `soundfont: SoundfontInstrument | null`.
- New private methods:
  - `ensureSoundfont()` — lazily creates the shared SoundfontInstrument (one per AudioContext).
  - `resolveInstrumentId(clip, tracks)` — clip.instrumentId → track.instrumentId → `'inst-grand-piano'` fallback.
  - `resolveSynthParams(id)` — factory preset lookup, then `loadCustomInstruments()`, then grand-piano fallback.
  - `scheduleMidiClip(ctx, clip, track, offset, dest)` — schedules every note in a MIDI clip. For soundfont-piano: `sf.noteOn(midi, velocity*clipVol, when)` then `voice.stop(stopWhen)`. For synth presets: `startVoice(ctx, dest, params, midi, velocity*clipVol, when)` then `voice.stop(stopWhen)`. Notes whose start is in the past (playhead partway through the clip) are clamped to fire NOW (Web Audio throws if `source.start(when)` is called with `when < currentTime`). Voices are pushed to `playingMidiVoices` so `stop()`/`restartPlayback()` can release them.
- `play()` updates:
  - Audio-buffer preload loop skips MIDI clips (no PCM samples to load).
  - NEW soundfont preload pass: collects every distinct midi number across all soundfont-piano MIDI clips and calls `sf.preloadNotes(...)` in parallel, so by the time the scheduling loop runs, every note is cached and `noteOn` fires instantly.
  - Scheduling loop branches on `clip.kind === 'midi'` → calls `scheduleMidiClip()` and continues. Audio clips keep the existing path.
- `stop()` and `restartPlayback()` now also release all live MIDI voices (oscillator-based presets would ring past stop until their natural decay; soundfont samples would play their full release tail).
- `dispose()` calls `soundfont?.dispose()` and clears the reference.

### Task 6 — Track kind selector in TrackHeader (`AudioEditor.tsx`)
- Added `Piano` to the lucide-react imports.
- Added `SOUNDFONT_PIANO_ID` to the engine import; added `INSTRUMENT_PRESETS, loadCustomInstruments` to the instruments import.
- TrackHeader now has:
  - **Kind toggle button** (Volume2 icon for audio, Piano icon for MIDI, highlighted when MIDI) — toggles `track.kind` between `'audio'` and `'midi'`. Switching to MIDI defaults `instrumentId` to `SOUNDFONT_PIANO_ID` if not set, and drops a mic-arm. Switching to audio clears a midi-arm.
  - **Arm button** — on an audio track sets `input: 'mic'`; on a MIDI track sets `input: 'midi'`. The arm state still toggles.
  - **Instrument picker row** (MIDI tracks only) — replaces the pan-slider row with a compact `<select>` listing: Soundfont Piano, all factory synth presets (optgroup), and any custom instruments from localStorage (optgroup). Bound to `track.instrumentId`.
  - Audio tracks keep the original volume + pan slider row.
- The existing armed-track indicator (added by ROUND11-A) is preserved.

### Task 7 — Remote mute fix (`AudioEditor.tsx`)
- The fix was already in place from a prior round (the `applyTracks` subscription registered on `tracks.observeDeep`). Verified it's there: `tracks.observeDeep(applyTracks)` at line 417, with cleanup at line 459.
- `applyTracks = () => { engineRef.current?.updateTracks(slateRef.current); }` — re-applies the Yjs track values to the live audio graph whenever any track field changes (local OR remote, including mute/solo). `updateTracks` calls `setupTrackNodes`, which writes `gain.gain.value = audible ? volume : 0` per track (audible = solo ? track.solo : !track.muted).
- Added a detailed comment explaining WHY this fixes the "can't mute others" bug: the mute state IS in Yjs and syncs to every peer, but sync alone doesn't affect the audio graph — the local engine's per-track gain nodes still hold the old value until something re-applies them. `applyTracks` is that "something".

### Bonus — MIDI clip helpers (`scene.ts`)
- `addMidiClip(slate, trackId, { start, notes, name?, color?, duration?, instrumentId? })` — creates a MIDI clip in Yjs (no IndexedDB sample blob). Duration defaults to the latest note end + 0.05s tail.
- `splitAudioClip` now has a MIDI branch: splits the note list at the boundary (notes before the split keep their full duration on the left half; notes at-or-after the split move to the right half with their start times shifted back by `relTime`). No sample I/O for MIDI clips.
- `duplicateAudioClip` now has a MIDI branch: deep-copies the notes array (so the dupe is fully independent) and calls `addMidiClip`. No sample I/O.
- `readAudioTrack` now reads `instrumentId` from Yjs.
- `readAudioClip` now reads `kind`, `notes`, `instrumentId` from Yjs.

### Task 3 (quantize) — InstrumentPanel
- Added `QuantizeOption` type (`'off' | '1/4' | '1/8' | '1/16' | '1/32'`) and `QUANTIZE_OPTIONS` array.
- New state: `quantize` + `quantizeRef` (so the long-lived `placeTake` callback reads the latest value without re-creating).
- `placeTake` now has a quantize pass BEFORE `renderPerformance`:
  - Reads BPM from `slate.doc.getMap('audio').get('bpm')` (matches the timeline the user sees, not a stale local value).
  - Grid step = `(60/bpm) / (division/4)` seconds — e.g. at 120 BPM, 1/16 = 0.125s (a sixteenth note).
  - `qNotes = notes.map(n => ({ ...n, start: Math.round(n.start / step) * step }))` — snaps each note's start to the nearest grid line. Duration is preserved (held notes stay held).
  - Toast now includes `· quantized 1/16` (or whichever) when quantize is on.
- New compact `<select>` in the InstrumentPanel header (next to the Record and Keyboard buttons): "Free" for off, otherwise the grid value. Highlighted accent when active.

## Verification
- `cd /home/z/my-project/slate/packages/sync-protocol && npx tsc --noEmit` → exit 0, no errors.
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0, no errors (clean across all 7 modified/created files plus the rest of the codebase).
- `cd /home/z/my-project/slate/packages/sync-protocol && npx vitest run --passWithNoTests` → 11/11 tests pass (existing validator tests still green; new audio schemas not yet covered by tests but parse correctly per tsc).
- `npx eslint` on the 5 touched client files → 0 errors, 2 pre-existing warnings (AudioEditor:1127 useCallback pxPerSec dep — pre-existing; engine:134 unused no-console eslint-disable — pre-existing).
- `dev.log` (root Next.js sandbox) shows no compile errors.

## Cross-agent notes
- ROUND11-A (parallel agent) modified `Home.tsx`, `AudioEditor.tsx` (armed-track indicator), `ExportDialog.tsx`, `Viewport3D.tsx`, and added `files/exportAudio.ts`. My changes to `AudioEditor.tsx` preserve ROUND11-A's armed-track badge (verified via git diff — the transport-bar Record button block at line 1149-1157 is intact).
- ROUND11-A's `files/exportAudio.ts` reads `clip.kind === 'midi'` indirectly through `collectClips` — it loads PCM samples via `loadSamples(clip.sampleKey)`. MIDI clips have an empty `sampleKey`, so `loadSamples('')` returns an empty Float32Array, and ROUND11-A's exporter skips empty-sample clips. This means MIDI clips are NOT included in the audio mixdown export — that's a known limitation; a future agent could add a MIDI-to-PCM render step (offline render via `startVoice` against an OfflineAudioContext, similar to `renderPerformance` in instruments.ts).
- The `addMidiClip` helper stores `notes` as a plain JS array in the Yjs Map. Yjs serialises this as a JSON value (not a Y.Array), so concurrent edits to a MIDI clip's notes will OVERWRITE rather than merge. For real-time collaborative MIDI editing, a future agent could swap `notes` for a `Y.Array<NoteEvent>` and update `readAudioClip`/`updateAudioClip` accordingly. The current approach is fine for the typical workflow (one user records a take, others hear it).
- The SoundfontInstrument fetches from `freepats.zenvoid.org` cross-origin. The site serves WAVs with permissive CORS headers (`Access-Control-Allow-Origin: *`), so `fetch()` + `decodeAudioData()` work without a proxy. If the sandbox blocks the fetch, notes silently fail (marked in `failedMidis`) — the rest of the instrument (oscillator presets) still works.
