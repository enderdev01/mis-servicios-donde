import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, test } from './fixtures.js';

/*
 * The mobile sheet used to stack everything into one scroll: the framing, the
 * legend, three filters, the outage list and the whole report form. The form
 * sat entirely below the fold. Below 56rem the two panels are now two tabs —
 * "Reportar" first, "Reportes" second — so one set of options shows at a time.
 *
 * The desktop rail is a 25rem column that fits both panels, so it keeps showing
 * both and must carry no tab semantics at all: a tablist whose tabs are not
 * rendered would still announce a two-tab widget with nothing to switch.
 */

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/**
 * Opens the mobile sheet and waits for it to finish rising. `aria-expanded`
 * flips synchronously while the `.42s` transform is still running, so any
 * assertion about where something sits on screen has to wait for the slide to
 * settle — otherwise it measures the sheet mid-flight.
 */
async function openSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ver el panel' }).click();
  await expect(page.locator('#grip')).toHaveAttribute('aria-expanded', 'true');
  // Wait for the `.42s` transform to reach its resting identity matrix. Polling
  // the sheet's top edge for two equal reads is not enough: the transition may
  // not have started yet when the first pair is taken, and the loop then exits
  // at the peek position — which passes alone and fails under load.
  await expect
    .poll(async () => page.evaluate(() => {
      const rail = document.getElementById('rail');
      return rail ? getComputedStyle(rail).transform : 'missing';
    }))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

/**
 * Whether a control can actually take focus. `toBeHidden` only says a control
 * is not painted; this says it is out of the tab sequence, which is the part
 * that matters for a panel the visitor has switched away from.
 */
async function canFocus(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) return false;
    element.focus();
    return document.activeElement === element;
  }, selector);
}

test('splits the mobile panel into a report tab and a reports tab', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await openSheet(page);

  const report = page.getByRole('tab', { name: 'Reportar' });
  const reports = page.getByRole('tab', { name: 'Reportes' });
  await expect(page.getByRole('tablist')).toBeVisible();

  // "Reportar" is the left tab and the one the sheet opens on.
  await expect(report).toHaveAttribute('aria-selected', 'true');
  await expect(reports).toHaveAttribute('aria-selected', 'false');
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.rail-tab')].map((tab) => tab.textContent));
  expect(order, 'report on the left, reports on the right').toEqual(['Reportar', 'Reportes']);

  // One panel at a time.
  await expect(page.getByRole('heading', { name: 'Reportar un corte' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeHidden();
  await expect(page.getByLabel('Ver distrito')).toBeHidden();

  // The hidden panel has to leave the tab sequence too, or the controls the
  // visitor cannot see still collect their Tab presses. `display: none` is what
  // delivers that, so the probe is whether the control can take focus at all.
  expect(await canFocus(page, '#district-filter'), 'the hidden filters are unfocusable').toBe(false);
  expect(await canFocus(page, '#submit'), 'the shown form is focusable').toBe(true);

  await reports.click();
  await expect(reports).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reportar un corte' })).toBeHidden();
  await expect(page.locator('#report-form')).toBeHidden();
  expect(await canFocus(page, '#submit'), 'the hidden form is unfocusable').toBe(false);
  expect(await canFocus(page, '#district-filter'), 'the shown filters are focusable').toBe(true);

  // The legend decodes the same levels the list and the map blobs use, so it
  // travels with the reports tab.
  await expect(page.locator('#map-legend')).toBeVisible();

  await report.click();
  await expect(page.locator('#report-form')).toBeVisible();
  await expect(page.locator('#map-legend')).toBeHidden();
});

/*
 * The tabs alone did not finish the job. The shared header still carried 67px
 * of framing onto the path to the primary action, so the report tab needed
 * 526px of a 489px sheet and "Enviar reporte" sat below the fold — the exact
 * overload the split was meant to end. The lede is not deleted (a visitor who
 * skipped the onboarding has no other place to learn the confirmation rule); it
 * shows on the reports tab, where "sin confirmar" actually appears.
 */
test('fits the whole report form without scrolling the mobile sheet', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await openSheet(page);

  const fits = await page.evaluate(() => {
    const body = document.getElementById('rail-body')!;
    return { scroll: body.scrollHeight, client: body.clientHeight };
  });
  expect(fits.scroll, 'the report tab does not scroll').toBeLessThanOrEqual(fits.client);

  // The submit button is the thing that used to be unreachable.
  const submit = page.locator('#submit');
  await expect(submit).toBeVisible();
  const probe = await submit.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const rail = document.getElementById('rail')!;
    return {
      onScreen: rect.bottom <= window.innerHeight + 1,
      submitBottom: Math.round(rect.bottom),
      viewport: window.innerHeight,
      railTop: Math.round(rail.getBoundingClientRect().top),
      railState: rail.getAttribute('data-state'),
      hit: hit instanceof Element ? `${hit.tagName}#${hit.id}` : null,
    };
  });
  expect(probe, 'the submit button is on screen and tappable without scrolling')
    .toMatchObject({ onScreen: true, hit: 'BUTTON#submit' });

  // The rule is not lost — it moved to the tab where it applies.
  await expect(page.locator('.lede')).toBeHidden();
  await page.getByRole('tab', { name: 'Reportes' }).click();
  await expect(page.locator('.lede')).toBeVisible();
  await expect(page.locator('.lede')).toContainText('Tres vecinos distintos');
});

