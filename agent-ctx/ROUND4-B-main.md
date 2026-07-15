---
Task ID: ROUND4-B
Agent: main (Z.ai Code)
Task: 2 fixes — (1) 2D timeline overlap with toolbar; (2) eraser partial-stroke erasure

Files modified:
1. apps/client/src/canvas2d/Toolbar.tsx
   - History & zoom bar: removed `sm:left-1/2 sm:right-auto sm:top-auto sm:bottom-2 sm:-translate-x-1/2`
     → now `absolute right-2 top-2 z-10` on every viewport. Bottom is left
     clear for Timeline2D on desktop and the mobile style strip.
   - Updated the explanatory comment.
2. apps/client/src/canvas2d/geometry.ts
   - Renamed private `distToSegment` → exported `pointToSegmentDistance`
     (same algorithm). Updated the 2 internal call sites
     (`pointInShape` line/arrow branch + `pointNearStroke`).
3. apps/client/src/canvas2d/engine.ts
   - Added `splitStroke(id: string, newStrokes: Stroke[])` — deletes the
     original stroke and commits each new stroke in a single Yjs transaction.
     Skips when `isDrawMuted()`. Mirrors commitStroke's parsing/validation.
4. apps/client/src/canvas2d/tools.ts
   - Imported `pointToSegmentDistance` from `./geometry`.
   - Rewrote `EraserTool.eraseAt`: strokes → `eraseStrokePartial` (partial);
     shapes → `pointInShape` test → `deleteIds` (whole).
   - New `eraseStrokePartial(stroke, p, radius)`:
     • Detects stride (3 if pressure, 2 if not) from `points.length % 3`.
     • Effective radius = `max(stroke.size/2 + 2, radius)` — matches
       `pointNearStroke` hit-test threshold.
     • Marks segments within effRadius; early-returns if none erased.
     • Builds sub-strokes from non-erased runs (≥2 points each).
     • Early-returns if single sub-stroke equals original (untouched).
     • `deleteIds([stroke.id])` if zero sub-strokes (fully erased).
     • Otherwise `engine.splitStroke(stroke.id, newStrokes)` — new strokes
       spread original (same kind/color/size/opacity/createdAt/authorId),
       fresh id via `makeId('stroke')`, points = sub-stroke array.

Verification:
- `npx tsc --noEmit` (from apps/client) → only 2 pre-existing TS2688 errors
  about missing `vite/client` + `vite-plugin-pwa/client` type defs
  (verified pre-existing via `git stash && tsc && git stash pop`). Zero
  source-level type errors from my changes.
- ESLint can't run (missing `eslint-config-prettier` — pre-existing env issue).
- dev.log shows `GET / 200` — project compiles cleanly via the dev server.

Notes for downstream agents:
- The eraser now performs N independent Yjs transactions per move event (one
  per stroke that needs splitting). If eraser-drag perf becomes an issue on
  dense boards, the fix is to batch all splitStroke ops into a single
  `slate.doc.transact()` — would require a new `splitStrokes(updates: {id,
  newStrokes}[])` engine method.
- `pointToSegmentDistance` is now the canonical name; `distToSegment` is gone.
  No other code in the repo imported `distToSegment` (it was private).
- Stroke splitting preserves `createdAt` so z-order is stable (the engine
  sorts by createdAt with a stable sort, and Yjs Map iteration puts new keys
  after existing ones — so the pieces visually stay at the original's
  stacking position).
