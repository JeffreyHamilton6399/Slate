---
Task ID: ROUND5-B
Agent: Main (Z.ai Code)
Task: Fix audio playback for multiplayer — ensure samples sync and play for all peers (4 issues)

Work Log:
- Read `/home/z/my-project/worklog.md` to understand prior work (8-bug exploration + rounds 1–4). Read all 3 target files in full: `audio/sampleStore.ts`, `audio/engine.ts`, `audio/AudioEditor.tsx`. Also read `sync/RoomContext.tsx`, `sync/doc.ts` (to confirm `audioClips()` returns `Y.Map<Y.Map<unknown>>`), and the yjs `.d.ts` exports (to confirm `YMapEvent<T>` / `YMap<T>` are the exported type names — `Map` is re-exported as a named export shadowing the global).

Issue 1 — SYNC_SIZE_LIMIT too small + O(n²) base64 (sampleStore.ts):
- Bumped `SYNC_SIZE_LIMIT` from `500_000` → `5_000_000` (~5MB = ~28s mono @ 44.1kHz, covering most voice recordings and short music clips; the old 500KB limit only allowed ~2.8s and silently dropped the vast majority of clips).
- Updated the file-header comment (`~500KB` → `~5MB`) and the constant's JSDoc to the accurate "~5MB = ~28s mono @ 44.1kHz".
- Fixed the O(n²) base64 encoding in `publishToSyncMap`: replaced the `for (i…) binary += String.fromCharCode(bytes[i])` char-by-char string concat (which rebuilds the entire string on every append and freezes the main thread for several seconds on a 5MB blob) with a chunked build — `parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, end))))` in 8192-byte chunks, then `parts.join('')` + `btoa`. 8192 is the safe stack limit for `Function.prototype.apply` across JS engines. `Array.from` wraps the subarray into a true `number[]` so TypeScript's strict signature is satisfied without a cast. Total cost is now O(n).

