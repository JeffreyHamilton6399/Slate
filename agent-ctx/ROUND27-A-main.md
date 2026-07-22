# ROUND27-A — main (Z.ai Code)

## Task
Fix 4 Slate client UI issues:
1. Friends list — grid not long row (contact-directory-style cards)
2. Remove emoji from status (plain text only)
3. Distinct colored card backgrounds for every project mode (2D/3D/Audio/Doc/Code/Diagram)
4. UI cleanup pass — remove visual noise, consistent spacing, tidy Profile/Home

## Files modified
- `apps/client/src/app/modeColors.ts` (new)
- `apps/client/src/app/ProfileDialog.tsx`
- `apps/client/src/app/Home.tsx`
- `apps/client/src/app/Onboarding.tsx`
- `apps/client/src/app/store.ts`
- `apps/client/src/account/friends.ts`

## Work log

### Task 1 — Friends list grid (ProfileDialog.tsx)
- Problem: The FriendsSection accepted-friends list rendered as a long vertical column of single-row tiles (`<ul className="flex flex-col gap-1">`), one friend per row. Each tile had a left avatar + name + status side-by-side. The user wanted a contact-directory-style grid of square-ish cards.
- Fix: Rewrote the `FriendList` component to render `<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">` and added a new `FriendCard` component. Each card is a full-card `<button>` (the whole card is clickable to open the profile view) with:
  - 44px `Avatar` circle centered at the top (using the existing `Avatar` component which falls back to the first letter initial on an accent disc).
  - Online/offline dot indicator overlapping the avatar bottom-right (`bg-green` / `bg-text-dim/50`).
  - Display name below the avatar, truncated (`w-full truncate text-xs font-semibold`), with `title` for the full name.
  - Status text below the name (small, `text-[10px] text-text-dim`, truncated), falling back to bio / email / "Online"/"Offline".
  - Consistent padding (`p-3`), centered alignment, hover state (`hover:border-accent/50 hover:bg-bg-3`).
  - The remove-friend button (UserMinus icon) overlays the top-right corner of the card on hover (bg-bg-3/90 backdrop blur) so it doesn't compete with the click-to-open affordance.
- The pending-requests list above it stays as a vertical `<ul>` because each row needs inline Accept/Decline buttons that don't suit a grid tile.

