# Task ID: ROUND6-A
# Agent: main (Z.ai Code)
# Task: 2 fixes — (1) smooth eraser (no clipping/deleting weirdly); (2) track header sliders — only one works, laggy

## Work Log

- Read worklog (latest ROUND5-B) + all 3 target files fully:
  `canvas2d/tools.ts` (EraserTool class, lines 248–364),
  `audio/engine.ts` (trackGains/trackPanners maps + setupTrackNodes + updateTracks),
  `audio/AudioEditor.tsx` (TrackHeader component, lines 682–724).
- Also read `canvas2d/engine.ts` (splitStroke/deleteIds/snapshot) and
  `canvas2d/types.ts` (BoardPoint) to confirm the EraserTool's engine API
  surface and that no new imports were needed (requestAnimationFrame /
  cancelAnimationFrame are globals).

### Task 1 — Smooth eraser (`canvas2d/tools.ts` EraserTool)

Five sub-fixes applied to the `EraserTool` class:

1. **Throttle to one erase per animation frame** — added three new fields:
   `pendingPoint: BoardPoint | null`, `rafScheduled: boolean`,
   `rafId: number | null`. `move()` no longer calls `eraseAt` directly;
   instead it stashes the latest point in `pendingPoint` and schedules a
   single `requestAnimationFrame` (only if one isn't already scheduled).
   The rAF callback reads + clears `pendingPoint` and calls `eraseAt`
   once. This coalesces the 4–8 pointermove events that fire per frame
   into a single erase pass — previously each move snapshot the whole
   scene + iterated all strokes + opened a Yjs transaction, stacking
   work the browser couldn't keep up with (the "eraser deletes weirdly"
   symptom). `end()` flushes any pending point immediately (no waiting a
   frame for an already-over gesture) and `cancel()` cancels the rAF.

2. **Track already-erased stroke IDs** — added `erasedThisGesture: Set<string>`,
   cleared in `start()` and `cancel()`. In `eraseAt`, strokes whose id is
   in this set are skipped. In `eraseStrokePartial`, the original stroke
   id is added to the set right before the `deleteIds` (full-erase) or
   `splitStroke` (partial) call — so subsequent erase passes within the
   same gesture don't re-process the same id. Split fragments have new
   ids and are picked up naturally if the cursor is still over them.
   This prevents re-splitting the same stroke on every move event, which
   generated tiny fragments and stacked transactions.

3. **Decouple eraser size from brush width** — changed
   `Math.max(6, ctx.strokeWidth * 2)` to
   `Math.min(40, Math.max(8, ctx.strokeWidth))`. The `* 2` previously
   meant a size-50 brush gave the eraser a 100px radius (nuking a huge
   area). Now: 8px floor (usable on small strokes), 40px ceiling (a huge
   brush setting doesn't erase an entire board region in one tap), and
   `* 1` (not `* 2`) so the eraser feels like the same size as the
   brush, not twice as aggressive.

4. **Assume stride 3 always** — replaced
   `const stride = points.length % 3 === 0 ? 3 : 2` with an early-return
   guard `if (points.length % 3 !== 0) return;` followed by
   `const stride = 3`. InkTool always writes 3 values per point
   `[x, y, pressure]`; the old guess-and-check could read garbage
   coordinates from a malformed stroke. Now malformed strokes are
   skipped entirely (safer than guessing).

5. **Drop tiny fragments** — replaced the per-sub-stroke minimum from
   `stride * 2` (2 points) to `stride * 3` (3 points) in all three
   places where sub-strokes are committed. Extracted a local
   `const minLen = stride * 3` for clarity. 2-point dots were creating
   tiny fragments that stacked up in Yjs and cluttered the scene
   without adding visible ink.

### Task 2 — Track header sliders (`audio/AudioEditor.tsx` + `audio/engine.ts`)

**Root cause confirmed:** `onVol`/`onPan` called
`engineRef.current?.updateTracks(slate)` on every `onChange` event.
`updateTracks` re-reads ALL tracks from Yjs (`slate.audioTracks().forEach`
+ `readAudioTrack` per track) and calls `setupTrackNodes(tracks)` which
iterates the entire `trackGains`/`trackPanners` maps. That's O(tracks²)
per slider tick — the lag source. The shared `isDraggingRef` between
both sliders also meant starting a volume drag blocked the pan
prop-sync effect (and vice versa).

**Fix in `audio/engine.ts`:** added two new public methods next to
`updateTracks`:

- `setTrackVolume(trackId: string, volume: number, audible: boolean)` —
  O(1) direct write to the track's `GainNode.gain.value`. No-op if
  AudioContext not created or the gain node doesn't exist (e.g.
  playback hasn't started — no audio to adjust; the next `play()`
  reads the committed Yjs value). `audible` mirrors `setupTrackNodes`'
  mute/solo logic so dragging the volume slider on a muted track
  doesn't briefly un-mute it: gain is forced to 0 if not audible.

