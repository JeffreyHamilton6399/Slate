---
Task ID: ROUND21-A
Agent: Code (Slate Doc editor tool expansion + cleanup)
Task: Add text-color picker + font-size selector + justify alignment + code-block language + table row/col delete + task-item toggle to the DocToolsPanel, plus delete the dead on-image toolbar CSS.

Work Log:
- Read worklog tail (latest: ROUND20-A — code terminal; ROUND18-A — ExportDialog/Header/CodeEditor split-view; ROUND16-A — doc/code editor tool expansion that already shipped Subscript/Superscript/FontSize/Print/Export HTML/Clear-formatting/Indent/Outdent and a FontSize dropdown *inside the DocEditor toolbar*). Note: ROUND16-A wired FontSize into the DocEditor toolbar — but per ROUND14-A the doc editor no longer has a top toolbar (DocToolsPanel owns all formatting). Inspected DocEditor.tsx, DocToolsPanel.tsx, docBridge.ts, docEditor.css in full. Confirmed the `Color`, `FontSize`, `Table`, `TaskItem` extensions are loaded but the panel only exposes a subset of their commands.
- Verified installed TipTap APIs against `node_modules/@tiptap/...`:
  - `Color` extension → `setColor(color)` / `unsetColor()` (typed in `@tiptap/extension-text-style`'s `color` Commands interface).
  - `FontSize` extension → `setFontSize('16px')` / `unsetFontSize()` (same package).
  - `Table` extension → `deleteRow()` / `deleteColumn()` (typed in `@tiptap/extension-table`).
  - `TaskItem` node has a boolean `checked` attribute (verified by grepping `extension-list/dist/task-item/index.js` — `addAttributes() { checked: { ... } }`) but no toggle command. TipTap v3 also dropped `splitListItem` (it's now part of the `@tiptap/extension-list-keymap` plugin, not a chainable command). So the `toggleTask` handler walks the selection's `$from` ancestors for a `taskItem` and flips `node.attrs.checked` via `updateAttributes`.

Step 1 — docBridge.ts (bridge extended for value payloads):
- Added `DocCommandDetail` interface: `{ command: string; value?: string }`.
- Changed `runDocCommand(command, value?)` to dispatch `{ detail: { command, value } }` as a `CustomEvent<DocCommandDetail>`. Existing call sites without a value continue to work (the second arg is optional, the detail serialises to `{ command, value: undefined }`).

Step 2 — DocEditor.tsx (command handler grew 9 new cases):
- Import: added `type DocCommandDetail` alongside `DocApplyDetail` from docBridge.
- Handler: reads `detail` once, pulls `cmd` + (for the value-carrying commands) `detail.value`. Switch grew:
  - `textColor` → `if (value) c.setColor(value).run()`
  - `clearColor` → `c.unsetColor().run()`
  - `fontSize` → `if (value) c.setFontSize(`${value}px`).run()` (panel sends the bare number; the editor wraps it as `${px}px`).
  - `clearFontSize` → `c.unsetFontSize().run()`
  - `alignJustify` → `c.setTextAlign('justify').run()`
  - `codeLang` → `window.prompt` for a language string (prefilled with `editor.getAttributes('codeBlock').language ?? ''` so editing an existing block shows its current lang), then `c.updateAttributes('codeBlock', { language: trimmed }).run()`. Prompted here rather than in the panel so the panel doesn't need editor-state access.
  - `delRow` → `c.deleteRow().run()`
  - `delCol` → `c.deleteColumn().run()`
  - `toggleTask` → walks `editor.state.selection.$from` depth from inner to outer; first ancestor whose `type.name === 'taskItem'` gets `c.updateAttributes('taskItem', { checked: !node.attrs.checked }).run()`. No-op (silent) outside a task item so the button doesn't throw mid-paragraph.
- docEditor.css already had `.slate-doc .ProseMirror [style*='text-align: justify'] { text-align: justify !important; }` from ROUND14-A — justify renders correctly out of the box.

Step 3 — DocToolsPanel.tsx (panel rewritten with custom-tool support):
- New imports: `useState, useRef, useEffect, type ReactNode, type CSSProperties` from React; new lucide icons `AlignJustify, X, Palette, Type, ChevronDown, Rows3, Columns3, SquareCheck, Languages`.
- GROUPS additions:
  - Text section: `textColor` (Palette), `clearColor` (X), `fontSize` (Type), `clearFontSize` (Eraser — reusing the icon since both "reset" actions read naturally with it).
  - Lists section: `toggleTask` (SquareCheck) — labelled "Toggle item".
  - Align section: `alignJustify` (AlignJustify) — labelled "Justify".
  - Insert section: `codeLang` (Languages) labelled "Code language"; `delCol` (Columns3); `delRow` (Rows3).
- Extracted the shared button chrome into a `TOOL_BUTTON_CLASS` constant so every tool — generic or custom — looks identical.
- `ToolButton` component: dispatches on `t.command`:
  - `textColor` → renders a `<label>` styled like a button, wrapping a Palette icon + label + an `<input type="color">` with `className="absolute inset-0 cursor-pointer opacity-0"`. Clicking anywhere on the label forwards to the input (native OS color dialog). `onChange` calls `runDocCommand('textColor', e.target.value)` with the picked hex. `defaultValue="#1f2328"` so the picker opens on the paper ink color rather than pure black.
  - `fontSize` → renders `<FontSizeButton>` (see below).
  - everything else → the original generic `<button>` calling `runDocCommand(t.command)`.
- `FontSizeButton`: tracks `open` state; renders the Type icon + label + a ChevronDown hint. When open, shows a 2-col popover anchored `bottom-full right-0` (above the button, right-aligned so it doesn't overflow the left dock). The popover contains a `Default` entry (dispatches `clearFontSize`) and one button per preset in `[12, 14, 16, 18, 24, 32]`. Each size button has `style={{ fontSize: ${min(px,16)}px }}` so the menu doubles as a sample of how the picked size reads (capped at 16px so the largest presets don't blow out the 2-col grid). Click-away (mousedown outside the ref'd container) + Escape both close the popover.
- `SizeOption` helper: a `role="menuitem"` button that accepts an optional `style` for the size preview.
- `Group` helper: keeps the existing header + `grid grid-cols-3 gap-1` chrome; takes children so the custom tools slot into the same grid as the generic ones.
- `DocToolsPanel` itself: just maps GROUPS → `<Group>` → `<ToolButton>` per tool.

Step 4 — docEditor.css (dead image-bar CSS removed):
- Deleted the 7 rules for the floating on-image toolbar that was removed in ROUND14-A (when the DocImage extension was rewired to use the 2D-canvas-style resizable `ResizableImageView`): `.slate-img-bar`, `.slate-img-btn`, `.slate-img-btn:hover`, `.slate-img-btn.is-active`, `.slate-img-move`, `.slate-img-sep`, plus the `/* Floating on-image toolbar (move / wrap / rotate). */` comment. Verified zero references to those class names anywhere in `src/` (the only hit was the CSS itself) before deleting.
- Kept `.slate-img-rotate` and the corner-handle `.slate-img-handle` rules — those are still used by `ResizableImageView.tsx`.

Verification:
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0, zero errors across all 4 modified files (docBridge.ts, DocEditor.tsx, DocToolsPanel.tsx, docEditor.css — CSS isn't type-checked) plus the rest of the codebase.
- `npx eslint src/panels/DocToolsPanel.tsx src/docs/DocEditor.tsx src/docs/docBridge.ts` → exit 0, zero errors, zero warnings.
- `npx vitest run --passWithNoTests` → 9 files, 48 tests pass. No regressions.

Stage Summary:
- The doc editor's dockable tool palette now exposes every command the loaded TipTap extensions actually offer. Eight new commands joined the existing 25-ish: `textColor` (Palette button → OS color picker → `setColor`), `clearColor` (X button → `unsetColor`), `fontSize` (Type button → popover of 6 presets + Default → `setFontSize(`${px}px`)` / `unsetFontSize`), `clearFontSize` (Eraser button → `unsetFontSize`), `alignJustify` (AlignJustify button → `setTextAlign('justify')`), `codeLang` (Languages button → prompt → `updateAttributes('codeBlock', { language })`), `delRow` / `delCol` (Rows3 / Columns3 buttons → `deleteRow()` / `deleteColumn()`), and `toggleTask` (SquareCheck button → walks `$from` ancestors for a `taskItem` and flips `checked`).
- Bridge extended generically: `runDocCommand(command, value?)` now carries an optional value payload on the `slate:doc-command` event detail, so future value-carrying commands reuse the same channel without another bridge change.
- Dead CSS removed: 7 unused image-bar rules (≈28 lines) deleted from docEditor.css. The still-used `.slate-img-rotate` / `.slate-img-handle` rules are untouched.
- TypeScript clean (exit 0). ESLint clean (0/0). All 48 existing tests still pass. No new dependencies — every command maps to an existing TipTap extension method. Backward compatible — the bridge change is additive (the value arg is optional) and every existing panel button continues to dispatch with no value.
