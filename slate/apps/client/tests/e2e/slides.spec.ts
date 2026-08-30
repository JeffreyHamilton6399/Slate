/**
 * Presentation editor — element insertion and the arrange tools.
 *
 * Desktop only: these drive the stage's floating toolbar, which a phone
 * reaches through the mobile drawer instead (the smoke spec covers the
 * mobile presentation path).
 */

import { test, expect, type Page } from '@playwright/test';

const boardName = (prefix: string): string =>
  `${prefix}-${test.info().project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chrome', 'stage toolbar is desktop-only');
  await page.goto(`/?board=${boardName('slides')}&mode=presentation`);
  await page.getByPlaceholder(/e\.g\. Alex/i).fill('Alice');
  await page.locator('input[type=checkbox]').first().check();
  await page.getByRole('button', { name: /enter board/i }).click();
  // The stage toolbar is the signal that the deck is ready to edit.
  await page.getByTitle('Rectangle').waitFor({ timeout: 30_000 });
});

/** Interactive hit-boxes, one per element on the current slide. */
const elements = (page: Page) => page.locator('[data-slide-el]');

/** Screen-space geometry of every element, in DOM order. */
async function boxes(page: Page): Promise<{ left: number; cx: number; cy: number }[]> {
  return elements(page).evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }),
  );
}

/** Drag the nth element by a screen-space offset. */
async function dragBy(page: Page, i: number, dx: number, dy: number): Promise<void> {
  const box = await elements(page).nth(i).boundingBox();
  if (!box) throw new Error(`element ${i} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** The element wrappers are transparent hit-boxes; the painted shape is a
 *  separate node underneath at the same geometry. Read its fill. */
async function paintedFill(page: Page, i: number): Promise<string> {
  return page.evaluate((index) => {
    const wrap = document.querySelectorAll('[data-slide-el]')[index] as HTMLElement;
    const r = wrap.getBoundingClientRect();
    const painted = [...document.querySelectorAll('div')].find(
      (d) =>
        d !== wrap &&
        Math.abs(d.getBoundingClientRect().left - r.left) < 2 &&
        Math.abs(d.getBoundingClientRect().width - r.width) < 2,
    );
    return painted ? getComputedStyle(painted).backgroundColor : 'not-found';
  }, i);
}

test('inserts lines and arrows', async ({ page }) => {
  const linesBefore = await page.locator('svg line').count();
  await page.getByTitle('Line', { exact: true }).click();
  await expect(elements(page)).toHaveCount(1);
  await page.getByTitle('Arrow', { exact: true }).click();
  await expect(elements(page)).toHaveCount(2);
  // Both draw a stroked line onto the stage (the arrow adds a head on top).
  await expect
    .poll(() => page.locator('svg line').count())
    .toBeGreaterThanOrEqual(linesBefore + 2);
});

test('switches a shape between solid, tinted and outline fill', async ({ page }) => {
  await page.getByTitle('Rectangle').click();
  await expect(elements(page)).toHaveCount(1);

  await page.getByTitle('Solid fill').click();
  await expect.poll(() => paintedFill(page, 0)).toBe('rgb(124, 106, 255)');

  await page.getByTitle('No fill (outline only)').click();
  await expect.poll(() => paintedFill(page, 0)).toBe('rgba(0, 0, 0, 0)');

  await page.getByTitle('Tinted fill').click();
  await expect.poll(() => paintedFill(page, 0)).toMatch(/^rgba\(124, 106, 255, 0\./);
});

test('Ctrl+A selects every element on the slide', async ({ page }) => {
  await page.getByTitle('Rectangle').click();
  await page.getByTitle('Ellipse').click();
  await expect(elements(page)).toHaveCount(2);

  await page.keyboard.press('Control+a');
  // A multi-selection outlines each element; resize handles are single-only.
  await expect(page.locator('[data-slide-el].outline')).toHaveCount(2);
  await expect(page.getByLabel('Align and distribute')).toBeVisible();
});

test('aligns a multi-selection to a shared edge', async ({ page }) => {
  await page.getByTitle('Rectangle').click();
  await page.getByTitle('Ellipse').click();
  await dragBy(page, 0, -180, -110);
  await dragBy(page, 1, 140, 90);

  await page.keyboard.press('Control+a');
  await page.getByLabel('Align and distribute').click();
  await page.getByRole('menuitem', { name: 'Align left' }).click();

  await expect
    .poll(async () => {
      const ls = (await boxes(page)).map((b) => b.left);
      return Math.max(...ls) - Math.min(...ls);
    })
    .toBeLessThanOrEqual(2);
});

test('spaces three elements evenly', async ({ page }) => {
  await page.getByTitle('Rectangle').click();
  await page.getByTitle('Ellipse').click();
  await page.getByTitle('Line', { exact: true }).click();
  await expect(elements(page)).toHaveCount(3);

  // Scatter them vertically so the middle one has somewhere to move.
  await dragBy(page, 0, 0, -200);
  await dragBy(page, 1, 0, 30);
  await dragBy(page, 2, 0, 240);

  await page.keyboard.press('Control+a');
  await page.getByLabel('Align and distribute').click();
  await page.getByRole('menuitem', { name: /space evenly down/i }).click();

  await expect
    .poll(async () => {
      const cs = (await boxes(page)).map((b) => b.cy).sort((a, z) => a - z);
      return Math.abs(cs[1]! - cs[0]! - (cs[2]! - cs[1]!));
    })
    .toBeLessThanOrEqual(2);
});
