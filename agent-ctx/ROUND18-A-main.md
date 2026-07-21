# ROUND18-A — Export dialog per-mode + Code editor split-view preview

## Scope
Three fixes for the Slate client (`apps/client/src`):
1. `files/ExportDialog.tsx` — doc + code modes used to fall through the 2D
   branch and offer PNG/JPG/MP4 (silently wrong). Now they have their own
   format lists and export branches.
2. `app/Header.tsx` — File menu now hides Print for audio mode (already
   hidden for 3D).
3. `code/CodeEditor.tsx` — added a split-view live preview (Bolt.new / z.ai
   style) with an Eye toggle in the toolbar.

## Changes

### `files/ExportDialog.tsx`
- Imports `docFragmentToMarkdown` (from `../docs/exportMarkdown`) and
  `codeZipBlob`, `listCodeFiles` (from `../code/exportCode`).
- `ExportFormat` union now includes `'md' | 'html' | 'zip' | 'file'`.
- `defaultFormatForMode` accepts the full `'2d' | '3d' | 'audio' | 'doc' | 'code'`
  union; returns `'md'` for doc and `'zip'` for code.
- The dialog reads `board?.mode` once and casts to the full union (no longer
  silently casts doc/code down to '2d').
- Added `isDoc` and `isCode` boolean branches.
- Added `FORMAT_INFO` entries for `md`, `html`, `zip`, `file`.
- `formats` array and `description` line branch on doc/code.
- `onExport`:
  - **doc + md** → `docFragmentToMarkdown(room.slate.docText())`, download
    `${boardName}.md`.
  - **doc + html** → wrap the markdown in a standalone HTML document
    (title + body both HTML-escaped, body is a `<pre>`) via a new
    `docMarkdownToStandaloneHtml` helper. The DocEditor's rich-HTML export
    path needs the live TipTap instance which the dialog can't reach, so
    this is a faithful-but-flat fallback (markdown-as-text in a styled
    page). Discussed in the file comment.
  - **code + zip** → `codeZipBlob(room.slate)`, download `${boardName}.zip`.
  - **code + file** → reads the active file id from
    `window.__slateCodeActiveFileId` (published by CodeEditor), falls back
    to the first file in the map, and downloads its Y.Text content as
    `${active.name}`.
- Added doc and code info panels (the small grey tip box at the bottom of
  the dialog) describing each format.
- `raster` flag now excludes doc and code modes (so the size/quality panel
  never shows for them).

### `app/Header.tsx`
- File menu Print item now hidden when `board?.mode === '3d'` OR
  `board?.mode === 'audio'` (was 3D-only). Code mode keeps Print (printing
  code is useful). Save / Save As / Open / Import / Export stay for every
  mode (Export now that ExportDialog handles doc/code).

### `code/CodeEditor.tsx`
- New imports: `Eye`, `RefreshCw` from lucide-react; `buildPreview`,
  `PreviewFile` from `./preview`.
- New state: `showPreview` (default false), `splitPct` (default 50),
  `previewSrcDoc`, `previewEntry`, `previewReason`, `previewDebounceRef`.
- `rebuildPreview` callback: reads every file's `codeText` off Yjs and
  hands the array to `buildPreview`, which inlines local `<link>` /
  `<script src>` into the entry HTML (prefers `index.html`, falls back to
  the shallowest `.html`, then to a lone `.js` with a console mirror).
- Two effects: (a) rebuild when `showPreview` flips on; (b) auto-refresh
  with a 400ms debounce on any Y.Doc update while the preview is visible.
- A new effect publishes `window.__slateCodeActiveFileId` whenever
  `activeId` changes, and deletes it on unmount — this is what the
  ExportDialog's `file` branch reads so it can download "the active file"
  without a context/store.
- `startSplitDrag` — basic mouse-driven splitter drag. Clamps the split
  to `[20%, 80%]`, sets a global `col-resize` cursor and disables text
  selection during the drag, restores both on mouseup. Double-click resets
  to 50%.
- Toolbar: added an Eye toggle button after the Download button. The
  active state uses `bg-accent/15 text-accent` to match the wrap/preview
  accent pattern; inactive uses the standard `text-text-mid hover:bg-bg-3`
  pattern.
- Editor wrapper now uses `flex` (was `relative flex-1 min-h-0`); the
  CM host div gets an inline `width: ${splitPct}%` when preview is on and
  `width: 100%` when off. The hostRef div is rendered unconditionally
  inside the `activeId ? … : …` branch so toggling preview never unmounts
  the editor (no scroll/cursor loss).
- When preview is on and a file is active, the wrapper renders a 1px
  drag-resizable divider followed by the preview column: a small header
  strip (Eye icon + "Preview" + entry name + Refresh button) and the
  iframe (`sandbox="allow-scripts"` only, `srcDoc={previewSrcDoc}`,
  `bg-white`). If there's no HTML/script, the iframe area shows the
  `previewReason` ("Add an index.html (or a .js file) to see a live
  preview." etc).
- Command palette gained a "Show preview / Hide preview" entry.
- File header comment updated to describe the new preview feature; the
  old "Code does NOT execute" line is replaced because the preview now
  does execute (in a sandboxed null origin).

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0
  (had to `bun install` the monorepo first; node_modules was empty).
- `npx eslint src/files/ExportDialog.tsx src/app/Header.tsx src/code/CodeEditor.tsx`
  → exit 0, no warnings.

## Notes for downstream agents
- `window.__slateCodeActiveFileId` is the contract between CodeEditor
  (publisher) and ExportDialog (subscriber). If a future agent moves the
  active-file state into a zustand store, drop the `window` bridge and
  read the store directly from ExportDialog.
- The doc HTML export is intentionally a flat `<pre>` of the markdown —
  the rich HTML path lives in DocEditor.tsx's toolbar and needs a live
  TipTap instance. If you want the dialog to also produce rich HTML, the
  cleanest fix is to extract the DocEditor's HTML-template helper into a
  shared module that takes a `Y.XmlFragment` and renders via TipTap's
  `generateHTML` (would add `@tiptap/core` + the doc's extension list to
  the ExportDialog's eager bundle).
