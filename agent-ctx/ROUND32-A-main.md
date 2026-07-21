# ROUND32-A — Upgrade the Presentation editor to be fully polished with lots of tools

## Files created

1. `slate/apps/client/src/presentation/presentationBridge.ts` (NEW)
   - `PRESENTATION_COMMAND_EVENT = 'slate:presentation-command'`
   - `PresentationCommandDetail { command: string; value?: string }`
   - `runPresentationCommand(command, value?)` dispatches a CustomEvent.
   - Mirrors `docs/docBridge.ts` (same pattern, different event name so the
     two editors don't cross-talk).

2. `slate/apps/client/src/panels/PresentationToolsPanel.tsx` (NEW)
   - Mirrors `DocToolsPanel.tsx` structure: grouped tool grids, each
     button dispatches a `slate:presentation-command` window event.
   - Groups: Slide (add/duplicate/delete/move left/move right), Text
     (H1/H2/bold/italic/underline/strike/text color/clear format),
     Lists (bullet/numbered), Align (left/center/right), Design
     (background swatches + font size popover), Actions (present /
     export HTML).
   - Text color = label-wrapped native `<input type="color">` (same
     pattern as DocToolsPanel).
   - Font size = popover with presets 12/14/16/18/24/32/48/64px + a
     "Default" entry that clears the size.
   - Background swatches = 10 solids + 3 gradients (sunset / ocean /
     forest). Gradients render with `backgroundImage`; solids with
     `backgroundColor`.
   - Add Slide = a popover with 5 template choices (blank / title /
     title+content / two-column / section divider). Dispatches
     `addSlideTemplate` with the template id.
   - Footer hint summarizing drag-to-reorder + keyboard shortcuts.

## Files modified

3. `slate/apps/client/src/presentation/PresentationEditor.tsx` (REWRITTEN)
   - **Command listener**: subscribes to `PRESENTATION_COMMAND_EVENT`
     and routes each command to either a slide mutation
     (addSlideTemplate / duplicateSlide / deleteSlide / moveSlideLeft
     / moveSlideRight) or a `document.execCommand` formatting call
     (bold / italic / underline / strikeThrough / formatBlock h1-h3 /
     foreColor / removeFormat / insertUnorderedList /
     insertOrderedList / justifyLeft/Center/Right) or a design action
     (setBackground / setTransition) or an action (present /
     exportHtml).
   - **Font size**: implemented via `range.surroundContents(<span
     style="font-size:Npx">)` (with an extract-then-insert fallback
     for cross-element selections) instead of `execCommand('fontSize')`
     which only accepts the legacy 1–7 scale. `clearFontSize` walks
     the selection and strips `font-size` from every parent style.
   - **Slide templates**: `templateHtml(id)` returns the inline-styled
     HTML for blank / title / title+content / two-column / section.
     `addSlideInternal(templateId)` seeds a new slide's `content`
     field with the template HTML before pushing it to Yjs.
   - **Drag-to-reorder**: pointerdown on a thumbnail `<li>` starts a
     drag (records `from` index + start coords); document-level
     `pointermove` uses `elementFromPoint` + `closest('[data-slide-idx]')`
     to find the thumbnail under the pointer and updates `over`;
     document-level `pointerup` calls `moveSlideTo(from, over)`.
     A 4px movement threshold distinguishes click vs drag — the
     button's `onClick` checks `dragStateRef.current?.moved` and
     suppresses the selection if a drag happened. (Did NOT use
     `setPointerCapture` because it would swallow `pointerenter` on
     sibling thumbnails.)
   - **Right-click context menu**: a `ContextMenu` popover at the
     click coords with Add / Duplicate / Move left / Move right /
     Delete. Closes on outside click or Escape. Items disable
     themselves at deck boundaries (can't move left at index 0, etc.).
   - **Speaker notes**: a toggle button in the toolbar opens a
     collapsible `<textarea>` below the editing surface. Bound to the
     slide's `notes` Y.Map field with the same debounced-commit +
     `selfNotesCommitRef` pattern as content (separate 250ms timer so
     editing notes doesn't reset the content debounce).
   - **Slide transitions**: a `<select>` in the toolbar for
     none/fade/slide/zoom, stored in the slide's `transition` Y.Map
     field. In present mode, the slide container carries a
     `present-transition-{id}` class and a `key={presentKey}` that
     bumps on every navigation, re-triggering the CSS `@keyframes`
     animation (pFade / pSlide / pZoom).
   - **Export HTML**: `exportHtml()` builds a standalone HTML doc
     (one `<section>` per slide, backgrounds + content + notes
     inline, `@media print` page-break rules) and downloads it as
     `{boardName}.html`. Reads `room.room` for the board name.
   - **Keyboard shortcuts** (only when not presenting, and only when
     not editing text for nav/delete):
     - Ctrl+Shift+N → add slide
     - Ctrl+Shift+D → duplicate slide
     - Ctrl+Shift+P → present
     - ArrowLeft / PageUp → prev slide
     - ArrowRight / PageDown → next slide
     - Delete / Backspace → delete slide
   - **Improved present mode**: slide counter (top-left), progress
     bar (bottom), click-to-advance on the backdrop, transitions
     applied via CSS keyframes, prev/next/exit controls
     (bottom-right, hover to reveal), inline `<style>` block with
     the transition keyframes.
   - **Improved editing surface**: 16:9 aspect, centered with
     `shadow-xl`, background color OR gradient applied (the
     `activeBgStyle` helper branches on `linear-gradient`/`
     radial-gradient` prefix), click anywhere to edit, empty-
     contenteditable placeholder via
     `[data-placeholder]:empty::before { content: attr(data-placeholder); }`.
   - **Improved slide navigator**: slide numbers on thumbnails
     (rendered inside a tiny swatch of the slide's background so the
     number stays legible on any bg), drag-to-reorder with a
     `ring-2 ring-accent/60` indicator on the drop target, right-
     click context menu, accent border on the active slide, and a
     `↻` indicator on slides with a non-`none` transition.
   - **Slide Y.Map shape** now `{ id, content, background, notes,
     transition }` — `readSlide` defensively coerces `transition`
     to the union, falling back to `'none'` for unknown values.

4. `slate/apps/client/src/panels/registerBuiltInPanels.ts`
   - Imported `PresentationToolsPanel`.
   - Registered `presentation-tools` (left dock, order 0, mode
     'presentation') BEFORE the `ai-presentation` registration so
     it's the first tab in the left zone (mirrors doc-tools /
     diagram-tools placement).
   - Updated the comment on `ai-presentation` (was "no presentation-
     specific panels yet").

5. `slate/apps/client/src/files/ExportDialog.tsx`
   - Added `'presentation'` to the `mode` union type and a
     `defaultFormatForMode` branch (→ `'html'`).
   - Added `'pdf'` to the `ExportFormat` union + a `FORMAT_INFO`
     entry.
   - Added an `isPresentation` flag.
   - Added a presentation export branch in `onExport`: reads slides
     straight from `room.slate.slides()` via the new
     `presentationDeckToHtml(slate, boardName)` helper; `'html'`
     downloads the file, `'pdf'` calls `printHtmlInIframe(html)`.
   - Added `presentationDeckToHtml(slate, boardName)` — builds the
     same standalone HTML structure the PresentationEditor's toolbar
     export uses (one `<section>` per slide, inline styles,
     `@media print` page-break-per-slide).
   - Added `printHtmlInIframe(html)` — creates a hidden 0×0 iframe,
     writes the HTML, waits 200ms for layout, calls
     `iframe.contentWindow.print()`, cleans up on `afterprint` (or a
     30s timeout fallback for Safari). Avoids popup blockers and
     keeps the print CSS scoped to the iframe.
   - Added `'presentation'` to the `formats` ternary (→ `['html',
     'pdf']`) and the `raster` exclusion + `description` branch.
   - Added a presentation info box (format-dependent description
     for HTML vs PDF export).

## Verification

- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` →
  **EXIT 0**, zero type errors.
- Dev server log tail: only routine `/health 404` and `/ 200`
  entries; no compile errors after the edits.

## Key design notes for downstream agents

- The `contenteditable` ↔ Yjs binding pattern (debounced commit +
  `selfCommitRef` to suppress the observer's re-render of our own
  edit + `el.innerHTML !== slide.content` guard before rewriting
  DOM) is unchanged from ROUND31-A — it's the simplest reliable way
  to bind a contenteditable to a Y.Map string field without pulling
  in ProseMirror. The notes field uses the SAME pattern with a
  SEPARATE `selfNotesCommitRef` + `notesTimerRef` so the two
  debounces don't reset each other.
- Font size uses `range.surroundContents(<span style="font-size:Npx">)`
  instead of `execCommand('fontSize')` because the legacy command
  only accepts sizes 1–7 (the old HTML `<font size="">` scale).
  The surroundContents call has a try/catch fallback to
  extractContents + insertNode for selections that cross element
  boundaries (where surroundContents throws).
- The drag-to-reorder deliberately avoids `setPointerCapture` —
  pointer capture routes ALL pointer events to the captured element,
  which means `pointerenter` on sibling thumbnails would never fire.
  Instead, document-level `pointermove` uses `elementFromPoint` +
  `closest('[data-slide-idx]')` to find the thumbnail under the
  pointer. The 4px movement threshold + the `dragStateRef.current?.moved`
  check in the button's `onClick` prevents a drag release from also
  selecting the drop target as the active slide.
- The present-mode transitions work via a `key={presentKey}` on the
  slide container that bumps on every navigation — React remounts
  the container, the CSS `@keyframes` animation re-runs. The
  `present-transition-{id}` class selects which keyframe (pFade /
  pSlide / pZoom / none).
- The `presentationDeckToHtml` helper lives in ExportDialog.tsx (not
  in a shared util) because it duplicates the PresentationEditor's
  inline `exportHtml` callback — the editor can't be reached from
  the dialog (no editor instance is exposed), so both paths read
  from Yjs independently. If you add a third export path, factor
  this out into `presentation/exportDeck.ts`.
