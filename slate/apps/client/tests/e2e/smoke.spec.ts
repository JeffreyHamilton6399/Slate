/**
 * Smoke test — ensures the production bundle boots, the onboarding card
 * renders, and the user can enter a board (offline / no-server). Network
 * provider failures are handled gracefully so this can run without the
 * server up.
 */

import { test, expect } from '@playwright/test';

test('renders onboarding and enters a working board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Slate/i).first()).toBeVisible();
  await page.getByPlaceholder(/e\.g\. Alex/i).fill('Alice');
  await page.getByRole('button', { name: /enter board/i }).click();
  // Workspace chrome appears: tool rail + connection pill (LOCAL without a
  // server, ONLINE with one) + style toolbar.
  await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('status').filter({ hasText: /local|online|waking/i }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('toolbar', { name: 'Style' })).toBeVisible();
});

test('share link prefills the board name', async ({ page }) => {
  await page.goto('/?board=smoke-shared&mode=2d');
  const boardInput = page.getByPlaceholder(/leave empty/i);
  await expect(boardInput).toHaveValue('smoke-shared', { timeout: 15_000 });
});

test('PWA manifest is served', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/manifest.webmanifest`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.name).toMatch(/slate/i);
});
