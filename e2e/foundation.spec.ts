import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, noticeControl, revealNotice, test } from './fixtures.js';

test('serves the static public foundation', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  await expect(response.text()).resolves.toContain('Información sobre cortes generada por la comunidad, no oficial.');
});

test('offers an unofficial filtered map and accessible report validation', async ({ page }) => {
  // Returning-user state: this spec exercises the map and panel, not the first run.
  await asReturningVisitor(page);
  await page.route('**/v1/cells?service=water', (route) => route.fulfill({ json: [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }] }));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '¿Es solo tu casa?' })).toBeVisible();
  await revealNotice(page);
  await expect(page.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');
  await expect(page.getByLabel('Ver servicio')).toHaveValue('all');
  await expect(page.getByRole('status')).toContainText('No hay cortes reportados en este momento.');

  await page.getByLabel('Ver servicio').selectOption('water');
  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua en una zona cercana');

  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.getByRole('alert')).toContainText('Elige al menos un servicio afectado.');
});

test('keeps a permanent unofficial marker and the full notice one tap away', async ({ page }) => {
  await asReturningVisitor(page);
  await page.goto('/');

  // Collapsed is the default on every viewport: the two-line plate no longer
  // spends the map's top band, but the non-official marker never leaves.
  const control = page.getByRole('button', { name: noticeControl });
  const panel = page.locator('#site-identity');
  await expect(control).toBeVisible();
  await expect(control).toContainText('No oficial');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(control).toHaveAttribute('aria-controls', 'site-identity');
  await expect(panel).toBeHidden();
  // Past the old 3.5s auto-hide window: the control never yields the map either.
  await page.waitForTimeout(4_500);
  await expect(control).toBeVisible();
  await expect(panel).toBeHidden();

  // Expanding reveals the identity and the full naming.
  await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Mis Servicios');
  await expect(panel.getByRole('note')).toContainText('Información sobre cortes generada por la comunidad, no oficial.');
  await expect(panel.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');

  // Three ways back: the control itself, Escape, and a pointer outside it.
  await control.click();
  await expect(panel).toBeHidden();
  await control.click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await control.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(700, 500);
  await expect(panel).toBeHidden();
});

test('reaches the notice control by keyboard alone', async ({ page }) => {
  await asReturningVisitor(page);
  await page.goto('/');

  const control = page.getByRole('button', { name: noticeControl });
  await control.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#site-identity')).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Sedapal');
  await page.keyboard.press('Escape');
  await expect(page.locator('#site-identity')).toBeHidden();
  // Escape hands focus back to the control, so the panel is never a dead end.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('identity-toggle');
});

/**
 * The identity is fixed over the map, so anything it overlaps would be
 * unreachable. A collapsed control is small enough to leave the Leaflet
 * zoom/locate strip at its default offset; an expanded panel must push it down
 * instead of covering it. Both states are measured, not assumed.
 */
async function measureControlStrip(page: Page): Promise<{ top: number; targetable: boolean[] }> {
  return page.evaluate(() => {
    const hit = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target instanceof Element && (target === element || element.contains(target));
    };
    const strip = document.querySelector('.leaflet-top.leaflet-right');
    const controls = ['.leaflet-control-zoom-in', '.leaflet-control-zoom-out', '.locate-control']
      .map((selector) => document.querySelector(selector));
    return {
      top: strip ? strip.getBoundingClientRect().top : -1,
      targetable: controls.map(hit),
    };
  });
}

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`hands the map controls their default offset while collapsed at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await asReturningVisitor(page);
    await page.goto('/');

    const control = page.getByRole('button', { name: noticeControl });
    await expect(control).toBeVisible();

    // Collapsed: the strip keeps Leaflet's own top inset — the notice no longer
    // buys its space out of the map controls.
    const collapsed = await measureControlStrip(page);
    expect(collapsed.top, 'the control strip is not pushed down while collapsed').toBeLessThan(24);
    expect(collapsed.targetable, 'zoom and locate stay targetable while collapsed').toEqual([true, true, true]);

    // Expanded: the panel takes real space, so the strip drops below it rather
    // than disappearing underneath.
    await control.click();
    await expect(page.locator('#site-identity')).toBeVisible();
    const expanded = await measureControlStrip(page);
    expect(expanded.targetable, 'zoom and locate stay targetable while expanded').toEqual([true, true, true]);
    const clears = await page.evaluate(() => {
      const identity = document.querySelector('#identity');
      const zoom = document.querySelector('.leaflet-control-zoom-in');
      if (!identity || !zoom) return false;
      const a = identity.getBoundingClientRect();
      const b = zoom.getBoundingClientRect();
      return !(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
    });
    expect(clears, 'the expanded panel never intersects the zoom control').toBe(true);
  });
}
