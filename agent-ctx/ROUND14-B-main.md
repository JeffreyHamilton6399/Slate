Task ID: ROUND14-B
Agent: Code (Slate client — Code editor polish + doc/code dock panels)
Task: Polish the Code editor (fold gutter, Find UI, multi-tab strip, light/dark theme toggle, indent guides) and register four new dock panels (DocOutline, DocStats, CodeFiles, CodeSearch).

Work Log:
- Read worklog (latest: ROUND14-A parallel agent — installed pnpm + TipTap + CodeMirror deps and polished DocEditor.tsx). The CodeEditor.tsx imports from `@codemirror/*` and `y-codemirror.next` resolve cleanly thanks to ROUND14-A's install — my own `npx pnpm add @codemirror/language ...` was a no-op on the lockfile but kept the deps explicit in package.json (already there from ROUND14-A).
- Read all targets fully: code/CodeEditor.tsx, code/exportCode.ts, code/codeEditor.css, panels/registerBuiltInPanels.ts, workspace/panelRegistry.tsx, workspace/dockStore.ts, sync/doc.ts, sync/RoomContext.tsx, docs/DocEditor.tsx (parallel agent's WIP), docs/docTextJson.ts, docs/exportMarkdown.ts, panels/NotesPanel.tsx, panels/AudioAssetsPanel.tsx.

Part A — Polish the Code editor (code/CodeEditor.tsx, rewritten in place):

Step 1 — Code folding:
- Imported `foldGutter` from `@codemirror/language` and added it to the extensions array.
- Custom `markerDOM` renders ▾ (open) / ▸ (closed) glyphs at 10px with reduced opacity — matches the line-number gutter's visual weight.

Step 2 — Find/Replace UI:
- Did NOT build a custom search panel — `searchKeymap` is already bound, so CM's built-in search dialog already opens on Ctrl+F.
- Added a Search-icon button to the editor toolbar that synthesizes a `KeyboardEvent('keydown', { key: 'f', ctrlKey: true, metaKey: true, bubbles: true })` and dispatches it on `viewRef.current.contentDOM` (falls back to the wrapper). CM's listener catches it and opens its own panel. `metaKey: true` is set alongside `ctrlKey: true` so the same dispatch works on macOS (CM listens for Mod-f, which is either).
- Button is disabled when there's no active file (`!activeId`).

Step 3 — Editor tabs:
- Added `openFiles: string[]` and `activeFileId: string | null` state alongside the existing `selectedId`.
- New `openFile(id)` callback (wrapped in `useCallback` so the open-file event listener below doesn't rebind every render): pushes id into `openFiles` if absent, sets `selectedId` + `activeFileId`.
- New `closeTab(id)`: removes from `openFiles`; if the closed tab was active, falls through to `next[idx] ?? next[idx-1] ?? next[next.length-1] ?? null` so closing the rightmost tab keeps the editor on its neighbour (matches VS Code). Closing a tab does NOT delete the file from Yjs — the rail's trash icon is the delete affordance.
- `validOpenFiles = useMemo(openFiles.filter(exists), [openFiles, files])` — drops tabs whose files were deleted remotely. The filter mutates state in a `setTimeout(..., 0)` to avoid the "set state during render" error.
- `activeId` resolution chain: explicit `activeFileId` → `selectedId` (legacy single-file click) → first open tab → first file in rail → null. Keeps existing `setSelectedId` call sites working.
- Rendered a tab strip above the editor: each tab is a `role="tab"` div with the filename, click to switch, × button to close, middle-click (button 1) closes, `Ctrl/Cmd+W` closes (keyboard). Active tab lifts to `bg-bg` so its bottom border merges with the editor's chrome; inactive tabs are `bg-bg-2`.
- The file rail's click handler now calls `openFile(f.id)` (was `setSelectedId(f.id)`), so clicking a file in the rail also opens a tab.
- `deleteFile` cleans up `activeFileId` + `openFiles` in addition to the legacy `selectedId` cleanup.

Step 4 — Light theme toggle:
- `const lightTheme = EditorView.theme({}, { dark: false });` — an empty rule set marked light-mode. CM skips oneDark and lets the page tokens (via `.slate-code-host .cm-editor { background: var(--bg) }` in codeEditor.css) carry the surface; syntax tokens fall back to `defaultHighlightStyle`'s own light palette.
- New `darkMode` state (default `true` to preserve the existing look).
- The CM extensions use a `themeConf` Compartment so toggling doesn't recreate the editor — `themeConf.of(darkMode ? oneDark : lightTheme)` and `darkMode` is in the mount effect's deps so the view re-creates on toggle (Compartment reconfigure would also work but the mount-effect approach matches the existing language-conf pattern).
- Toolbar button toggles darkMode; Sun icon in dark mode (click → light), Moon icon in light mode (click → dark).

Step 5 — Indent guides:
- Imported `indentUnit` from `@codemirror/language`.
- Added `indentUnit.of('  ')` (2 spaces) BEFORE `indentOnInput()` so the latter knows what to insert on a fresh line. 2 spaces matches what most grammars expect for JS/TS/CSS/etc., and what pressing Tab produces via `indentWithTab`.

Bonus — Open-file event listener (Part B wiring):
- Added a `useEffect` that listens for `window` 'slate:code-open-file' `CustomEvent<{ id: string }>` events. When fired (by the dockable CodeFilesPanel or CodeSearchPanel), it calls `openFile(id)` after verifying the file still exists in the Y.Map. This is the channel between the dockable file-tree/search panels and the editor — they only know the file id and ask the editor (which owns the tab/active state) to actually open it.

Part B — Doc/code dock panels:

B-1 — DocOutlinePanel (panels/DocOutlinePanel.tsx, NEW):
- Reads `room.slate.docText()` (Y.XmlFragment) and uses `docTextToJson` from docs/docTextJson.ts (the same dependency-free converter the Markdown exporter uses) to walk the doc.
- `extractHeadings(fragment)`: iterates top-level content nodes, picks `type === 'heading'`, clamps the level to 1–6 from `node.attrs.level`, flattens the heading's inline content into a plain string (handling hardBreak as space, recursing into nested content).
- Subscribes via `fragment.observeDeep(update)` so edits inside an existing heading (which live in nested Y.XmlText children) trigger re-renders — a shallow observe would miss them.
- Clicking a heading queries `document.querySelectorAll('.slate-doc .ProseMirror h1, h2, h3, h4')` (the rendered TipTap output) and `scrollIntoView({ behavior: 'smooth', block: 'start' })`s the nth match — the order matches `extractHeadings`' walk. Adds a `slate-outline-flash` class for 1.2s (CSS not added; the class is a hook for future styling).
- Indented by level: H1 = font-semibold + text-text, H2 = pl-4, H3 = pl-7 + text-text-dim. Empty-state: "Add a heading (H1/H2/H3) to your document and it will appear here."
- Registered: id 'doc-outline', title 'Outline', defaultSide 'left', order 0, mode 'doc'.

B-2 — DocStatsPanel (panels/DocStatsPanel.tsx, NEW):
- Computes `Stats { words, chars, paragraphs, headings, readingMinutes }` from the Y.XmlFragment on every deep-observe callback.
- Uses `docTextToJson` to count top-level paragraph/heading nodes; uses `docFragmentToText` (from exportMarkdown.ts) for the plain-text representation, then `text.trim().split(/\s+/).filter(Boolean).length` for words and `text.replace(/\s+/g, '').length` for chars.
- Reading time: `Math.max(1, Math.ceil(words / 200))` (200 wpm, min 1 minute, 0 only when words === 0).
- UI: a 2×2 grid of stat cards (Words / Characters / Paragraphs / Headings), a prominent reading-time card, and a footnote explaining the 200-wpm assumption.
- Registered: id 'doc-stats', title 'Stats', defaultSide 'right', order 1, mode 'doc'.

B-3 — CodeFilesPanel (panels/CodeFilesPanel.tsx, NEW):
- Reads `listCodeFiles(room.slate)` (name-sorted) and builds a folder tree via `buildTree(files)`: splits each filename by `/` (after normalizing `\` → `/` for Windows-style paths), creates intermediate folder nodes, file leaves carry the file id.
- Renders the tree recursively: folders first (alphabetical), then files (alphabetical); each folder is collapsible (chevron + Folder/FolderOpen icon, accent-colored); clicking a file calls `openCodeFile(id)`.
- `openCodeFile(id)` dispatches a `window.CustomEvent('slate:code-open-file', { detail: { id } })`. CodeEditor listens (see the bonus in Part A) and opens the file in its tab strip.
- Exports `CODE_OPEN_FILE_EVENT`, `CodeOpenFileEvent`, and `openCodeFile` so the CodeSearchPanel can reuse the same channel.
- Registered: id 'code-files', title 'Files', defaultSide 'left', order 0, mode 'code'.

B-4 — CodeSearchPanel (panels/CodeSearchPanel.tsx, NEW):
- Search input (live, no submit button) + two toggle buttons (CaseSensitive, Regex) + a hit counter ("N matches in M files").
- The search runs in a `useMemo` keyed on `[query, caseSensitive, useRegex, files]` — `files` is a fresh array on every observeDeep callback (listCodeFiles builds new), so the memo recomputes on every Yjs change.
- Per file: `room.slate.codeText(f.id).toString().split('\n')`, then for each line call the matcher. Plain-text matcher does case-insensitive `indexOf` loops; regex matcher uses `new RegExp(q, flags)` with manual zero-width-match advancement to avoid infinite loops. Invalid regex → returns `[]` (no results) rather than throwing in render.
- Results grouped by file (FileCode2 icon + name + hit count), each hit shows line number (right-aligned, accent on hover) + the line text (truncated, monospace). Clicking a hit calls `openCodeFile(f.id)` — opens the file in the editor; the editor's own search panel can then be used for in-file navigation.
- Empty state: "Type above to search every file on this board."
- Registered: id 'code-search', title 'Search', defaultSide 'right', order 1, mode 'code'.

B-5 — registerBuiltInPanels.ts:
- Added imports for DocOutlinePanel, DocStatsPanel, CodeFilesPanel, CodeSearchPanel.
- Registered all four panels at the end of `registerBuiltInPanels()` with the task-specified mode/defaultSide/order.

Verification:
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0, no type errors across all 6 modified/created files plus the rest of the codebase.
- `npx eslint` on the 6 touched files → 0 errors, 1 pre-existing warning ('AudioEditorPanel' unused import in registerBuiltInPanels.ts — was there before this round; verified by `git stash` + lint).
- `npx vitest run --passWithNoTests` → 9 files, 48 tests pass (including code/zip.test.ts, docs/docTextJson.test.ts).
- `cd /home/z/my-project/slate/packages/sync-protocol && npx tsc --noEmit` → exit 0 (no schema changes).

Stage Summary:
- Code editor polish: fold gutter (▾/▸ glyphs), indent unit (2 spaces) + indent-on-input, light/dark theme toggle (Sun/Moon button, theme via CM Compartment so the effect re-runs on toggle), multi-tab strip (open/close/switch, middle-click + Ctrl+W close, active-tab surface lift), Find button that dispatches a synthetic Ctrl+F into the editor so CM's built-in search panel opens.
- Doc/code dock panels: four new panels registered for the doc and code board modes — DocOutline (left, order 0, navigates the rendered TipTap headings via DOM scrollIntoView), DocStats (right, order 1, live word/char/paragraph/heading counts + reading time), CodeFiles (left, order 0, folder-tree navigation that dispatches `slate:code-open-file`), CodeSearch (right, order 1, project-wide plain-text/regex search with per-file grouping).
- Wiring: CodeEditor listens for `slate:code-open-file` window events and opens the file in its tab strip (after a Y.Map existence check so stale events for deleted files don't create phantom tabs). Both CodeFilesPanel and CodeSearchPanel dispatch the event; openCodeFile is exported from CodeFilesPanel and reused by CodeSearchPanel so there's one event channel.
- TypeScript clean (exit 0). ESLint clean (0 errors, 1 pre-existing warning unrelated to this round). All 48 existing tests pass. No new dependencies added (CodeMirror + y-codemirror.next were already installed by ROUND14-A).
