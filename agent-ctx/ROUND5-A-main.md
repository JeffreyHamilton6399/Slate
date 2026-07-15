---
Task ID: ROUND5-A
Agent: Main
Task: Move basic tools (undo/redo/clear/zoom) to the left bar bottom

Work Log:
- Read `/home/z/my-project/worklog.md` to understand prior work (8-bug exploration + several prior rounds).
- Read `/home/z/my-project/slate/apps/client/src/canvas2d/Toolbar.tsx` fully to understand the three existing regions: left rail (tools), top-center style strip, top-right history & zoom bar.
- Read `ui/Tooltip.tsx` to confirm Tooltip uses `RadixTooltip.Trigger asChild` — non-interactive `<span>` children are fine but kept the zoom label as a plain `<span>` (not wrapped in Tooltip) to avoid needing a focusable trigger.
- Edited `Toolbar.tsx`:
  1. Removed the entire top-right "History & zoom" `<div>` region (previously lines 366–406) including its surrounding comment.
  2. Inserted a new bottom-of-rail block inside the `<aside>`, right after the Insert Image button (before `</aside>`). Wrapped in `<div className="mt-auto flex flex-col items-center gap-0.5">` so `mt-auto` pushes the group to the bottom of the existing `flex flex-col` rail.
  3. Order: separator → Undo → Redo → Clear → separator → Zoom out → zoom label (`<span>`) → Zoom in → Fit.
  4. Reused the same button styling as the other rail action buttons (`flex h-8 w-8 items-center justify-center rounded-sm border border-transparent text-text-mid hover:bg-bg-4 hover:text-text`) with `size={15}` icons to match the existing tools.
  5. Tooltips switched to `side="right"` to match the rest of the rail (top-right bar used default `side="top"`).
  6. Zoom label shrunk from `min-w-[3.5rem] text-xs` to `text-[10px] leading-none text-text-dim` so it fits the 44px-wide rail; added `aria-label={\`Zoom level ${zoomLabel}\`}` for accessibility.
  7. Kept all existing props (`onUndo`, `onRedo`, `onClear`, `onZoomIn`, `onZoomOut`, `onFit`, `zoomLabel`) — no API change.
- Ran `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` — passed with zero output (no type errors). All previously-imported icons (`Undo2`, `Redo2`, `Trash2`, `Minus`, `Plus`, `Maximize2`) and `Button` (still used in the Style strip for swap-colors) remain referenced, so no unused-import lint errors were introduced.

Stage Summary:
- The separate top-right History & zoom bar is gone. Undo/Redo/Clear and Zoom out/label/in/Fit now live at the bottom of the left rail, pushed down by `mt-auto`. The rail's existing `overflow-y-auto` still handles overflow when many tools are favorited. Style strip (top-center / bottom on mobile) is untouched.
- Files modified: `slate/apps/client/src/canvas2d/Toolbar.tsx` (single file, ~75 line delta).
- No type errors. No new dependencies. No API/prop changes.