Issue 2 — getBuffer has no retry for empty samples (engine.ts):
- Added a `private retryingClips = new Set<string>()` field to `AudioEngine` to track clips currently in a retry loop (prevents multiple concurrent retry loops for the same clip when several `play()`/`restartPlayback()` calls race — e.g. a remote clip arriving while the user is scrubbing).
- Rewrote `getBuffer`:
  1. Fast path: cache hit → return. Else if `retryingClips.has(clip.id)` → return null (a retry is already running; the AudioEditor's restart-on-sample-arrival will pick up the cached buffer once it lands).
  2. Extracted the sample-load + AudioBuffer-build into a local `buildBuffer` async helper.
  3. First attempt via `buildBuffer()` — if non-null, cache + return (the overwhelmingly common case where samples are already in IndexedDB).
  4. If empty (samples still in flight from a remote peer), enter the retry loop: add to `retryingClips`, then `for (attempt 0..9): await sleep(300ms); buildBuffer(); if non-null cache+return`. Total worst-case wait is 3s (10 × 300ms). The `finally` block always removes the clip from `retryingClips`.
  5. If all 10 retries fail, return null (clip skipped on this pass). The AudioEditor's restart-on-`slate:audio-clip-changed` will re-schedule once the samples eventually arrive.
- Only the buffer is cached after a successful (non-empty) load — never after a failed one.

Issue 3 — syncedKeys not cleared on remote delete (sampleStore.ts):
- Rewrote the `syncMap.observe` callback. Previously it did `if (syncedKeys.has(key)) continue; const base64 = syncMap.get(key); if (!base64) continue;` which meant: if a key was deleted and later re-added with the same name, the re-add was skipped forever (syncedKeys still had it).
- New logic: for each `key` in `event.keysChanged`, `const base64 = syncMap.get(key);` — if `base64 === undefined` (key was deleted or never had a value), `syncedKeys.delete(key)` and `continue` (so a future re-add is processed). If `base64` is defined but `syncedKeys.has(key)` → skip (already processed). Otherwise decode + store + dispatch `slate:audio-clip-changed` as before.

Issue 4 — mid-playback clip additions not picked up (AudioEditor.tsx + engine.ts):
- Added a `restartPlayback(slate, offset)` method to `AudioEngine`: stops all current `playingClips` sources (try/catch around `source.stop()` for already-stopped nodes), clears the array, stops the metronome, then immediately calls `void this.play(slate, offset)`. Crucially, `playing` stays `true` throughout (unlike `stop()` which sets it false) so `getPosition()` keeps tracking from the new `startTime` — no playhead jump back to 0, no UI flicker. Falls back to a plain `play()` if the AudioContext hasn't been created yet (first user gesture). There's a brief audio gap while buffers reload, but the playhead and `playing` state never glitch.
- In `AudioEditor.tsx`, added 3 refs:
  • `playingRef` — mirrors `playing` state so long-lived Yjs/event listeners read the fresh value without re-subscribing.
  • `slateRef` — mirrors `slate` for the same reason (the `slate:audio-clip-changed` effect has `[]` deps).
  • `restartTimerRef` — holds the debounce timer id.
- Added a `scheduleRestart` `useCallback` (empty deps — reads only refs): no-op if not playing; otherwise clears any pending timer and sets a 500ms `setTimeout` that calls `engineRef.current.restartPlayback(slateRef.current, positionRef.current)`. The 500ms debounce coalesces rapid bursts (e.g. a peer imports 5 files at once) into a single restart.
- Wired `scheduleRestart` into two places:
  1. The Yjs subscription effect: added a SEPARATE shallow `clips.observe(onClipsAdded)` (alongside the existing `clips.observeDeep(bump)`). `onClipsAdded` inspects `event.changes.keys` and only calls `scheduleRestart()` if at least one key has `action === 'add'` — so property edits to existing clips (volume nudges, trims) do NOT trigger a restart (that would fight the user). The cleanup calls `clips.unobserve(onClipsAdded)`. This picks up clips a remote peer adds mid-playback.
  2. The `slate:audio-clip-changed` window event listener: after the existing `invalidateWaveform` + `clearCache` + `setVersion`, it now also calls `scheduleRestart()`. This covers the case where a clip's metadata arrived (triggering a restart that returned null from `getBuffer` because samples were still in flight) and the samples arrive later — the event re-triggers a restart that picks up the now-loadable buffer.
- Added cleanup: the playhead effect clears `restartTimerRef` when `playing` turns false (so a pending mid-playback restart doesn't fire after the user presses pause). The engine-setup effect's cleanup also clears the timer before `dispose()` (so it doesn't fire on a disposed engine after unmount).
- Added `import type * as Y from 'yjs'` to AudioEditor.tsx for the `Y.YMapEvent<Y.Map<unknown>>` type annotation on `onClipsAdded` (the `clips.observe` signature requires the event type to match exactly — `YMapEvent<unknown>` is not assignable to `YMapEvent<Y.Map<unknown>>` because `YMapEvent` is invariant in T).

Verification:
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → EXIT 0, zero output (no type errors). The only iteration needed was the YMapEvent generic: first attempt used `YMapEvent<unknown>` which failed TS2345 (incompatibility in `target._eH` / `EventHandler`); fixed by using the exact `Y.YMapEvent<Y.Map<unknown>>` from the `import type * as Y` namespace import.
- Confirmed no pre-existing TS2688 (vite/client) errors in this run — the slate/apps/client tsconfig lists those types but they resolve cleanly in this workspace.

Stage Summary:
- 3 files modified: `audio/sampleStore.ts`, `audio/engine.ts`, `audio/AudioEditor.tsx`.
- Sync limit 500KB → 5MB; base64 encode is O(n) chunked instead of O(n²) char-by-char; syncMap.observe handles key deletions so delete+re-add cycles work; `getBuffer` retries for 3s on empty samples (with a per-clip Set guard against concurrent retry loops); new `engine.restartPlayback` atomically stops + re-schedules all clips without dropping `playing`; AudioEditor debounces (500ms) a `restartPlayback` call when clips are added mid-playback OR when a clip's samples arrive mid-playback, with proper cleanup on pause/unmount.
- End-to-end: a remote peer's clip (metadata + sample blob) now reliably plays on this peer whether the metadata or the samples arrive first, and whether they arrive before or after the user hits Play. The retry in `getBuffer` covers the metadata-first-samples-later race; the restart-on-sample-arrival covers the samples-late case after a failed first `getBuffer`; the restart-on-clip-add covers clips added during active playback.
- TypeScript clean (exit 0, zero errors).