test('keeps the lede under the heading on desktop', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(DESKTOP);
  await page.goto('/');

  // The desktop rail is one column with room for everything, so the mobile
  // relocation must not reach it.
  await expect(page.locator('.lede')).toBeVisible();
  const placement = await page.evaluate(() => {
    const lede = document.querySelector('.lede')!;
    return { parent: lede.parentElement?.id, previous: lede.previousElementSibling?.tagName };
  });
  expect(placement).toEqual({ parent: 'rail-body', previous: 'H1' });
});

test('keeps the sheet headline and the question outside the tabs', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await openSheet(page);

  // The document keeps exactly one h1 in the tree whichever tab is open, and
  // the sticky answer belongs to both: it says whether there is an outage now.
  for (const tab of ['Reportar', 'Reportes']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('heading', { level: 1, name: '¿Es solo tu casa?' })).toBeVisible();
    await expect(page.locator('#answer')).toBeVisible();
  }
});

test('moves between the mobile tabs with the arrow keys', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await openSheet(page);

  const report = page.getByRole('tab', { name: 'Reportar' });
  const reports = page.getByRole('tab', { name: 'Reportes' });

  // Roving tabindex: only the selected tab is in the tab sequence, so one Tab
  // press moves from the strip into the panel it opened.
  await expect(report).toHaveAttribute('tabindex', '0');
  await expect(reports).toHaveAttribute('tabindex', '-1');

  await report.focus();
  await page.keyboard.press('ArrowRight');
  await expect(reports).toBeFocused();
  await expect(reports).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await expect(report).toBeFocused();
  await expect(page.locator('#report-form')).toBeVisible();
});

test('shows both desktop panels and declares no tabs there', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(DESKTOP);
  await page.goto('/');

  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reportar un corte' })).toBeVisible();
  await expect(page.locator('#report-form')).toBeVisible();
  await expect(page.locator('#map-legend')).toBeVisible();

  // Each panel is labelled by its own heading again, not by a tab.
  const labels = await page.evaluate(() =>
    ['reports-panel', 'report-panel'].map((id) => document.getElementById(id)?.getAttribute('aria-labelledby')));
  expect(labels).toEqual(['near-heading', 'report-heading']);
});

test('moves the tab semantics with the layout across a resize', async ({ page }) => {
  await asReturningVisitor(page);
  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await expect(page.getByRole('tablist')).toHaveCount(0);

  // Narrow: the split applies, and the roles come with it.
  await page.setViewportSize(MOBILE);
  await openSheet(page);
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Reportes' }).click();
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeVisible();

  // Wide again: both panels return and nothing about the tabs is left behind,
  // including on the panel that was hidden a moment ago.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('#report-form')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cortes cerca tuyo' })).toBeVisible();
  const leftovers = await page.evaluate(() =>
    ['reports-panel', 'report-panel'].map((id) => {
      const panel = document.getElementById(id);
      return { role: panel?.getAttribute('role') ?? null, tabindex: panel?.getAttribute('tabindex') ?? null };
    }));
  expect(leftovers).toEqual([{ role: null, tabindex: null }, { role: null, tabindex: null }]);
});
