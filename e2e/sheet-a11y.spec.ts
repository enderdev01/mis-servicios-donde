import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, test } from './fixtures.js';

/*
 * Accessibility, motion and touch behaviour of the bottom sheet, the dialogs
 * and the map controls. The sheet cases run at phone size; the rest on the
 * default desktop viewport unless a test says otherwise.
 */

const MOBILE = { width: 390, height: 844 };
const UNCONFIRMED = [{ h3Cell: '898e62c01afffff', service: 'internet', provider: 'movistar', confirmed: false }];

async function grantLocation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: (position: GeolocationPosition) => void) => success({ coords: { latitude: -12.0464, longitude: -77.0428 } } as GeolocationPosition) },
    });
  });
}

/** Resolves once the sheet has stopped moving (identity transform or the peek offset). */
async function settled(page: Page): Promise<void> {
  const read = (): Promise<string> => page.evaluate(() => getComputedStyle(document.getElementById('rail')!).transform);
  let previous = '';
  await expect.poll(async () => { const now = await read(); const same = now === previous; previous = now; return same; }).toBe(true);
}

async function openCellInfoByPointer(page: Page): Promise<void> {
  await page.route('**/v1/cells', (route) => route.fulfill({ json: UNCONFIRMED }));
  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();
  await expect(page.locator('#cell-info')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await asReturningVisitor(page);
});

test('takes the off-screen sheet body out of the tab order while peeking', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');

  const body = page.locator('#rail-body');
  await expect(body).toHaveJSProperty('inert', true);

  // Tab from the handle never lands on a control below the screen edge.
  await page.locator('#grip').focus();
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press('Tab');
    const insideBody = await page.evaluate(() => document.activeElement?.closest('#rail-body') !== null && document.activeElement !== document.body);
    expect(insideBody, `Tab press ${press + 1} stayed out of the hidden body`).toBe(false);
  }

  // Opening the sheet gives the body back, and so does leaving the phone layout.
  await page.locator('#grip').click();
  await expect(body).toHaveJSProperty('inert', false);
  await page.locator('#grip').click();
  await expect(body).toHaveJSProperty('inert', true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(body).toHaveJSProperty('inert', false);
});

test('moves focus to the handle when the sheet closes around it', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await page.locator('#grip').click();
  await page.getByRole('checkbox', { name: 'Agua' }).focus();
  await page.locator('#grip').click();
  await expect(page.locator('#grip')).toBeFocused();
});

test('reaches the answer and the panel before any map control', async ({ page }) => {
  await page.goto('/');

  const visited: string[] = [];
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      if (active?.closest('#rail')) return 'rail';
      if (active?.closest('.garden')) return 'map';
      return 'other';
    });
    visited.push(where);
    if (where === 'map') break;
  }
  expect(visited.includes('map'), 'the map is still reachable by keyboard').toBe(true);
  expect(visited.indexOf('rail'), 'the panel comes before the map').toBeGreaterThanOrEqual(0);
  expect(visited.indexOf('rail')).toBeLessThan(visited.indexOf('map'));
});

test('labels the zoom buttons and the Leaflet link in Spanish', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.leaflet-control-zoom-in')).toHaveAttribute('aria-label', 'Acercar');
  await expect(page.locator('.leaflet-control-zoom-in')).toHaveAttribute('title', 'Acercar');
  await expect(page.locator('.leaflet-control-zoom-out')).toHaveAttribute('aria-label', 'Alejar');
  await expect(page.locator('.leaflet-control-zoom-out')).toHaveAttribute('title', 'Alejar');
  await expect(page.locator('.leaflet-control-attribution a[href="https://leafletjs.com"]')).toHaveAttribute('title', /^Biblioteca/);
});

test('closes the zone dialog by tapping the backdrop', async ({ page }) => {
  await openCellInfoByPointer(page);
  await page.mouse.click(5, 5);
  await expect(page.locator('#cell-info')).toBeHidden();

  // A tap inside the card is not outside it.
  await page.locator('#cell-list .cell-row').first().click();
  await expect(page.locator('#cell-info')).toBeVisible();
  await page.locator('#cell-info h2').click();
  await expect(page.locator('#cell-info')).toBeVisible();
});

