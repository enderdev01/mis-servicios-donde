import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, test } from './fixtures.js';

const limaCell = '898e62c0cdbffff';
const anotherCell = '898e62c01afffff';
const water = { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true };
const internet = { h3Cell: anotherCell, service: 'internet', provider: 'movistar', confirmed: true };
const mapBlobs = '#outage-map .leaflet-overlay-pane path';

/** Serves `/v1/cells` from a switchable state and counts the requests it receives. */
async function serveCells(page: Page, state: { cells: unknown[]; down: boolean; requests: number }): Promise<void> {
  await page.route('**/v1/cells', (route) => {
    state.requests += 1;
    return state.down ? route.abort() : route.fulfill({ json: state.cells });
  });
}

test('refreshes the list every 30 seconds without a reload', async ({ page }) => {
  await asReturningVisitor(page);
  const state = { cells: [water], down: false, requests: 0 };
  await serveCells(page, state);
  await page.clock.install();

  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.getByRole('status')).toContainText('Actualizado hace un momento.');

  state.cells = [water, internet];
  await page.clock.fastForward(30_000);

  await expect(page.getByRole('status')).toContainText('2 confirmados.');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(2);
});

test('pauses polling while the tab is hidden and refreshes when it returns', async ({ page }) => {
  await asReturningVisitor(page);
  const state = { cells: [water], down: false, requests: 0 };
  await serveCells(page, state);
  await page.clock.install();

  await page.goto('/');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  const afterLoad = state.requests;

  const setVisibility = (value: 'hidden' | 'visible') => page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);

  await setVisibility('hidden');
  await page.clock.fastForward(120_000);
  expect(state.requests).toBe(afterLoad);

  state.cells = [water, internet];
  await setVisibility('visible');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(2);
});

test('keeps the last good data and says it may be behind when a refresh fails', async ({ page }) => {
  await asReturningVisitor(page);
  const state = { cells: [water], down: false, requests: 0 };
  await serveCells(page, state);
  await page.clock.install();

  await page.goto('/');
  await expect(page.locator(mapBlobs)).toHaveCount(1);

  state.down = true;
  await page.clock.fastForward(5 * 60_000);

  await expect(page.getByRole('status')).toContainText('No pudimos actualizar los cortes. Esto es lo último que tenemos.');
  await expect(page.getByRole('status')).toContainText('Actualizado hace 5 min.');
  await expect(page.getByRole('status')).not.toContainText('Lo que ves');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  await expect(page.locator(mapBlobs)).toHaveCount(1);
  await expect(page.locator('#answer')).not.toContainText('No pudimos cargar');
});

test('changing the service filter never asks the network and survives an outage', async ({ page }) => {
  await asReturningVisitor(page);
  const state = { cells: [water, internet], down: false, requests: 0 };
  await serveCells(page, state);

  await page.goto('/');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(2);
  state.down = true;
  const before = state.requests;

  await page.getByLabel('Ver servicio').selectOption('water');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  await expect(page.locator(mapBlobs)).toHaveCount(1);
  await page.getByLabel('Ver servicio').selectOption('all');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(2);
  expect(state.requests).toBe(before);
});

test('shows the last saved copy when the network is down on a later visit', async ({ page }) => {
  await asReturningVisitor(page);
  const state = { cells: [water], down: false, requests: 0 };
  await serveCells(page, state);

  await page.goto('/');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);

  state.down = true;
  await page.reload();

  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('Esto es lo último que tenemos.');
  await expect(page.getByRole('status')).toContainText('Actualizado hace');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
});

test('runs without persistence when localStorage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  });
  const state = { cells: [water], down: false, requests: 0 };
  await serveCells(page, state);

  await page.goto('/');

  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  await expect(page.locator(mapBlobs)).toHaveCount(1);
});

test('ignores a /v1/zones answer that is not a list of zones', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/zones', (route) => route.fulfill({ json: { error: 'bad gateway' } }));
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [water] }));

  await page.goto('/');

  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
  await expect(page.getByLabel('Ver distrito')).toHaveValue('all');
});

async function fillWaterReport(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
}

test('retries a report with the same submission id after the connection dropped', async ({ page }) => {
  await asReturningVisitor(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: (position: GeolocationPosition) => void) => success({ coords: { latitude: -12.0464, longitude: -77.0428 } } as GeolocationPosition) },
    });
  });
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));
  const ids: string[] = [];
  await page.route('**/v1/reports', async (route) => {
    ids.push((route.request().postDataJSON() as { submissionId: string }).submissionId);
    if (ids.length === 1) { await route.abort(); return; }
    await route.fulfill({ status: 201, json: { accepted: true } });
  });

  await page.goto('/');
  await fillWaterReport(page);
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.locator('#report-state')).toContainText('No pudimos enviar tu reporte.');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.getByRole('dialog')).toContainText('Gracias por tu reporte');

  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test('tells a slow location fix apart from a denied permission', async ({ page }) => {
  await asReturningVisitor(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_success: unknown, error: (failure: { code: number }) => void) => error({ code: 3 }) },
    });
  });
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');
  await fillWaterReport(page);
  await page.getByRole('button', { name: 'Enviar reporte' }).click();

  await expect(page.locator('#report-state')).toContainText('Tu ubicación tardó demasiado en llegar. Reintenta.');
  await expect(page.locator('#report-state')).not.toContainText('Permite la ubicación');
});
