---
Task ID: ROUND4-A
Agent: main (Z.ai Code)
Task: 3 audio editor fixes — (1) zoom centering on playhead + adaptive ruler ticks; (2) track header slider drag-fighting fix; (3) RotaryKnob drag reliability + separate speed/pitch knobs

Files modified:
1. apps/client/src/audio/AudioEditor.tsx
   - Added `useLayoutEffect` to imports.
   - Added `pendingScrollRef` (number | null) to hold desired scrollLeft.
   - New `zoomAtPlayhead(newPxPerSec)` useCallback:
     • playheadOffset = positionRef.current * oldPxPerSec - scrollLeft
     • newScrollLeft = positionRef.current * newPxPerSec - playheadOffset
     • stashes newScrollLeft in pendingScrollRef, calls setPxPerSec.
   - New `useLayoutEffect([pxPerSec])` applies pendingScrollRef to
     scrollRef.scrollLeft (after React commits the new minWidth so the
     scrollWidth isn't stale). Layout effect = before paint, no flash.
   - Ctrl+scroll wheel handler: reads pxRef.current, computes next, calls
     zoomAtPlayhead. Dep array now [zoomAtPlayhead].
   - Zoom out/in buttons: replaced setPxPerSec((c) => ...) with
     zoomAtPlayhead(pxRef.current * or / 1.3).
   - fitToWindow: now goes through zoomAtPlayhead too.
   - Adaptive ruler ticks via useMemo([pxPerSec]) → { tickInterval, formatTick }:
     • >=400 → 0.1s, `X.Xs`
     • >=100 → 1s, `Xs`
     • >=40  → 5s, `Xs` (previous fixed interval)
     • >=10  → 10s, `Xs`
     • <10   → 60s, `Xm` or `Xm Ys`
   - Ruler render: replaced fixed 5s step with tickInterval + formatTick(t).
   - TrackHeader: added isDraggingRef. Both prop-sync useEffects now
     early-return when isDraggingRef.current is true. Added onVolDown/
     onPanDown (set ref true) wired to <input onPointerDown>. onVolEnd/
     onPanEnd now clear the ref BEFORE committing to Yjs.

2. apps/client/src/panels/AudioSettingsPanel.tsx
   - RotaryKnob: replaced setPointerCapture with WINDOW-level listeners.
     onPointerDown creates onMove + onUp closures, adds them to window
     (pointermove + pointerup). onMove reads dragRef.current + uses
     onChangeRef.current (freshest onChange). onUp clears dragRef + removes
     both listeners. Removed onPointerMove/onPointerUp React props on <svg>.
     Used valueRef.current for startVal (consistency with wheel listener).
   - Sensitivity: 150 normal (was 200), 400 fine/Shift (was 600).
   - Replaced single "Speed / Pitch" knob with a 2-col grid:
     • Speed: 0.25×..4×, step 0.05, clip.speed, format `${v.toFixed(2)}×`.
     • Pitch: -12..+12 semitones, step 1. value = (clip.pitch ?? 0) / 100
       (cents → semitones for display). onChange = (v) => setClip({ pitch:
       v * 100 }) (semitones → cents for storage). Format rounds to integer
       and prefixes + for positive: `+5 st`, `-3 st`, `0 st`.

3. apps/client/src/audio/scene.ts
   - readAudioClip: added `pitch: (m.get('pitch') as number) ?? 0` so old
     clips default to 0 (no pitch shift).

4. apps/client/src/audio/engine.ts
   - After `source.playbackRate.value = speed`, added
     `if (pitchCents !== 0) source.detune.value = pitchCents` (pitchCents
     from `clip.pitch ?? 0`). Documented the Web Audio limitation in a
     comment: AudioBufferSourceNode couples pitch and speed
     (effectiveRate = playbackRate * 2^(detune/1200)); true
     pitch-independent-of-speed requires offline time-stretching (out of
     scope). The two knobs still give independent control — to hold
     timeline speed constant while shifting pitch, set
     speed = 1 / 2^(pitch/1200) to compensate.

5. packages/sync-protocol/src/schema.ts
   - Added `pitch?: number` to AudioClip interface. Documented as cents
     (-1200..+1200), matching the unit Web Audio's `detune` AudioParam
     expects. Default 0.

Verification:
- `cd apps/client && npx tsc --noEmit` → only the 2 pre-existing TS2688
  errors about missing `vite/client` + `vite-plugin-pwa/client` type defs
  (confirmed pre-existing by ROUND4-B; none of my modified files appear in
  the error list). Zero source-level type errors.
- `cd packages/sync-protocol && npx tsc --noEmit` → only a pre-existing
  TS2307 about `vitest` in `validators.test.ts` (test file, unrelated).
- dev.log shows the dev server compiling cleanly (GET / 200); no errors
  related to the modified files.

Notes for downstream agents:
- The pitch knob uses `detune` which compounds with `playbackRate` (both
  affect effective rate). This is a Web Audio limitation, not a bug. If a
  future task wants TRUE pitch-independent-of-speed, the fix is to
  time-stretch the source AudioBuffer offline (e.g. via a phase vocoder or
  RubberBand library) — that's a significant addition, not a small fix.
- The `isDraggingRef` pattern in TrackHeader is reusable for any slider
  that has both local state AND a Yjs/prop-sync useEffect. The key insight:
  gate the sync effect with a ref that's true during drag, false otherwise.
- `zoomAtPlayhead` works for ANY horizontal-scroll + scale change scenario.
  The pendingScrollRef + useLayoutEffect pattern is necessary because
  setting scrollLeft immediately after setState would be clamped by the
  stale scrollWidth (React hasn't committed the new minWidth yet).
- The window-level pointer listener pattern in RotaryKnob is more reliable
  than setPointerCapture across browsers. The same pattern could be applied
  to the loop-region drag in AudioEditor (which currently uses window
  listeners already) and the clip drag/trim (which also uses window
  listeners) — both are already correct.