test('lands on the answer after the thank-you dialog, from the keyboard and from the backdrop', async ({ page }) => {
  await grantLocation(page);
  await page.route('**/v1/reports', (route) => route.fulfill({ status: 201, json: { submissionId: 'a11y-submission', accepted: true } }));
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));
  await page.goto('/');

  const send = async (): Promise<void> => {
    await page.getByRole('checkbox', { name: 'Agua' }).check();
    await page.getByLabel('Empresa de agua').selectOption('sedapal');
    await page.locator('#submit').focus();
  };

  await send();
  await page.keyboard.press('Enter');
  await expect(page.locator('#thanks')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entendido' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#thanks')).toBeHidden();
  await expect(page.locator('#answer')).toBeFocused();

  // Light dismiss ends in the same place.
  await send();
  await page.keyboard.press('Enter');
  await expect(page.locator('#thanks')).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.locator('#thanks')).toBeHidden();
  await expect(page.locator('#answer')).toBeFocused();
});

test('announces form states politely, keeps the region in the tree and describes the service group', async ({ page }) => {
  await page.goto('/');

  const state = page.locator('#report-state');
  await expect(state).toHaveAttribute('aria-live', 'polite');
  await expect(state).not.toHaveAttribute('role', 'alert');
  // Empty, it is still rendered (no display:none), just without a box.
  expect(await state.evaluate((element) => getComputedStyle(element).display)).not.toBe('none');

  const group = page.locator('#report-form fieldset').first();
  await expect(group).not.toHaveAttribute('aria-describedby', /.+/);
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(state).toContainText('Elige al menos un servicio afectado.');
  await expect(group).toHaveAttribute('aria-describedby', 'report-state');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await expect(group).not.toHaveAttribute('aria-describedby', /.+/);
});

test('does not write the interim submit states into the live region', async ({ page }) => {
  await page.addInitScript(() => {
    // Never answers: the request stays in its "asking for the location" state.
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: () => undefined } });
  });
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.locator('#submit')).toHaveText('Solicitando ubicación…');
  await expect(page.locator('#report-state')).toBeEmpty();
});

test('keeps form controls at 16px or more so iOS does not zoom', async ({ page }) => {
  await page.goto('/');
  const sizes = await page.evaluate(() => [...document.querySelectorAll('select')].map((select) => parseFloat(getComputedStyle(select).fontSize)));
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
});

test('draws control borders with at least 3:1 contrast', async ({ page }) => {
  await page.goto('/');
  const color = await page.locator('#service-filter').evaluate((select) => getComputedStyle(select).borderTopColor);
  const [red, green, blue] = (color.match(/\d+/g) ?? []).map(Number) as [number, number, number];
  const channel = (value: number): number => { const v = value / 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const luminance = .2126 * channel(red) + .7152 * channel(green) + .0722 * channel(blue);
  // Against the lightest surface a control sits on: white rows and pills.
  expect(1.05 / (luminance + .05)).toBeGreaterThanOrEqual(3);
});

test.describe('reduced motion', () => {
  test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

  test('drops map animation, the identity slide, the sheet and dialog transitions and the pulse', async ({ page }) => {
    await page.route('**/v1/cells', (route) => route.fulfill({ json: UNCONFIRMED }));
    await page.goto('/');

    // Leaflet marks a marker `leaflet-zoom-hide` instead of `leaflet-zoom-animated` when the map has zoom animation off.
    await expect(page.locator('.blob-glyph')).toHaveClass(/leaflet-zoom-hide/);

    await page.locator('#identity-toggle').click();
    expect(await page.locator('#site-identity').evaluate((plate) => getComputedStyle(plate).animationName)).toBe('none');

    const transitions = await page.evaluate(() => ({
      rail: getComputedStyle(document.getElementById('rail')!).transitionDuration,
      dialog: getComputedStyle(document.getElementById('cell-info')!).transitionDuration,
    }));
    expect(transitions).toEqual({ rail: '0s', dialog: '0s' });
  });
});

test('animates the map, the identity panel and the dialogs when motion is allowed', async ({ page }) => {
  await page.route('**/v1/cells', (route) => route.fulfill({ json: UNCONFIRMED }));
  await page.goto('/');

  await expect(page.locator('.blob-glyph')).toHaveClass(/leaflet-zoom-animated/);
  await page.locator('#identity-toggle').click();
  expect(await page.locator('#site-identity').evaluate((plate) => getComputedStyle(plate).animationName)).toBe('identity-open');
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('cell-info')!).transitionDuration)).toContain('0.18s');
});

