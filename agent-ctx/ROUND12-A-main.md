# ROUND12-A — Slate audio editor fixes (5 tasks)

## Summary

All 5 fixes done. `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` exits 0 with zero errors. ESLint on touched files: 0 errors, 1 pre-existing warning (pxPerSec useCallback dep in AudioEditor — predates this round).

## Files modified
- `slate/apps/client/src/audio/AudioEditor.tsx` (Tasks 1, 2, 4, 5)
- `slate/apps/client/src/audio/scene.ts` (Task 4 — decodeMidiFile)
- `slate/apps/client/src/files/exportAudio.ts` (Task 3 — MP3 encoder)
- `slate/apps/client/src/files/ExportDialog.tsx` (Task 3 — mp3 in dialog)
- `slate/apps/client/package.json` (lamejs + @tonejs/midi added)

## Files created
- `slate/apps/client/src/lamejs.d.ts` — ambient module declaration (lamejs ships no types)

## Task-by-task details

### Task 1 — Multi-select clip drag
- Extended `dragRef` type with optional `origins?: Map<string, {el, waveEl, os, od, oo, trackId}>` storing every selected clip's original position + DOM element.
- `dragGeometry(clip, excludeIds?)` now takes an optional set of clip ids to skip when building the neighbour bounds — multi-drag passes the full selectedRef so the group's own members don't block it.
- `startDrag`: detects `multiDrag = !additive && selectedRef.current.has(clip.id) && selectedRef.current.size > 1` BEFORE calling selectClip (so a plain click on an already-multi-selected clip preserves the group). Populates `origins` via `document.querySelector('[data-clip-id="..."]')` for every selected clip.
- Added `data-clip-id={clip.id}` attribute to ClipBlock's root div.
- `applyMove` (rAF callback): when `d.origins` is populated, snaps based on the dragged clip's edges then moves EVERY selected clip's `el.style.left` by the same delta. Vertical rowDelta is bypassed for the group (each clip stays on its origin track) since cross-track reshuffle would be ambiguous.
- `onUp`: when committing, computes `dt = left - draggedOrigin.os`, clamps it via the new `clampGroupDt(dt, origins, byTrack)` helper (intersect per-clip non-overlap ranges), writes the resolved positions to the DOM, and commits each clip's `start` to Yjs inside a single `slate.doc.transact()` so peers see one atomic update.
- Added module-level `clampGroupDt` helper near `nearestFreeStart`: for each clip × blocker pair, derive lower/upper bounds on dt and clamp the desired dt into the intersection. Returns 0 if constraints conflict.

### Task 2 — Plain drag = marquee, plain click = seek
- Extended `marqueeRef` type with `seekTime`, `additive`, `moved` fields.
- Seek layer's `onPointerDown` now ALWAYS starts a potential marquee (no modifier-key gate). Stashes `seekTime = sx / pps` for the click fallback.
- `onPointerMove` keeps a 3px dead zone. Once exceeded, sets `moved = true` and starts updating the marquee rect + hit-testing clips (same as before). Before the dead zone, the pointer is still treated as a potential click.
- `onPointerUp`: if `!moved` → it was a click → seek to `seekTime` and (if non-additive) clear the selection. If `moved` → marquee selection was already finalised incrementally, nothing to do.
- Shift/Cmd+drag is still additive (origin = current selection). Plain drag now starts a fresh marquee (origin = empty set), no modifier needed.

### Task 3 — MP3 export (replaces MP4)
- Installed `lamejs@1.2.1` and `@tonejs/midi@2.0.28` via `npx pnpm add ... --filter @slate/client`.
- Created `src/lamejs.d.ts` ambient module declaration (lamejs has no bundled types) declaring the `Mp3Encoder` class with `encodeBuffer(left, right?)` + `flush()`.
- Added `encodeMp3(buffer)` helper to `exportAudio.ts`: converts Float32 channels → Int16 PCM, feeds lamejs 1152-sample blocks, drains with flush(), concatenates chunks into one ArrayBuffer.
- Added `exportAudioMp3({slate, duration, onProgress})` — same offline mixdown path as WAV, then `encodeMp3(rendered)`, downloads `slate-mix.mp3` (MIME `audio/mpeg`).
- Removed the old `exportAudioMp4` (MediaRecorder realtime capture) — no longer reachable from the dialog.
- `ExportDialog.tsx`: import switched from `exportAudioMp4` to `exportAudioMp3`. Audio formats changed from `['wav','mp4']` to `['wav','mp3']`. Added `mp3` to FORMAT_INFO. Added `'mp3'` to the `ExportFormat` union. onExport's audio branch now calls `exportAudioMp3`. Updated description text + dialog header comment.
- 192 kbps stereo MP3, fast (not realtime), plays everywhere.

### Task 4 — MIDI file import
- `scene.ts`: imported `Midi` from `@tonejs/midi` and `NoteEvent` type from `@slate/sync-protocol`.
- Added `decodeMidiFile(file)` — reads the file as ArrayBuffer, parses with `new Midi(arrayBuffer)`, flattens `midi.tracks[].notes` into one `NoteEvent[]` (each note's `start` is the absolute time in seconds from the start of the file). Returns `{notes, duration, tempo}` where tempo comes from `midi.header.tempos[0]?.bpm ?? 120`.
- `AudioEditor.tsx`: imported `addMidiClip` and `decodeMidiFile` from scene.
- `handleFileImport` now branches on file extension: `/\.midi?$/i` → MIDI path (creates a MIDI track with `instrumentId: SOUNDFONT_PIANO_ID` + a MIDI clip via `addMidiClip` with the note list; also adopts the file's tempo as the board BPM if it's in [20, 300]); other audio files keep the existing `decodeAudioFile` → audio track + audio clip path.
- Drag-drop regex updated: `/\.(mp3|wav|ogg|m4a|flac|aac|mid|midi)$/i`.
- Import button's `accept` attribute: `"audio/*,.mid,.midi"`.

### Task 5 — MIDI Track button
- Added a second track button next to the existing "+Track" button in the transport bar:
  ```tsx
  <button onClick={() => addAudioTrack(slate, { kind: 'midi', instrumentId: SOUNDFONT_PIANO_ID, name: 'MIDI Track' })}
    className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20"
    title="Add MIDI track"><Piano size={12} />MIDI</button>
  ```
- `Piano` was already imported from lucide-react (Task from a prior round added it for the track-kind toggle). `SOUNDFONT_PIANO_ID` was already imported from `./engine`. No new imports needed.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0, 0 errors.
- `cd /home/z/my-project/slate/packages/sync-protocol && npx tsc --noEmit` → exit 0, 0 errors.
- `npx eslint src/audio/AudioEditor.tsx src/audio/scene.ts src/files/exportAudio.ts src/files/ExportDialog.tsx src/lamejs.d.ts` → 0 errors, 1 pre-existing warning (line 1293 useCallback pxPerSec dep — was at line 1127 before this round; line shift due to added helpers/comments).
