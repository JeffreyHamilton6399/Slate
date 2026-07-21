# ROUND20-A — Real interactive file-system terminal

## Task
Turn `CodeTerminalPanel` from a read-only preview-console viewer into a
real interactive terminal: file commands (`ls`, `cat`, `touch`, `mkdir`,
`rm`, `mv`, `write`, `echo`), code commands (`run` → refresh preview,
`clear`, `pwd`, `help`), command history (↑/↓), and an editable prompt.
Keep the existing preview-console forwarding.

## Files changed
- `code/codeFiles.ts` — export `findFileId` (was private) and add a public
  `readCodeFileText(slate, path)` wrapper.
- `code/terminalCommands.ts` — NEW. The command engine: pure
  `runTerminalCommand(slate, rawInput) -> TerminalResult`.
- `panels/CodeTerminalPanel.tsx` — rewritten as an interactive terminal
  with prompt, history, output log + preview console forwarding, and an
  exported `SLATE_REFRESH_PREVIEW_EVENT` constant.
- `code/CodeEditor.tsx` — imports `SLATE_REFRESH_PREVIEW_EVENT` and adds
  a useEffect listener that calls `rebuildPreview()` on the split-view
  preview when the event fires.
- `panels/CodePreviewPanel.tsx` — same listener wired to the dockable
  panel's `rebuild()`.

## Implementation notes

### `code/codeFiles.ts`
- `findFileId` is now `export function` (was `function`). All existing
  call sites continue to work — they were already inside this module.
- New `readCodeFileText(slate, path)`: returns the file's `Y.Text` content
  as a plain string, or `null` if no file at that path. Used by the
  terminal's `cat` command (and any future read-only consumer) so they
  don't reach into Yjs directly.

### `code/terminalCommands.ts` (new, ~230 lines)
- `TerminalResult = { output: string; clear?: boolean; refreshPreview?: boolean }`
- `runTerminalCommand(slate, rawInput)` trims, splits on whitespace,
  dispatches on `cmd`:
  - `ls [path]` — lists direct children of `/` or `<path>/`. Files show
    `<name>\t<size>b`; folders show `<name>/`. Children are derived by
    stripping the prefix and taking the first path segment, so a nested
    file like `src/app/foo.ts` shows up as `app/` under `ls src`.
  - `cat <path>` — prints file contents. Refuses to cat a folder
    (`Is a directory`), errors on missing files.
  - `touch <path>` — no-op if file exists (shell semantics), errors on
    existing folder, otherwise `upsertCodeFile(path, '')`.
  - `mkdir <path>` — no-op if folder exists, errors on existing file,
    otherwise `createCodeFolder`.
  - `rm <path>` — recursive delete via `deleteCodePath`. Always
    recursive (no `-rf` flag needed for a creative tool).
  - `mv <old> <new>` — `renameCodePath`. Refuses to silently overwrite
    an existing leaf file (foot-gun in a collaborative editor).
  - `write <path> <content...>` — re-derives content from the raw input
    (so quoted/multi-word text is preserved verbatim, not
    space-collapsed). Calls `upsertCodeFile`.
  - `echo <text...>` — prints the raw text after `echo `.
  - `run` — `{ output: 'Refreshing preview…', refreshPreview: true }`.
  - `clear` — `{ output: '', clear: true }`.
  - `pwd` — `{ output: '/' }` (Slate has no cwd concept).
  - `help` — lists every command with a one-line description.
  - default — `Command not found: <cmd>. Type 'help' for available commands.`
- All paths go through `normalizePath` first (forward slashes, no `.`/`..`).

### `panels/CodeTerminalPanel.tsx` (rewritten)
- Uses `useRoom()` to get `room.slate` for the command engine.
- New `Line` type discriminates `cmd` | `out` | `preview` (was just
  `level` + `text`). The render switch picks prefix + color per kind:
  - `cmd` — `$ <text>` with accent-green prompt.
  - `out` — plain output text in light grey.
  - `preview` — `›`/`⚠`/`✕` prefix, red/yellow/blue/grey by level.
- Keeps the preview-console `message` event listener (unchanged
  behavior; messages now go through the same `appendLines` helper).
- Prompt row at the bottom: a `$` in `#7ee787`, an `<input>` with a
  green caret, no border, no background (terminal feel). Clicking
  anywhere in the panel focuses the input.
- Command history:
  - Stored as `string[]`, most-recent-first, capped at 200.
  - `↑` walks back (older), `↓` walks forward (newer). At the bottom of
    history, `↓` returns to the live input.
  - Consecutive duplicates are deduped (zsh-style).
  - Typing any printable char while browsing history drops back to live
    input mode (so further `↑` starts from the latest entry again).
  - `Ctrl+L` clears the log (shell convention).
- `run` dispatches `window.dispatchEvent(new Event(SLATE_REFRESH_PREVIEW_EVENT))`.
- `clear` empties `lines`.
- Auto-scrolls to bottom on new output via `useLayoutEffect`.
- Exports `SLATE_REFRESH_PREVIEW_EVENT = 'slate:code-refresh-preview'`
  so consumers (CodeEditor split view + dockable CodePreviewPanel) share
  the same string.

### `code/CodeEditor.tsx`
- Adds `SLATE_REFRESH_PREVIEW_EVENT` to the existing `CodeTerminalPanel`
  import (no new module dependency).
- New useEffect after the auto-refresh one: registers a listener that
  calls `rebuildPreview()` when the event fires — but only if
  `showPreview` is true (no point rebuilding a hidden iframe).
- Cleanup removes the listener.

### `panels/CodePreviewPanel.tsx`
- Imports `SLATE_REFRESH_PREVIEW_EVENT` from `./CodeTerminalPanel`.
- New useEffect after the auto-refresh one: registers a listener that
  calls `rebuild()` unconditionally (this panel is always "on" when it's
  mounted, so any `run` should rebuild).
- Cleanup removes the listener.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0.
- `npx eslint` on all five changed files → exit 0, no warnings.

## Notes for downstream agents
- The terminal mutates the shared Yjs doc directly through the same
  helpers the Files panel + AI assistant use, so every command is
  collaborative and undoable via Yjs's UndoManager. No new "terminal
  state" lives outside the doc.
- The `SLATE_REFRESH_PREVIEW_EVENT` is a fire-and-forget signal — both
  preview surfaces (split view + dockable panel) listen for it. If a
  future agent adds a third preview surface, just add the same listener.
- The terminal's `write` command re-parses content from the raw input
  string (after stripping `write <path> `). This preserves spaces and
  quotes verbatim, but it does mean inline `\n` literals in the typed
  input won't be expanded to newlines (the input is single-line). If
  multi-line writes are needed, the cleanest extension is a heredoc
  syntax (`write foo.js <<EOF … EOF`) — left as future work.
- `findFileId` is now exported. If you need a path→id lookup elsewhere
  (e.g., the Files panel's context menu), prefer it over re-implementing
  the `forEach`.