### Task 2 — Status emoji removal (ProfileDialog.tsx, store.ts, friends.ts)
- Problem: The Status input's placeholder was `"🎨 What are you up to?"` — the emoji was the source of the unwanted emoji. The store comment also said "Emoji welcome" and friends.ts JSDoc said `"🎨 sketching"`. Some users may also have an emoji-prefixed status already saved in the cloud DB.
- Fix:
  - Added a `stripEmoji(s)` helper at the top of ProfileDialog.tsx. It runs the string through six `replace` passes (each in its own regex character class so eslint's `no-misleading-character-class` rule is satisfied — mixing ranges with lone combining marks in one class is what triggers that lint):
    1. `\u{1F000}-\u{1FAFF}` — main emoji/pictograph block (emoticons, transport, supplemental symbols, regional indicators, etc.)
    2. `\u{2600}-\u{27BF}` — misc symbols + dingbats
    3. `\u{2B00}-\u{2BFF}` — misc symbols and arrows
    4. `\u{FE0F}` — variation selector-16 (emoji variation selector)
    5. `\u{200D}` — zero-width joiner (used in compound emoji like family emojis)
    6. `\u{20E3}` — combining enclosing keycap
    Then collapses whitespace and trims.
  - Changed the status input placeholder from `"🎨 What are you up to?"` to `"What are you up to?"`.
  - The Status Save button now runs the draft through `stripEmoji` before saving — both the local store and the cloud profile get the plain-text version, and the input is reset to the cleaned value.
  - The status display in `ProfileTabView` (own profile) and `FriendProfileView` (clicked friend's profile) is wrapped in `stripEmoji()` so any emoji already stored in the cloud DB (from before this fix) is cleaned up on display.
  - The subline in each `FriendCard` is also `stripEmoji(f.statusText)`.
  - Updated the helper text under the input from "A one-liner friends see next to your name." to "A short plain-text line friends see next to your name." (emphasizes plain text).
  - Updated the `statusText` JSDoc in `app/store.ts` from "Emoji welcome." to "plain-text".
  - Updated the `statusText` JSDoc in `account/friends.ts` from `"🎨 sketching"` to `"Available"`.

### Task 3 — Distinct mode colors (modeColors.ts, Home.tsx, Onboarding.tsx)
- Problem: Mode badge/header colors were inconsistent. `Home.tsx` had a local `modeBadgeClass()` that used `bg-accent-2/15` for BOTH doc and code (no distinction). The All Projects dialog card header used a long inline ternary that also shared `bg-accent-2/10` for doc/code. `Onboarding.tsx` had its own copies of the same inline ternaries. Only `diagram` had the blue (`bg-sky-500`) tint the user liked.
- Fix: Created `apps/client/src/app/modeColors.ts` as the single source of truth with three exports:
  - `modeBadgeClass(mode)` — compact pill tint, `/15` opacity. Used in: Home recent widget, Home live boards list, Onboarding live boards list.
  - `modeHeaderClass(mode)` — full-width card banner tint, `/10` opacity. Used in: All Projects dialog (Home + Onboarding) card headers.
  - `modeTextClass(mode)` — text-only tint (no background), used for the tiny inline mode label in Onboarding's recent list.
  
  Color assignment per mode:
  - **2D**: `bg-green/15 text-green` / `bg-green/10 text-green` (emerald — drawing / whiteboard)
  - **3D**: `bg-accent/15 text-accent` / `bg-accent/10 text-accent` (purple — 3D scene)
  - **Audio**: `bg-warn/15 text-warn` / `bg-warn/10 text-warn` (amber — sound)
  - **Doc**: `bg-blue-500/15 text-blue-400` / `bg-blue-500/10 text-blue-400` (blue — long-form text, same family as the diagram tint the user likes)
  - **Code**: `bg-cyan-500/15 text-cyan-400` / `bg-cyan-500/10 text-cyan-400` (cyan — code editor)
  - **Diagram**: `bg-sky-500/15 text-sky-400` / `bg-sky-500/10 text-sky-400` (sky — kept as-is)
  
  Each mode now has a distinct, pleasing color. Doc and Code are no longer sharing the same tint.
  
- Updated consumers:
  - `Home.tsx`: deleted the local `modeBadgeClass` function, imported `modeBadgeClass` + `modeHeaderClass` from `./modeColors`. The All Projects dialog card header's inline ternary is replaced with `modeHeaderClass(r.mode)`. The recent widget + live boards list still call `modeBadgeClass(r.mode)` (now the imported version).
  - `Onboarding.tsx`: imported `modeBadgeClass`, `modeHeaderClass`, `modeTextClass`. The recent list's inline ternary is replaced with `modeTextClass(r.mode)`. The All Projects dialog card header's inline ternary is replaced with `modeHeaderClass(r.mode)`. The Live public boards list previously showed `{r.members} · {r.mode}` with no color — now it shows a colored mode badge (`modeBadgeClass(r.mode)`) + name + member count, matching the Home live boards list style.

### Task 4 — UI cleanup
- **ProfileDialog FriendProfileView**: tightened the outer wrapper from `gap-4` to `gap-3` and moved the "Loading profile…" line out of its own gap-row into the stats row as an inline "Loading…" chip, so it no longer breaks the card → button visual flow with an awkward empty row while the fetch is in flight.
- **ProfileDialog FriendList/FriendCard**: consistent `p-3` card padding, `gap-2` grid gap, `gap-1.5` intra-card gap, `rounded-lg` corners, hover border/bg transition. The section label uses `mb-2` (was `mb-1`) to balance the larger card tiles.
- **Home.tsx**: removed the leftover multi-line comment block that described the old `modeBadgeClass` function (now imported) — it was just clutter above the `Home` component.
- **Workspace header (Header.tsx)**: already minimal — brand mark, board name + mode label, File menu, then on the right: connection pill (only when unstable), Share, divider, mobile Panels button, Settings, Leave. No changes needed.
- All other spacing in Home (hero `gap-5`, create bar `gap-2`, recents widget `p-2`, live boards `gap-1.5`) was already consistent and untouched.

## Verification
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0 (zero type errors in modified files).
- `npx eslint src/app/ProfileDialog.tsx src/app/Home.tsx src/app/Onboarding.tsx src/app/modeColors.ts src/app/store.ts src/account/friends.ts` → exit 0 (zero lint errors). Initial run flagged `no-misleading-character-class` on the combined emoji regex; fixed by splitting into one regex character class per pass.
- Dev server log: only routine `/health` 404s; no compile errors.

## Stage summary
- 6 files modified, 1 file created (`modeColors.ts`), 0 new dependencies.
- Friends list is now a 2-col (mobile) / 3-col (sm+) grid of square-ish contact cards; each card is fully clickable to open the friend's profile, with a hover-only remove button in the corner.
- Status field is plain-text only: emoji stripped on save (input + store + cloud), on display (own profile + friend profile + friend card subline), and the emoji placeholder is gone.
- Every project mode has a distinct card/badge color via the shared `modeColors.ts` module: 2D green, 3D accent (purple), Audio warn (amber), Doc blue, Code cyan, Diagram sky (kept). Applied consistently to Home recents, Home live boards, Home All Projects dialog, Onboarding recents, Onboarding live boards, Onboarding All Projects dialog.
- Friend profile detail view no longer has an awkward loading row; the loading hint is inline in the stats area.
