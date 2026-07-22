# ROUND28-A — main (Z.ai Code)

## Task
Fix 4 Slate client UI issues:
1. Doc pages — separated like Google Docs (visible page breaks every 11in)
2. Card colors — ALL modes (2d/3d/audio too) get colored card backgrounds
3. New user onboarding — ToS checkbox + experience question + first-run tutorial overlay
4. Mobile UI cleanup — 320px fitting, All Projects dialog, ProfileDialog tabs, FAB overlap

## Work Log

Read previous worklog (latest: ROUND27-A) and the relevant target files:
- `docs/docEditor.css` (407 lines), `docs/DocEditor.tsx` (407 lines)
- `app/modeColors.ts` (75 lines), `app/Home.tsx` (815 lines), `app/Onboarding.tsx` (468→500 lines after edits)
- `app/Workspace.tsx` (467 lines), `app/ProfileDialog.tsx` (1007 lines)
- `packages/ui-tokens/src/tailwind-preset.ts`, `packages/ui-tokens/src/tokens.css`
- `app/TermsDialog.tsx`, `ui/Dialog.tsx`, `workspace/MobileDrawer.tsx`, `app/PeopleWidget.tsx`

### Task 1 — DocEditor CSS mobile fallback (`docs/docEditor.css`)

The desktop `.slate-doc-page` already had page-break guide lines (added by an
earlier round) via `repeating-linear-gradient` every 1056px (11in @ 96dpi),
plus the 816px width (8.5in), 72px×84px padding, paper background, and drop
shadow. So the desktop "Google Docs separated pages" look was already in place
— verified, not re-implemented.

What was missing: the mobile media query only changed `padding` to `24px 16px`
but left `min-height: 1056px` and the `background-image: repeating-linear-gradient`
intact. On a 375px-wide phone, the 1056px min-height forced a giant empty
paper sheet, and the horizontal page-divider lines dominated the viewport
without adding useful "page" affordance.

Fix: extended the existing `@media (max-width: 640px)` rule for `.slate-doc-page`
to also set `min-height: auto` and `background-image: none`. On mobile the
paper now flows as one continuous card with comfortable 24px×16px margins;
desktop keeps the multi-page guide-line look.

### Task 2 — Card colors for ALL modes (`app/modeColors.ts`)

Diagnosis: `modeColors.ts` already had explicit `case '2d'`, `case '3d'`,
`case 'audio'` branches in all three functions (`modeBadgeClass`,
`modeHeaderClass`, `modeTextClass`) — so the "fallback returns empty string"
hypothesis from the task description was wrong. The actual bug was that
2D/3D/audio used CSS-variable theme colors (`bg-green/15`, `bg-accent/15`,
`bg-warn/15`) while doc/code/diagram used Tailwind-native palette colors
(`bg-blue-500/15`, `bg-cyan-500/15`, `bg-sky-500/15`).

In Tailwind v3.4, the `/15` opacity modifier on a CSS-variable color emits
`color-mix(in srgb, var(--x) 15%, transparent)`, which is correct CSS but
renders visibly more washed-out next to a Tailwind-native tint (which
emits `rgb(R G B / 0.15)` — full-strength color at the requested alpha).
The user-visible symptom matched: "only doc/code/diagram look colored".

Fix: switched ALL six modes to Tailwind-native palette colors so the opacity
modifiers always compile to a proper `rgb(... / α)`:
- 2D      → `emerald-500` (close to brand `--green #22d3a5`)
- 3D      → `violet-500`  (close to brand `--accent #7c6aff`)
- Audio   → `amber-500`   (close to brand `--warn #fbbf24`)
- Doc     → `blue-500`    (kept)
- Code    → `cyan-500`    (kept)
- Diagram → `sky-500`     (kept)

All three functions (`modeBadgeClass`, `modeHeaderClass`, `modeTextClass`)
were updated to use the same six palette colors, with the badge at `/15`,
the header at `/10`, and text-only at full color (no `/` modifier).

Also updated `app/Onboarding.tsx` recents list: was using `modeTextClass`
(text-only, no background pill); now uses `modeBadgeClass` (colored pill
background) so the recents rows in Onboarding visually match Home's recents
widget, where every mode already showed a colored badge.

Removed the now-unused `modeTextClass` import from `Onboarding.tsx`. The
function still exists in `modeColors.ts` for any future compact-list use.

### Task 3 — ToS + experience + tutorial (`app/Onboarding.tsx`, new `app/WelcomeOverlay.tsx`, `app/Workspace.tsx`)

#### 3a. ToS checkbox in Onboarding form

Added `tos` state (`useState(false)`). Added a checkbox + Terms link label
between the visibility/mode IconToggles and the Enter board button — same
pattern as the SignIn sign-up form (lines 247-264 of `Home.tsx`), so guests
and accounts see the same gate. The Terms link opens the existing
`TermsDialog` (already mounted at the bottom of Onboarding).

