# ROUND31-A — Fix audio editor mobile layout + add Presentation mode

## Files modified

### Task 1 — Audio editor mobile layout
1. `slate/apps/client/src/audio/AudioEditor.tsx`
   - Transport bar: split into two rows on mobile (Row 1 primary =
     SkipBack / Play / Record / position / Split / Delete; Row 2
     scrollable = Duplicate / Copy / Paste / BPM / Metronome / Loop /
     Snap / Volume / Zoom / Fit / Import / Track / MIDI). Desktop
     keeps the existing single-row layout, now without the
     `!isMobile &&` guards around BPM/Volume since the desktop branch
     always has room.
   - `TrackHeader` (memo'd) now calls `useIsMobile()` itself and hides
     BOTH the kind toggle AND the volume/pan slider row (and the MIDI
     instrument picker) on mobile. On mobile the top row gets `h-full`
     so it centers vertically in the 60px track height.
   - Status bar: bumped `text-[8px]` → `text-[10px]`, added
     `tracking-wider`, dropped the long keyboard cheat sheet on mobile
     (replaced with the two hints that still apply on touch — seek +
     ctrl+scroll zoom).

### Task 2 — Presentation (slides) mode
2. `slate/packages/sync-protocol/src/schema.ts`
   - `DocMode` extended with `'presentation'`.
   - `SlateDocSnapshot.slides?: { id; content; background }[]` added.
3. `slate/packages/sync-protocol/src/constants.ts`
   - `export const SLIDES_KEY = 'slides';`
4. `slate/apps/client/src/sync/doc.ts`
   - Imported `SLIDES_KEY` from `@slate/sync-protocol`.
   - Added `slides: () => Y.Array<Y.Map<unknown>>` to the `SlateDoc`
     interface and the `createSlateDoc()` factory
     (`doc.getArray<Y.Map<unknown>>(SLIDES_KEY)`).
5. `slate/apps/client/src/files/snapshot.ts`
   - New `snapshotSlides()` helper; `snapshotDoc` now writes
     `slides: snapshotSlides(slate)`.
   - `applySnapshot` clears `slate.slides()` and repopulates from
     `snap.slides` inside the existing Yjs transaction.
6. `slate/apps/client/src/presentation/PresentationEditor.tsx` (NEW)
   - Left-side slide navigator (thumbnail list, hidden on mobile).
   - Centered 16:9 editing surface with a `contenteditable` div bound
     to the slide's `content` HTML string. Commits are debounced
     250ms; a `selfCommitRef` flag suppresses the Yjs observer's
     re-render of our own edit (avoids caret jumps).
   - Toolbar: add / duplicate / delete slide, B/I/U + bullet/numbered
     list (execCommand — no TipTap), background color swatches,
     prev/next + slide counter, Present button.
   - Present mode: fullscreen overlay with the current slide; ←/→/
     Space navigate, Esc exits. The browser's fullscreenchange event
     keeps `presenting` state in sync if the user hits Esc.
   - Empty decks seed one blank slide (id from `makeId('slide')`).
7. `slate/apps/client/src/app/Workspace.tsx`
   - `const PresentationEditor = lazy(() => import('../presentation/PresentationEditor'));`
   - Added a `board.mode === 'presentation'` branch in the central
     editor switch (with Suspense fallback "presentation editor").
8. `slate/apps/client/src/app/Home.tsx`
   - Imported `Presentation as PresentationIcon` from lucide.
   - `linkMode` whitelist now includes `'presentation'`.
   - Mode toggle cycle extended: `2d → 3d → audio → doc → code →
     diagram → presentation → 2d`. onIcon and onLabel branches updated.
9. `slate/apps/client/src/app/Onboarding.tsx`
   - Same `PresentationIcon` import + `linkMode` whitelist + cycle
     extension (onLabel uses `'Slides'` here, matching the shorter
     onboarding style).
10. `slate/apps/client/src/app/modeColors.ts`
    - `presentation` → `orange-500` (badge `/15`, header `/10`, text
      `text-orange-300`). Distinct from `amber-500` (audio) and any
      red/danger tone.
11. `slate/apps/client/src/app/Header.tsx`
    - Mode label: `board?.mode === 'presentation' ? 'Presentation' : …`
12. `slate/apps/client/src/app/App.tsx`
    - `linkMode` from URL `?mode=` now recognizes `'doc'`, `'code'`,
      `'diagram'`, `'presentation'` (the old ternary only handled
      2d/3d/audio, so a `?mode=presentation` share link silently
      fell back to `'2d'`).
13. `slate/apps/client/src/panels/registerBuiltInPanels.ts`
    - `registerPanel({ id: 'ai-presentation', …, mode: 'presentation' })`
      — AI Assistant on the right, same as diagram/doc.

## Key design notes for downstream agents
- The PresentationEditor's `contenteditable` ↔ Yjs binding pattern
  (debounced commit + `selfCommitRef` to suppress the observer's
  re-render of our own edit + `el.innerHTML !== slide.content` guard
  before rewriting DOM) is the simplest reliable way to bind a
  contenteditable to a Y.Map string field WITHOUT pulling in
  ProseMirror. If you add a TipTap-backed slide editor later, the
  Y.Map shape stays the same (`{ id, content, background }`).
- `slides` lives at the TOP LEVEL of the Y.Doc
  (`doc.getArray('slides')`) for the same reason as scene/audio
  containers — see the doctrine comment at the top of `sync/doc.ts`.
  Do NOT nest it under a parent Y.Map.
- The PresentationEditor seeds a blank slide on first mount if the
  deck is empty. This means a peer who joins a brand-new deck may
  also seed a blank slide — Yjs will merge both pushes, briefly
  leaving 2-3 blanks. That's fine and intended (the user can delete
  the extras); the alternative (locking seeding to the host) adds
  latency to the first-paint experience.
- The audio editor's mobile transport now has buttons sized for
  touch (h-8/h-9/h-10 instead of h-7). The status bar text bump
  (8px → 10px) brings it in line with the presentation editor's
  status bar.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` →
  exit 0, no errors.
- `cd /home/z/my-project/slate/apps/server && npx tsc --noEmit` →
  exit 0, no errors (server uses `DocMode` too).
- `cd /home/z/my-project/slate/packages/sync-protocol && npx tsc --noEmit`
  → exit 0.
- ESLint on all 11 modified client files: 0 errors, 3 pre-existing
  warnings in `Workspace.tsx` / `AudioEditor.tsx` (missing-deps
  warnings on hooks that intentionally read refs — not introduced by
  this change).

Full worklog entry appended to `/home/z/my-project/worklog.md`.
