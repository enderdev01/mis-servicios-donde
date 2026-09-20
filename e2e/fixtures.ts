import { type Page, test as base, expect } from '@playwright/test';

/**
 * Marks this browser context as a returning visitor before any page script
 * runs: the first-run onboarding stays closed and `page.goto('/')` lands the
 * test directly on the live map. The record mirrors the versioned contract in
 * `apps/web/src/onboarding.ts` (key `mis-servicios:onboarding`, version 1).
 * Onboarding tests must not use this — they exist to exercise the first run.
 */
export async function asReturningVisitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('mis-servicios:onboarding', JSON.stringify({ version: 1, status: 'completed' }));
  });
}

/**
 * Keeps every test hermetic. A developer's local API on :3000 is proxied into
 * `vite preview` through `server.proxy`, so an unmocked `/v1` call would answer
 * with real rows and quietly rewrite these assertions. Routes a test registers
 * itself take precedence over these.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**tile.openstreetmap.org/**', (route) => route.abort());
    await page.route('**/v1/**', (route) => route.abort());
    await use(page);
  },
});

export { expect };
