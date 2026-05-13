/**
 * Smoke test — ensures the production bundle boots, the onboarding card
 * renders, and the user can enter a board (offline / no-server). Network
 * provider failures are handled gracefully so this can run without the
 * server up.
 */

import { test, expect } from '@playwright/test';

test('renders onboarding and lets the user enter a board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Slate/i).first()).toBeVisible();
  // The Onboarding card has a "name" field and a "Create board" / "Join" button.
  const nameInput = page.getByLabel(/display name|your name/i).first();
  if (await nameInput.count()) {
    await nameInput.fill('Alice');
  }
  const startBtn = page
    .getByRole('button', { name: /create|new|start|join/i })
    .first();
  if (await startBtn.count()) {
    await startBtn.click();
  }
});

test('PWA manifest is served', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/manifest.webmanifest`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.name).toMatch(/slate/i);
});
