/**
 * Smoke test — ensures the production bundle boots, the onboarding card
 * renders, and the user can enter a board. Runs either standalone or against
 * a live sync server: network provider failures are handled gracefully, and
 * the assertions that depend on a server probe `/health` first.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/** Boards are keyed by name, and a running sync server persists each board's
 *  Yjs doc — so a hard-coded name carries state across projects and across
 *  runs (the deck test would open yesterday's slides and miscount). Unique
 *  per test, per project, per run. */
const boardName = (prefix: string): string =>
  `${prefix}-${test.info().project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Is a sync server reachable behind the preview proxy? The connection pill's
 *  resting state depends on it, so the assertions below have to branch: these
 *  tests run both standalone and against a full stack. */
async function hasServer(request: APIRequestContext): Promise<boolean> {
  try {
    return (await request.get('/health')).ok();
  } catch {
    return false;
  }
}

/** Fill in onboarding and enter the board. "Enter board" stays disabled until
 *  a project name is set AND the Terms box is ticked, so every test that needs
 *  a workspace goes through here. A `?board=` link prefills the name; without
 *  one this supplies it. */
async function enterBoard(page: Page, name = 'Alice'): Promise<void> {
  await page.getByPlaceholder(/e\.g\. Alex/i).fill(name);
  const board = page.getByPlaceholder(/name your project/i);
  if (!(await board.inputValue())) await board.fill(boardName('smoke'));
  await page.locator('input[type=checkbox]').first().check();
  await page.getByRole('button', { name: /enter board/i }).click();
}

test('renders onboarding and enters a working board', async ({ page, request }) => {
  const online = await hasServer(request);
  await page.goto('/');
  await expect(page.getByText(/Slate/i).first()).toBeVisible();
  await enterBoard(page);
  // Workspace chrome appears: tool rail + style toolbar.
  await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('toolbar', { name: 'Style' })).toBeVisible();
  // The connection pill then settles into its resting state. With no server
  // that is a calm LOCAL badge; with one, the pill disappears entirely once
  // the connection is healthy — Header only surfaces a problem state, and
  // routes connect/disconnect transitions to toasts instead.
  const pill = page.getByRole('status').filter({ hasText: /local|waking|connecting|offline|error/i }).first();
  if (online) await expect(pill).toBeHidden({ timeout: 30_000 });
  else await expect(pill).toHaveText(/local/i, { timeout: 30_000 });
});

test('share link prefills the board name', async ({ page }) => {
  const shared = boardName('smoke-shared');
  await page.goto(`/?board=${shared}&mode=2d`);
  const boardInput = page.getByPlaceholder(/name your project/i);
  await expect(boardInput).toHaveValue(shared, { timeout: 15_000 });
});

test('presenting a deck runs the show and comes back', async ({ page }) => {
  await page.goto(`/?board=${boardName('smoke-slides')}&mode=presentation`);
  await enterBoard(page);

  // The deck bootstraps with one slide; add a second so navigation has
  // somewhere to go. Driven from the Present menu rather than the left dock's
  // layout panel, which phones reach through the mobile drawer instead.
  const options = page.locator('button[title="Presentation options"]');
  await options.click({ timeout: 25_000 });
  await page.getByRole('menuitem', { name: 'New slide' }).click();
  await expect(page.locator('[data-slide-thumb]')).toHaveCount(2);

  // Speaker notes round-trip into the presenter view.
  await page.getByRole('button', { name: /speaker notes/i }).click();
  const notes = page.locator('textarea').first();
  await notes.fill('Remember the outage story.');
  await notes.blur();

  await page.getByTitle(/present from this slide/i).click();
  const overlay = page.getByRole('button', { name: /end presentation/i });
  await expect(overlay).toBeVisible();

  // Presenter view surfaces this slide's notes (scoped to the sidebar — the
  // editor's own notes textarea holds the same string underneath).
  await page.keyboard.press('s');
  await expect(
    page.getByRole('complementary').getByText('Remember the outage story.'),
  ).toBeVisible();
  // …and the overview grid lists every slide.
  await page.keyboard.press('o');
  await expect(page.getByTitle('Slide 2')).toBeVisible();
  await page.keyboard.press('Escape');

  // Esc ends the show and returns to the editor.
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(page.getByTitle(/present from this slide/i)).toBeVisible();
});

test('PWA manifest is served', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/manifest.webmanifest`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.name).toMatch(/slate/i);
});