test('does not paint a focus ring on dialog buttons opened by a pointer, but does for the keyboard', async ({ page }) => {
  await openCellInfoByPointer(page);
  const ring = (): Promise<string> => page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  await expect(page.locator('#cell-info-close')).toBeFocused();
  expect(await ring(), 'no ring after a tap').toBe('none');

  await page.keyboard.press('Escape');
  await expect(page.locator('#cell-info')).toBeHidden();
  await page.locator('#cell-list .cell-row').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cell-info')).toBeVisible();
  await expect(page.locator('#cell-info-close')).toBeFocused();
  expect(await ring(), 'the ring is back for the keyboard').toBe('solid');
});

test('keeps the mobile tabs inside their strip at 200% text', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#grip').click();

  const fit = await page.evaluate(() => {
    const strip = document.getElementById('rail-tabs')!.getBoundingClientRect();
    return [...document.querySelectorAll('.rail-tab')].map((tab) => {
      const box = tab.getBoundingClientRect();
      return box.left >= strip.left - 1 && box.right <= strip.right + 1;
    });
  });
  expect(fit, 'both tabs sit inside the strip').toEqual([true, true]);
});

test('clamps the answer to three lines in the open sheet', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  // The page rewrites the answer once the list loads: wait for that before standing in a long one.
  await expect(page.locator('#answer')).not.toHaveText('Buscando cortes confirmados…');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    document.getElementById('answer')!.textContent = 'Hay cortes confirmados cerca de ti. '.repeat(8);
  });
  const textHeight = (): Promise<number> => page.locator('#answer').evaluate((answer) => {
    const style = getComputedStyle(answer);
    return answer.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  });
  const lineHeight = await page.locator('#answer').evaluate((answer) => parseFloat(getComputedStyle(answer).fontSize) * 1.2);
  expect(await textHeight(), 'peeking shows the whole answer').toBeGreaterThan(lineHeight * 4);
  await page.locator('#grip').click();
  expect(await textHeight(), 'open clamps it to three lines').toBeLessThanOrEqual(lineHeight * 3.6);
});

test.describe('drag handle', () => {
  test.use({ viewport: MOBILE, hasTouch: false });

  async function drag(page: Page, deltaY: number): Promise<void> {
    const box = (await page.locator('#grip').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + deltaY, { steps: 8 });
    await page.mouse.up();
  }

  test('drags the sheet open and closed, following the pointer', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'peek');

    const box = (await page.locator('#grip').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 120, { steps: 6 });
    // Mid-drag the sheet is where the pointer left it, without a transition fighting it.
    const midDrag = await page.locator('#rail').evaluate((rail) => ({ transform: rail.style.transform, transition: rail.style.transition }));
    expect(midDrag.transform).toMatch(/^translateY\(/);
    expect(midDrag.transition).toBe('none');
    await page.mouse.up();

    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#grip')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#rail-body')).toHaveJSProperty('inert', false);
    // The click that ends a drag does not toggle the sheet back.
    await settled(page);
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'open');
    expect(await page.locator('#rail').evaluate((rail) => rail.getAttribute('style'))).toBeFalsy();

    await drag(page, 300);
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'peek');
    await expect(page.locator('#grip')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#rail-body')).toHaveJSProperty('inert', true);
  });

  test('still toggles with a click and with the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.locator('#grip').click();
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'open');
    await page.locator('#grip').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'peek');
    await page.keyboard.press('Space');
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'open');
  });

  test('settles without a transition under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await drag(page, -300);
    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'open');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('rail')!).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  });
});
