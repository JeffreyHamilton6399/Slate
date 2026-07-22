# ROUND26-A — main (Z.ai Code)

## Task
Fix 4 Slate client issues:
1. Mobile portrait — panels access for ALL modes
2. Landscape mobile — UI too big, panels cover canvas
3. Display name sync across devices
4. Remove Donate from dropdown, remove Friends tab from dropdown, add user profile view

## Files modified
- `apps/client/src/workspace/useMediaQuery.ts`
- `apps/client/src/app/Workspace.tsx`
- `apps/client/src/app/Home.tsx`
- `apps/client/src/app/ProfileDialog.tsx`
- `apps/client/src/account/friends.ts`

## Work log

### Task 1 — Mobile FAB for panels access (Workspace.tsx)
- Problem: The Header has a small `Menu` icon for opening the MobileDrawer, but on a phone it's mixed in with Share / Settings / Leave and easy to miss. Users reported that 2D and 3D modes "don't show the tabs at the top like if we were in code" — they couldn't find the panels.
- Fix: Added a floating "Panels" button at the bottom-right of the canvas (`absolute bottom-4 right-4 z-40`), 12×12 (48px) hit area, accent-colored with a shadow. Uses the `LayoutGrid` icon (4-square grid) which more strongly suggests "panels" than the generic hamburger Menu icon. Renders only on mobile (`isMobile`), calls `setMobileDrawer(true)`. Visible in every mode (2D, 3D, audio, doc, code) since it lives in the always-rendered `<main>`. The Header's small Menu button is unchanged as a secondary affordance.
- New component: `PanelsFabIcon` (renders `<LayoutGrid size={22} />`).

### Task 2 — Landscape mobile UI too big (useMediaQuery.ts, Workspace.tsx)
- Problem: `useIsMobile()` checks `(max-width: 768px) and (orientation: portrait)`. A landscape phone (812×375) crosses the 768px threshold → gets the full desktop layout with docks. Default dock widths are 240px/260px = 500px total, leaving only 312px for the canvas on a 812px-wide phone.
- Fix: Added `useIsSmallScreen()` hook (`(max-width: 900px)`) that returns true regardless of orientation — true for both portrait phones AND landscape phones.
- In `Workspace.tsx`:
  - When `smallLandscape = isSmallScreen && !isMobile`:
    - Skip the auto-open-tabs useEffect (`if (smallLandscape) return;`). Docks start empty (just the `+` menu) so the user gets the full canvas; they open panels via the dock's `+` button.
    - Cap the rendered dock widths: `effectiveSidebar = Math.min(sidebarWidth, 200)`, `effectiveDock = Math.min(dockWidth, 220)`. The resizer still writes the underlying persisted value, so a user who explicitly drags wider on a small screen sees it apply on a larger screen later.
  - Pass `effectiveSidebar`/`effectiveDock` to the `<Dock>` components instead of the raw persisted values.

### Task 3 — Display name sync across devices (Home.tsx, ProfileDialog.tsx)
- Problem: When a user changed their display name in Settings, it updated `useAppStore.setDisplayName()` (localStorage, per-device) AND `upsertMyProfile()` (Supabase profiles table). But on another device, the user signed in and the local store only took the cloud value when `!s.displayName` — so a device that already had a stale localStorage name never picked up the cloud change.
- Fix:
  - `Home.tsx`: Added a new `useEffect` on `userId` that calls `fetchMyProfile(userId)` and ALWAYS overwrites the local store with the cloud values when the cloud has a non-empty value (displayName, avatarUrl, bio, status, bannerColor). Cloud is now the source of truth on sign-in.
  - `ProfileDialog.tsx`: Changed the existing fetch-on-open `useEffect` from "only set when local is empty" (`if (prof.displayName && !s.displayName)`) to "always overwrite when cloud has a value" (`if (prof.displayName) setDisplayName(...)`). This picks up changes made on another device while the tab was open, on the next dialog open.
- The save path (ProfileDialog's Save button → `upsertMyProfile`) was already correct and is unchanged.

### Task 4 — Remove Donate/Friends from dropdown, add friend profile view (Home.tsx, ProfileDialog.tsx, friends.ts)

**4a. Remove Donate + Friends from ProfileMenu dropdown (Home.tsx):**
- Removed the `Friends` dropdown item (the Friends tab inside ProfileDialog is the path; the avatar's notification badge still surfaces incoming requests).
- Removed the `Donate` dropdown item (already in the footer About dialog).
- Moved the notification badge to the `Profile` item so the incoming-request count is still visible from the menu.
- Removed the now-unused `onOpenFriends` prop and the `Coffee` lucide import.

**4b. Add `fetchUserProfile` to friends.ts:**
- New function `fetchUserProfile(userId)` that fetches another user's public profile (display_name, email, avatar_url, bio, status, banner_color, created_at, last_seen). Returns null if unconfigured / not found. The profiles table is publicly readable per the schema RLS policies, so this works for any friend.

**4c. Add FriendProfileView component (ProfileDialog.tsx):**
- New `FriendProfileView` component rendered when a friend is clicked. Shows:
  - Banner with the friend's `banner_color` (or default accent).
  - Big avatar (88px) overlapping the banner, with online/offline dot.
  - Display name (large, bold).
  - Status text (one-liner, if any).
  - Email (if any).
  - Bio (multi-line, if any).
  - Stats row: online status + "X days on Slate" (calculated from `created_at`).
  - Back button at the top to return to the friends list.
  - "Remove friend" button at the bottom.
- Fetches the friend's full profile on mount via `fetchUserProfile`; falls back to the `Friend` row's basic fields (displayName, avatarUrl, status, bio, email) immediately so the view renders before the fetch resolves.
- `daysOnSlate` is computed with `useMemo` from `profile.createdAt` (`Math.floor((now - createdAt) / 86400000)`).

**4d. Wire FriendProfileView into FriendsSection (ProfileDialog.tsx):**
- Added `selectedFriend: Friend | null` state to `FriendsSection`.
- When `selectedFriend` is set, renders `<FriendProfileView>` instead of the list. `onBack` clears the state; `onRemove` calls `remove(id)` then clears the state.
- Added `onSelect: (friend: Friend) => void` prop to `FriendList`. The avatar + name area is now a `<button>` that calls `onSelect(f)`; the UserMinus remove button stays separate so it doesn't trigger navigation.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → only pre-existing environment errors (`vite-plugin-pwa/client`, `vite/client` type defs not installed in sandbox); zero errors in any of the 5 modified files.
- ESLint: pre-existing config issue (`eslint-config-prettier` not installed); no new issues introduced.
- Dev server log clean (only routine `/health` 404s, no compile errors).

## Stage summary
- Task 1: Mobile FAB (LayoutGrid icon, bottom-right, accent) makes panels discoverable for every mode.
- Task 2: `useIsSmallScreen()` + skip auto-open-tabs + cap dock widths to 200/220 on narrow landscape screens.
- Task 3: Cloud is now the source of truth — sign-in always overwrites local with cloud profile; ProfileDialog re-fetches on open.
- Task 4: Donate + Friends removed from the dropdown (badge moved to Profile item); Friends tab in ProfileDialog unchanged; clicking a friend opens a social-style profile card with banner, avatar, bio, status, email, days-on-Slate, online dot, and Back/Remove actions.
- 5 files modified, 0 files created, 0 new dependencies.
