# ROUND9-B — 2D animation MP4 export

## Goal
Port the 3D viewport's `onRenderAnimation` (MediaRecorder + canvas.captureStream) pattern to the 2D timeline so users can export their cel animation as an MP4 (WebM fallback).

## Files touched
- **Created** `slate/apps/client/src/files/export2dVideo.ts`
- **Modified** `slate/apps/client/src/canvas2d/Timeline2D.tsx`

## Implementation notes

### `export2dVideo.ts`
- `export2dVideo({ canvas, fps, duration, onProgress }): Promise<void>`
- MIME negotiation order (same as 3D): `video/mp4;codecs=avc1.640028` → `video/mp4;codecs=avc1` → `video/mp4` → `video/webm;codecs=vp9` → `video/webm;codecs=vp8` → `video/webm`.
- `canvas.captureStream(fps)` + `new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 })`.
- Calls `setAnimPlaying(false)` → `setAnimFrame(0)` → `setAnimPreview(true)` before recording starts. Order matters: `setAnimFrame(0)` clears `animPreview` (only sets it true when frame > 0 or playing), so we re-flip it on afterward. The engine's render loop only repaints when `animPreview` is true (see `canvas2d/engine.ts` `loop`).
- Steps `i = 0..totalFrames-1`: `setAnimFrame(i)` + `setAnimPreview(true)` + `await wait(1000/fps)`. The setTimeout wait (not just rAF) gives `captureStream` time to sample each distinct frame — rAF alone is too fast and multiple frames collapse into a single recorder sample.
- `onProgress((i+1)/totalFrames)` per frame.
- `recorder.onstop` → Blob → download `slate-animation.{ext}` → restore `animFrame=0` + `animPreview=false`.
- One rAF before `recorder.start()` (repaint frame 0); one rAF before `recorder.stop()` (paint final frame).

### `Timeline2D.tsx`
- Added imports: `useCallback`, `Clapperboard`, `export2dVideo`, `toast`.
- State: `exporting`, `exportPct`.
- `onExportVideo` callback:
  1. Bail + toast if `!hasAnimation` (no cels on >1 frame AND no motion keyframes).
  2. Find canvas via `document.querySelector('canvas:not([aria-label])')` (skips Minimap canvas which has `aria-label="Minimap"`), fallback `document.querySelector('canvas')`.
  3. Bail + error toast if MediaRecorder/captureStream unavailable.
  4. `setAnimPlaying(false)`, call `export2dVideo`, drive `setExportPct` via `onProgress`.
  5. Success/failure toasts; `finally` resets state.
- Button: Clapperboard icon + "MP4" label, at the end of the open-timeline header (after the Frames input). Disabled while exporting or when there's no animation. While exporting: `bg-warn/20 text-warn` + live percent label.

## Verification
- `npx tsc --noEmit` from `apps/client`: only 2 pre-existing errors (`vite-plugin-pwa/client` and `vite/client` type defs missing) — both environment-level, unrelated to this task. No errors in `export2dVideo.ts` or `Timeline2D.tsx`.
- ESLint couldn't run (missing `eslint-config-prettier` in this sandbox — pre-existing).
- `dev.log` tail shows only `/health` heartbeats, no compile errors from the new code.

## Cross-agent notes
- No changes to engine/store/renderer — exporter only drives existing `animFrame`/`animPreview` store state.
- The `animPreview=true` invariant during the loop is critical: without it the engine's render loop guard (`!dirty && !live.stroke && !live.shape && !animPreview` → skip) won't repaint, and captureStream samples a static canvas.
- If a future agent adds a second interactive `<canvas>` to the 2D editor without an `aria-label`, the `canvas:not([aria-label])` selector will need to be tightened (e.g. add a `data-canvas-main` attribute to the Canvas2D `<canvas>` and select by that).