`canSubmit` now requires `tos` in addition to a non-empty board name; the
`submit` handler also re-checks `!tos` and bails before `enterBoard` so a
stale click can't bypass the gate.

#### 3b. WelcomeOverlay component (new file)

Created `app/WelcomeOverlay.tsx` — a one-time first-run tutorial overlay
shown the first time a user enters a board on this device. Self-gates on
the localStorage flag `slate.onboarding.done` (read at mount time, so no
flash-open-then-close).

Exports:
- `ONBOARDING_DONE_KEY = 'slate.onboarding.done'`
- `hasSeenOnboarding()` — reads the flag
- `markOnboardingDone()` — sets the flag to `'1'`
- `WelcomeOverlay` — the component

Flow (three steps, all in the same Radix Dialog):
1. **Welcome** — icon badge + "Welcome to Slate" title + one-paragraph
   pitch ("real-time multi-mode canvas — draw in 2D, build in 3D, mix
   audio, write docs, code, and diagram…") + Continue button.
2. **Experience question** — "Have you used Slate before?" with two
   tappable cards:
   - "No, it's new" → advance to tips
   - "Yes, jump in" → `dismiss()` (sets the flag, closes the overlay)
3. **Tips** (only shown if the user said No) — 4 tip cards, each with an
   icon and 1-2 sentence body:
   - Pick your mode (2D/3D/audio/doc/code/diagram)
   - Tools live in the panels (desktop docks; mobile bottom-right FAB)
   - Everything syncs live (Share button, real-time merge, offline catch-up)
   - Save & export anytime (File menu, auto-save)
   Then a "Got it — start creating" button → `dismiss()`.

Skip path: the RadixDialog.Close X button (top-right) and the Escape key
(RadixDialog handles natively) both call `dismiss()` too — so the user is
never trapped, and skipping still sets the flag so the overlay never
re-shows.

The overlay sits at z-[1200]/z-[1201] (above the Workspace shell at
z-30/z-40 and the existing Dialog z-[1100]/z-[1101]) so it renders above
any other dialog that might be open. Uses the same `surface` token +
`animate-slide-up` as the shared `Dialog` component so it matches the
app's existing dialog aesthetic.

#### 3c. Wire WelcomeOverlay into Workspace

`app/Workspace.tsx`:
- Imported `WelcomeOverlay` from `./WelcomeOverlay`.
- Mounted `<WelcomeOverlay />` at the end of the Workspace's outer flex
  column, after `<AutosaveBadge />`. The component self-gates on the
  localStorage flag, so it's safe to always mount — it returns `null` if
  the user has already seen the tutorial.

### Task 4 — Mobile UI cleanup

#### 4a. Onboarding card fits on 320px (`app/Onboarding.tsx`)

- Outer container padding: `p-6` → `p-3 sm:p-6` (24px → 12px on mobile).
- Card padding: `p-8` → `p-5 sm:p-8` (32px → 20px on mobile).
- Card gap: `gap-5` → `gap-4 sm:gap-5` (20px → 16px on mobile).
- Donate text link in the header: `flex` → `hidden sm:flex` (hidden on
  phones; still reachable from the guest dropdown menu, which already has
  a Donate item).

On a 320px-wide screen, the card now has 320 - 2*12 = 296px width, minus
2*20px padding = 256px for content (was 320 - 2*24 = 272px outer, minus
2*32 = 208px for content). The form fields, IconToggles, ToS checkbox, and
Enter board button all fit comfortably without horizontal scrolling.

#### 4b. All Projects dialog delete button visible on mobile

Both `Home.tsx` (AllProjectsDialog) and `Onboarding.tsx` (inline All
Projects dialog) had the delete button styled as
`opacity-0 hover:text-danger group-hover:opacity-100` — invisible by
default, revealed on hover. On touch devices there's no hover, so the
delete button was permanently invisible.

Fix: changed the class to
`opacity-100 hover:text-danger sm:opacity-0 sm:group-hover:opacity-100`
— visible by default on mobile, hidden until hover on desktop. Same
pattern in both files.

#### 4c. ProfileDialog tabs work on mobile (`app/ProfileDialog.tsx`)

The tab nav was `flex shrink-0 gap-1 border-b border-border p-3 sm:w-56
sm:flex-col`. On a 320px screen with the dialog at `w-[95vw]` = 304px and
`p-0`, the three tabs (Profile / Friends / Settings, each ~95-105px wide
with px-3 + gap-2 + Icon + label) couldn't fit horizontally — they'd
overflow and wrap or push the dialog wider than the viewport.

Fix:
- Nav: added `overflow-x-auto` and reduced padding to `p-2 sm:p-3`. Added
  `sm:overflow-visible` so the horizontal scroll only applies on mobile
  (desktop rail stays as a vertical column).
- Tab buttons: added `shrink-0` so they don't compress when the nav is
  narrow. Each tab keeps its full width and the strip scrolls if needed.
- Content area: reduced padding from `p-6` to `p-4 sm:p-6` so the tab
  content has more room on small screens.

#### 4d. FAB doesn't overlap with bottom UI (`app/Workspace.tsx`)

Diagnosis: the FAB was at `absolute bottom-4 right-4` of the `<main>`
element. On mobile this overlapped with:
- The 2D bottom toolbar (`absolute bottom-2 left-2 right-2 z-10`, ~32px
  tall → extends to ~44px from bottom). FAB at bottom-4 (16px) overlapped
  with the toolbar's right end.
- The doc word-count footer (`justify-end`, ~24px tall at the bottom).
- The 3D Timeline panel (when open: `absolute bottom-2 left-2 right-2`).

MobileDrawer overlap was already fine — MobileDrawer is z-[200]/z-[201],
FAB is z-40, so opening the drawer covers the FAB.

Fix: moved the FAB from `bottom-4` to `bottom: calc(4rem + var(--safe-bottom, 0px))`
(64px + iOS safe area inset). This clears:
- The 2D bottom toolbar (ends ~44px from bottom).
- The doc word-count footer (~24px tall).
- The closed 3D timeline pill (`bottom-2` centered, small).
- The 2D left toolbar's reserved zone (the left toolbar is
  `bottom-16`, exactly matching this 64px clearance).

