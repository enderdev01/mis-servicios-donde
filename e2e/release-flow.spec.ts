import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, revealNotice, test } from './fixtures.js';

async function grantLocation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: (position: GeolocationPosition) => void) => success({ coords: { latitude: -12.0464, longitude: -77.0428 } } as GeolocationPosition) },
    });
  });
}

test('submits a report and renders only the public aggregate after confirmation', async ({ page }) => {
  // Returning-user state: this spec exercises the report flow, not the first run.
  await asReturningVisitor(page);
  let reported = false;
  await grantLocation(page);
  await page.route('**/v1/reports', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ services: ['water'], providers: { water: 'sedapal' }, status: 'outage' });
    expect(route.request().postDataJSON()).not.toHaveProperty('name');
    reported = true;
    await route.fulfill({ status: 201, json: { submissionId: 'release-browser-submission', accepted: true } });
  });
  await page.route('**/v1/cells', async (route) => route.fulfill({
    json: reported ? [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true, deviceToken: 'never-public' }] : [],
  }));

  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.getByRole('dialog')).toContainText('Gracias por tu reporte');
  await page.getByRole('button', { name: 'Entendido' }).click();

  await page.getByLabel('Ver servicio').selectOption('water');
  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua confirmado');
  await revealNotice(page);
  await expect(page.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');
  await expect(page.locator('body')).not.toContainText('8999999999fffff');
  await expect(page.locator('body')).not.toContainText('never-public');
});

const limaCell = '898e62c0cdbffff';

test.describe('after reporting', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('lets the reporter see the report land: sheet folded, own position and area marked, row labelled', async ({ page }) => {
    await asReturningVisitor(page);
    await grantLocation(page);
    let reported = false;
    await page.route('**/v1/reports', async (route) => {
      reported = true;
      await route.fulfill({ status: 201, json: { submissionId: 'landing', accepted: true } });
    });
    await page.route('**/v1/cells', (route) => route.fulfill({
      json: reported ? [{ h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false }] : [],
    }));

    await page.goto('/');
    await page.getByRole('button', { name: 'Ver el panel' }).click();
    await page.getByRole('tab', { name: 'Reportar' }).click();
    await page.getByRole('checkbox', { name: 'Luz' }).check();
    await page.getByLabel('Empresa de luz').selectOption('luz_del_sur');
    await page.getByRole('button', { name: 'Enviar reporte' }).click();
    await expect(page.getByRole('dialog')).toContainText('«sin confirmar»');
    await page.getByRole('button', { name: 'Entendido' }).click();

    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'peek');
    await expect(page.locator('.me span')).toBeVisible();
    await expect(page.locator('#outage-map path.cell-mine')).toHaveCount(1);
    await expect(page.locator('#cell-list .cell-row')).toContainText('Tu reporte · sin confirmar');
    // The area ends above the peeking sheet (9.6rem tall at 16px), not behind it. Polled: the map is still flying there.
    await expect.poll(async () => {
      const blob = await page.locator('#outage-map path.cell-mine').boundingBox();
      return (blob?.y ?? Number.POSITIVE_INFINITY) + (blob?.height ?? 0);
    }).toBeLessThan(844 - 9.6 * 16);
  });

  test('does not promise an unconfirmed area after «Ya volvió»', async ({ page }) => {
    await asReturningVisitor(page);
    await grantLocation(page);
    await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));
    await page.route('**/v1/reports', (route) => route.fulfill({ status: 201, json: { accepted: true } }));

    await page.goto('/');
    await page.getByRole('button', { name: 'Ver el panel' }).click();
    await page.getByRole('tab', { name: 'Reportar' }).click();
    await expect(page.getByRole('heading', { name: '¿Se fue o volvió el servicio?' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Agua' }).check();
    await page.getByLabel('Empresa de agua').selectOption('sedapal');
    await page.getByLabel('Ya volvió').check();
    await page.getByRole('button', { name: 'Enviar reporte' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Si otros vecinos también avisan que volvió');
    await expect(dialog).not.toContainText('sin confirmar');
  });
});

test('reports from the area dialog through the same submit path', async ({ page }) => {
  await asReturningVisitor(page);
  await grantLocation(page);
  await page.route('**overpass-api.de/**', (route) => route.abort());
  await page.route('**nominatim.openstreetmap.org/**', (route) => route.abort());
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));
  const bodies: unknown[] = [];
  await page.route('**/v1/reports', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { accepted: true } });
  });

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();
  await page.getByRole('button', { name: 'También me pasa' }).click();
  // By id: the area dialog is still fading out while the thank-you opens.
  await expect(page.locator('#thanks')).toContainText('Gracias por tu reporte');
  await page.getByRole('button', { name: 'Entendido' }).click();

  await page.locator('#cell-list .cell-row').first().click();
  await page.getByRole('button', { name: 'Ya volvió aquí' }).click();
  await expect(page.locator('#thanks')).toContainText('volvió');

  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ services: ['water'], providers: { water: 'sedapal' }, status: 'outage', latitude: -12.0464, longitude: -77.0428 });
  expect(bodies[1]).toMatchObject({ services: ['water'], providers: { water: 'sedapal' }, status: 'restored' });
  expect(bodies[0]).toHaveProperty('submissionId');
});

test('brings the reporter to the message when the dialog report fails', async ({ page }) => {
  await asReturningVisitor(page);
  await grantLocation(page);
  await page.route('**overpass-api.de/**', (route) => route.abort());
  await page.route('**nominatim.openstreetmap.org/**', (route) => route.abort());
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));
  await page.route('**/v1/reports', (route) => route.fulfill({ status: 409, json: { code: 'duplicate' } }));

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();
  await page.getByRole('button', { name: 'También me pasa' }).click();

  await expect(page.locator('#report-state')).toContainText('Ya enviaste este reporte hace menos de una hora.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps the browser private and actionable when rollout APIs are disabled', async ({ page }) => {
  await asReturningVisitor(page);
  await grantLocation(page);
  await page.route('**/v1/cells', async (route) => route.fulfill({ json: [] }));
  await page.route('**/v1/reports', async (route) => route.fulfill({ status: 400, json: { code: 'report_unavailable' } }));

  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();

  await expect(page.locator('#report-state')).toContainText('No pudimos enviar tu reporte ahora.');
  await expect(page.getByRole('status')).toContainText('Nadie ha reportado cortes en los distritos con cobertura.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toBeEmpty();
});
