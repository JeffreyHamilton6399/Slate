---
Task ID: ROUND23-A
Agent: main
Task: Fix Header, Settings, and File menu (replace SettingsDialog with ProfileDialog, add Background to File menu, clean up header, verify ProfileDialog layout)

Work Log:
- Read previous worklog and the three target files: Workspace.tsx, Header.tsx, ProfileDialog.tsx. Also read Settings.tsx, BackgroundDialog.tsx, and BoardSettings.tsx for context.
- Confirmed ProfileDialog already exports an `initialTab?: ProfileTab` prop (default 'profile') with a `useEffect` that resets the tab to `initialTab` whenever `open` flips true — so no edit was needed there for Task 1.
- Confirmed ProfileDialog already satisfies all Task 5 layout requirements:
  - `Dialog className="max-w-5xl w-[95vw] p-0"` + inner `flex max-h-[85vh] min-h-[300px] flex-col sm:flex-row` → dialog is bounded to the viewport.
  - Content area `<div className="min-w-0 flex-1 overflow-y-auto p-6">` → scrolls internally.
  - Tab rail `<nav className="flex shrink-0 gap-1 border-b border-border p-3 sm:w-56 sm:flex-col sm:border-b-0 sm:border-r">` → horizontal on mobile (default `flex` row + bottom border), vertical sidebar on `sm:` up.
  - Settings tab uses `<div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">` → two-column grid on desktop.
  No edits required for Task 5.

Changes made:

1. `apps/client/src/app/Workspace.tsx`
   - Swapped the `SettingsDialog` import for `ProfileDialog`:
     - `import { SettingsDialog } from './Settings';` → `import { ProfileDialog } from './ProfileDialog';`
   - Replaced the dialog instance:
     - `<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />`
     - → `<ProfileDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab="settings" />`
   - Effect: the in-board Settings button now opens the modern tabbed ProfileDialog (Profile / Friends / Settings) defaulting to the Settings tab, instead of the old tall single-column SettingsDialog.
   - `Settings.tsx` is left in place (still exported, now unused) — out of scope to delete.

2. `apps/client/src/app/Header.tsx`
   - File menu (`DropdownMenuContent`):
     - Added `align="start"` so the menu opens left-aligned under the File button.
     - Added a new `Background…` item that emits `onFileMenu('background')`, placed after `Print` and before the separator that precedes `Board settings…`. Print stays mode-conditional (hidden for 3D/audio); Background is unconditional because the shared `paper` board meta applies to every mode.
     - Re-grouped items with explicit section comments matching the spec:
       New project… │ Save / Save as… / Open… │ Import… / Export… / Print / Background… │ Board settings… / Keyboard shortcuts / Install app…
     - This means board background is now reachable directly via File → Background… (one click) instead of File → Board settings → Board background.
   - Right cluster: consolidated the previously loose ConnectionPill + Share + HeaderDivider + app-cluster div into a single wrapper:
     - `<div className="flex min-w-0 items-center gap-1 overflow-x-auto">` — `overflow-x-auto` + `min-w-0` lets a narrow phone scroll the cluster instead of pushing layout off-screen.
     - Each interactive button now carries `shrink-0` so icons keep their hit area and don't get squished when the cluster scrolls.
     - `HeaderDivider` (already `hidden sm:block`) stays desktop-only, sitting between Share and the app cluster.
     - Order matches the spec: ConnectionPill (only renders when not connected — its existing behavior) → Share → divider (desktop) → [Panels mobile-only] → Settings → Leave.
   - Settings button already calls `setSettingsOpen(true)`, which Task 1 now wires to `ProfileDialog` with `initialTab="settings"`. No Header change needed for that wiring.

Verification:
- Ran `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit`.
- The only errors are pre-existing environment errors: `Cannot find type definition file for 'vite-plugin-pwa/client'` and `vite/client` (vite types not installed in this sandbox). They are unrelated to my changes — grepping the tsc output for `Workspace.tsx|Header.tsx|ProfileDialog.tsx|Settings.tsx` returns zero matches.
- No test code was written.

Stage Summary:
- In-board Settings button → modern ProfileDialog (Settings tab) — done.
- File → Background… menu item added — done.
- File menu reorganized into logical groups with dividers — done.
- Header right cluster consolidated with overflow-x-auto + shrink-0; desktop-only divider preserved — done.
- ProfileDialog layout already correct (max-h-[85vh], sm:grid-cols-2, overflow-y-auto content, horizontal tab rail on mobile) — verified, no edits needed.
- TypeScript clean for all touched files.
