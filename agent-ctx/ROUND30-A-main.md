# ROUND30-A — Fix 3D viewport + audio editor on mobile

## Files modified
1. `slate/apps/client/src/audio/AudioEditor.tsx`
2. `slate/apps/client/src/viewport3d/Toolbar3D.tsx`
3. `slate/apps/client/src/viewport3d/Viewport3D.tsx`
4. `slate/apps/client/src/panels/registerBuiltInPanels.ts`

## Key findings for downstream agents
- `useIsMobile` lives at `workspace/useMediaQuery.ts` and matches
  `(max-width: 768px) and (orientation: portrait)` — landscape
  phones get the desktop layout.
- `MobileDrawer.tsx` builds its tab strip as
  `[...tabOrder.left, ...tabOrder['left-bottom'], ...tabOrder.right,
  ...tabOrder['right-bottom']]` and auto-selects `allTabs[0]` when
  no active tab is set.
- `dockStore.ensureTab` APPENDS to a zone's tabOrder; it does NOT
  sort by the panel `order` field. So the order of `registerPanel`
  CALLS in `registerBuiltInPanels.ts` is what determines initial
  tab order within a zone. The panel `order` field only sorts the
  Dock "+" add-menu.
- GizmoHelper from `@react-three/drei` has no `position` prop with
  a 7-number array (the task description floated that as a
  hypothetical). Real API: `alignment` (one of 9 corner/edge
  strings), `margin`, `renderPriority`, plus group-level props.
  I hid it on mobile (`{!isMobile && <GizmoHelper .../>}`)
  rather than moving it — simpler and fully removes the overlap
  with the Timeline strip + FAB-style affordances.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit`
  → exit 0, no errors.

Full worklog entry appended to `/home/z/my-project/worklog.md`.