When the 3D timeline is fully open (can be 80-150px tall), the FAB may
still overlap with its right end — but that's a user-controlled panel
they can close, and the FAB's z-40 wins visually so it stays tappable.
Added `var(--safe-bottom, 0px)` so the iOS home indicator doesn't
underlap the FAB on notched phones.

### Verification

- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → exit 0,
  zero type errors.
- `npx eslint src/docs/docEditor.css src/app/modeColors.ts src/app/Onboarding.tsx
  src/app/WelcomeOverlay.tsx src/app/Workspace.tsx src/app/ProfileDialog.tsx
  src/app/Home.tsx` → 0 errors, 2 warnings. Both warnings are pre-existing
  on the unmodified main branch (Workspace.tsx:277 useEffect missing
  'board.mode' dep — file-menu keyboard shortcuts; Workspace.tsx:325 useMemo
  missing 'setBgOpen' dep — handleFileMenu — both noted in ROUND25-A).
  The docEditor.css "File ignored" line is just eslint having no CSS plugin
  configured — not a real warning.
- No new ESLint warnings introduced by this round.
- Dev server log: only routine /health 404s; / 200 OK; no compile errors.

## Stage Summary

- 6 files modified, 1 file created (WelcomeOverlay.tsx), 0 new dependencies.
- Task 1: docEditor.css mobile rule now disables page-break guide lines
  and the 1056px min-height on phones; desktop "separated pages" look
  (already implemented by an earlier round) unchanged.
- Task 2: modeColors.ts switched all 6 modes to Tailwind-native palette
  colors (emerald/violet/amber/blue/cyan/sky) so the `/15` and `/10`
  opacity modifiers compile to proper `rgb(... / α)` instead of washed-out
  `color-mix(in srgb, var(--x) …)`. 2D/3D/audio cards now render with the
  same color strength as doc/code/diagram. Onboarding recents switched
  from text-only `modeTextClass` to colored-pill `modeBadgeClass` to match
  Home's recents widget.
- Task 3: ToS checkbox (required) added to Onboarding form, mirroring the
  SignIn sign-up pattern. New `WelcomeOverlay` component shows a 3-step
  first-run tutorial (welcome → experience question → 4 tip cards) gated
  by `localStorage['slate.onboarding.done']` — only shows once per device,
  never nags, skip path also sets the flag. Wired into Workspace so it
  appears the first time the user enters any board.
- Task 4: Onboarding card padding shrunk on mobile (p-5 sm:p-8, outer
  p-3 sm:p-6, gap-4 sm:gap-5); Donate link hidden on mobile (still in
  guest dropdown). All Projects dialog delete buttons now visible on
  mobile (was hover-only, which doesn't fire on touch). ProfileDialog
  tabs scroll horizontally on mobile with `shrink-0` buttons; content
  padding reduced on mobile. FAB moved from `bottom-4` to
  `calc(4rem + var(--safe-bottom, 0px))` to clear the 2D bottom toolbar,
  doc word-count footer, and respect the iOS home indicator.
- TypeScript clean (exit 0). ESLint clean on all touched code (the 2
  warnings are pre-existing and unrelated).