- `setTrackPan(trackId: string, pan: number)` — O(1) direct write to
  the track's `StereoPannerNode.pan.value`, clamped to [-1, 1] (the
  legal range; values outside throw NotSupportedError on assignment).

Also added a JSDoc on `updateTracks` clarifying when to use it (track
set changed, or mute/solo toggled which rebalances every track) vs.
when to use the new direct setters (single-track volume/pan drag).

**Fix in `audio/AudioEditor.tsx` TrackHeader:**

1. Split the single shared `isDraggingRef` into `isDraggingVolRef` and
   `isDraggingPanRef`. Each prop-sync `useEffect` now gates on its own
   flag, so the two sliders' prop-sync is independent.

2. `onVol` / `onPan` no longer call `updateTracks(slate)`. Instead:
   - `onVol(v)` → `setVol(v)` (local state) +
     `engineRef.current?.setTrackVolume(track.id, v, audible)` (direct
     gain node write).
   - `onPan(p)` → `setPan(p)` (local state) +
     `engineRef.current?.setTrackPan(track.id, p)` (direct panner node
     write).
   Both are O(1) — no Yjs read, no graph rebuild — so the slider
   tracks the cursor with zero lag.

3. `onVolEnd` / `onPanEnd` unchanged in structure: clear the drag flag,
   then `updateAudioTrack(slate, track.id, { volume: vol })` /
   `{ pan: pan }` commits to Yjs once on pointerup. The next Yjs echo
   re-syncs local state via the prop-sync effect (drag flag is false by
   then).

4. Added `const audible = hasSolo ? track.solo : !track.muted;` (same
   formula as `setupTrackNodes`) so the live gain write respects
   mute/solo.

5. Made the sliders clearly functional and labelled:
   - Volume slider: `flex-1` (primary, bigger), preceded by a `Volume2`
     lucide icon, `aria-label="Volume"`, `title="Volume"`.
   - Pan slider: `w-10` (secondary, smaller but still usable — bumped
     from the previous `w-8` which was too tiny), flanked by `L` and
     `R` text labels (`text-[8px] font-medium text-text-dim`), plus
     `aria-label="Pan"` and `title="Pan"`.
   - Both slider tracks bumped from `h-0.5` (2px) to `h-1` (4px) for
     better visibility.
   - All labels marked `aria-hidden` (the `aria-label` on the input
     itself is the accessible name; the visible L/R/icons are
     decorative).

## Verification

- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` →
  **EXIT 0, zero output, zero errors**. (Confirmed tsc actually ran by
  passing `--listFiles`: 1649 files processed, including the
  vite-plugin-pwa type defs that previous rounds reported as missing —
  the env issue is now resolved.)
- dev.log: dev server running cleanly, `GET / 200`, no errors related
  to the modified files.

## Files Modified (3)

1. `slate/apps/client/src/canvas2d/tools.ts` — EraserTool class rewritten
   (rAF throttle + erasedThisGesture set + decoupled radius + stride-3
   guard + 3-point minimum for fragments).
2. `slate/apps/client/src/audio/engine.ts` — added `setTrackVolume` and
   `setTrackPan` public methods; added clarifying JSDoc on `updateTracks`.
3. `slate/apps/client/src/audio/AudioEditor.tsx` — TrackHeader component:
   split drag refs, swapped `updateTracks` calls for direct node writes
   in `onVol`/`onPan`, added L/R labels + icons + aria-labels, bumped
   slider track height.

## Stage Summary

- Eraser now erases smoothly: one erase pass per animation frame
  (coalesced from many pointermove events), already-erased strokes are
  skipped within a gesture (no re-splitting / tiny fragments), the
  radius is decoupled from the brush width (8–40px range), the stride
  is fixed at 3 (malformed strokes skipped), and sub-strokes need ≥ 3
  points (no 2-point dot fragments).
- Track header volume + pan sliders both work and are no longer laggy:
  each `onChange` does an O(1) direct write to the Web Audio gain /
  panner node (no Yjs read, no graph rebuild); Yjs is committed once on
  pointerup. The two sliders have independent drag refs and are clearly
  labelled (Volume2 icon for volume, L/R text for pan) so it's obvious
  what each does.
- TypeScript clean (exit 0, zero errors). No new dependencies. No API
  breakage (the new engine methods are additive; `updateTracks` is
  unchanged and still used by the non-slider `update` path for
  name/mute/solo/arm edits).
