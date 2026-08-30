/**
 * The multiplayer path, end to end: two independent browsers on one board.
 *
 * Everything else in this suite exercises a single tab, where a broken relay,
 * a rejected token, or a roster that never updates all still look fine. This
 * is the test that fails when collaboration is broken.
 *
 * Needs a live sync server (the preview proxy forwards /api, /yjs and /health
 * to :8080). Without one the whole file skips rather than quietly asserting
 * single-user behaviour.
 */

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/** Unique per test, per project, per run: a running server persists each
 *  board's Yjs doc, so a fixed name would carry state between runs. */
const boardName = (prefix: string): string =>
  `${prefix}-${test.info().project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function hasServer(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get('/health');
    return res.ok() && (res.headers()['content-type'] ?? '').includes('application/json');
  } catch {
    return false;
  }
}

/** A fresh browser context = a fresh person: identity is minted per session,
 *  so two contexts join as two peers rather than one peer in two tabs. */
async function joinBoard(browser: Browser, board: string, who: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?board=${board}&mode=doc`);
  await page.getByPlaceholder(/e\.g\. Alex/i).fill(who);
  const boardInput = page.getByPlaceholder(/name your project/i);
  await expect(boardInput).toHaveValue(board, { timeout: 15_000 });
  await page.locator('input[type=checkbox]').first().check();
  await page.getByRole('button', { name: /enter board/i }).click();
  await expect(page.getByLabel('Document editor')).toBeVisible({ timeout: 30_000 });
  return page;
}

test('two people on one board see each other, and each other’s edits', async ({
  browser,
  request,
}) => {
  test.skip(!(await hasServer(request)), 'no sync server reachable — collaboration cannot be tested');
  test.slow(); // two browsers, two connections, one relay round trip

  const board = boardName('collab');
  const alice = await joinBoard(browser, board, 'Alice');
  const bob = await joinBoard(browser, board, 'Bob');

  // Presence: each of them counts two people in the room.
  const people = (page: Page) => page.getByRole('group', { name: 'People' });
  await expect(people(alice)).toContainText('2', { timeout: 30_000 });
  await expect(people(bob)).toContainText('2', { timeout: 30_000 });

  // Content: what Alice types reaches Bob's editor through the relay.
  const fromAlice = `alice-was-here-${Math.random().toString(36).slice(2, 8)}`;
  await alice.getByLabel('Document editor').click();
  await alice.keyboard.type(fromAlice);
  await expect(bob.getByLabel('Document editor')).toContainText(fromAlice, { timeout: 30_000 });

  // …and back the other way, on the same doc, without clobbering Alice's text.
  const fromBob = `bob-replies-${Math.random().toString(36).slice(2, 8)}`;
  await bob.getByLabel('Document editor').click();
  await bob.keyboard.press('End');
  await bob.keyboard.type(` ${fromBob}`);
  await expect(alice.getByLabel('Document editor')).toContainText(fromBob, { timeout: 30_000 });
  await expect(alice.getByLabel('Document editor')).toContainText(fromAlice);

  // Leaving is visible too: the roster drops back to one.
  await bob.context().close();
  await expect(people(alice)).toContainText('1', { timeout: 45_000 });

  await alice.context().close();
});
